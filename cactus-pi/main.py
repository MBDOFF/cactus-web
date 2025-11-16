# Acest script restructurează detectorul YOLOv8 într-o aplicație web Flask.
# Rulează detecția video într-un fir de execuție separat și expune
# fluxul video pe /video_feed și starea detecției pe /detect, pe portul 8000.
# CORS este activat pentru a permite accesul API din orice domeniu.
# Suportă multiple intersecții cu state machine logic în backend.

from flask import Flask, Response, jsonify, request
from flask_cors import CORS
import threading
import cv2
import time
import numpy as np
import os
import json
from datetime import datetime
from ultralytics import YOLO
import requests

# --- Configurare Flask ---
app = Flask(__name__)
# Activează CORS pentru toate rutele și toate originile
CORS(app)

# --- Configurare YOLO și Camera ---
CAMERA_INDEX = 0 
MODEL_NAME = 'yolov8n.pt'
INTERSECTIONS_FILE = 'intersections.json'

# Mapează COCO IDs la noile categorii de ieșire: "humans" sau "wheels"
CLASS_MAP = {
    0: "humans",       
    2: "wheels",        
    3: "wheels",
    5: "wheels",        
    7: "wheels",       
    44: "wheels"
}

# --- Variabile de stare globale partajate ---
global_frame = None
intersections_frames = {}  # {intersection_id: frame} - frame-uri pentru fiecare intersecție
detection_data = {}  # {intersection_id: {"humans": bool, "wheels": bool, "zones": {0: bool, 1: bool, 2: bool, 3: bool}}}
intersections_state = {}  # {intersection_id: intersection_state_object}
intersections_cameras = {}  # {intersection_id: cv2.VideoCapture}
lock = threading.Lock()
PRINT_COOLDOWN = 0.5
last_print_time = time.time()

TRAFFIC_LIGHT_API_URL = "http://cactus:8014/api/set"

def send_traffic_light_command(light_type, value):
    """Trimite comenzi către API-ul semaforului fizic.
    
    Args:
        light_type: "car" sau "pedestrian"
        value: "red", "yellow" sau "green"
    """
    try:
        response = requests.post(
            TRAFFIC_LIGHT_API_URL,
            json={"type": light_type, "value": value},
            headers={"Content-Type": "application/json"},
            timeout=2
        )
        if response.status_code == 200:
            print(f"✓ Comandă trimisă către semafor: {light_type} -> {value}")
        else:
            print(f"⚠ Eroare la trimiterea comenzii către semafor: {response.status_code}")
    except Exception as e:
        print(f"⚠ Eroare la comunicarea cu API-ul semaforului: {e}")

def update_traffic_lights_physical(intersection_type, lights_state, previous_lights=None):
    """Actualizează semafoarele fizice când se schimbă starea pentru car_pedestrian.
    
    Args:
        intersection_type: "car_pedestrian" sau "car_car"
        lights_state: [car_light, ped_light] - 0=red, 1=green, 2=yellow
        previous_lights: [car_light, ped_light] anterior (opțional, pentru a evita apelurile inutile)
    """
    if intersection_type != "car_pedestrian":
        return
    
    car_light = lights_state[0]
    ped_light = lights_state[1] if len(lights_state) > 1 else 0
    
    if previous_lights:
        prev_car_light = previous_lights[0]
        prev_ped_light = previous_lights[1] if len(previous_lights) > 1 else 0
        if car_light == prev_car_light and ped_light == prev_ped_light:
            return
    
    color_map = {0: "red", 1: "green", 2: "yellow"}
    
    if car_light in color_map:
        send_traffic_light_command("car", color_map[car_light])
    
    if ped_light in color_map:
        if ped_light == 2:
            send_traffic_light_command("pedestrian", "red")
        else:
            send_traffic_light_command("pedestrian", color_map[ped_light])

# --- Funcții pentru gestionarea intersecțiilor ---

def load_intersections():
    """Încarcă intersecțiile din fișierul JSON."""
    if os.path.exists(INTERSECTIONS_FILE):
        try:
            with open(INTERSECTIONS_FILE, 'r') as f:
                return json.load(f)
        except Exception as e:
            print(f"Eroare la citirea intersecțiilor: {e}")
            return get_default_intersections()
    return get_default_intersections()

def save_intersections(intersections):
    """Salvează intersecțiile în fișierul JSON."""
    try:
        with open(INTERSECTIONS_FILE, 'w') as f:
            json.dump(intersections, f, indent=2)
        return True
    except Exception as e:
        print(f"Eroare la salvarea intersecțiilor: {e}")
        return False

def get_default_intersections():
    """Returnează intersecțiile default."""
    return {
        "intersections": [
            {
                "id": "depou-001",
                "name": "Depou",
                "type": "car_pedestrian",  # sau "car_car"
                "cameraIndex": 0,
                "lights": [
                    {"id": 0, "type": "car", "name": "Vehicule"},
                    {"id": 1, "type": "pedestrian", "name": "Pietoni"}
                ],
                "settings": {
                    "mode": "Automatic",  # Automatic, Manual, Override
                    "greenLinePreference": "Car",  # Car sau Pedestrian (pentru car_pedestrian) sau 0/1 (pentru car_car)
                    "carGreenTime": 15,
                    "pedGreenTime": 10,
                    "yellowTime": 3,
                    "allRedSafetyTime": 2
                },
                "state": {
                    "phase": "CAR_GREEN",  # CAR_GREEN, CAR_YELLOW, ALL_RED_1, PED_GREEN, ALL_RED_2
                    "lights": [1, 0],  # [car, ped] - 0=red, 1=green, 2=yellow (dar ped nu are yellow)
                    "timer": {"for": "car", "value": 999},
                    "lastUpdate": None,
                    "previousMode": None,
                    "_fromVehicleDetection": False
                }
            },
            {
                "id": "centru-001",
                "name": "Centru",
                "type": "car_car",
                "cameraIndex": 0,
                "lights": [
                    {"id": 0, "type": "car", "name": "Vehicule Nord-Sud", "zones": [1, 2]},
                    {"id": 1, "type": "car", "name": "Vehicule Est-Vest", "zones": [3, 4]}
                ],
                "settings": {
                    "mode": "Automatic",
                    "greenLinePreference": "0",  # 0 sau 1 pentru car_car
                    "carGreenTime": 20,
                    "pedGreenTime": 10,
                    "yellowTime": 3,
                    "allRedSafetyTime": 2
                },
                "state": {
                    "phase": "LIGHT_0_GREEN",
                    "lights": [1, 0],  # [light_0, light_1] - 0=red, 1=green, 2=yellow
                    "timer": {"for": "light_0", "value": 999},
                    "lastUpdate": None,
                    "previousMode": None,
                    "_fromVehicleDetection": False,
                    "_fromOppositeDetection": False
                }
            }
        ]
    }

# --- State Machine Logic pentru Intersecții ---

class IntersectionStateMachine:
    """State machine pentru gestionarea stării unei intersecții."""
    
    def __init__(self, intersection_config):
        self.config = intersection_config
        self.state = intersection_config["state"].copy()
        self.last_tick = time.time()
        
        # EDGE CASE 28: Asigură că lastUpdate există în state
        if "lastUpdate" not in self.state:
            self.state["lastUpdate"] = None
        
        # EDGE CASE 29: Asigură că previousMode există în state
        if "previousMode" not in self.state:
            self.state["previousMode"] = None
        
        # EDGE CASE 52: Asigură că flag-ul pentru detecție vehicule există
        if "_fromVehicleDetection" not in self.state:
            self.state["_fromVehicleDetection"] = False
        
        # EDGE CASE 57: Asigură că flag-ul pentru detecție opusă există (pentru car_car)
        if "_fromOppositeDetection" not in self.state:
            self.state["_fromOppositeDetection"] = False
        
        # EDGE CASE 30: Validare și corectare timer invalid
        if "timer" not in self.state or not isinstance(self.state["timer"], dict):
            # Inițializează timer-ul default bazat pe fază
            phase = self.state.get("phase", "CAR_GREEN")
            
            if self.config["type"] == "car_car":
                green_line_light = int(self.config["settings"].get("greenLinePreference", "0"))
                if phase == f"LIGHT_{green_line_light}_GREEN":
                    self.state["timer"] = {"for": f"light_{green_line_light}", "value": 999}
                elif phase == f"LIGHT_{1 - green_line_light}_GREEN":
                    self.state["timer"] = {"for": f"light_{1 - green_line_light}", "value": self.config["settings"]["carGreenTime"]}
                elif "YELLOW" in phase:
                    self.state["timer"] = {"for": "yellow", "value": self.config["settings"]["yellowTime"]}
                else:
                    self.state["timer"] = {"for": "all_red", "value": self.config["settings"]["allRedSafetyTime"]}
            else:
                green_line = self.config["settings"].get("greenLinePreference", "Car")
                if phase == "CAR_GREEN":
                    self.state["timer"] = {"for": "car", "value": 999 if green_line == "Car" else self.config["settings"]["carGreenTime"]}
                elif phase == "PED_GREEN":
                    self.state["timer"] = {"for": "ped", "value": 999 if green_line == "Pedestrian" else self.config["settings"]["pedGreenTime"]}
                else:
                    self.state["timer"] = {"for": "all_red", "value": self.config["settings"]["allRedSafetyTime"]}
        
        # EDGE CASE 31: Validare timer value - asigură că este întreg pozitiv sau 999
        timer_value = self.state["timer"].get("value", 0)
        if not isinstance(timer_value, (int, float)) or timer_value < 0:
            self.state["timer"]["value"] = 999 if timer_value == 999 else max(0, int(timer_value))
        
        # Inițializează semafoarele fizice pentru car_pedestrian
        if self.config["type"] == "car_pedestrian" and "lights" in self.state:
            update_traffic_lights_physical(self.config["type"], self.state["lights"])
    
    def get_zone_from_position(self, x, y, frame_width, frame_height):
        """Determină zona (cadranul) în care se află o detecție.
        Returnează: 0=top-left, 1=top-right, 2=bottom-left, 3=bottom-right
        """
        center_x = frame_width // 2
        center_y = frame_height // 2
        
        if x < center_x:
            if y < center_y:
                return 0  # top-left
            else:
                return 2  # bottom-left
        else:
            if y < center_y:
                return 1  # top-right
            else:
                return 3  # bottom-right
    
    def update_from_detection(self, detection_data, frame_width, frame_height):
        """Actualizează starea bazată pe detecții.
        detection_data: dict cu {"humans": bool, "wheels": bool, "zones": {...}} pentru această intersecție
        """
        # detection_data este deja dict-ul pentru această intersecție (nu dict-ul cu toate intersecțiile)
        detection = detection_data if isinstance(detection_data, dict) else {}
        
        if self.config["type"] == "car_pedestrian":
            # Logica pentru intersecție mașini/pietoni
            humans = detection.get("humans", False)
            wheels = detection.get("wheels", False)
            
            if self.config["settings"]["mode"] == "Automatic":
                green_line = self.config["settings"]["greenLinePreference"]
                phase = self.state["phase"]
                timer_value = self.state["timer"]["value"]
                
                # Debug logging (doar dacă există detecție)
                if humans or wheels:
                    print(f"[{self.config['id']}] Detecție: humans={humans}, wheels={wheels}, phase={phase}, timer={timer_value}, green_line={green_line}")
                
                # EDGE CASE 1: Ignoră detecțiile în faze de tranziție (ALL_RED, YELLOW)
                # Aceste faze trebuie să se termine complet înainte de a răspunde la detecții
                # Nu există PED_YELLOW - doar CAR_YELLOW
                if phase in ["CAR_YELLOW", "ALL_RED_1", "ALL_RED_2"]:
                    # Nu face nimic - lasă tranziția să se termine
                    if humans or wheels:
                        print(f"[{self.config['id']}] Ignoră detecție în fază de tranziție: {phase}")
                    return
                
                # EDGE CASE 2: Detecție simultană (humans + wheels) - Prioritate: humans > wheels
                # Dacă detectăm ambele, prioritizăm humans (pietonii au prioritate)
                
                # Logica pentru green line infinită (timer = 999)
                if phase == "CAR_GREEN" and timer_value == 999:
                    # Pe linie verde infinită pentru mașini
                    if humans:
                        # Detectat pieton - trece la galben
                        # EDGE CASE 3: Dacă detectăm și wheels simultan, ignorăm wheels (humans are prioritate)
                        print(f"[{self.config['id']}] CAR_GREEN (green line) -> CAR_YELLOW (detectat pieton)")
                        self.state["phase"] = "CAR_YELLOW"
                        self.state["lights"] = [2, 0]  # galben, roșu
                        self.state["timer"] = {"for": "yellow", "value": self.config["settings"]["yellowTime"]}
                        self.state["lastUpdate"] = time.time()
                    # EDGE CASE 4: Dacă nu detectăm nimic, rămâne pe verde infinit (corect)
                
                elif phase == "PED_GREEN" and timer_value == 999:
                    # Pe linie verde infinită pentru pietoni
                    if wheels:
                        # Detectat vehicul - trece direct la ALL_RED_2, apoi la verde mașini
                        # Nu mai trece prin PED_YELLOW pentru a fi mai rapid
                        # Marchează că am venit din detecție pentru a ști că trebuie să trecem la verde mașini
                        print(f"[{self.config['id']}] PED_GREEN (green line) -> ALL_RED_2 (detectat vehicul)")
                        previous_lights = self.state.get("lights", [0, 0]).copy()
                        self.state["phase"] = "ALL_RED_2"
                        self.state["lights"] = [0, 0]  # roșu, roșu
                        self.state["timer"] = {"for": "all_red", "value": self.config["settings"]["allRedSafetyTime"]}
                        self.state["_fromVehicleDetection"] = True  # Flag pentru a ști că trebuie să trecem la verde mașini
                        self.state["lastUpdate"] = time.time()
                        update_traffic_lights_physical(self.config["type"], self.state["lights"], previous_lights)
                    # EDGE CASE 6: Dacă nu detectăm nimic, rămâne pe verde infinit (corect)
                
                # Logica pentru timer finit - menține verde dacă există detecție
                elif phase == "PED_GREEN" and timer_value > 0 and timer_value != 999:
                    # Pe verde pietoni cu timer
                    # EDGE CASE 7: Evită resetarea prea frecventă - doar dacă timer-ul este < 50% din timpul total
                    # Aceasta previne "bouncing" când detecția este intermitentă
                    if humans:
                        # Menține verde dacă încă există pietoni
                        # Resetăm timer-ul doar dacă e aproape de expirare (evită resetări prea frecvente)
                        if timer_value <= self.config["settings"]["pedGreenTime"] * 0.5:
                            print(f"[{self.config['id']}] PED_GREEN (timer) - reset timer (detectat pieton)")
                            self.state["timer"] = {"for": "ped", "value": self.config["settings"]["pedGreenTime"]}
                            self.state["lastUpdate"] = time.time()
                    # EDGE CASE 8: Dacă nu mai există pietoni, timer-ul continuă să scadă normal
                    # Tranziția se face automat în tick() când timer-ul ajunge la 0
                
                elif phase == "CAR_GREEN" and timer_value > 0 and timer_value != 999:
                    # Pe verde mașini cu timer
                    # EDGE CASE 9: Evită resetarea prea frecventă - doar dacă timer-ul este < 50% din timpul total
                    if wheels:
                        # Menține verde dacă încă există vehicule
                        # Resetăm timer-ul doar dacă e aproape de expirare (evită resetări prea frecvente)
                        if timer_value <= self.config["settings"]["carGreenTime"] * 0.5:
                            print(f"[{self.config['id']}] CAR_GREEN (timer) - reset timer (detectat vehicul)")
                            self.state["timer"] = {"for": "car", "value": self.config["settings"]["carGreenTime"]}
                            self.state["lastUpdate"] = time.time()
                    # EDGE CASE 10: Dacă nu mai există vehicule, timer-ul continuă să scadă normal
                    # Tranziția se face automat în tick() când timer-ul ajunge la 0
                
                # EDGE CASE 11: Dacă phase nu este recunoscut, nu face nimic (previne erori)
        
        elif self.config["type"] == "car_car":
            # Logica pentru intersecție mașini/mașini cu zone personalizate
            zones = detection.get("zones", {})
            green_line_light = int(self.config["settings"]["greenLinePreference"])  # 0 sau 1
            
            if self.config["settings"]["mode"] == "Automatic":
                opposite_light = 1 - green_line_light
                phase = self.state["phase"]
                timer_value = self.state["timer"]["value"]
                
                # EDGE CASE 12: Ignoră detecțiile în faze de tranziție pentru car_car
                if "YELLOW" in phase or phase == "ALL_RED":
                    # Nu face nimic - lasă tranziția să se termine
                    return
                
                # Obține zonele personalizate pentru fiecare light
                green_light_config = self.config["lights"][green_line_light]
                opposite_light_config = self.config["lights"][opposite_light]
                
                # Obține zonele personalizate (customZones) sau fallback la zones vechi (pentru backward compatibility)
                green_custom_zones = green_light_config.get("customZones", [])
                opposite_custom_zones = opposite_light_config.get("customZones", [])
                
                # Verifică dacă există detecție în zonele opuse
                # Pentru zone personalizate, verifică dacă există detecție în oricare dintre zonele light-ului opus
                opposite_detected = False
                green_detected = False
                
                # Debug: afișează toate zonele detectate (doar dacă există detecție)
                detected_zones = [k for k, v in zones.items() if v]
                
                if opposite_custom_zones:
                    # Verifică dacă există detecție în oricare dintre zonele personalizate ale light-ului opus
                    for zone_idx in range(len(opposite_custom_zones)):
                        zone_key = f"light_{opposite_light}_zone_{zone_idx}"
                        if zones.get(zone_key, False):
                            opposite_detected = True
                            print(f"[{self.config['id']}] CAR_CAR: Detectat în zona opusă: {zone_key}")
                            break
                else:
                    # Fallback la logica veche cu quadrants (pentru backward compatibility)
                    old_zones = opposite_light_config.get("zones", [])
                    if old_zones:
                        opposite_zones = [str(z - 1) for z in old_zones if 1 <= z <= 4]
                        opposite_detected = any(zones.get(zone, False) for zone in opposite_zones)
                        if opposite_detected:
                            print(f"[{self.config['id']}] CAR_CAR: Detectat în zone opuse (quadrants): {opposite_zones}")
                
                if green_custom_zones:
                    # Verifică dacă există detecție în oricare dintre zonele personalizate ale green line light
                    for zone_idx in range(len(green_custom_zones)):
                        zone_key = f"light_{green_line_light}_zone_{zone_idx}"
                        if zones.get(zone_key, False):
                            green_detected = True
                            print(f"[{self.config['id']}] CAR_CAR: Detectat în zona green line: {zone_key}")
                            break
                else:
                    # Fallback la logica veche cu quadrants
                    old_zones = green_light_config.get("zones", [])
                    if old_zones:
                        green_zones = [str(z - 1) for z in old_zones if 1 <= z <= 4]
                        green_detected = any(zones.get(zone, False) for zone in green_zones)
                        if green_detected:
                            print(f"[{self.config['id']}] CAR_CAR: Detectat în zone green line (quadrants): {green_zones}")
                
                # LOGICA PRINCIPALĂ PENTRU CAR_CAR
                # Debug logging doar dacă există detecție sau dacă suntem pe green line
                if detected_zones or (phase == f"LIGHT_{green_line_light}_GREEN" and timer_value == 999):
                    print(f"[{self.config['id']}] CAR_CAR: Phase={phase}, timer={timer_value}, opposite_detected={opposite_detected}, green_detected={green_detected}, detected_zones={detected_zones}")
                
                if phase == f"LIGHT_{green_line_light}_GREEN":
                    # Pe green line (timer 999) sau pe verde cu timer
                    if timer_value == 999:
                        # Green line infinită - verifică dacă există detecție în zona opusă
                        if opposite_detected:
                            # Detectat vehicul în zona opusă - trece la galben
                            print(f"[{self.config['id']}] CAR_CAR: Green line detectat opus -> YELLOW (phase={phase}, timer={timer_value})")
                            self.state["phase"] = f"LIGHT_{green_line_light}_YELLOW"
                            lights = [0, 0]
                            lights[green_line_light] = 2  # galben
                            self.state["lights"] = lights
                            self.state["timer"] = {"for": "yellow", "value": self.config["settings"]["yellowTime"]}
                            self.state["_fromOppositeDetection"] = True  # Flag pentru a ști că trebuie să trecem la opus
                            self.state["lastUpdate"] = time.time()
                        else:
                            # Debug: de ce nu se face tranziția
                            if detected_zones:
                                print(f"[{self.config['id']}] CAR_CAR: Zone detectate dar nu în zona opusă. Zone opuse configurate: {len(opposite_custom_zones) if opposite_custom_zones else 'fallback quadrants'}")
                    else:
                        # Pe verde cu timer - menține verde dacă există detecție în zonele proprii
                        if green_detected and timer_value <= self.config["settings"]["carGreenTime"] * 0.5:
                            # Reset timer dacă e aproape de expirare și există detecție
                            print(f"[{self.config['id']}] CAR_CAR: Reset timer green line (detectat propriu)")
                            self.state["timer"] = {"for": f"light_{green_line_light}", "value": self.config["settings"]["carGreenTime"]}
                            self.state["lastUpdate"] = time.time()
                
                elif phase == f"LIGHT_{opposite_light}_GREEN":
                    # Pe verde opus (nu green line) - menține verde dacă există detecție
                    # Dar adaugă o limită de timp maximă pentru a preveni blocarea
                    current_time = time.time()
                    
                    # Inițializează timestamp-ul când am trecut la verde opus (dacă nu există)
                    if "_oppositeGreenStartTime" not in self.state:
                        self.state["_oppositeGreenStartTime"] = current_time
                    
                    opposite_green_start_time = self.state.get("_oppositeGreenStartTime", current_time)
                    time_on_opposite_green = current_time - opposite_green_start_time
                    
                    # Limită maximă: 3x timpul normal de verde (pentru a preveni blocarea)
                    max_time_on_opposite = self.config["settings"]["carGreenTime"] * 3
                    
                    if time_on_opposite_green >= max_time_on_opposite:
                        # Forțează trecerea la galben după timp maxim, chiar dacă detecția persistă
                        print(f"[{self.config['id']}] CAR_CAR: Timp maxim atins pe verde opus ({max_time_on_opposite}s) -> YELLOW (forțat)")
                        self.state["phase"] = f"LIGHT_{opposite_light}_YELLOW"
                        lights = [0, 0]
                        lights[opposite_light] = 2
                        self.state["lights"] = lights
                        self.state["timer"] = {"for": "yellow", "value": self.config["settings"]["yellowTime"]}
                        self.state["_fromOppositeDetection"] = False  # Asigură revenirea la green line
                        self.state["lastUpdate"] = current_time
                        return
                    
                    if opposite_detected and timer_value > 0 and timer_value != 999:
                        if timer_value <= self.config["settings"]["carGreenTime"] * 0.5:
                            # Reset timer dacă e aproape de expirare și există detecție
                            print(f"[{self.config['id']}] CAR_CAR: Reset timer opus (detectat opus, timp total: {time_on_opposite_green:.1f}s)")
                            self.state["timer"] = {"for": f"light_{opposite_light}", "value": self.config["settings"]["carGreenTime"]}
                            self.state["lastUpdate"] = current_time
                    # IMPORTANT: Dacă detecția dispare, timer-ul continuă să scadă normal
                    # Nu face nimic - lasă timer-ul să scadă și să treacă la YELLOW
    
    def set_mode(self, mode):
        """Setează modul de operare (Automatic, Manual, Override)."""
        # EDGE CASE 25: Validare mod
        if mode not in ["Automatic", "Manual", "Override"]:
            print(f"⚠ Eroare: Mod invalid: {mode}")
            return
        
        # EDGE CASE 26: Dacă modul este deja setat, nu face nimic (evită resetări inutile)
        if self.config["settings"]["mode"] == mode:
            return
        
        if mode == "Override":
            # Păstrează modul anterior
            if "previousMode" not in self.state or self.state["previousMode"] is None:
                self.state["previousMode"] = self.config["settings"].get("mode", "Automatic")
        elif mode == "Automatic" or mode == "Manual":
            # EDGE CASE 27: Când revine la Automatic, reinițializează timer-ul corect bazat pe fază
            if mode == "Automatic" and "previousMode" in self.state:
                # Reinițializează timer-ul bazat pe fază și green line preference
                phase = self.state["phase"]
                
                if self.config["type"] == "car_car":
                    green_line_light = int(self.config["settings"].get("greenLinePreference", "0"))
                    if phase == f"LIGHT_{green_line_light}_GREEN":
                        self.state["timer"] = {"for": f"light_{green_line_light}", "value": 999}
                    elif phase == f"LIGHT_{1 - green_line_light}_GREEN":
                        self.state["timer"] = {"for": f"light_{1 - green_line_light}", "value": self.config["settings"]["carGreenTime"]}
                    # Pentru alte faze, păstrează timer-ul existent
                else:
                    green_line = self.config["settings"].get("greenLinePreference", "Car")
                    if phase == "CAR_GREEN":
                        self.state["timer"] = {"for": "car", "value": 999 if green_line == "Car" else self.config["settings"]["carGreenTime"]}
                    elif phase == "PED_GREEN":
                        self.state["timer"] = {"for": "ped", "value": 999 if green_line == "Pedestrian" else self.config["settings"]["pedGreenTime"]}
                    # Pentru alte faze, păstrează timer-ul existent
            elif mode == "Manual":
                # Când se setează modul Manual, inițializează ciclul normal de semafor
                phase = self.state["phase"]
                settings = self.config["settings"]
                
                if self.config["type"] == "car_car":
                    green_line_light = int(settings["greenLinePreference"])
                    opposite_light = 1 - green_line_light
                    # Faze valide pentru car_car: LIGHT_0_GREEN, LIGHT_0_YELLOW, LIGHT_1_GREEN, LIGHT_1_YELLOW, ALL_RED
                    valid_phases = [f"LIGHT_{green_line_light}_GREEN", f"LIGHT_{green_line_light}_YELLOW",
                                   f"LIGHT_{opposite_light}_GREEN", f"LIGHT_{opposite_light}_YELLOW", "ALL_RED"]
                    if phase not in valid_phases:
                        self.state["phase"] = f"LIGHT_{green_line_light}_GREEN"
                        lights = [0, 0]
                        lights[green_line_light] = 1
                        self.state["lights"] = lights
                        self.state["timer"] = {"for": f"light_{green_line_light}", "value": settings["carGreenTime"]}
                    else:
                        # Reinițializează timer-ul pentru faza curentă cu timpii normali (nu green line)
                        if phase == f"LIGHT_{green_line_light}_GREEN" or phase == f"LIGHT_{opposite_light}_GREEN":
                            light_idx = green_line_light if phase == f"LIGHT_{green_line_light}_GREEN" else opposite_light
                            self.state["timer"] = {"for": f"light_{light_idx}", "value": settings["carGreenTime"]}
                        elif "YELLOW" in phase:
                            self.state["timer"] = {"for": "yellow", "value": settings["yellowTime"]}
                        elif phase == "ALL_RED":
                            self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
                else:
                    # Dacă suntem într-o fază invalidă pentru Manual, reinițializează la CAR_GREEN
                    # Nu există PED_YELLOW - doar CAR_YELLOW
                    if phase not in ["CAR_GREEN", "CAR_YELLOW", "ALL_RED_1", "PED_GREEN", "ALL_RED_2"]:
                        previous_lights = self.state.get("lights", [0, 0]).copy()
                        self.state["phase"] = "CAR_GREEN"
                        self.state["lights"] = [1, 0]
                        self.state["timer"] = {"for": "car", "value": settings["carGreenTime"]}
                        update_traffic_lights_physical(self.config["type"], self.state["lights"], previous_lights)
                    else:
                        # Reinițializează timer-ul pentru faza curentă cu timpii normali (nu green line)
                        if phase == "CAR_GREEN":
                            self.state["timer"] = {"for": "car", "value": settings["carGreenTime"]}
                        elif phase == "CAR_YELLOW":
                            self.state["timer"] = {"for": "yellow", "value": settings["yellowTime"]}
                        elif phase == "ALL_RED_1" or phase == "ALL_RED_2":
                            self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
                        elif phase == "PED_GREEN":
                            self.state["timer"] = {"for": "ped", "value": settings["pedGreenTime"]}
            
            # Revine la modul normal
            if "previousMode" in self.state:
                self.state["previousMode"] = None
        
        self.config["settings"]["mode"] = mode
        self.state["lastUpdate"] = time.time()
        # EDGE CASE 50: Resetează last_tick când se schimbă modul
        self.last_tick = time.time()
    
    def set_override(self, light_index, light_value):
        """Setează manual o lumină (Override mode).
        light_index: 0 pentru car, 1 pentru ped (sau light 0/1 pentru car_car)
        light_value: 0=red, 1=green, 2=yellow
        """
        # EDGE CASE 43: Validare parametri
        if light_index not in [0, 1]:
            print(f"⚠ Eroare: light_index invalid: {light_index}")
            return
        if light_value not in [0, 1, 2]:
            print(f"⚠ Eroare: light_value invalid: {light_value}")
            return
        
        # EDGE CASE 53: Semafoarele de pietoni nu au galben - doar roșu sau verde
        if self.config["type"] == "car_pedestrian":
            # Verifică dacă încercăm să setăm galben la semafor de pietoni
            light_config = self.config["lights"][light_index]
            if light_config.get("type") == "pedestrian" and light_value == 2:
                print(f"⚠ Eroare: Semafoarele de pietoni nu au lumina galbenă. Folosește doar roșu (0) sau verde (1).")
                return
        
        # EDGE CASE 44: Salvează modul anterior doar dacă nu există deja
        if "previousMode" not in self.state or self.state["previousMode"] is None:
            self.state["previousMode"] = self.config["settings"].get("mode", "Automatic")
        
        self.config["settings"]["mode"] = "Override"
        
        lights = self.state["lights"].copy()
        if len(lights) < 2:
            # EDGE CASE 45: Inițializează lights dacă nu există
            lights = [0, 0]
        
        lights[light_index] = light_value
        
        previous_lights = self.state.get("lights", [0, 0]).copy()
        
        if self.config["type"] == "car_pedestrian":
            if light_index == 0:
                if light_value == 1:
                    lights[1] = 0
                elif light_value == 0:
                    lights[1] = 1
            elif light_index == 1:
                if light_value == 1:
                    lights[0] = 0
                elif light_value == 0:
                    lights[0] = 1
        
        self.state["lights"] = lights
        update_traffic_lights_physical(self.config["type"], self.state["lights"], previous_lights)
        
        # Set timer based on light value
        if light_value == 1:  # Green
            duration = self.config["settings"]["carGreenTime"] if light_index == 0 else self.config["settings"]["pedGreenTime"]
        elif light_value == 2:  # Yellow
            duration = self.config["settings"]["yellowTime"]
        else:  # Red
            duration = self.config["settings"]["allRedSafetyTime"]
        
        # EDGE CASE 48: Validare duration
        duration = max(1, int(duration))  # Minimum 1 secundă
        
        self.state["timer"] = {"for": "override", "value": duration}
        self.state["lastUpdate"] = time.time()
        # EDGE CASE 49: Resetează last_tick pentru a preveni timer-ul să scadă prea repede
        self.last_tick = time.time()
    
    def simulate_detection(self, detection_type, light_index=None):
        """Simulează o detecție (pentru testare).
        detection_type: 'car', 'ped', 'none'
        light_index: pentru car_car, index-ul semaforului (0 sau 1)
        """
        if self.config["type"] == "car_car":
            # Pentru car_car, simulează detecție în zonele semaforului specificat
            if light_index is not None and detection_type == "car":
                # Obține zonele pentru semaforul specificat
                if light_index < len(self.config["lights"]):
                    light_config = self.config["lights"][light_index]
                    zones_config = light_config.get("zones", [])
                    
                    # Creează un dict de detecție cu zonele activate
                    zones_dict = {"0": False, "1": False, "2": False, "3": False}
                    for zone in zones_config:
                        # Convertește din format configurație (1-4) la indexuri (0-3)
                        if 1 <= zone <= 4:
                            zone_index = str(zone - 1)
                            if zone_index in zones_dict:
                                zones_dict[zone_index] = True
                    
                    # Simulează detecția
                    detection_data = {
                        "humans": False,
                        "wheels": True,
                        "zones": zones_dict
                    }
                    self.update_from_detection(detection_data, 640, 480)  # Dimensiuni default
            elif detection_type == "none":
                # Simulează fără detecție
                detection_data = {
                    "humans": False,
                    "wheels": False,
                    "zones": {"0": False, "1": False, "2": False, "3": False}
                }
                self.update_from_detection(detection_data, 640, 480)
        else:
            # Pentru car_pedestrian, simulează detecție normală
            if detection_type == "car":
                detection_data = {
                    "humans": False,
                    "wheels": True,
                    "zones": {}
                }
                self.update_from_detection(detection_data, 640, 480)
            elif detection_type == "ped":
                detection_data = {
                    "humans": True,
                    "wheels": False,
                    "zones": {}
                }
                self.update_from_detection(detection_data, 640, 480)
            elif detection_type == "none":
                detection_data = {
                    "humans": False,
                    "wheels": False,
                    "zones": {}
                }
                self.update_from_detection(detection_data, 640, 480)
    
    def tick(self):
        """Actualizează timer-ul și face tranziții dacă e necesar."""
        current_time = time.time()
        
        # EDGE CASE 18: Inițializare last_tick dacă nu există
        if not hasattr(self, 'last_tick') or self.last_tick is None:
            self.last_tick = current_time
        
        # Nu face tranziții în Override sau Manual (sunt controlate manual)
        if self.config["settings"]["mode"] == "Override":
            # Actualizează timer-ul
            if self.state["timer"]["value"] > 0 and self.state["timer"]["value"] != 999:
                elapsed = current_time - self.last_tick
                # EDGE CASE 19: Previne timer-ul să scadă prea repede dacă tick() este apelat prea des
                if elapsed >= 1.0:
                    self.state["timer"]["value"] = max(0, self.state["timer"]["value"] - 1)
                    self.last_tick = current_time
            
            # EDGE CASE 20: Când timer-ul ajunge la 0, revine la modul anterior
            if self.state["timer"]["value"] == 0 and "previousMode" in self.state and self.state["previousMode"]:
                previous_mode = self.state["previousMode"]
                self.config["settings"]["mode"] = previous_mode
                self.state["previousMode"] = None
                # Reinițializează state machine cu modul anterior
                # EDGE CASE 21: Asigură că timer-ul este setat corect după revenirea la modul anterior
                if previous_mode == "Automatic":
                    # Reinițializează timer-ul bazat pe fază
                    phase = self.state["phase"]
                    if phase == "CAR_GREEN":
                        green_line = self.config["settings"].get("greenLinePreference", "Car")
                        self.state["timer"] = {"for": "car", "value": 999 if green_line == "Car" else self.config["settings"]["carGreenTime"]}
                    elif phase == "PED_GREEN":
                        green_line = self.config["settings"].get("greenLinePreference", "Car")
                        self.state["timer"] = {"for": "ped", "value": 999 if green_line == "Pedestrian" else self.config["settings"]["pedGreenTime"]}
                return
        
        # Manual mode - ciclu normal de semafor (verde → galben → roșu → repetă)
        if self.config["settings"]["mode"] == "Manual":
            # Actualizează timer-ul
            if self.state["timer"]["value"] > 0 and self.state["timer"]["value"] != 999:
                elapsed = current_time - self.last_tick
                if elapsed >= 1.0:
                    self.state["timer"]["value"] = max(0, self.state["timer"]["value"] - 1)
                    self.last_tick = current_time
            
            # Face tranziții automate când timer-ul ajunge la 0 (ciclu normal de semafor)
            if self.state["timer"]["value"] == 0:
                # Previne tranziții multiple
                if self.state.get("lastUpdate") is None or (current_time - self.state["lastUpdate"]) >= 0.5:
                    self.transition_manual()
            return
        
        # Actualizează timer-ul pentru Automatic mode
        if self.config["settings"]["mode"] == "Automatic":
            if self.state["timer"]["value"] > 0 and self.state["timer"]["value"] != 999:
                elapsed = current_time - self.last_tick
                # EDGE CASE 22: Previne timer-ul să scadă prea repede
                if elapsed >= 1.0:
                    self.state["timer"]["value"] = max(0, self.state["timer"]["value"] - 1)
                    self.last_tick = current_time
            
            # EDGE CASE 23: Face tranziții când timer-ul ajunge exact la 0
            # Verifică explicit pentru 0 (nu doar <= 0) pentru a evita tranziții multiple
            if self.state["timer"]["value"] == 0:
                # EDGE CASE 24: Previne tranziții multiple dacă tick() este apelat de mai multe ori rapid
                # Verifică dacă nu tocmai am făcut o tranziție (prin lastUpdate)
                if self.state.get("lastUpdate") is None or (current_time - self.state["lastUpdate"]) >= 0.5:
                    # Verifică tipul intersecției
                    if self.config["type"] == "car_pedestrian":
                        # EDGE CASE 51: Verifică dacă green line este pentru fază curentă - dacă da, nu face tranziție
                        phase = self.state["phase"]
                        green_line = self.config["settings"].get("greenLinePreference", "Car")
                        
                        # Dacă suntem pe green line infinită (timer 999), nu ar trebui să ajungem aici
                        # Dar dacă ajungem, verifică dacă trebuie să rămânem pe green line
                        if phase == "PED_GREEN" and green_line == "Pedestrian":
                            # Green line pentru pietoni - reinițializează timer-ul la 999
                            self.state["timer"] = {"for": "ped", "value": 999}
                            self.state["lastUpdate"] = current_time
                            return
                        elif phase == "CAR_GREEN" and green_line == "Car":
                            # Green line pentru mașini - reinițializează timer-ul la 999
                            self.state["timer"] = {"for": "car", "value": 999}
                            self.state["lastUpdate"] = current_time
                            return
                        
                        # Altfel, face tranziția normală
                        self.transition()
                    elif self.config["type"] == "car_car":
                        # Pentru car_car, verifică dacă suntem pe green line
                        phase = self.state["phase"]
                        green_line_light = int(self.config["settings"]["greenLinePreference"])
                        
                        # Dacă suntem pe green line (timer 999), nu ar trebui să ajungem aici
                        # Dar dacă ajungem, reinițializează timer-ul la 999
                        if phase == f"LIGHT_{green_line_light}_GREEN" and self.state["timer"].get("for") == f"light_{green_line_light}":
                            self.state["timer"] = {"for": f"light_{green_line_light}", "value": 999}
                            self.state["lastUpdate"] = current_time
                            return
                        
                        # Altfel, face tranziția normală
                        self.transition()
    
    def transition_manual(self):
        """Face tranziția la următoarea fază în modul Manual (ciclu normal de semafor)."""
        phase = self.state["phase"]
        settings = self.config["settings"]
        current_time = time.time()
        
        if self.config["type"] == "car_pedestrian":
            previous_lights = self.state.get("lights", [0, 0]).copy()
            
            if phase == "CAR_GREEN":
                self.state["phase"] = "CAR_YELLOW"
                self.state["lights"] = [2, 0]
                self.state["timer"] = {"for": "yellow", "value": settings["yellowTime"]}
            elif phase == "CAR_YELLOW":
                self.state["phase"] = "ALL_RED_1"
                self.state["lights"] = [0, 0]
                self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
            elif phase == "ALL_RED_1":
                self.state["phase"] = "PED_GREEN"
                self.state["lights"] = [0, 1]
                self.state["timer"] = {"for": "ped", "value": settings["pedGreenTime"]}
            elif phase == "PED_GREEN":
                self.state["phase"] = "ALL_RED_2"
                self.state["lights"] = [0, 0]
                self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
            elif phase == "ALL_RED_2":
                self.state["phase"] = "CAR_GREEN"
                self.state["lights"] = [1, 0]
                self.state["timer"] = {"for": "car", "value": settings["carGreenTime"]}
            else:
                self.state["phase"] = "CAR_GREEN"
                self.state["lights"] = [1, 0]
                self.state["timer"] = {"for": "car", "value": settings["carGreenTime"]}
            
            update_traffic_lights_physical(self.config["type"], self.state["lights"], previous_lights)
            self.state["lastUpdate"] = current_time
            self.last_tick = current_time
        
        elif self.config["type"] == "car_car":
            # Pentru car_car, ciclu similar: LIGHT_0_GREEN → LIGHT_0_YELLOW → ALL_RED → LIGHT_1_GREEN → LIGHT_1_YELLOW → ALL_RED → repeat
            green_line_light = int(settings["greenLinePreference"])
            opposite_light = 1 - green_line_light
            
            if phase == f"LIGHT_{green_line_light}_GREEN":
                self.state["phase"] = f"LIGHT_{green_line_light}_YELLOW"
                lights = [0, 0]
                lights[green_line_light] = 2  # galben
                self.state["lights"] = lights
                self.state["timer"] = {"for": "yellow", "value": settings["yellowTime"]}
            elif phase == f"LIGHT_{green_line_light}_YELLOW":
                self.state["phase"] = "ALL_RED"
                self.state["lights"] = [0, 0]
                self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
            elif phase == "ALL_RED":
                # Verifică dacă trebuie să treacă la opus sau să revină la green line
                # În modul Manual, trece întotdeauna la opus
                self.state["phase"] = f"LIGHT_{opposite_light}_GREEN"
                lights = [0, 0]
                lights[opposite_light] = 1  # verde
                self.state["lights"] = lights
                self.state["timer"] = {"for": f"light_{opposite_light}", "value": settings["carGreenTime"]}
            elif phase == f"LIGHT_{opposite_light}_GREEN":
                self.state["phase"] = f"LIGHT_{opposite_light}_YELLOW"
                lights = [0, 0]
                lights[opposite_light] = 2  # galben
                self.state["lights"] = lights
                self.state["timer"] = {"for": "yellow", "value": settings["yellowTime"]}
            elif phase == f"LIGHT_{opposite_light}_YELLOW":
                self.state["phase"] = "ALL_RED"
                self.state["lights"] = [0, 0]
                self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
            else:
                # Reinițializează la green line
                self.state["phase"] = f"LIGHT_{green_line_light}_GREEN"
                lights = [0, 0]
                lights[green_line_light] = 1
                self.state["lights"] = lights
                self.state["timer"] = {"for": f"light_{green_line_light}", "value": settings["carGreenTime"]}
            
            self.state["lastUpdate"] = current_time
            self.last_tick = current_time
    
    def transition(self):
        """Face tranziția la următoarea fază (pentru modul Automatic)."""
        phase = self.state["phase"]
        settings = self.config["settings"]
        
        if self.config["type"] == "car_pedestrian":
            green_line = settings.get("greenLinePreference", "Car")
            
            previous_lights = self.state.get("lights", [0, 0]).copy()
            
            if phase == "CAR_YELLOW":
                self.state["phase"] = "ALL_RED_1"
                self.state["lights"] = [0, 0]
                self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
            elif phase == "ALL_RED_1":
                self.state["phase"] = "PED_GREEN"
                self.state["lights"] = [0, 1]
                if green_line == "Pedestrian":
                    self.state["timer"] = {"for": "ped", "value": 999}
                else:
                    self.state["timer"] = {"for": "ped", "value": settings["pedGreenTime"]}
            elif phase == "PED_GREEN":
                if green_line == "Pedestrian":
                    self.state["timer"] = {"for": "ped", "value": 999}
                else:
                    self.state["phase"] = "ALL_RED_2"
                    self.state["lights"] = [0, 0]
                    self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
            elif phase == "CAR_GREEN":
                if green_line == "Pedestrian":
                    self.state["phase"] = "ALL_RED_2"
                    self.state["lights"] = [0, 0]
                    self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
                    self.state["_fromVehicleDetection"] = False
                else:
                    self.state["phase"] = "CAR_YELLOW"
                    self.state["lights"] = [2, 0]
                    self.state["timer"] = {"for": "yellow", "value": settings["yellowTime"]}
            elif phase == "ALL_RED_2":
                from_detection = self.state.get("_fromVehicleDetection", False)
                
                if green_line == "Pedestrian":
                    if from_detection:
                        self.state["phase"] = "CAR_GREEN"
                        self.state["lights"] = [1, 0]
                        self.state["timer"] = {"for": "car", "value": settings["carGreenTime"]}
                        self.state["_fromVehicleDetection"] = False
                    else:
                        self.state["phase"] = "PED_GREEN"
                        self.state["lights"] = [0, 1]
                        self.state["timer"] = {"for": "ped", "value": 999}
                        self.state["_fromVehicleDetection"] = False
                else:
                    self.state["phase"] = "CAR_GREEN"
                    self.state["lights"] = [1, 0]
                    self.state["timer"] = {"for": "car", "value": 999}
                    self.state["_fromVehicleDetection"] = False
            
            update_traffic_lights_physical(self.config["type"], self.state["lights"], previous_lights)
            self.state["lastUpdate"] = time.time()
        
        elif self.config["type"] == "car_car":
            green_line_light = int(settings["greenLinePreference"])
            opposite_light = 1 - green_line_light
            from_opposite_detection = self.state.get("_fromOppositeDetection", False)
            current_time = time.time()
            
            if phase == f"LIGHT_{green_line_light}_YELLOW":
                # După galben green line, trece la ALL_RED
                self.state["phase"] = "ALL_RED"
                self.state["lights"] = [0, 0]
                self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
                # Păstrează flag-ul pentru a ști că trebuie să trecem la opus
            elif phase == "ALL_RED":
                # Verifică de unde am venit pentru a ști dacă trebuie să trecem la opus sau să revenim la green line
                if from_opposite_detection:
                    # Am venit din detecție opusă pe green line → trecem la verde opus
                    print(f"[{self.config['id']}] CAR_CAR: ALL_RED -> LIGHT_{opposite_light}_GREEN (din detecție)")
                    self.state["phase"] = f"LIGHT_{opposite_light}_GREEN"
                    lights = [0, 0]
                    lights[opposite_light] = 1
                    self.state["lights"] = lights
                    self.state["timer"] = {"for": f"light_{opposite_light}", "value": settings["carGreenTime"]}
                    self.state["_fromOppositeDetection"] = False  # Resetează flag-ul după ce am trecut la opus
                    self.state["_oppositeGreenStartTime"] = time.time()  # Marchează când am trecut la verde opus
                else:
                    # Am venit din expirare timer verde opus → revenim la green line
                    print(f"[{self.config['id']}] CAR_CAR: ALL_RED -> LIGHT_{green_line_light}_GREEN (revenire green line)")
                    self.state["phase"] = f"LIGHT_{green_line_light}_GREEN"
                    lights = [0, 0]
                    lights[green_line_light] = 1
                    self.state["lights"] = lights
                    self.state["timer"] = {"for": f"light_{green_line_light}", "value": 999}  # Green line infinită
                    self.state["_fromOppositeDetection"] = False  # Resetează flag-ul
            elif phase == f"LIGHT_{opposite_light}_GREEN":
                # Pe verde opus - când expiră, trece la galben
                print(f"[{self.config['id']}] CAR_CAR: LIGHT_{opposite_light}_GREEN expirat -> YELLOW")
                self.state["phase"] = f"LIGHT_{opposite_light}_YELLOW"
                lights = [0, 0]
                lights[opposite_light] = 2
                self.state["lights"] = lights
                self.state["timer"] = {"for": "yellow", "value": settings["yellowTime"]}
                # Nu resetează flag-ul - va reveni la green line după ALL_RED
            elif phase == f"LIGHT_{opposite_light}_YELLOW":
                # După galben opus, trece la ALL_RED și apoi revine la green line
                print(f"[{self.config['id']}] CAR_CAR: LIGHT_{opposite_light}_YELLOW expirat -> ALL_RED (revenire green line)")
                self.state["phase"] = "ALL_RED"
                self.state["lights"] = [0, 0]
                self.state["timer"] = {"for": "all_red", "value": settings["allRedSafetyTime"]}
                # Nu setează flag-ul - înseamnă că revenim la green line
                self.state["_fromOppositeDetection"] = False  # Asigură că revenim la green line
                # Șterge timestamp-ul pentru verde opus
                if "_oppositeGreenStartTime" in self.state:
                    del self.state["_oppositeGreenStartTime"]
            else:
                # EDGE CASE 36: Faza necunoscută pentru car_car - reinițializează la green line
                print(f"⚠ Avertisment: Faza necunoscută '{phase}' pentru {self.config['id']}. Reinițializare la green line.")
                self.state["phase"] = f"LIGHT_{green_line_light}_GREEN"
                lights = [0, 0]
                lights[green_line_light] = 1
                self.state["lights"] = lights
                self.state["timer"] = {"for": f"light_{green_line_light}", "value": 999}
                self.state["_fromOppositeDetection"] = False
            
            self.state["lastUpdate"] = current_time
            # EDGE CASE 37: Resetează last_tick după tranziție
            self.last_tick = current_time

# --- Funcția de procesare video cu detecție de zone ---

def video_processing_loop(model, class_map, intersections_config):
    """Buclează, citește cadrele camerelor, rulează detecția YOLO și actualizează starea globală."""
    global global_frame, detection_data, last_print_time, intersections_cameras
    
    print("\n--- Firul de execuție pentru detecție video a început. ---")
    
    # Inițializează camerele pentru fiecare intersecție
    cameras = {}
    for intersection in intersections_config["intersections"]:
        intersection_id = intersection["id"]
        camera_index = intersection.get("cameraIndex", 0)
        try:
            cap = cv2.VideoCapture(camera_index)
            if cap.isOpened():
                cameras[intersection_id] = cap
                print(f"✓ Camera {camera_index} deschisă pentru {intersection['name']}")
            else:
                print(f"⚠ Eroare: Nu s-a putut deschide camera {camera_index} pentru {intersection['name']}")
        except Exception as e:
            print(f"⚠ Eroare la deschiderea camerei {camera_index} pentru {intersection['name']}: {e}")
    
    if not cameras:
        print("✗ Eroare: Nu s-au putut deschide camere pentru nicio intersecție!")
        return
    
    with lock:
        intersections_cameras.update(cameras)
    
    # Folosește prima cameră disponibilă pentru global_frame (pentru video feed)
    primary_camera_id = list(cameras.keys())[0] if cameras else None
    primary_cap = cameras[primary_camera_id] if primary_camera_id else None

    while True:
        try:
            # Procesează fiecare cameră pentru intersecția corespunzătoare
            new_detection_data = {}
            combined_frame = None
            
            for intersection in intersections_config["intersections"]:
                intersection_id = intersection["id"]
                camera_index = intersection.get("cameraIndex", 0)
                
                # Inițializează detecțiile pentru această intersecție
                # Pentru car_car, inițializează zonele pentru fiecare light și zonă personalizată
                zones_dict = {}
                if intersection.get("type") == "car_car":
                    # Inițializează zonele pentru fiecare light și zonă personalizată
                    for light_config in intersection.get("lights", []):
                        light_id = light_config.get("id")
                        custom_zones = light_config.get("customZones", [])
                        if custom_zones:
                            # Dacă există zone personalizate, inițializează-le
                            for zone_idx in range(len(custom_zones)):
                                zone_key = f"light_{light_id}_zone_{zone_idx}"
                                zones_dict[zone_key] = False
                        else:
                            # Dacă nu există zone personalizate, folosește fallback la quadrants
                            # Inițializează zonele pentru quadrants (0-3)
                            for zone_idx in range(4):
                                zone_key = str(zone_idx)
                                if zone_key not in zones_dict:
                                    zones_dict[zone_key] = False
                else:
                    # Pentru car_pedestrian, folosește quadrants vechi
                    zones_dict = {"0": False, "1": False, "2": False, "3": False}
                
                new_detection_data[intersection_id] = {
                    "humans": False,
                    "wheels": False,
                    "zones": zones_dict
                }
                
                # Citește frame-ul de la camera corespunzătoare
                if intersection_id in cameras:
                    cap = cameras[intersection_id]
                    ret, frame = cap.read()
                    
                    if not ret:
                        continue
                    
                    # Folosește primul frame disponibil pentru global_frame
                    if combined_frame is None:
                        combined_frame = frame.copy()
                    
                    frame_height, frame_width = frame.shape[:2]
                    center_x = frame_width // 2
                    center_y = frame_height // 2
                    
                    # Desenează linii pentru zone (debug)
                    cv2.line(frame, (center_x, 0), (center_x, frame_height), (128, 128, 128), 1)
                    cv2.line(frame, (0, center_y), (frame_width, center_y), (128, 128, 128), 1)
                    
                    # --- Rulare Detecție pentru această cameră ---
                    results = model.predict(frame, stream=True, verbose=False)
                    
                    # Procesează rezultatele pentru această intersecție
                    for r in results:
                        boxes = r.boxes
                        
                        for box in boxes:
                            class_id = int(box.cls[0])
                            
                            if class_id in class_map:
                                category = class_map[class_id]
                                x1, y1, x2, y2 = map(int, box.xyxy[0])
                                center_box_x = (x1 + x2) // 2
                                center_box_y = (y1 + y2) // 2
                                
                                # Pentru car_car intersections, verifică dacă obiectul este în zonele personalizate
                                intersection_config = None
                                for inter in intersections_config["intersections"]:
                                    if inter["id"] == intersection_id:
                                        intersection_config = inter
                                        break
                                
                                # Actualizează detecțiile pentru această intersecție
                                if category == "humans":
                                    new_detection_data[intersection_id]["humans"] = True
                                elif category == "wheels":
                                    new_detection_data[intersection_id]["wheels"] = True
                                    
                                    # Pentru car_car, verifică zonele personalizate
                                    if intersection_config and intersection_config.get("type") == "car_car":
                                        # Verifică pentru fiecare light dacă obiectul intersectează zonele sale
                                        for light_config in intersection_config.get("lights", []):
                                            light_id = light_config.get("id")
                                            custom_zones = light_config.get("customZones", [])  # Lista de zone personalizate
                                            
                                            # Verifică dacă bounding box-ul obiectului intersectează oricare dintre zonele personalizate
                                            # Zonele sunt salvate în coordonate canvas (640x480), trebuie să le scalăm la dimensiunile reale ale frame-ului
                                            canvas_width = 640  # Dimensiunea canvas-ului în frontend
                                            canvas_height = 480
                                            
                                            for zone_idx, zone in enumerate(custom_zones):
                                                if isinstance(zone, dict) and "x" in zone and "y" in zone and "width" in zone and "height" in zone:
                                                    # Scalează coordonatele zonei de la canvas (640x480) la dimensiunile reale ale frame-ului
                                                    scale_x = frame_width / canvas_width
                                                    scale_y = frame_height / canvas_height
                                                    
                                                    zone_x = int(zone["x"] * scale_x)
                                                    zone_y = int(zone["y"] * scale_y)
                                                    zone_width = int(zone["width"] * scale_x)
                                                    zone_height = int(zone["height"] * scale_y)
                                                    
                                                    # Verifică intersecția bounding box-ului obiectului cu zona
                                                    # Obiectul este detectat dacă există orice suprapunere
                                                    zone_right = zone_x + zone_width
                                                    zone_bottom = zone_y + zone_height
                                                    
                                                    # Verifică dacă există intersecție între bounding box-ul obiectului și zona
                                                    if not (x2 < zone_x or x1 > zone_right or y2 < zone_y or y1 > zone_bottom):
                                                        # Există intersecție - obiectul este în zonă
                                                        zone_key = f"light_{light_id}_zone_{zone_idx}"
                                                        new_detection_data[intersection_id]["zones"][zone_key] = True
                                                        # Debug logging (doar ocazional pentru a nu încărca log-ul)
                                                        if time.time() % 2 < 0.1:  # Log doar aproximativ o dată la 2 secunde
                                                            print(f"[{intersection_id}] Detecție în {zone_key}: obiect ({x1},{y1})-({x2},{y2}) intersectează zona ({zone_x},{zone_y})-({zone_right},{zone_bottom})")
                                    else:
                                        # Pentru car_pedestrian sau alte tipuri, folosește logica veche cu quadrants
                                        zone = None
                                        if center_box_x < center_x:
                                            if center_box_y < center_y:
                                                zone = 0  # top-left
                                            else:
                                                zone = 2  # bottom-left
                                        else:
                                            if center_box_y < center_y:
                                                zone = 1  # top-right
                                            else:
                                                zone = 3  # bottom-right
                                        new_detection_data[intersection_id]["zones"][str(zone)] = True
                                
                                # Vizualizare
                                if category == "humans":
                                    color = (0, 255, 0)
                                    label_text = "HUMANS"
                                else:
                                    color = (0, 0, 255)
                                    label_text = f"WHEELS-Z{zone}"
                                
                                cv2.rectangle(frame, (x1, y1), (x2, y2), color, 2)
                                confidence = float(box.conf[0])
                                label = f"{label_text}: {confidence:.2f}"
                                cv2.putText(frame, label, (x1, y1 - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
                    
                    # Actualizează frame-ul pentru această intersecție
                    intersections_frames[intersection_id] = frame.copy()
                    
                    # Actualizează global_frame cu primul frame disponibil (pentru backward compatibility)
                    if combined_frame is None:
                        combined_frame = frame.copy()

            # Actualizează detecțiile globale
            with lock:
                if combined_frame is not None:
                    global_frame = combined_frame
                detection_data = new_detection_data
                
                # Actualizează state machine-urile
                state_machines_items = list(intersections_state.items())
                for intersection_id, state_machine in state_machines_items:
                    try:
                        if intersection_id in new_detection_data:
                            # Obține dimensiunile frame-ului pentru această intersecție
                            if intersection_id in cameras:
                                cap = cameras[intersection_id]
                                frame_width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                                frame_height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                            else:
                                frame_width, frame_height = 640, 480
                            # Pass the detection data for this specific intersection
                            intersection_detection = new_detection_data[intersection_id]
                            state_machine.update_from_detection(intersection_detection, frame_width, frame_height)
                    except Exception as e:
                        print(f"⚠ Eroare la update_from_detection pentru {intersection_id}: {e}")
                        import traceback
                        traceback.print_exc()
            
            # Logare
            time_now = time.time()
            should_print = (time_now - last_print_time) > PRINT_COOLDOWN
            if should_print:
                for intersection_id, detection in new_detection_data.items():
                    if detection["humans"] or detection["wheels"]:
                        status = []
                        if detection["humans"]:
                            status.append("HUMANS")
                        if detection["wheels"]:
                            zones = [z for z, v in detection["zones"].items() if v]
                            status.append(f"WHEELS-Z{','.join(zones)}")
                        print(f"Detecție [{intersection_id}]: {' '.join(status)}")
                        last_print_time = time_now
            
            time.sleep(0.033)  # ~30 FPS
            
        except Exception as e:
            print(f"⚠ Eroare în video_processing_loop: {e}")
            import traceback
            traceback.print_exc()
            time.sleep(1)

# --- Thread pentru state machine ticks ---

def state_machine_tick_loop():
    """Loop pentru actualizarea state machine-urilor."""
    while True:
        time.sleep(1)  # Tick la fiecare secundă
        try:
            with lock:
                # EDGE CASE 38: Iterează peste o copie a listei pentru a evita erori dacă se modifică în timpul iterației
                state_machines = list(intersections_state.values())
                for state_machine in state_machines:
                    try:
                        state_machine.tick()
                    except Exception as e:
                        # EDGE CASE 39: Previne căderea întregului sistem dacă o intersecție are o eroare
                        print(f"⚠ Eroare la tick pentru {state_machine.config.get('id', 'unknown')}: {e}")
                        import traceback
                        traceback.print_exc()
        except Exception as e:
            # EDGE CASE 40: Previne căderea thread-ului de tick
            print(f"⚠ Eroare în state_machine_tick_loop: {e}")
            import traceback
            traceback.print_exc()
            time.sleep(1)  # Așteaptă înainte de a reîncerca

# --- Funcție Generator pentru Streaming Video ---

def generate_frames(intersection_id=None):
    """Generează cadre JPEG pentru fluxul video Motion JPEG.
    Dacă intersection_id este specificat, returnează feed-ul pentru acea intersecție.
    Altfel, returnează global_frame (backward compatibility).
    """
    global global_frame, intersections_frames
    while True:
        time.sleep(0.05)
        
        with lock:
            frame_to_use = None
            if intersection_id and intersection_id in intersections_frames:
                frame_to_use = intersections_frames[intersection_id]
            elif global_frame is not None:
                frame_to_use = global_frame
            
            if frame_to_use is None:
                continue
            
            (flag, encodedImage) = cv2.imencode(".jpg", frame_to_use)
            if not flag:
                continue
            
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + bytearray(encodedImage) + b'\r\n')

# --- Endpoint-uri Flask ---

@app.route("/")
def index():
    """Pagina principală."""
    return Response("""
        <html>
        <head>
            <title>YOLOv8 Trafic Detector Web</title>
            <style>
                body { font-family: sans-serif; text-align: center; margin: 20px; background-color: #f4f4f9; }
                h1 { color: #333; }
                .container { display: flex; flex-direction: column; align-items: center; }
                #video-stream { border: 5px solid #4a90e2; border-radius: 8px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1); max-width: 90%; height: auto; }
                .info-box { background-color: #e9e9f1; padding: 15px; border-radius: 8px; margin-top: 20px; text-align: left; max-width: 500px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Detector de Trafic YOLOv8</h1>
                <p>Fluxul video cu detecții în timp real:</p>
                <img id="video-stream" src="/video_feed" alt="Flux Video Detector">
            </div>
        </body>
        </html>
    """, mimetype='text/html')

@app.route("/video_feed")
def video_feed():
    """Endpoint pentru streaming video Motion JPEG.
    Acceptă query parameter 'intersection_id' pentru a returna feed-ul unei intersecții specifice.
    Dacă nu este specificat, returnează global_frame (backward compatibility).
    """
    intersection_id = request.args.get('intersection_id', None)
    return Response(generate_frames(intersection_id=intersection_id), 
                    mimetype='multipart/x-mixed-replace; boundary=frame')

@app.route("/detect")
def detect_status():
    """Endpoint API care returnează starea detecției curente (legacy, pentru compatibilitate)."""
    with lock:
        # Returnează detecția pentru prima intersecție (legacy)
        if detection_data:
            first_id = list(detection_data.keys())[0]
            detection = detection_data[first_id]
            if detection["humans"]:
                return jsonify({"status": "humans"})
            elif detection["wheels"]:
                return jsonify({"status": "wheels"})
        return jsonify({"status": "none"})

@app.route("/intersections", methods=['GET'])
def get_intersections():
    """Returnează toate intersecțiile cu setările și starea curentă."""
    with lock:
        intersections_config = load_intersections()
        result = []
        
        for intersection in intersections_config["intersections"]:
            intersection_id = intersection["id"]
            state_machine = intersections_state.get(intersection_id)
            
            if state_machine:
                intersection_data = {
                    "id": intersection_id,
                    "name": intersection["name"],
                    "type": intersection["type"],
                    "cameraIndex": intersection.get("cameraIndex", 0),
                    "lights": intersection["lights"],
                    "settings": intersection["settings"],
                    "state": state_machine.state.copy()
                }
            else:
                intersection_data = {
                    "id": intersection_id,
                    "name": intersection["name"],
                    "type": intersection["type"],
                    "cameraIndex": intersection.get("cameraIndex", 0),
                    "lights": intersection["lights"],
                    "settings": intersection["settings"],
                    "state": intersection["state"]
                }
            
            result.append(intersection_data)
        
        return jsonify({"intersections": result})

@app.route("/intersections", methods=['POST'])
def update_intersections():
    """Actualizează setările unei intersecții."""
    data = request.json
    
    if not data or "id" not in data:
        return jsonify({"error": "ID-ul intersecției este necesar"}), 400
    
    intersection_id = data["id"]
    
    with lock:
        intersections_config = load_intersections()
        
        # Găsește intersecția
        intersection = None
        for i in intersections_config["intersections"]:
            if i["id"] == intersection_id:
                intersection = i
                break
        
        if not intersection:
            return jsonify({"error": f"Intersecția {intersection_id} nu a fost găsită"}), 404
        
        # Actualizează setările
        if "settings" in data:
            new_settings = data["settings"]
            # Păstrează modul curent dacă nu este specificat explicit în request
            # (pentru a nu reseta modul când se schimbă doar greenLinePreference sau alte setări)
            if "mode" not in new_settings:
                # Nu schimbă modul dacă nu este specificat
                pass
            else:
                # Dacă modul este specificat, actualizează-l
                intersection["settings"]["mode"] = new_settings["mode"]
            
            # Actualizează celelalte setări
            for key in ["greenLinePreference", "carGreenTime", "pedGreenTime", "yellowTime", "allRedSafetyTime"]:
                if key in new_settings:
                    intersection["settings"][key] = new_settings[key]
        
        # Actualizează lights (pentru car_car - zone configuration)
        if "lights" in data:
            new_lights = data["lights"]
            if isinstance(new_lights, list) and len(new_lights) == len(intersection["lights"]):
                # Actualizează zonele pentru fiecare light
                for i, new_light in enumerate(new_lights):
                    if i < len(intersection["lights"]):
                        # Actualizează zonele personalizate (customZones)
                        if "customZones" in new_light:
                            intersection["lights"][i]["customZones"] = new_light["customZones"]
                        # Păstrează backward compatibility cu zones vechi
                        if "zones" in new_light:
                            intersection["lights"][i]["zones"] = new_light["zones"]
                        if "name" in new_light:
                            intersection["lights"][i]["name"] = new_light["name"]
        
        # Actualizează cameraIndex
        if "cameraIndex" in data:
            new_camera_index = data["cameraIndex"]
            if isinstance(new_camera_index, int) and new_camera_index >= 0:
                intersection["cameraIndex"] = new_camera_index
                # Reinițializează camera pentru această intersecție
                if intersection_id in intersections_cameras:
                    old_cap = intersections_cameras[intersection_id]
                    if old_cap.isOpened():
                        old_cap.release()
                    del intersections_cameras[intersection_id]
                
                # Deschide noua cameră
                try:
                    new_cap = cv2.VideoCapture(new_camera_index)
                    if new_cap.isOpened():
                        intersections_cameras[intersection_id] = new_cap
                        print(f"✓ Camera {new_camera_index} reinițializată pentru {intersection['name']}")
                    else:
                        print(f"⚠ Eroare: Nu s-a putut deschide camera {new_camera_index} pentru {intersection['name']}")
                except Exception as e:
                    print(f"⚠ Eroare la reinițializarea camerei {new_camera_index} pentru {intersection['name']}: {e}")
        
        # Salvează
        if save_intersections(intersections_config):
            # Actualizează state machine dacă există
            if intersection_id in intersections_state:
                state_machine = intersections_state[intersection_id]
                # Actualizează config-ul state machine-ului cu noile setări
                state_machine.config = intersection
                # Dacă s-a schimbat modul, aplică-l
                if "settings" in data and "mode" in data["settings"]:
                    new_mode = data["settings"]["mode"]
                    if new_mode != state_machine.config["settings"]["mode"]:
                        state_machine.set_mode(new_mode)
                # Dacă s-a schimbat greenLinePreference, reinițializează timer-ul corect
                if "settings" in data and "greenLinePreference" in data["settings"]:
                    # Reinițializează timer-ul bazat pe green line preference
                    phase = state_machine.state["phase"]
                    green_line = intersection["settings"].get("greenLinePreference", "Car")
                    if phase == "CAR_GREEN":
                        state_machine.state["timer"] = {"for": "car", "value": 999 if green_line == "Car" else intersection["settings"]["carGreenTime"]}
                    elif phase == "PED_GREEN":
                        state_machine.state["timer"] = {"for": "ped", "value": 999 if green_line == "Pedestrian" else intersection["settings"]["pedGreenTime"]}
            
            return jsonify({"success": True, "intersection": intersection})
        else:
            return jsonify({"error": "Eroare la salvarea setărilor"}), 500

@app.route("/traffic_lights")
def traffic_lights():
    """Endpoint API care returnează starea semafoarelor pentru toate intersecțiile."""
    with lock:
        intersections_config = load_intersections()
        result = []
        
        for intersection in intersections_config["intersections"]:
            intersection_id = intersection["id"]
            state_machine = intersections_state.get(intersection_id)
            
            if state_machine:
                lights = state_machine.state["lights"]
            else:
                lights = intersection["state"]["lights"]
            
            result.append({
                "name": intersection["name"],
                "lights": lights
            })
        
        return jsonify(result)

@app.route("/cameras", methods=['GET'])
def get_available_cameras():
    """Returnează lista camerelor disponibile."""
    available_cameras = []
    max_cameras_to_check = 10  # Verifică până la 10 camere
    
    for i in range(max_cameras_to_check):
        cap = cv2.VideoCapture(i)
        if cap.isOpened():
            # Încearcă să citească un frame pentru a verifica dacă camera funcționează
            ret, _ = cap.read()
            if ret:
                available_cameras.append({
                    "index": i,
                    "name": f"Camera {i}"
                })
        cap.release()
    
    return jsonify({
        "cameras": available_cameras
    })

@app.route("/intersections/<intersection_id>/control", methods=['POST'])
def control_intersection(intersection_id):
    """Endpoint pentru controlul unei intersecții (mode, override, simulate)."""
    data = request.json
    
    if not data or "action" not in data:
        return jsonify({"error": "Acțiunea este necesară"}), 400
    
    action = data["action"]
    
    with lock:
        if intersection_id not in intersections_state:
            return jsonify({"error": f"Intersecția {intersection_id} nu a fost găsită"}), 404
        
        state_machine = intersections_state[intersection_id]
        
        if action == "set_mode":
            mode = data.get("mode")
            if mode not in ["Automatic", "Manual", "Override"]:
                return jsonify({"error": "Mod invalid"}), 400
            state_machine.set_mode(mode)
            
        elif action == "override":
            light = data.get("light")  # "car" sau "ped"
            state = data.get("state")  # "red", "green", "yellow"
            
            if light not in ["car", "ped"]:
                return jsonify({"error": "Lumină invalidă"}), 400
            if state not in ["red", "green", "yellow"]:
                return jsonify({"error": "Stare invalidă"}), 400
            
            # Convert to backend format
            light_index = 0 if light == "car" else 1
            light_value = 0 if state == "red" else (1 if state == "green" else 2)
            
            # Verifică dacă încercăm să setăm galben la semafor de pietoni
            if state_machine.config["type"] == "car_pedestrian":
                light_config = state_machine.config["lights"][light_index]
                if light_config.get("type") == "pedestrian" and state == "yellow":
                    return jsonify({"error": "Semafoarele de pietoni nu au lumina galbenă. Folosește doar roșu sau verde."}), 400
            
            state_machine.set_override(light_index, light_value)
            
        elif action == "simulate":
            detection_type = data.get("type")  # "car", "ped", "none"
            light_index = data.get("lightIndex")  # Pentru car_car: 0 sau 1
            if detection_type not in ["car", "ped", "none"]:
                return jsonify({"error": "Tip detecție invalid"}), 400
            state_machine.simulate_detection(detection_type, light_index)
            
        else:
            return jsonify({"error": f"Acțiune necunoscută: {action}"}), 400
        
        # Salvează configurația
        intersections_config = load_intersections()
        for intersection in intersections_config["intersections"]:
            if intersection["id"] == intersection_id:
                intersection["settings"]["mode"] = state_machine.config["settings"]["mode"]
                intersection["state"] = state_machine.state.copy()
                break
        
        save_intersections(intersections_config)
        
        return jsonify({
            "success": True,
            "intersection": {
                "id": intersection_id,
                "state": state_machine.state,
                "settings": state_machine.config["settings"]
            }
        })

# --- Funcția Principală de Rulare ---

if __name__ == "__main__":
    # 1. Încărcare Model YOLO
    print(f"Încărcare model YOLO: {MODEL_NAME}...")
    
    if os.path.exists(MODEL_NAME):
        print(f"✓ Fișierul modelului găsit local: {MODEL_NAME}")
    else:
        print(f"⚠ Fișierul modelului nu există local. Ultralytics va încerca să-l descarce automat...")
        print("  Aceasta poate dura câteva minute la prima rulare.")
    
    try:
        print("  Inițializare YOLO...")
        model = YOLO(MODEL_NAME)
        print(f"✓ Model YOLO încărcat cu succes!")
    except Exception as e:
        print(f"✗ Eroare la încărcarea modelului: {e}")
        import traceback
        traceback.print_exc()
        exit(1)

    # 2. Încărcare intersecții
    print("\n--- Încărcare configurație intersecții ---")
    intersections_config = load_intersections()
    print(f"✓ {len(intersections_config['intersections'])} intersecții încărcate")
    
    # Inițializează state machine-uri
    for intersection in intersections_config["intersections"]:
        intersections_state[intersection["id"]] = IntersectionStateMachine(intersection)
        print(f"  - {intersection['name']} ({intersection['type']})")

    # 3. Pornire Fire de Execuție
    print("\nPornire fire de execuție...")
    
    # Thread pentru detecție video (camerele vor fi inițializate în video_processing_loop)
    t_video = threading.Thread(target=video_processing_loop, args=(model, CLASS_MAP, intersections_config))
    t_video.daemon = True 
    t_video.start()
    print("✓ Thread detecție video pornit!")
    
    # Thread pentru state machine ticks
    t_state = threading.Thread(target=state_machine_tick_loop)
    t_state.daemon = True
    t_state.start()
    print("✓ Thread state machine pornit!")
    
    # 5. Pornire Server Flask
    print(f"\nServerul Flask pornește pe http://0.0.0.0:8000/")
    print("  Endpoint-uri disponibile:")
    print("    - http://localhost:8000/ (pagina principală)")
    print("    - http://localhost:8000/video_feed (stream video)")
    print("    - http://localhost:8000/detect (status detecție - legacy)")
    print("    - http://localhost:8000/traffic_lights (culori semafoare)")
    print("    - http://localhost:8000/intersections (GET: fetch, POST: update)")
    print("\n  Apasă Ctrl+C pentru a opri serverul.\n")
    
    try:
        app.run(host='0.0.0.0', port=8000, debug=False, use_reloader=False)
    except KeyboardInterrupt:
        print("\n\n--- Server oprit de utilizator ---")
    except Exception as e:
        print(f"\n✗ Eroare la pornirea serverului: {e}")
        import traceback
        traceback.print_exc()
    finally:
        print("\n--- Curățenie resurse ---")
        with lock:
            for intersection_id, cap in intersections_cameras.items():
                if cap.isOpened():
                    cap.release()
                    print(f"✓ Camera închisă pentru {intersection_id}")
        print("✓ Aplicația a fost închisă.")
