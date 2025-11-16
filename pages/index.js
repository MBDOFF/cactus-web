import React, { useState, useEffect, useMemo, useCallback, createContext, useContext, useReducer } from 'react';

import { 
  Camera, Zap, TrendingUp, Shield, Map, LayoutDashboard, Settings, 
  Truck, Car, PersonStanding, Hand, Cog, Timer, AlertCircle, RefreshCcw, Cpu, 
  Video, X, BarChart3, Activity, MapPin, Users, Clock, Gauge, 
  Eye, Database, TrendingDown, AlertTriangle, CheckCircle2, Maximize2, Minimize2
} from 'lucide-react';

// --- Global Data and Utilities ---

const pages = [
  { name: 'Acasă', path: 'landing', icon: Map },
  { name: 'Control', path: 'control', icon: Cog },
  { name: 'Setări', path: 'settings', icon: Settings },
];

const SINGLE_INTERSECTION_ID = "in-door-traffic-hub-001";
const DEFAULT_SETTINGS = {
  id: SINGLE_INTERSECTION_ID,
  name: "City Center Hub 001",
  yoloSensitivity: 80,
  carGreenTime: 15,
  pedGreenTime: 10,
  yellowTime: 3,
  allRedSafetyTime: 2,
  greenLinePreference: 'Car',
};

// --- Application Context ---
const AppContext = createContext();

// --- Local Storage Hook for Persistence ---
function usePersistentState(key, defaultValue) {
  const [state, setState] = useState(() => {
    // Check if we're in the browser environment
    if (typeof window === 'undefined') {
      return defaultValue;
    }
    try {
      const persistentValue = localStorage.getItem(key);
      return persistentValue ? JSON.parse(persistentValue) : defaultValue;
    } catch (error) {
      console.error("Eroare la citirea din localStorage", error);
      return defaultValue;
    }
  });

  useEffect(() => {
    // Check if we're in the browser environment
    if (typeof window === 'undefined') {
      return;
    }
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch (error) {
      console.error("Eroare la scrierea in localStorage", error);
    }
  }, [key, state]);

  return [state, setState];
}

// --- State Definitions and Reducer Helpers (FSM Core Logic) ---

const AutoPhase = {
  CAR_GREEN: 'CAR_GREEN',
  CAR_YELLOW: 'CAR_YELLOW',
  ALL_RED_1: 'ALL_RED_1',
  PED_GREEN: 'PED_GREEN',
  PED_RED_STOP: 'PED_RED_STOP',
  ALL_RED_2: 'ALL_RED_2',
};

const createInitialState = (settings = DEFAULT_SETTINGS) => ({
  systemMode: 'Automatic',
  autoPhase: AutoPhase.CAR_GREEN, 
  carLight: 'red', // Default to red, will be updated from backend (legacy, pentru prima intersecție)
  pedLight: 'red', // Default to red, will be updated from backend (legacy, pentru prima intersecție)
  carDetected: false, 
  pedDetected: false, 
  timer: { for: 'car', value: 999 },
  previousSystemMode: 'Automatic',
  settings: settings, // Store settings in state
  // Intersections data from backend - format complet cu setări și state
  intersections: [],
  // Traffic stats
  trafficStats: {
    vehiclesPerHour: 0,
    pedestriansPerHour: 0,
    averageWaitTime: 0,
    congestionLevel: 'low',
    detectionAccuracy: 0,
  },
  // Historical data
  hourlyData: [],
});

function createTransition(mode, settings, phase, timerFor) {
    const duration = timerFor === 'yellow' ? settings.yellowTime : settings.allRedSafetyTime;
    
    // Setează luminile opuse corect
    let car, ped;
    
    switch(phase) {
        case AutoPhase.CAR_YELLOW:
            car = 'yellow';
            ped = 'red'; // Pietonii sunt roșu când mașinile sunt galben
            break;
        case AutoPhase.ALL_RED_1:
        case AutoPhase.ALL_RED_2:
            car = 'red';
            ped = 'red'; // Ambele roșu în faza de siguranță
            break;
        case AutoPhase.PED_RED_STOP:
            car = 'red'; // Mașinile sunt roșu când pietonii au "Don't Walk"
            ped = 'red';
            break;
        default:
            car = 'red';
            ped = 'red';
    }

    return {
        systemMode: mode,
        autoPhase: phase,
        carLight: car,
        pedLight: ped,
        timer: { for: timerFor, value: duration },
    };
}

function transitionAutomatic(state, settings) {
    const { autoPhase, timer, carDetected, pedDetected } = state;
    const isCarGreenLine = settings.greenLinePreference === 'Car';
    
    if (timer.value === 999) {
        const currentIsCarGreen = (autoPhase === AutoPhase.CAR_GREEN);
        const currentIsPedGreen = (autoPhase === AutoPhase.PED_GREEN);

        if (isCarGreenLine && currentIsCarGreen) {
            // Suntem pe linie verde mașini (timer infinit)
            // Verifică dacă s-a schimbat detecția
            if (pedDetected && !carDetected) {
                // Dacă există pietoni detectați și nu mai există vehicul, trece la verde pietoni
                return {
                    ...state,
                    ...createTransition('Automatic', settings, AutoPhase.CAR_YELLOW, 'yellow')
                };
            }
            // Dacă încă există vehicul detectat, rămâne pe verde mașini
            if (carDetected) {
                return state;
            }
            // Dacă nu există nicio detecție, rămâne pe verde mașini (stare inițială)
            return state;
        }

        if (!isCarGreenLine && currentIsPedGreen) {
            // Suntem pe linie verde pietoni (timer infinit)
            // Verifică dacă s-a detectat mașină
            if (carDetected) {
                // Ped e verde, dar s-a detectat mașină -> pietonii devin roșu, mașinile devin verde
                // Tranziție directă: Ped Green -> Car Green (cu All Red de siguranță)
                return {
                    ...state,
                    systemMode: 'Automatic',
                    autoPhase: AutoPhase.ALL_RED_1, // All Red de siguranță
                    pedLight: 'red', // Pietonii devin roșu
                    carLight: 'red', // Ambele roșu în All Red
                    timer: { for: 'all_red', value: settings.allRedSafetyTime },
                };
            }
            // Dacă încă există pietoni detectați, rămâne pe verde pietoni
            if (pedDetected) {
                return state;
            }
            // Dacă nu există nicio detecție, rămâne pe verde pietoni (stare inițială)
            return state;
        }
    }

    if (timer.value > 0) return state;

    if (isCarGreenLine) {
        switch (autoPhase) {
            case AutoPhase.CAR_YELLOW:
                return { ...state, ...createTransition('Automatic', settings, AutoPhase.ALL_RED_1, 'all_red') };
            case AutoPhase.ALL_RED_1:
                return {
                    ...state,
                    systemMode: 'Automatic',
                    autoPhase: AutoPhase.PED_GREEN,
                    carLight: 'red',
                    pedLight: 'green',
                    // Nu resetăm pedDetected aici - se va actualiza din API
                    timer: { for: 'ped', value: settings.pedGreenTime },
                };
            case AutoPhase.PED_GREEN:
                // Verifică dacă există detecție de vehicul - prioritate pentru mașini
                if (carDetected) {
                    // Dacă există vehicul detectat, trece la verde mașini
                    return {
                        ...state,
                        systemMode: 'Automatic',
                        autoPhase: AutoPhase.ALL_RED_2, // All Red de siguranță scurt
                        pedLight: 'red', // Pietonii devin roșu
                        carLight: 'red', // Ambele roșu în All Red
                        timer: { for: 'all_red', value: settings.allRedSafetyTime },
                    };
                }
                // Verifică dacă încă există detecție de pietoni
                if (pedDetected) {
                    // Dacă încă există pietoni detectați, menține verde și resetează timer-ul
                    return {
                        ...state,
                        systemMode: 'Automatic',
                        autoPhase: AutoPhase.PED_GREEN,
                        pedLight: 'green',
                        carLight: 'red',
                        timer: { for: 'ped', value: settings.pedGreenTime }, // Resetează timer-ul
                    };
                }
                // Dacă nu mai există pietoni detectați, continuă cu tranziția normală
                return {
                    ...state,
                    systemMode: 'Automatic',
                    autoPhase: AutoPhase.ALL_RED_2, // All Red de siguranță scurt
                    pedLight: 'red', // Pietonii devin roșu
                    carLight: 'red', // Ambele roșu în All Red
                    timer: { for: 'all_red', value: settings.allRedSafetyTime },
                };
            case AutoPhase.ALL_RED_2:
                // După All Red, verifică ce detecție există
                // Dacă există pietoni detectați, revenim la verde pietoni
                if (pedDetected && !carDetected) {
                    return {
                        ...state,
                        systemMode: 'Automatic',
                        autoPhase: AutoPhase.PED_GREEN,
                        carLight: 'red',
                        pedLight: 'green',
                        timer: { for: 'ped', value: settings.pedGreenTime },
                    };
                }
                // Dacă există vehicul detectat sau nu există nicio detecție, mașinile devin verde
                return {
                    ...state,
                    systemMode: 'Automatic',
                    autoPhase: AutoPhase.CAR_GREEN,
                    carLight: 'green', // Mașinile devin verde
                    pedLight: 'red', // Pietonii rămân roșu (OPUS)
                    // Nu resetăm carDetected - se va actualiza din API
                    timer: { for: 'car', value: 999 },
                };
            default: return state;
        }
    } else {
        switch (autoPhase) {
            case AutoPhase.ALL_RED_1:
                // După All Red (când s-a detectat mașină și ped era verde), mașinile devin verde
                return {
                    ...state,
                    systemMode: 'Automatic',
                    autoPhase: AutoPhase.CAR_GREEN,
                    carLight: 'green', // Mașinile devin verde
                    pedLight: 'red', // Pietonii rămân roșu (OPUS)
                    // Nu resetăm carDetected - se va actualiza din API
                    timer: { for: 'car', value: settings.carGreenTime },
                };
            case AutoPhase.CAR_GREEN:
                // Verifică dacă încă există detecție de vehicul
                if (carDetected) {
                    // Dacă încă există vehicul detectat, menține verde și resetează timer-ul
                    return {
                        ...state,
                        systemMode: 'Automatic',
                        autoPhase: AutoPhase.CAR_GREEN,
                        carLight: 'green',
                        pedLight: 'red',
                        timer: { for: 'car', value: settings.carGreenTime }, // Resetează timer-ul
                    };
                }
                // Dacă nu mai există vehicul detectat, verifică dacă există pietoni detectați
                // Dacă da, revenim la verde pietoni
                if (pedDetected) {
                    return {
                        ...state,
                        systemMode: 'Automatic',
                        autoPhase: AutoPhase.ALL_RED_2, // All Red de siguranță
                        pedLight: 'red',
                        carLight: 'red',
                        timer: { for: 'all_red', value: settings.allRedSafetyTime },
                    };
                }
                // Dacă nu mai există nici vehicul, nici pietoni detectați, continuă cu tranziția normală
                return { ...state, ...createTransition('Automatic', settings, AutoPhase.CAR_YELLOW, 'yellow') };
            case AutoPhase.CAR_YELLOW:
                return { ...state, ...createTransition('Automatic', settings, AutoPhase.ALL_RED_2, 'all_red') };
            case AutoPhase.ALL_RED_2:
                // După All Red, pietonii devin verde, mașinile rămân roșu
                 return {
                    ...state,
                    systemMode: 'Automatic',
                    autoPhase: AutoPhase.PED_GREEN,
                    carLight: 'red', // Mașinile rămân roșu (OPUS)
                    pedLight: 'green', // Pietonii devin verde
                    timer: { for: 'ped', value: 999 },
                };
            default: return state;
        }
    }
}

function setMode(mode, settings) {
    let newState = {
        ...createInitialState(settings),
        systemMode: mode,
    };

    if (mode === 'Manual') {
        newState.carLight = 'green';
        newState.pedLight = 'red';
        newState.autoPhase = AutoPhase.CAR_GREEN;
        newState.timer = { for: 'car', value: settings.carGreenTime };
    } else if (mode === 'Automatic') {
        const isCarGreenLine = settings.greenLinePreference === 'Car';
        newState.carLight = isCarGreenLine ? 'green' : 'red';
        newState.pedLight = isCarGreenLine ? 'red' : 'green';
        newState.autoPhase = isCarGreenLine ? AutoPhase.CAR_GREEN : AutoPhase.PED_GREEN;
        newState.timer = { for: isCarGreenLine ? 'car' : 'ped', value: 999 };
        newState.carDetected = false;
        newState.pedDetected = false;
    }
    return newState;
}

function trafficReducer(state, action) {
  // Get settings from action or state, fallback to DEFAULT_SETTINGS
  const settings = action.settings || state.settings || DEFAULT_SETTINGS;

  switch (action.type) {
    case 'TICK': {
      let { timer, systemMode } = state;

      if (timer.value > 0 && timer.value !== 999) {
        timer = { ...timer, value: timer.value - 1 };
        return { ...state, timer };
      }
      
      if (systemMode === 'Override' && timer.value === 0) {
        return { 
            ...state, 
            ...setMode(state.previousSystemMode, settings),
            previousSystemMode: state.previousSystemMode,
        };
      }
      
      if (systemMode === 'Manual' && timer.value === 0) {
        return transitionManual(state, settings);
      }
      
      if (systemMode === 'Automatic' && (timer.value === 0 || timer.value === 999)) {
        return transitionAutomatic(state, settings);
      }

      return state;
    }

    case 'SET_CAR_DETECTED':
      // Actualizează întotdeauna detecția de vehicul în state
      const newStateWithCar = { ...state, carDetected: true };
      
      // În modul Automatic, verifică dacă trebuie să declanșeze o tranziție imediată
      if (state.systemMode === 'Automatic') {
          // Dacă suntem pe PED_GREEN cu timer infinit, declanșează tranziția imediat
          if (state.autoPhase === AutoPhase.PED_GREEN && state.timer.value === 999) {
              return transitionAutomatic(newStateWithCar, settings);
          }
          // Dacă suntem pe PED_GREEN cu timer finit, detecția va fi procesată la următorul TICK
          // Dacă suntem pe CAR_GREEN, detecția va fi procesată la următorul TICK pentru a menține verde
      }
      
      return newStateWithCar;
      
    case 'SET_PED_DETECTED':
      // Actualizează întotdeauna detecția de pieton în state
      const newStateWithPed = { ...state, pedDetected: true };
      
      // În modul Automatic, verifică dacă trebuie să declanșeze o tranziție imediată
      if (state.systemMode === 'Automatic') {
          // Dacă suntem pe CAR_GREEN cu timer infinit, declanșează tranziția imediat
          if (state.autoPhase === AutoPhase.CAR_GREEN && state.timer.value === 999) {
              return transitionAutomatic(newStateWithPed, settings);
          }
          // Dacă suntem pe CAR_GREEN cu timer finit, detecția va fi procesată la următorul TICK
          // Dacă suntem pe PED_GREEN, detecția va fi procesată la următorul TICK pentru a menține verde
      }
      
      return newStateWithPed;
      
    case 'CLEAR_DETECTIONS':
        return { ...state, carDetected: false, pedDetected: false };
    
    case 'UPDATE_DETECTIONS_FROM_API':
        // Overwrite direct al detecțiilor din API - fără logica de tranziție imediată
        // Logica de tranziție va fi procesată la următorul TICK
        const { carDetected: newCarDetected, pedDetected: newPedDetected } = action.payload;
        const updatedState = { ...state, carDetected: newCarDetected, pedDetected: newPedDetected };
        
        // Dacă suntem în modul Automatic și pe timer infinit, verifică dacă trebuie tranziție imediată
        if (state.systemMode === 'Automatic' && state.timer.value === 999) {
            // Dacă s-a schimbat detecția și suntem pe fază opusă, declanșează tranziția
            if (newCarDetected && state.autoPhase === AutoPhase.PED_GREEN) {
                return transitionAutomatic(updatedState, settings);
            }
            if (newPedDetected && state.autoPhase === AutoPhase.CAR_GREEN) {
                return transitionAutomatic(updatedState, settings);
            }
        }
        
        return updatedState;
    
    case 'SET_MODE':
      const newMode = action.payload;
      const newState = setMode(newMode, settings);
      return { 
          ...newState,
          settings: settings, // Preserve settings in state
          previousSystemMode: newMode === 'Override' ? state.previousSystemMode : state.systemMode,
      };

    case 'OVERRIDE':
      return { ...state, ...setOverride(state, action.payload, settings), settings: settings };

    case 'UPDATE_STATS':
      return { ...state, trafficStats: action.payload };

    case 'UPDATE_SETTINGS_IN_STATE':
      return { ...state, settings: action.payload || settings };

    case 'UPDATE_LIGHTS_FROM_BACKEND':
      // Legacy - kept for compatibility
      const { intersections: legacyIntersections, carLight: legacyCarLight, pedLight: legacyPedLight } = action.payload;
      return {
        ...state,
        intersections: legacyIntersections || state.intersections,
        carLight: legacyCarLight || state.carLight,
        pedLight: legacyPedLight || state.pedLight,
      };

    case 'UPDATE_INTERSECTIONS_FROM_BACKEND':
      // Update intersections with full data from backend
      const { intersections: newIntersections, carLight: newCarLight, pedLight: newPedLight, timer: newTimer } = action.payload;
      return {
        ...state,
        intersections: newIntersections || state.intersections,
        carLight: newCarLight || state.carLight, // Legacy support
        pedLight: newPedLight || state.pedLight, // Legacy support
        timer: newTimer || state.timer, // Legacy support
      };

    default:
      return state;
  }
}

function setOverride(currentState, payload, settings) {
    const { light, state } = payload;
    let duration = 0;
    let newCarLight = currentState.carLight;
    let newPedLight = currentState.pedLight;
    const minDuration = 5; 

    if (light === 'car') {
        newCarLight = state;
        if (state === 'green') {
            newPedLight = 'red'; // Verde mașini = Roșu pietoni (OPUS)
            duration = settings.carGreenTime;
        } else if (state === 'yellow') {
            newPedLight = 'red'; // Galben mașini = Roșu pietoni (OPUS)
            duration = settings.yellowTime;
        } else if (state === 'red') {
            // Dacă mașinile devin roșu, pietonii devin verde (OPUS)
            newPedLight = 'green';
            duration = settings.pedGreenTime;
        }
    } else if (light === 'ped') {
        newPedLight = state;
        if (state === 'green') {
            newCarLight = 'red'; // Verde pietoni = Roșu mașini (OPUS)
            duration = settings.pedGreenTime;
        } else if (state === 'red') {
            // Dacă pietonii devin roșu, mașinile devin verde (OPUS)
            newCarLight = 'green';
            duration = settings.carGreenTime;
        }
    }
    
    if (duration < minDuration) duration = minDuration;

    return {
        ...currentState,
        systemMode: 'Override',
        previousSystemMode: currentState.systemMode, 
        carLight: newCarLight,
        pedLight: newPedLight,
        timer: { for: 'override_timer', value: duration },
    };
}

function transitionManual(state, settings) {
    const { autoPhase } = state;

    switch (autoPhase) {
        case AutoPhase.CAR_GREEN:
            return {
                ...state,
                ...createTransition('Manual', settings, AutoPhase.CAR_YELLOW, 'yellow')
            };
        case AutoPhase.CAR_YELLOW:
            return {
                ...state,
                ...createTransition('Manual', settings, AutoPhase.ALL_RED_1, 'all_red')
            };
        case AutoPhase.ALL_RED_1:
            return {
                ...state,
                systemMode: 'Manual',
                autoPhase: AutoPhase.PED_GREEN,
                carLight: 'red',
                pedLight: 'green',
                timer: { for: 'ped', value: settings.pedGreenTime },
            };
        case AutoPhase.PED_GREEN:
            // Când se termină verde la pietoni, All Red scurt, apoi mașinile devin verde
            return {
                ...state,
                systemMode: 'Manual',
                autoPhase: AutoPhase.ALL_RED_2,
                pedLight: 'red', // Pietonii devin roșu
                carLight: 'red', // Ambele roșu în All Red
                timer: { for: 'all_red', value: settings.allRedSafetyTime },
            };
        case AutoPhase.ALL_RED_2:
            // După All Red, mașinile devin verde, pietonii rămân roșu (OPUS)
            return {
                ...state,
                systemMode: 'Manual',
                autoPhase: AutoPhase.CAR_GREEN,
                carLight: 'green', // Mașinile devin verde
                pedLight: 'red', // Pietonii rămân roșu (OPUS)
                timer: { for: 'car', value: settings.carGreenTime },
            };
        default:
            return state;
    }
}

function useMockApi() {
  // Load settings from backend first, fallback to localStorage, then default
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  
  // Load settings from backend on mount
  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const loadSettingsFromBackend = async () => {
      try {
        const response = await fetch('http://localhost:8000/intersections', {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        });

        if (response.ok) {
          const data = await response.json();
          
          if (data.intersections && Array.isArray(data.intersections) && data.intersections.length > 0) {
            // Use first intersection settings
            const intersection = data.intersections[0];
            const backendSettings = intersection.settings || {};
            
            // Map backend settings to frontend format
            const frontendSettings = {
              id: intersection.id || DEFAULT_SETTINGS.id,
              name: intersection.name || DEFAULT_SETTINGS.name,
              yoloSensitivity: DEFAULT_SETTINGS.yoloSensitivity, // Not in backend yet
              carGreenTime: backendSettings.carGreenTime || DEFAULT_SETTINGS.carGreenTime,
              pedGreenTime: backendSettings.pedGreenTime || DEFAULT_SETTINGS.pedGreenTime,
              yellowTime: backendSettings.yellowTime || DEFAULT_SETTINGS.yellowTime,
              allRedSafetyTime: backendSettings.allRedSafetyTime || DEFAULT_SETTINGS.allRedSafetyTime,
              greenLinePreference: backendSettings.greenLinePreference || DEFAULT_SETTINGS.greenLinePreference,
            };
            
            setSettings(frontendSettings);
            setSettingsLoaded(true);
            
            // Also update localStorage as backup
            try {
              localStorage.setItem('smartTrafficSettings', JSON.stringify(frontendSettings));
            } catch (e) {
              console.warn('Could not save to localStorage:', e);
            }
            
            return;
          }
        }
      } catch (error) {
        console.warn('Could not load settings from backend, using localStorage fallback:', error);
      }
      
      // Fallback to localStorage
      try {
        const stored = localStorage.getItem('smartTrafficSettings');
        if (stored) {
          const parsed = JSON.parse(stored);
          setSettings(parsed);
          setSettingsLoaded(true);
          return;
        }
      } catch (e) {
        console.warn('Could not load from localStorage:', e);
      }
      
      // Final fallback to default
      setSettings(DEFAULT_SETTINGS);
      setSettingsLoaded(true);
    };

    loadSettingsFromBackend();
  }, []);
  
  const initializer = useCallback(() => {
    const initState = createInitialState(settings);
    return setMode(initState.systemMode, settings);
  }, [settings]);
  const [state, dispatch] = useReducer(trafficReducer, createInitialState(settings), initializer);

  useEffect(() => {
    // Update settings in state when they change
    dispatch({ type: 'UPDATE_SETTINGS_IN_STATE', payload: settings, settings });
    dispatch({ type: 'SET_MODE', payload: state.systemMode, settings });
  }, [settings.greenLinePreference, settings]); 

  useEffect(() => {
    const mainLoop = setInterval(() => {
      dispatch({ type: 'TICK', settings }); 
    }, 1000); 

    return () => clearInterval(mainLoop);
  }, [settings]); 

  // Simulate traffic stats updates
  useEffect(() => {
    const statsInterval = setInterval(() => {
      const newStats = {
        vehiclesPerHour: Math.floor(Math.random() * 200) + 50,
        pedestriansPerHour: Math.floor(Math.random() * 100) + 20,
        averageWaitTime: (Math.random() * 30 + 10).toFixed(1),
        congestionLevel: ['low', 'medium', 'high'][Math.floor(Math.random() * 3)],
        detectionAccuracy: Math.floor(Math.random() * 10) + 90,
      };
      dispatch({ type: 'UPDATE_STATS', payload: newStats });
    }, 5000);

    return () => clearInterval(statsInterval);
  }, []);

  // Poll intersections from backend
  useEffect(() => {
    // Check if we're in browser environment
    if (typeof window === 'undefined') {
      return;
    }

    let errorCount = 0;
    const MAX_ERRORS = 5;

    const intersectionsInterval = setInterval(async () => {
      // Create AbortController for timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

      try {
        const response = await fetch('http://localhost:8000/intersections', {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        
        // Reset error count on successful fetch
        errorCount = 0;
        
        // Backend returns: {"intersections": [{id, name, type, lights, settings, state}, ...]}
        if (data.intersections && Array.isArray(data.intersections) && data.intersections.length > 0) {
          // Convert backend state to frontend format
          const intersections = data.intersections.map(intersection => {
            const lights = intersection.state?.lights || intersection.lights || [0, 0];
            const timer = intersection.state?.timer || { for: 'car', value: 999 };
            
            // Convert light values to colors for first intersection (legacy support)
            let carLight = 'red';
            let pedLight = 'red';
            if (lights.length >= 2) {
              carLight = lights[0] === 1 ? 'green' : lights[0] === 2 ? 'yellow' : 'red';
              pedLight = lights[1] === 1 ? 'green' : lights[1] === 2 ? 'yellow' : 'red';
            }
            
            return {
              ...intersection,
              carLight, // Legacy support
              pedLight, // Legacy support
              timer // Include timer in intersection data
            };
          });
          
          // Use first intersection for legacy carLight/pedLight
          const firstIntersection = intersections[0];
          
          dispatch({ 
            type: 'UPDATE_INTERSECTIONS_FROM_BACKEND', 
            payload: { 
              intersections,
              carLight: firstIntersection.carLight,
              pedLight: firstIntersection.pedLight,
              timer: firstIntersection.timer
            }, 
            settings 
          });
        }
      } catch (error) {
        clearTimeout(timeoutId);
        errorCount++;
        
        // Only log errors occasionally to avoid console spam
        if (errorCount === 1 || errorCount % 10 === 0) {
          if (error.name === 'AbortError') {
            console.warn('Timeout la actualizarea intersecțiilor - serverul nu răspunde');
          } else if (error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError') || error.name === 'TypeError') {
            console.warn('Nu se poate conecta la serverul de intersecții (http://localhost:8000/intersections). Asigură-te că serverul rulează.');
          } else {
            console.error('Eroare la actualizarea intersecțiilor:', error.message || error);
          }
        }
      }
    }, 1000); // Poll every second

    return () => clearInterval(intersectionsInterval);
  }, [settings]);

  // Sync settings when intersections are loaded from backend
  useEffect(() => {
    if (!settingsLoaded || !state.intersections || state.intersections.length === 0) {
      return;
    }

    // Update settings from backend if they changed
    const firstIntersection = state.intersections[0];
    if (firstIntersection.settings) {
      const backendSettings = firstIntersection.settings;
      const currentSettings = settings;
      
      // Check if settings changed
      if (
        backendSettings.carGreenTime !== currentSettings.carGreenTime ||
        backendSettings.pedGreenTime !== currentSettings.pedGreenTime ||
        backendSettings.yellowTime !== currentSettings.yellowTime ||
        backendSettings.allRedSafetyTime !== currentSettings.allRedSafetyTime ||
        backendSettings.greenLinePreference !== currentSettings.greenLinePreference
      ) {
        const updatedSettings = {
          ...currentSettings,
          carGreenTime: backendSettings.carGreenTime || currentSettings.carGreenTime,
          pedGreenTime: backendSettings.pedGreenTime || currentSettings.pedGreenTime,
          yellowTime: backendSettings.yellowTime || currentSettings.yellowTime,
          allRedSafetyTime: backendSettings.allRedSafetyTime || currentSettings.allRedSafetyTime,
          greenLinePreference: backendSettings.greenLinePreference || currentSettings.greenLinePreference,
        };
        
        setSettings(updatedSettings);
        
        // Update localStorage as backup
        try {
          if (typeof window !== 'undefined') {
            localStorage.setItem('smartTrafficSettings', JSON.stringify(updatedSettings));
          }
        } catch (e) {
          console.warn('Could not save to localStorage:', e);
        }
      }
    }
  }, [state.intersections, settingsLoaded, settings]);

  const setApiSystemMode = (mode) => {
    dispatch({ type: 'SET_MODE', payload: mode, settings });
  };

  const setApiLightState = (light, state) => {
    dispatch({ type: 'OVERRIDE', payload: { light, state }, settings });
  };
  
  const setApiDetection = (type) => {
    if (state.systemMode === 'Automatic') {
        if (type === 'car') dispatch({ type: 'SET_CAR_DETECTED', settings });
        if (type === 'ped') dispatch({ type: 'SET_PED_DETECTED', settings });
    }
  };
  
  const clearApiDetections = () => {
    dispatch({ type: 'CLEAR_DETECTIONS' });
  };

  const updateApiSettings = async (newSettings) => {
    // Update local state
    setSettings(newSettings);
    
    // Also save to localStorage as backup
    try {
      if (typeof window !== 'undefined') {
        localStorage.setItem('smartTrafficSettings', JSON.stringify(newSettings));
      }
    } catch (e) {
      console.warn('Could not save to localStorage:', e);
    }
    
    // Try to sync with backend (but don't fail if backend is down)
    try {
      const intersectionId = newSettings.id || state.intersections?.[0]?.id || 'depou-001';
      // Get current mode from backend to preserve it
      const currentIntersection = state.intersections?.find(i => i.id === intersectionId);
      const currentMode = currentIntersection?.settings?.mode || "Automatic";
      
      const backendSettings = {
        mode: currentMode, // Preserve current mode, don't reset to Automatic
        greenLinePreference: newSettings.greenLinePreference || "Car",
        carGreenTime: newSettings.carGreenTime || 15,
        pedGreenTime: newSettings.pedGreenTime || 10,
        yellowTime: newSettings.yellowTime || 3,
        allRedSafetyTime: newSettings.allRedSafetyTime || 2
      };
      
      await updateIntersectionSettings(intersectionId, backendSettings);
    } catch (error) {
      // Silent fail - backend might be down, but we still want to update local state
      console.warn('Could not sync settings to backend:', error);
    }
  };

  const updateIntersectionSettings = async (intersectionId, newSettings) => {
    try {
      const response = await fetch('http://localhost:8000/intersections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          id: intersectionId,
          settings: newSettings
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Eroare la actualizarea setărilor intersecției:', error);
      throw error;
    }
  };

  const controlIntersection = async (intersectionId, action, payload = {}) => {
    try {
      const response = await fetch(`http://localhost:8000/intersections/${intersectionId}/control`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          action,
          ...payload
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Eroare la controlul intersecției:', error);
      throw error;
    }
  };

  return { 
    ...state,
    settings,
    api: { 
      setSystemMode: setApiSystemMode, 
      setLightState: setApiLightState, 
      updateSettings: updateApiSettings,
      updateIntersectionSettings: updateIntersectionSettings,
      controlIntersection: controlIntersection,
      setDetection: setApiDetection,
      clearDetections: clearApiDetections,
    } 
  };
}

// --- Component: Landing Page (Cactus Theme) ---

const SmartTrafficLanding = ({ navigate }) => {
  const [activeLight, setActiveLight] = useState(0);
  const [activeStat, setActiveStat] = useState(0);

  useEffect(() => {
    const lightInterval = setInterval(() => {
      setActiveLight((prev) => (prev + 1) % 3);
    }, 2500);
    return () => clearInterval(lightInterval);
  }, []);

  useEffect(() => {
    const statInterval = setInterval(() => {
      setActiveStat((prev) => (prev + 1) % 4);
    }, 3000);
    return () => clearInterval(statInterval);
  }, []);

  const stats = [
    { value: '40%', label: 'Less Traffic Jams', emoji: '🌵' },
    { value: '60%', label: 'Faster Flow', emoji: '⚡' },
    { value: '85%', label: 'Detection Rate', emoji: '🎯' },
    { value: '24/7', label: 'Always Sharp', emoji: '🌟' }
  ];

  const features = [
    {
      icon: Camera,
      title: 'Sharp Detection',
      description: 'Like a cactus, we never miss a thing! YOLO-powered AI spots every vehicle.',
      joke: 'No pricks, just picks! 🌵'
    },
    {
      icon: Zap,
      title: 'Lightning Fast',
      description: 'Traffic lights adapt faster than a cactus grows (which is saying something!).',
      joke: 'We stick to quick solutions! ⚡'
    },
    {
      icon: TrendingUp,
      title: 'Growth Analytics',
      description: 'Watch your traffic flow grow smoother, just like our team name suggests.',
      joke: 'Data that never wilts! 📊'
    },
    {
      icon: Shield,
      title: 'Tough & Reliable',
      description: 'Built desert-tough. Our system thrives in any condition.',
      joke: 'We handle the heat! 🔥'
    }
  ];

  return (
    <div className="min-h-screen bg-linear-to-br from-green-50 via-emerald-50 to-teal-50 overflow-hidden">
      <section className="relative z-10 px-6 pt-16 pb-24 text-center">
        <div className="max-w-6xl mx-auto">
          <h1 className="text-6xl md:text-7xl font-black mb-6 leading-tight text-gray-800">
            Traffic Lights
            <br />
            <span className="bg-linear-to-r from-green-500 via-emerald-500 to-teal-500 bg-clip-text text-transparent">
              Sharp as a Cactus
            </span>
          </h1>

          <p className="text-xl text-gray-700 mb-4 max-w-2xl mx-auto leading-relaxed font-medium">
            We're not your average traffic system – we're <span className="font-bold text-green-600">succulent smart!</span>
          </p>

          <div className="relative max-w-2xl mx-auto mb-12">
            <svg viewBox="0 0 400 500" className="w-full max-w-md mx-auto drop-shadow-2xl">
              <rect x="180" y="250" width="40" height="200" fill="#8B7355" rx="5"/>
              <rect x="150" y="80" width="100" height="180" fill="#2C3E50" rx="15"/>
              
              <circle cx="200" cy="120" r="25" fill={activeLight === 0 ? "#EF4444" : "#4B5563"} className="transition-colors duration-300"/>
              <circle cx="200" cy="180" r="25" fill={activeLight === 1 ? "#FBBF24" : "#4B5563"} className="transition-colors duration-300"/>
              <circle cx="200" cy="240" r="25" fill={activeLight === 2 ? "#10B981" : "#4B5563"} className="transition-colors duration-300"/>
              
              <ellipse cx="200" cy="370" rx="35" ry="80" fill="#22C55E"/>
              <ellipse cx="200" cy="360" rx="30" ry="70" fill="#16A34A"/>
              
              <ellipse cx="160" cy="340" rx="15" ry="40" fill="#22C55E" transform="rotate(-30 160 340)"/>
              <ellipse cx="240" cy="340" rx="15" ry="40" fill="#22C55E" transform="rotate(30 240 340)"/>
              
              <circle cx="190" cy="360" r="3" fill="#065F46"/>
              <circle cx="210" cy="360" r="3" fill="#065F46"/>
              <path d="M 190 375 Q 200 380 210 375" stroke="#065F46" strokeWidth="2" fill="none"/>
              
              <line x1="175" y1="340" x2="170" y2="335" stroke="#166534" strokeWidth="2"/>
              <line x1="180" y1="350" x2="175" y2="345" stroke="#166534" strokeWidth="2"/>
              <line x1="220" y1="350" x2="225" y2="345" stroke="#166534" strokeWidth="2"/>
              <line x1="225" y1="340" x2="230" y2="335" stroke="#166534" strokeWidth="2"/>
              
              <circle cx="200" cy="300" r="8" fill="#EC4899"/>
              <circle cx="193" cy="295" r="6" fill="#F472B6"/>
              <circle cx="207" cy="295" r="6" fill="#F472B6"/>
              <circle cx="200" cy="288" r="6" fill="#F472B6"/>
              <circle cx="200" cy="302" r="6" fill="#F472B6"/>
            </svg>
          </div>

          <div className="flex gap-4 justify-center mb-8">
            <button 
              onClick={() => navigate('dashboard')}
              className="px-8 py-4 bg-linear-to-r from-green-500 to-emerald-500 text-white rounded-full font-bold hover:shadow-2xl hover:shadow-green-500/50 transition-all duration-300 hover:scale-105 flex items-center gap-2"
            >
              <Zap className="w-5 h-5" />
              Go to Demo
            </button>
            <button className="px-8 py-4 bg-white border-2 border-green-500 text-green-700 rounded-full font-bold hover:bg-green-50 transition-all duration-300">
              Our team 🌵
            </button>
          </div>

          <p className="text-sm text-gray-500 italic">💡 Fun Fact: Cacti can survive without water for months. Our system works 24/7 without breaks!</p>
        </div>
      </section>

      <section className="relative z-10 px-6 py-16">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-center text-3xl font-bold text-gray-800 mb-4">
            We're Not <span className="text-green-600">Prickly</span> About Results! 📈
          </h2>
          <p className="text-center text-gray-600 mb-12">These numbers are sharper than our spines</p>
          
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {stats.map((stat, idx) => (
              <div 
                key={idx}
                className={`bg-white border-2 border-green-200 rounded-3xl p-6 text-center hover:scale-105 hover:shadow-xl hover:border-green-400 transition-all duration-300 ${activeStat === idx ? 'scale-105 border-green-400 shadow-xl' : ''}`}
              >
                <div className="text-5xl mb-2">{stat.emoji}</div>
                <div className="text-4xl font-black bg-linear-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent mb-2">
                  {stat.value}
                </div>
                <div className="text-gray-700 font-semibold text-sm">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative z-10 px-6 py-20 bg-white/50">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-black mb-4 text-gray-800">
              Why We're
              <span className="text-green-600"> Plant-astic! 🌵</span>
            </h2>
            <p className="text-gray-700 text-lg max-w-2xl mx-auto font-medium">
              Don't desert your city's traffic problems – let us handle them!
            </p>
          </div>

          <div className="grid md:grid-cols-2 gap-6">
            {features.map((feature, idx) => (
              <div
                key={idx}
                className="group bg-linear-to-br from-white to-green-50 border-2 border-green-200 rounded-3xl p-8 hover:border-green-400 hover:shadow-2xl transition-all duration-300"
              >
                <div className="w-16 h-16 bg-linear-to-br from-green-400 to-emerald-500 rounded-2xl flex items-center justify-center mb-6 group-hover:scale-110 group-hover:rotate-6 transition-all duration-300 shadow-lg">
                  <feature.icon className="w-8 h-8 text-white" />
                </div>
                <h3 className="text-2xl font-black mb-3 text-gray-800">{feature.title}</h3>
                <p className="text-gray-700 leading-relaxed mb-3">{feature.description}</p>
                <p className="text-green-600 font-bold italic">{feature.joke}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative z-10 px-6 py-20">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl md:text-5xl font-black mb-4 text-gray-800">
              It's Easy as <span className="text-green-600">1-2-Tree! 🌳</span>
            </h2>
            <p className="text-gray-700 text-lg">Well, 1-2-Cactus actually... 😄</p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            {[
              { step: '🌵', title: 'Spot It', desc: 'Our cameras catch every car like a cactus catches rainwater', bg: 'from-red-400 to-red-500' },
              { step: '🧠', title: 'Think It', desc: 'YOLO AI analyzes faster than you can say "succulent"', bg: 'from-yellow-400 to-yellow-500' },
              { step: '🚦', title: 'Fix It', desc: 'Lights adapt automatically – no manual watering needed!', bg: 'from-green-400 to-green-500' }
            ].map((item, idx) => (
              <div key={idx} className="relative">
                <div className="text-center bg-white border-2 border-green-200 rounded-3xl p-8 hover:shadow-xl transition-all duration-300">
                  <div className={`inline-flex items-center justify-center w-20 h-20 bg-linear-to-br ${item.bg} rounded-full mb-6 text-4xl shadow-lg`}>
                    {item.step}
                  </div>
                  <h3 className="text-2xl font-black mb-3 text-gray-800">{item.title}</h3>
                  <p className="text-gray-700">{item.desc}</p>
                </div>
                {idx < 2 && (
                  <div className="hidden md:block absolute top-12 -right-4 text-4xl">→</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="relative z-10 px-6 py-16 bg-linear-to-r from-green-100 to-emerald-100">
        <div className="max-w-4xl mx-auto text-center">
          <div className="text-6xl mb-4">🌵</div>
          <h3 className="text-3xl font-black text-gray-800 mb-4">
            Why did the cactus become a traffic controller?
          </h3>
          <p className="text-2xl text-green-700 font-bold">
            Because it was tired of people getting stuck in traffic! 😄
          </p>
          <p className="text-gray-600 mt-4 italic">
            (We're here all weekend, folks! Unlike traffic jams in your city... hopefully)
          </p>
        </div>
      </section>

      <section className="relative z-10 px-6 py-20">
        <div className="max-w-4xl mx-auto">
          <div className="bg-linear-to-br from-green-400 to-emerald-500 rounded-3xl p-12 text-center text-white shadow-2xl">
            <div className="text-6xl mb-6">🌵🚦✨</div>
            <h2 className="text-4xl md:text-5xl font-black mb-6">
              Ready to De-Desert
              <br />
              Your Traffic Problems?
            </h2>
            <p className="text-green-50 text-lg mb-8 max-w-2xl mx-auto font-medium">
              Join us and let's make your city's traffic flow smoother than a cactus smoothie! 
              (Yes, that's a thing... we think 🤔)
            </p>
            <button 
              onClick={() => navigate('dashboard')}
              className="px-10 py-4 bg-white text-green-600 rounded-full font-black text-lg hover:shadow-2xl transition-all duration-300 hover:scale-105"
            >
              Let's Stick Together! 🌵
            </button>
            <p className="text-green-100 text-sm mt-4">No desert required. WiFi preferred. 📶</p>
          </div>
        </div>
      </section>

      <footer className="relative z-10 px-6 py-12 bg-white border-t-2 border-green-200">
        <div className="max-w-6xl mx-auto">
          <div className="flex flex-col md:flex-row justify-between items-center gap-6">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-12 h-12 bg-linear-to-br from-green-400 to-emerald-500 rounded-xl flex items-center justify-center shadow-lg">
                  <span className="text-3xl">🌵</span>
                </div>
              </div>
              <div>
                <div className="font-black text-gray-800 text-lg">SmartTraffic</div>
                <div className="text-sm text-gray-600 font-semibold">by Cactus Team 🌵</div>
              </div>
            </div>
            <div className="text-center md:text-right">
              <div className="text-gray-700 font-semibold mb-1">
                © 2025 Cactus Team. Sharp minds, smooth traffic.
              </div>
              <div className="text-gray-500 text-sm italic">
                "We're not just smart, we're succu-smart!" 🌵✨
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

// --- Component: Car Traffic Light ---
const CarTrafficLight = ({ state }) => {
  return (
    <div className="bg-gray-100 p-3 rounded-xl border-2 border-gray-300 shadow-inner w-32 mx-auto">
      <div className={`w-full aspect-square rounded-full border border-gray-400 transition-all duration-300 mb-2 ${
        state === 'red' 
        ? 'bg-red-500 shadow-[0_0_15px_5px_rgba(239,68,68,0.7)]' 
        : 'bg-gray-300 opacity-30'
      }`}></div>
      <div className={`w-full aspect-square rounded-full border border-gray-400 transition-all duration-300 mb-2 ${
        state === 'yellow' 
        ? 'bg-yellow-400 shadow-[0_0_15px_5px_rgba(250,204,21,0.7)]' 
        : 'bg-gray-300 opacity-30'
      }`}></div>
      <div className={`w-full aspect-square rounded-full border border-gray-400 transition-all duration-300 ${
        state === 'green' 
        ? 'bg-green-500 shadow-[0_0_15px_5px_rgba(34,197,94,0.7)]' 
        : 'bg-gray-300 opacity-30'
      }`}></div>
    </div>
  );
};

// --- Component: Pedestrian Traffic Light ---
const PedestrianTrafficLight = ({ state }) => {
  return (
    <div className="bg-gray-100 p-3 rounded-xl border-2 border-gray-300 shadow-inner w-32 mx-auto">
      <div className={`w-full aspect-square rounded-full border border-gray-400 transition-all duration-300 flex items-center justify-center mb-2 ${
        state === 'red' 
        ? 'bg-red-500 shadow-[0_0_15px_5px_rgba(239,68,68,0.7)]' 
        : 'bg-gray-300 opacity-30'
      }`}>
        <Hand className="w-12 h-12 text-white/90" />
      </div>
      <div className={`w-full aspect-square rounded-full border border-gray-400 transition-all duration-300 flex items-center justify-center ${
        state === 'green' 
        ? 'bg-green-500 shadow-[0_0_15px_5px_rgba(34,197,94,0.7)]' 
        : 'bg-gray-300 opacity-30'
      }`}>
        <PersonStanding className="w-12 h-12 text-white/90" />
      </div>
    </div>
  );
};

// --- Component: Timer Countdown ---
const CountdownTimer = ({ timer, systemMode, settings }) => {
  const isTransitioning = timer.value <= settings.yellowTime || timer.for === 'all_red' || timer.for === 'ped_stop' || systemMode === 'Manual';
  const isIndefinite = timer.value === 999;
  
  if (isIndefinite) return (
    <div className="mt-3 flex items-center justify-center gap-2 text-blue-600">
      <Timer className="w-5 h-5" />
      <span className="font-bold text-lg">Așteptare Adaptivă</span>
    </div>
  );

  if (timer.value === 0) return null;

  return (
    <div className={`mt-3 flex items-center justify-center gap-2 ${isTransitioning ? 'text-orange-500 animate-pulse' : 'text-gray-600'}`}>
      <Timer className="w-5 h-5" />
      <span className="font-bold text-2xl">{timer.value}s</span>
    </div>
  );
};

// --- Component: Traffic Dashboard (Enhanced) ---
const TrafficDashboard = () => {
  const { systemMode, previousSystemMode, carLight, pedLight, carDetected, pedDetected, settings, timer, autoPhase, trafficStats, api, intersections } = useContext(AppContext);
  const [isFullScreen, setIsFullScreen] = useState(false);
  
  // Use first intersection for legacy support, or get from intersections array
  const currentIntersection = intersections && intersections.length > 0 ? intersections[0] : null;
  const displayCarLight = currentIntersection?.carLight || carLight;
  const displayPedLight = currentIntersection?.pedLight || pedLight;
  const displayTimer = currentIntersection?.timer || timer;

  const modeStyles = {
    Automatic: "bg-blue-600 text-white border-blue-400",
    Manual: "bg-yellow-500 text-gray-900 border-yellow-400",
    Override: "bg-red-600 text-white border-red-400",
  };
  
  const currentModeStyle = modeStyles[systemMode] || "bg-gray-300 text-gray-800";
  
  const isTransitioning = (systemMode === 'Automatic' || systemMode === 'Manual') && (
    autoPhase === AutoPhase.CAR_YELLOW || 
    autoPhase === AutoPhase.ALL_RED_1 || 
    autoPhase === AutoPhase.ALL_RED_2 || 
    autoPhase === AutoPhase.PED_RED_STOP
  );
  
  const isOverrideActive = systemMode === 'Override';

  const getAutoPhaseDescription = (phase) => {
    switch(phase) {
      case AutoPhase.CAR_GREEN: return 'Verde Auto';
      case AutoPhase.CAR_YELLOW: return 'Galben Auto (Tranziție)';
      case AutoPhase.ALL_RED_1: return 'Roșu Total (Siguranță 1)';
      case AutoPhase.PED_GREEN: return 'Verde Pietoni';
      case AutoPhase.PED_RED_STOP: return 'Roșu Stop Pietoni';
      case AutoPhase.ALL_RED_2: return 'Roșu Total (Siguranță 2)';
      default: return 'Inactiv';
    }
  };

  const congestionColor = {
    low: 'text-green-600 bg-green-100',
    medium: 'text-yellow-600 bg-yellow-100',
    high: 'text-red-600 bg-red-100',
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-green-50 via-emerald-50 to-teal-50 text-gray-900 p-6 md:p-10">
      <header className="mb-8">
        <h1 className="text-4xl font-black text-gray-800 flex items-center gap-3">
          <span className="text-4xl">🌵</span>
          <span className="bg-linear-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent">
            Panou de Control
          </span>
          <span className="text-gray-700 text-2xl">- {settings.name}</span>
        </h1>
        <div className={`mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-full text-lg font-bold border-2 ${
          systemMode === 'Automatic' ? 'bg-linear-to-r from-green-500 to-emerald-500 text-white border-green-400' :
          systemMode === 'Manual' ? 'bg-yellow-500 text-gray-900 border-yellow-400' :
          'bg-red-600 text-white border-red-400'
        }`}>
          <Cpu className="w-5 h-5" />
          Mod: {systemMode}
          {(systemMode === 'Automatic' || systemMode === 'Manual') && (
             <span className="font-medium text-sm ml-2 px-2 py-0.5 rounded-full bg-white/30 text-white">
                Fază: {getAutoPhaseDescription(autoPhase)}
             </span>
          )}
        </div>
      </header>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Column 1: Control Panel */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-white border-2 border-green-200 rounded-3xl shadow-xl p-6">
            <h2 className="text-2xl font-black text-gray-800 mb-4 flex items-center gap-2">
              <Cog className="w-6 h-6 text-green-600" />
              Selector Mod
            </h2>
            <div className="flex flex-col gap-4">
              <button 
                onClick={() => api.setSystemMode('Automatic')}
                disabled={isTransitioning || isOverrideActive}
                className={`w-full py-4 font-black rounded-xl flex items-center justify-center gap-2 transition-all ${
                  systemMode === 'Automatic' 
                    ? 'bg-linear-to-r from-green-500 to-emerald-500 text-white shadow-lg scale-105' 
                    : 'bg-gray-200 text-gray-700 hover:bg-green-50'
                } ${isTransitioning || isOverrideActive ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <Zap className="w-5 h-5" /> Automatic 🌵
              </button>
              <button 
                onClick={() => api.setSystemMode('Manual')}
                disabled={isTransitioning || isOverrideActive}
                className={`w-full py-4 font-black rounded-xl flex items-center justify-center gap-2 transition-all ${
                  systemMode === 'Manual' 
                    ? 'bg-yellow-500 text-gray-900 shadow-lg scale-105' 
                    : 'bg-gray-200 text-gray-700 hover:bg-yellow-50'
                } ${isTransitioning || isOverrideActive ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <Cog className="w-5 h-5" /> Manual (Ciclu Fix)
              </button>
            </div>
            
            {systemMode === 'Automatic' && (
                <div className="mt-4 p-4 bg-linear-to-br from-green-50 to-emerald-50 rounded-xl border-2 border-green-300">
                    <p className="font-black text-green-700 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" />
                      Prioritate Linie Verde:
                    </p>
                    <p className="text-sm text-gray-700 mt-1">
                      Implicit: <span className="font-black text-green-600">{settings.greenLinePreference}</span>
                    </p>
                    <p className="text-xs text-gray-600 italic mt-2">
                        🌵 Sistemul rămâne pe Verde pentru {settings.greenLinePreference} până la detectarea cererii din partea opusă.
                    </p>
                </div>
            )}
            
            {isOverrideActive && (
              <div className="mt-4 p-4 bg-red-100 rounded-xl border-2 border-red-400">
                <p className="font-black text-red-700 flex items-center gap-2">
                  <AlertCircle className='w-5 h-5'/> Override Manual Activ!
                </p>
                <p className="text-sm text-gray-700 mt-1">
                  Revine la modul "{previousSystemMode}" în <span className="font-black text-red-600">{timer.value}s</span>.
                </p>
                <button
                  onClick={() => api.setSystemMode(previousSystemMode)}
                  className="w-full mt-3 py-2 text-sm font-black rounded-lg bg-gray-600 text-white hover:bg-gray-700 flex items-center justify-center gap-2 transition-all"
                >
                  <RefreshCcw className="w-4 h-4" />
                  Anulează Override Acum
                </button>
              </div>
            )}
            
            {isTransitioning && (
              <div className="mt-4 p-4 bg-yellow-100 rounded-xl border-2 border-yellow-400">
                <p className="font-black text-yellow-700 animate-pulse flex items-center gap-2">
                  <Timer className="w-4 h-4" />
                  Tranziție în Curs...
                </p>
                <p className="text-sm text-gray-700 mt-1">
                  Schimbările de mod sunt dezactivate pentru siguranță.
                </p>
              </div>
            )}
          </div>

          {/* Traffic Stats Quick View */}
          <div className="bg-white border-2 border-green-200 rounded-3xl shadow-xl p-6">
            <h2 className="text-2xl font-black text-gray-800 mb-4 flex items-center gap-2">
              <Activity className="w-6 h-6 text-green-600" />
              Statistici Live 📊
            </h2>
            <div className="space-y-4">
              <div className="flex justify-between items-center p-2 bg-green-50 rounded-lg">
                <span className="text-gray-700 text-sm font-semibold flex items-center gap-1">
                  <Car className="w-4 h-4" /> Vehicule/oră
                </span>
                <span className="font-black text-xl text-green-600">{trafficStats.vehiclesPerHour}</span>
              </div>
              <div className="flex justify-between items-center p-2 bg-purple-50 rounded-lg">
                <span className="text-gray-700 text-sm font-semibold flex items-center gap-1">
                  <PersonStanding className="w-4 h-4" /> Pietoni/oră
                </span>
                <span className="font-black text-xl text-purple-600">{trafficStats.pedestriansPerHour}</span>
              </div>
              <div className="flex justify-between items-center p-2 bg-blue-50 rounded-lg">
                <span className="text-gray-700 text-sm font-semibold flex items-center gap-1">
                  <Clock className="w-4 h-4" /> Așteptare medie
                </span>
                <span className="font-black text-xl text-blue-600">{trafficStats.averageWaitTime}s</span>
              </div>
              <div className="flex justify-between items-center p-2 rounded-lg bg-gray-50">
                <span className="text-gray-700 text-sm font-semibold">Nivel congestie</span>
                <span className={`font-black text-sm px-3 py-1 rounded-full ${congestionColor[trafficStats.congestionLevel]}`}>
                  {trafficStats.congestionLevel}
                </span>
              </div>
              <div className="flex justify-between items-center p-2 bg-orange-50 rounded-lg">
                <span className="text-gray-700 text-sm font-semibold flex items-center gap-1">
                  <Eye className="w-4 h-4" /> Precizie
                </span>
                <span className="font-black text-xl text-orange-600">{trafficStats.detectionAccuracy}%</span>
              </div>
            </div>
          </div>

          {/* Override Panel */}
          <div className="bg-white border-2 border-red-200 rounded-3xl shadow-xl p-6">
            <h2 className="text-2xl font-black text-gray-800 mb-2 flex items-center gap-2">
              <AlertTriangle className="w-6 h-6 text-red-600" />
              Override Manual
            </h2>
            <p className="text-sm text-gray-600 mb-4">Forțează temporar o stare. Activează modul Override.</p>
            <div className="space-y-4">
              <h3 className="font-black text-lg text-blue-600 flex items-center gap-2">
                <Car className="w-5 h-5" /> Lumini Vehicule
              </h3>
              <div className="grid grid-cols-3 gap-2">
                {['green', 'yellow', 'red'].map((state) => (
                    <button 
                        key={state}
                        onClick={() => api.setLightState('car', state)}
                        disabled={isTransitioning}
                        className={`w-full py-3 font-black rounded-xl capitalize transition-all disabled:opacity-50 disabled:cursor-not-allowed text-white shadow-md hover:scale-105 ${
                            state === 'green' ? 'bg-green-600 hover:bg-green-700' :
                            state === 'yellow' ? 'bg-yellow-500 hover:bg-yellow-600 text-gray-900' :
                            'bg-red-600 hover:bg-red-700'
                        }`}
                    >
                        {state}
                    </button>
                ))}
              </div>
              
              <h3 className="font-black text-lg text-purple-600 flex items-center gap-2">
                <PersonStanding className="w-5 h-5" /> Lumini Pietoni
              </h3>
              <div className="grid grid-cols-2 gap-3">
                {['green', 'red'].map((state) => (
                    <button 
                        key={state}
                        onClick={() => api.setLightState('ped', state)}
                        disabled={isTransitioning}
                        className={`w-full py-3 font-black rounded-xl capitalize transition-all disabled:opacity-50 disabled:cursor-not-allowed text-white shadow-md hover:scale-105 ${
                            state === 'green' ? 'bg-green-600 hover:bg-green-700' :
                            'bg-red-600 hover:bg-red-700'
                        }`}
                    >
                        {state}
                    </button>
                ))}
              </div>
            </div>
          </div>
          
          {/* Mock Detection Buttons */}
          <div className="bg-white border-2 border-green-200 rounded-3xl shadow-xl p-6">
            <h2 className="text-2xl font-black text-gray-800 mb-2 flex items-center gap-2">
              <Eye className="w-6 h-6 text-green-600" />
              Simulare Detecție 🌵
            </h2>
            <p className="text-sm text-gray-600 mb-4">
                Declanșează manual detecții pentru modul Automatic.
            </p>
            <div className="flex flex-col gap-3">
                <button 
                    onClick={() => api.setDetection('car')}
                    disabled={systemMode !== 'Automatic' || carDetected}
                    className="w-full py-3 bg-linear-to-r from-blue-500 to-cyan-500 text-white font-black rounded-xl hover:shadow-lg disabled:opacity-50 flex items-center justify-center gap-2 transition-all hover:scale-105"
                >
                    <Truck className="w-5 h-5" />
                    Detectează Vehicul 🚗
                </button>
                <button 
                    onClick={() => api.setDetection('ped')}
                    disabled={systemMode !== 'Automatic' || pedDetected}
                    className="w-full py-3 bg-linear-to-r from-purple-500 to-pink-500 text-white font-black rounded-xl hover:shadow-lg disabled:opacity-50 flex items-center justify-center gap-2 transition-all hover:scale-105"
                >
                    <PersonStanding className="w-5 h-5" />
                    Detectează Pieton 🚶
                </button>
                <button 
                    onClick={api.clearDetections}
                    className="w-full py-3 bg-gray-500 text-white font-black rounded-xl hover:bg-gray-600 flex items-center justify-center gap-2 transition-all hover:scale-105"
                >
                    <X className="w-5 h-5" />
                    Șterge Detecțiile
                </button>
            </div>
          </div>
        </div>

        {/* Column 2: Live Video & Traffic Lights */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white border-2 border-green-200 rounded-3xl shadow-xl p-6">
            <h2 className="text-2xl font-black text-gray-800 mb-4 flex items-center gap-2">
              <Camera className="w-6 h-6 text-green-600" /> 
              Feed Live - Detecție YOLO 🌵
            </h2>
            <div className="w-full h-[350px] bg-linear-to-br from-gray-100 to-gray-200 rounded-2xl text-gray-700 flex items-center justify-center relative overflow-hidden border-4 border-green-300 shadow-inner">
              <div className="absolute inset-0 bg-white/30 backdrop-blur-sm"></div>
              
              <div className="absolute top-3 left-4 text-xs text-gray-600 font-semibold bg-white/80 px-2 py-1 rounded-full z-20">
                FEED: {settings.name}
              </div>
              <div className="absolute top-3 right-4 text-xs text-red-600 font-black animate-pulse bg-white/80 px-2 py-1 rounded-full flex items-center gap-1 z-20">
                <span className="w-2 h-2 bg-red-600 rounded-full"></span> LIVE
              </div>
              
              {/* Full Screen Button */}
              <button
                onClick={() => setIsFullScreen(true)}
                className="absolute top-3 right-16 bg-black/50 hover:bg-black/70 text-white p-2 rounded-lg z-30 transition-all hover:scale-110"
                title="Full Screen"
              >
                <Maximize2 className="w-4 h-4" />
              </button>
              
              {/* Video Feed */}
              <img 
                src="http://localhost:8000/video_feed" 
                alt="Live Video Feed"
                className="absolute inset-0 w-full h-full object-cover z-0"
                onError={(e) => {
                  // Fallback to placeholder if video feed fails
                  e.target.style.display = 'none';
                  const fallback = e.target.nextElementSibling;
                  if (fallback) fallback.style.display = 'flex';
                }}
              />
              
              {/* Fallback placeholder when video feed is not available */}
              <div className="text-center z-10 p-4" style={{ display: 'none' }}>
                <Video className="w-20 h-20 mx-auto text-green-600" />
                <p className="mt-2 font-black text-gray-700">Sistem de Viziune Inteligent Activ</p>
                <p className="text-sm text-gray-600 font-semibold">YOLO Detection: <span className="text-green-600 font-black">{trafficStats.detectionAccuracy}%</span> accuracy</p>
                <p className="text-xs text-red-600 mt-2">Conectare la feed video...</p>
              </div>
              
              {/* Detection Warning in Bottom Right - Based on light colors from backend */}
              <div className="absolute bottom-4 right-4 z-20 flex flex-col gap-2">
                {displayCarLight === 'green' && (
                  <div className="px-4 py-2 bg-linear-to-r from-green-500 to-emerald-500 text-white font-black rounded-full flex items-center gap-2 shadow-xl animate-pulse border-2 border-white">
                    <Car className="w-5 h-5" /> Verde Vehicule 🚗
                  </div>
                )}
                {displayPedLight === 'green' && (
                  <div className="px-4 py-2 bg-linear-to-r from-purple-500 to-pink-500 text-white font-black rounded-full flex items-center gap-2 shadow-xl animate-pulse border-2 border-white">
                    <PersonStanding className="w-5 h-5" /> Verde Pietoni 🚶
                  </div>
                )}
                {displayCarLight === 'yellow' && (
                  <div className="px-4 py-2 bg-linear-to-r from-yellow-500 to-orange-500 text-white font-black rounded-full flex items-center gap-2 shadow-xl animate-pulse border-2 border-white">
                    <Car className="w-5 h-5" /> Galben Vehicule ⚠️
                  </div>
                )}
                {displayPedLight === 'yellow' && (
                  <div className="px-4 py-2 bg-linear-to-r from-yellow-500 to-orange-500 text-white font-black rounded-full flex items-center gap-2 shadow-xl animate-pulse border-2 border-white">
                    <PersonStanding className="w-5 h-5" /> Galben Pietoni ⚠️
                  </div>
                )}
                {displayCarLight === 'red' && displayPedLight === 'red' && (
                  <div className="px-4 py-2 bg-gray-500/80 text-white font-semibold rounded-full flex items-center gap-2 shadow-xl border-2 border-white">
                    <AlertCircle className="w-5 h-5" /> Roșu - Așteptare
                  </div>
                )}
              </div>
            </div>
            
            {/* Full Screen Overlay */}
            {isFullScreen && (
              <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
                {/* Close Button */}
                <button
                  onClick={() => setIsFullScreen(false)}
                  className="absolute top-4 left-4 bg-red-600 hover:bg-red-700 text-white p-3 rounded-lg z-50 transition-all hover:scale-110 flex items-center gap-2"
                  title="Închide Full Screen"
                >
                  <X className="w-5 h-5" /> Închide
                </button>
                
                {/* Video Feed Full Screen */}
                <div className="w-full h-full relative">
                  <img 
                    src="http://localhost:8000/video_feed" 
                    alt="Live Video Feed Full Screen"
                    className="w-full h-full object-contain"
                  />
                  
                  {/* Traffic Lights Overlay - Top Right */}
                  <div className="absolute top-4 right-4 rounded-xl z-40 overflow-hidden">
                    <div className="flex gap-0 p-2">
                      {/* Car Traffic Light */}
                      <div className="flex flex-col items-center">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Car className="w-3 h-3 text-white" />
                          <span className="text-white font-bold text-[11px]">Vehicule</span>
                          {displayTimer.value !== 999 && displayTimer.for === 'car' && (
                            <span className="text-white/80 font-semibold text-[10px] bg-white/20 px-1.5 py-0.5 rounded">
                              {displayTimer.value}s
                            </span>
                          )}
                          {displayTimer.value === 999 && displayTimer.for === 'car' && (
                            <span className="text-blue-400 font-semibold text-[9px]">∞</span>
                          )}
                        </div>
                        <div className="scale-[0.5] origin-top mt-2">
                          <CarTrafficLight state={displayCarLight} />
                        </div>
                      </div>
                    
                      
                      {/* Pedestrian Traffic Light */}
                      <div className="flex flex-col items-center">
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <PersonStanding className="w-3 h-3 text-white" />
                          <span className="text-white font-bold text-[11px]">Pietoni</span>
                          {displayTimer.value !== 999 && displayTimer.for === 'ped' && (
                            <span className="text-white/80 font-semibold text-[10px] bg-white/20 px-1.5 py-0.5 rounded">
                              {displayTimer.value}s
                            </span>
                          )}
                          {displayTimer.value === 999 && displayTimer.for === 'ped' && (
                            <span className="text-blue-400 font-semibold text-[9px]">∞</span>
                          )}
                        </div>
                        <div className="scale-[0.5] origin-top mt-2">
                          <PedestrianTrafficLight state={displayPedLight} />
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  {/* Detection Warning in Bottom Right - Full Screen - Based on light colors from backend */}
                  <div className="absolute bottom-4 right-4 z-40 flex flex-col gap-2">
                    {displayCarLight === 'green' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-green-500 to-emerald-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <Car className="w-5 h-5" /> 
                        <span className="text-sm">Verde Vehicule</span>
                      </div>
                    )}
                    {displayPedLight === 'green' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-purple-500 to-pink-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <PersonStanding className="w-5 h-5" /> 
                        <span className="text-sm">Verde Pietoni</span>
                      </div>
                    )}
                    {displayCarLight === 'yellow' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-yellow-500 to-orange-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <Car className="w-5 h-5" /> 
                        <span className="text-sm">Galben Vehicule</span>
                      </div>
                    )}
                    {displayPedLight === 'yellow' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-yellow-500 to-orange-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <PersonStanding className="w-5 h-5" /> 
                        <span className="text-sm">Galben Pietoni</span>
                      </div>
                    )}
                    {displayCarLight === 'red' && displayPedLight === 'red' && (
                      <div className="px-4 py-2.5 bg-gray-700/90 text-white/80 font-medium rounded-lg flex items-center gap-2 shadow-xl border border-white/20 backdrop-blur-sm">
                        <AlertCircle className="w-4 h-4" /> 
                        <span className="text-xs">Roșu - Așteptare</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
          
          <div className="bg-white border-2 border-green-200 rounded-3xl shadow-xl p-6">
            <h2 className="text-2xl font-black text-gray-800 mb-6 flex items-center gap-2">
              <span className="text-2xl">🚦</span>
              Status Lumini Curente
            </h2>
            <div className="flex justify-around items-start gap-6">
              <div className="text-center flex-1">
                <h3 className="text-xl font-black mb-4 text-blue-600 flex items-center justify-center gap-2">
                  <Car className="w-5 h-5" /> Trafic Vehicule
                </h3>
                <CarTrafficLight state={displayCarLight} />
                <CountdownTimer timer={displayTimer} systemMode={systemMode} settings={settings} />
              </div>
              
              <div className="text-center flex-1">
                <h3 className="text-xl font-black mb-4 text-purple-600 flex items-center justify-center gap-2">
                  <PersonStanding className="w-5 h-5" /> Traversare Pietoni
                </h3>
                <PedestrianTrafficLight state={displayPedLight} />
                <CountdownTimer timer={displayTimer} systemMode={systemMode} settings={settings} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Component: Statistics Page ---
const StatisticsPage = () => {
  const { trafficStats, settings } = useContext(AppContext);
  const [timeRange, setTimeRange] = useState('24h');

  const mockHourlyData = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    vehicles: Math.floor(Math.random() * 150) + 50,
    pedestrians: Math.floor(Math.random() * 80) + 20,
    avgWaitTime: (Math.random() * 25 + 8).toFixed(1),
  }));

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-6 md:p-10">
      <header className="mb-8">
        <h1 className="text-4xl font-black text-gray-900 flex items-center gap-3">
          <BarChart3 className="w-8 h-8 text-blue-600" />
          Statistici Trafic
        </h1>
        <p className="text-gray-600 mt-1">Analiză detaliată a performanței sistemului</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-200">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-blue-600" />
            Flux Vehicule
          </h2>
          <div className="h-64 flex items-end justify-between gap-2">
            {mockHourlyData.slice(0, 12).map((data, idx) => (
              <div key={idx} className="flex-1 flex flex-col items-center">
                <div 
                  className="w-full bg-blue-500 rounded-t hover:bg-blue-600 transition-colors"
                  style={{ height: `${(data.vehicles / 200) * 100}%` }}
                  title={`${data.vehicles} vehicule`}
                ></div>
                <span className="text-xs text-gray-500 mt-1">{data.hour}h</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-200">
          <h2 className="text-xl font-bold mb-4 flex items-center gap-2">
            <Users className="w-5 h-5 text-purple-600" />
            Flux Pietoni
          </h2>
          <div className="h-64 flex items-end justify-between gap-2">
            {mockHourlyData.slice(0, 12).map((data, idx) => (
              <div key={idx} className="flex-1 flex flex-col items-center">
                <div 
                  className="w-full bg-purple-500 rounded-t hover:bg-purple-600 transition-colors"
                  style={{ height: `${(data.pedestrians / 100) * 100}%` }}
                  title={`${data.pedestrians} pietoni`}
                ></div>
                <span className="text-xs text-gray-500 mt-1">{data.hour}h</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-900">Timp Mediu Așteptare</h3>
            <Clock className="w-5 h-5 text-orange-600" />
          </div>
          <div className="text-4xl font-black text-orange-600 mb-2">{trafficStats.averageWaitTime}s</div>
          <p className="text-sm text-gray-500">Reducere cu 35% față de sistemul tradițional</p>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-900">Nivel Congestie</h3>
            <Gauge className="w-5 h-5 text-red-600" />
          </div>
          <div className={`text-4xl font-black mb-2 capitalize ${
            trafficStats.congestionLevel === 'low' ? 'text-green-600' :
            trafficStats.congestionLevel === 'medium' ? 'text-yellow-600' : 'text-red-600'
          }`}>
            {trafficStats.congestionLevel}
          </div>
          <p className="text-sm text-gray-500">Monitorizat în timp real</p>
        </div>

        <div className="bg-white rounded-xl shadow-lg p-6 border border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-bold text-gray-900">Precizie Detecție</h3>
            <Eye className="w-5 h-5 text-blue-600" />
          </div>
          <div className="text-4xl font-black text-blue-600 mb-2">{trafficStats.detectionAccuracy}%</div>
          <p className="text-sm text-gray-500">YOLO Detection</p>
        </div>
      </div>
    </div>
  );
};

// --- Component: Control Page ---
const ControlPage = () => {
  const { intersections, api } = useContext(AppContext);
  const [selectedIntersectionId, setSelectedIntersectionId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [isFullScreen, setIsFullScreen] = useState(false);

  const selectedIntersection = intersections?.find(i => i.id === selectedIntersectionId) || intersections?.[0];
  
  useEffect(() => {
    if (intersections && intersections.length > 0 && !selectedIntersectionId) {
      setSelectedIntersectionId(intersections[0].id);
    }
  }, [intersections, selectedIntersectionId]);

  const handleSetMode = async (mode) => {
    if (!selectedIntersectionId) return;
    
    setLoading(true);
    setError(null);
    setSuccess(null);
    
    try {
      await api.controlIntersection(selectedIntersectionId, 'set_mode', { mode });
      setSuccess(`Mod setat la ${mode}`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(`Eroare: ${err.message}`);
      setTimeout(() => setError(null), 5000);
    } finally {
      setLoading(false);
    }
  };

  const handleOverride = async (light, state) => {
    if (!selectedIntersectionId) return;
    
    setLoading(true);
    setError(null);
    setSuccess(null);
    
    try {
      await api.controlIntersection(selectedIntersectionId, 'override', { light, state });
      const selectedIntersection = intersections?.find(i => i.id === selectedIntersectionId);
      const intersectionType = selectedIntersection?.type || 'car_pedestrian';
      const intersectionLights = selectedIntersection?.lights || [];
      
      let lightName = '';
      if (intersectionType === 'car_car') {
        const lightConfig = intersectionLights.find(l => l.id === (light === 'car' ? 0 : 1));
        lightName = lightConfig?.name || (light === 'car' ? 'Semafor 1' : 'Semafor 2');
      } else {
        lightName = light === 'car' ? 'Vehicule' : 'Pietoni';
      }
      
      setSuccess(`${lightName} setat la ${state}`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(`Eroare: ${err.message}`);
      setTimeout(() => setError(null), 5000);
    } finally {
      setLoading(false);
    }
  };

  const handleSimulate = async (type, lightIndex = null) => {
    if (!selectedIntersectionId) return;
    
    setLoading(true);
    setError(null);
    setSuccess(null);
    
    try {
      const payload = { type };
      // Pentru car_car, trimite și lightIndex pentru a ști în ce zone să simuleze
      if (isCarCar && lightIndex !== null) {
        payload.lightIndex = lightIndex;
      }
      await api.controlIntersection(selectedIntersectionId, 'simulate', payload);
      const selectedIntersection = intersections?.find(i => i.id === selectedIntersectionId);
      const intersectionLights = selectedIntersection?.lights || [];
      let message = `Simulare ${type} trimisă`;
      if (isCarCar && lightIndex !== null) {
        const lightName = intersectionLights[lightIndex]?.name || `Semafor ${lightIndex + 1}`;
        message = `Simulare vehicul pentru ${lightName} trimisă`;
      }
      setSuccess(message);
      setTimeout(() => setSuccess(null), 3000);
    } catch (err) {
      setError(`Eroare: ${err.message}`);
      setTimeout(() => setError(null), 5000);
    } finally {
      setLoading(false);
    }
  };

  if (!intersections || intersections.length === 0) {
    return (
      <div className="min-h-screen bg-linear-to-br from-green-50 via-emerald-50 to-teal-50 text-gray-900 p-6 md:p-10">
        <div className="max-w-4xl mx-auto">
          <h1 className="text-4xl font-black text-gray-800 mb-4">Control Intersecții</h1>
          <p className="text-gray-600">Se încarcă intersecțiile...</p>
        </div>
      </div>
    );
  }

  const currentMode = selectedIntersection?.settings?.mode || 'Automatic';
  const lights = selectedIntersection?.state?.lights || [0, 0];
  const intersectionType = selectedIntersection?.type || 'car_pedestrian';
  const intersectionLights = selectedIntersection?.lights || [];
  
  // Pentru car_pedestrian
  const carLight = lights[0] === 1 ? 'green' : lights[0] === 2 ? 'yellow' : 'red';
  const pedLight = lights[1] === 1 ? 'green' : 'red';
  const carLightConfig = intersectionLights.find(l => l.id === 0);
  const pedLightConfig = intersectionLights.find(l => l.id === 1);
  const isPedestrianLight = pedLightConfig?.type === 'pedestrian';
  
  // Pentru car_car
  const light0Config = intersectionLights.find(l => l.id === 0);
  const light1Config = intersectionLights.find(l => l.id === 1);
  const light0State = lights[0] === 1 ? 'green' : lights[0] === 2 ? 'yellow' : 'red';
  const light1State = lights[1] === 1 ? 'green' : lights[1] === 2 ? 'yellow' : 'red';
  const isCarCar = intersectionType === 'car_car';

  return (
    <div className="min-h-screen bg-linear-to-br from-green-50 via-emerald-50 to-teal-50 text-gray-900 p-6 md:p-10">
      <div className="max-w-6xl mx-auto">
        <header className="mb-8">
          <h1 className="text-4xl font-black text-gray-800 flex items-center gap-3">
            <Cog className="w-10 h-10 text-green-600" />
            Control Intersecții
          </h1>
          <p className="text-gray-600 mt-2">Controlează manual intersecțiile și testează sistemul</p>
        </header>

        {/* Video Feed Section */}
        <div className="bg-white rounded-xl shadow-lg p-6 border-2 border-green-200 mb-6 relative">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-2xl font-black text-gray-800 flex items-center gap-2">
              <Video className="w-6 h-6 text-green-600" />
              Feed Video Live
            </h2>
            <button
              onClick={() => setIsFullScreen(true)}
              className="bg-green-600 hover:bg-green-700 text-white p-2 rounded-lg transition-all hover:scale-110 flex items-center gap-2"
              title="Full Screen"
            >
              <Maximize2 className="w-5 h-5" />
            </button>
          </div>
          <div className="relative w-full bg-black rounded-lg overflow-hidden" style={{ minHeight: '400px' }}>
            <img 
              src={selectedIntersectionId ? `http://localhost:8000/video_feed?intersection_id=${selectedIntersectionId}` : "http://localhost:8000/video_feed"} 
              alt="Live Video Feed"
              className="w-full h-full object-contain"
              key={selectedIntersectionId} // Force re-render when intersection changes
              onError={(e) => {
                e.target.style.display = 'none';
                const errorDiv = e.target.parentElement.querySelector('.video-error');
                if (errorDiv) errorDiv.style.display = 'flex';
              }}
            />
            <div className="video-error absolute inset-0 items-center justify-center bg-gray-900 text-white hidden flex-col gap-2">
              <Video className="w-12 h-12 text-gray-500" />
              <p className="text-lg font-semibold">Feed video indisponibil</p>
              <p className="text-sm text-gray-400">Verifică că serverul backend rulează</p>
            </div>
          </div>
        </div>

        {/* Full Screen Overlay */}
        {isFullScreen && (
          <div className="fixed inset-0 z-50 bg-black flex items-center justify-center">
            {/* Close Button */}
            <button
              onClick={() => setIsFullScreen(false)}
              className="absolute top-4 left-4 bg-red-600 hover:bg-red-700 text-white p-3 rounded-lg z-50 transition-all hover:scale-110 flex items-center gap-2"
              title="Închide Full Screen"
            >
              <X className="w-5 h-5" /> Închide
            </button>
            
            {/* Video Feed Full Screen */}
            <div className="w-full h-full relative">
              <img 
                src={selectedIntersectionId ? `http://localhost:8000/video_feed?intersection_id=${selectedIntersectionId}` : "http://localhost:8000/video_feed"} 
                alt="Live Video Feed Full Screen"
                className="w-full h-full object-contain"
                key={selectedIntersectionId} // Force re-render when intersection changes
              />
              
              {/* Traffic Lights Overlay - Top Right */}
              {selectedIntersection && (
                <div className="absolute top-4 right-4 z-40 overflow-hidden">
                  <div className="flex gap-2 p-2">
                    {isCarCar ? (
                      <>
                        {/* Light 0 Traffic Light */}
                        <div className="flex flex-col items-center">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <Car className="w-3 h-3 text-white" />
                            <span className="text-white font-bold text-[11px]">{light0Config?.name || 'Semafor 1'}</span>
                            {selectedIntersection.timer && selectedIntersection.timer.value !== 999 && (selectedIntersection.timer.for === 'light_0' || selectedIntersection.timer.for === 'car') && (
                              <span className="text-white/80 font-semibold text-[10px] bg-white/20 px-1.5 py-0.5 rounded">
                                {selectedIntersection.timer.value}s
                              </span>
                            )}
                            {selectedIntersection.timer && selectedIntersection.timer.value === 999 && (selectedIntersection.timer.for === 'light_0' || selectedIntersection.timer.for === 'car') && (
                              <span className="text-blue-400 font-semibold text-[9px]">∞</span>
                            )}
                          </div>
                          <div className="scale-[0.5] origin-top mt-2">
                            <CarTrafficLight state={light0State} />
                          </div>
                        </div>
                        
                        {/* Light 1 Traffic Light */}
                        <div className="flex flex-col items-center">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <Car className="w-3 h-3 text-white" />
                            <span className="text-white font-bold text-[11px]">{light1Config?.name || 'Semafor 2'}</span>
                            {selectedIntersection.timer && selectedIntersection.timer.value !== 999 && (selectedIntersection.timer.for === 'light_1' || selectedIntersection.timer.for === 'ped') && (
                              <span className="text-white/80 font-semibold text-[10px] bg-white/20 px-1.5 py-0.5 rounded">
                                {selectedIntersection.timer.value}s
                              </span>
                            )}
                            {selectedIntersection.timer && selectedIntersection.timer.value === 999 && (selectedIntersection.timer.for === 'light_1' || selectedIntersection.timer.for === 'ped') && (
                              <span className="text-blue-400 font-semibold text-[9px]">∞</span>
                            )}
                          </div>
                          <div className="scale-[0.5] origin-top mt-2">
                            <CarTrafficLight state={light1State} />
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        {/* Car Traffic Light */}
                        <div className="flex flex-col items-center">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <Car className="w-3 h-3 text-white" />
                            <span className="text-white font-bold text-[11px]">Vehicule</span>
                            {selectedIntersection.timer && selectedIntersection.timer.value !== 999 && selectedIntersection.timer.for === 'car' && (
                              <span className="text-white/80 font-semibold text-[10px] bg-white/20 px-1.5 py-0.5 rounded">
                                {selectedIntersection.timer.value}s
                              </span>
                            )}
                            {selectedIntersection.timer && selectedIntersection.timer.value === 999 && selectedIntersection.timer.for === 'car' && (
                              <span className="text-blue-400 font-semibold text-[9px]">∞</span>
                            )}
                          </div>
                          <div className="scale-[0.5] origin-top mt-2">
                            <CarTrafficLight state={carLight} />
                          </div>
                        </div>
                        
                        {/* Pedestrian Traffic Light */}
                        <div className="flex flex-col items-center">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <PersonStanding className="w-3 h-3 text-white" />
                            <span className="text-white font-bold text-[11px]">Pietoni</span>
                            {selectedIntersection.timer && selectedIntersection.timer.value !== 999 && selectedIntersection.timer.for === 'ped' && (
                              <span className="text-white/80 font-semibold text-[10px] bg-white/20 px-1.5 py-0.5 rounded">
                                {selectedIntersection.timer.value}s
                              </span>
                            )}
                            {selectedIntersection.timer && selectedIntersection.timer.value === 999 && selectedIntersection.timer.for === 'ped' && (
                              <span className="text-blue-400 font-semibold text-[9px]">∞</span>
                            )}
                          </div>
                          <div className="scale-[0.5] origin-top mt-2">
                            <PedestrianTrafficLight state={pedLight} />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )}
              
              {/* Detection Warning in Bottom Right - Full Screen */}
              <div className="absolute bottom-4 right-4 z-40 flex flex-col gap-2">
                {isCarCar ? (
                  <>
                    {light0State === 'green' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-green-500 to-emerald-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <Car className="w-5 h-5" /> 
                        <span className="text-sm">Verde {light0Config?.name || 'Semafor 1'}</span>
                      </div>
                    )}
                    {light1State === 'green' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-green-500 to-emerald-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <Car className="w-5 h-5" /> 
                        <span className="text-sm">Verde {light1Config?.name || 'Semafor 2'}</span>
                      </div>
                    )}
                    {light0State === 'yellow' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-yellow-500 to-orange-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <Car className="w-5 h-5" /> 
                        <span className="text-sm">Galben {light0Config?.name || 'Semafor 1'}</span>
                      </div>
                    )}
                    {light1State === 'yellow' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-yellow-500 to-orange-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <Car className="w-5 h-5" /> 
                        <span className="text-sm">Galben {light1Config?.name || 'Semafor 2'}</span>
                      </div>
                    )}
                    {light0State === 'red' && light1State === 'red' && (
                      <div className="px-4 py-2.5 bg-gray-700/90 text-white/80 font-medium rounded-lg flex items-center gap-2 shadow-xl border border-white/20 backdrop-blur-sm">
                        <AlertCircle className="w-4 h-4" /> 
                        <span className="text-xs">Roșu - Așteptare</span>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    {carLight === 'green' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-green-500 to-emerald-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <Car className="w-5 h-5" /> 
                        <span className="text-sm">Verde Vehicule</span>
                      </div>
                    )}
                    {pedLight === 'green' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-purple-500 to-pink-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <PersonStanding className="w-5 h-5" /> 
                        <span className="text-sm">Verde Pietoni</span>
                      </div>
                    )}
                    {carLight === 'yellow' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-yellow-500 to-orange-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <Car className="w-5 h-5" /> 
                        <span className="text-sm">Galben Vehicule</span>
                      </div>
                    )}
                    {pedLight === 'yellow' && (
                      <div className="px-4 py-2.5 bg-linear-to-r from-yellow-500 to-orange-600 text-white font-bold rounded-lg flex items-center gap-2 shadow-2xl animate-pulse border border-white/30 backdrop-blur-sm">
                        <PersonStanding className="w-5 h-5" /> 
                        <span className="text-sm">Galben Pietoni</span>
                      </div>
                    )}
                    {carLight === 'red' && pedLight === 'red' && (
                      <div className="px-4 py-2.5 bg-gray-700/90 text-white/80 font-medium rounded-lg flex items-center gap-2 shadow-xl border border-white/20 backdrop-blur-sm">
                        <AlertCircle className="w-4 h-4" /> 
                        <span className="text-xs">Roșu - Așteptare</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Intersection Selector */}
        <div className="bg-white rounded-xl shadow-lg p-6 border-2 border-green-200 mb-6">
          <label className="block text-lg font-black text-gray-800 mb-3">
            Selectează Intersecția:
          </label>
          <select
            value={selectedIntersectionId || ''}
            onChange={(e) => setSelectedIntersectionId(e.target.value)}
            className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold"
          >
            {intersections.map(intersection => (
              <option key={intersection.id} value={intersection.id}>
                {intersection.name} ({intersection.type})
              </option>
            ))}
          </select>
        </div>

        {/* Status Messages */}
        {error && (
          <div className="bg-red-100 border-2 border-red-400 text-red-700 px-4 py-3 rounded-xl mb-4 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5" />
            {error}
          </div>
        )}
        {success && (
          <div className="bg-green-100 border-2 border-green-400 text-green-700 px-4 py-3 rounded-xl mb-4 flex items-center gap-2">
            <CheckCircle2 className="w-5 h-5" />
            {success}
          </div>
        )}

        {/* Current Status */}
        <div className="bg-white rounded-xl shadow-lg p-6 border-2 border-green-200 mb-6">
          <h2 className="text-2xl font-black text-gray-800 mb-4">Status Curent</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <p className="text-sm text-gray-600 mb-1">Mod:</p>
              <p className="text-xl font-black text-blue-600">{currentMode}</p>
            </div>
            {isCarCar ? (
              <>
                <div>
                  <p className="text-sm text-gray-600 mb-1">{light0Config?.name || 'Semafor 1'}:</p>
                  <p className={`text-xl font-black ${light0State === 'green' ? 'text-green-600' : light0State === 'yellow' ? 'text-yellow-600' : 'text-red-600'}`}>
                    {light0State.toUpperCase()}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 mb-1">{light1Config?.name || 'Semafor 2'}:</p>
                  <p className={`text-xl font-black ${light1State === 'green' ? 'text-green-600' : light1State === 'yellow' ? 'text-yellow-600' : 'text-red-600'}`}>
                    {light1State.toUpperCase()}
                  </p>
                </div>
              </>
            ) : (
              <>
                <div>
                  <p className="text-sm text-gray-600 mb-1">Vehicule:</p>
                  <p className={`text-xl font-black ${carLight === 'green' ? 'text-green-600' : carLight === 'yellow' ? 'text-yellow-600' : 'text-red-600'}`}>
                    {carLight.toUpperCase()}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 mb-1">Pietoni:</p>
                  <p className={`text-xl font-black ${pedLight === 'green' ? 'text-green-600' : 'text-red-600'}`}>
                    {pedLight.toUpperCase()}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Mode Control */}
        <div className="bg-white rounded-xl shadow-lg p-6 border-2 border-green-200 mb-6">
          <h2 className="text-2xl font-black text-gray-800 mb-4">Mod de Operare</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <button
              onClick={() => handleSetMode('Automatic')}
              disabled={loading || currentMode === 'Automatic'}
              className={`p-4 rounded-xl font-black text-lg transition-all ${
                currentMode === 'Automatic'
                  ? 'bg-blue-600 text-white'
                  : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              Automatic
            </button>
            <button
              onClick={() => handleSetMode('Manual')}
              disabled={loading || currentMode === 'Manual'}
              className={`p-4 rounded-xl font-black text-lg transition-all ${
                currentMode === 'Manual'
                  ? 'bg-yellow-500 text-gray-900'
                  : 'bg-yellow-100 text-yellow-700 hover:bg-yellow-200'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              Manual
            </button>
            <button
              onClick={() => handleSetMode('Override')}
              disabled={loading || currentMode === 'Override'}
              className={`p-4 rounded-xl font-black text-lg transition-all ${
                currentMode === 'Override'
                  ? 'bg-red-600 text-white'
                  : 'bg-red-100 text-red-700 hover:bg-red-200'
              } disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              Override
            </button>
          </div>
        </div>

        {/* Override Control */}
        <div className="bg-white rounded-xl shadow-lg p-6 border-2 border-green-200 mb-6">
          <h2 className="text-2xl font-black text-gray-800 mb-4">Override Manual</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {isCarCar ? (
              <>
                {/* Light 0 Control */}
                <div>
                  <h3 className="text-lg font-black text-blue-600 mb-3 flex items-center gap-2">
                    <Car className="w-5 h-5" /> {light0Config?.name || 'Semafor 1'}
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => handleOverride('car', 'red')}
                      disabled={loading}
                      className="p-3 bg-red-600 text-white rounded-lg font-black hover:bg-red-700 disabled:opacity-50"
                    >
                      Roșu
                    </button>
                    <button
                      onClick={() => handleOverride('car', 'yellow')}
                      disabled={loading}
                      className="p-3 bg-yellow-500 text-gray-900 rounded-lg font-black hover:bg-yellow-600 disabled:opacity-50"
                    >
                      Galben
                    </button>
                    <button
                      onClick={() => handleOverride('car', 'green')}
                      disabled={loading}
                      className="p-3 bg-green-600 text-white rounded-lg font-black hover:bg-green-700 disabled:opacity-50"
                    >
                      Verde
                    </button>
                  </div>
                </div>

                {/* Light 1 Control */}
                <div>
                  <h3 className="text-lg font-black text-blue-600 mb-3 flex items-center gap-2">
                    <Car className="w-5 h-5" /> {light1Config?.name || 'Semafor 2'}
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => handleOverride('ped', 'red')}
                      disabled={loading}
                      className="p-3 bg-red-600 text-white rounded-lg font-black hover:bg-red-700 disabled:opacity-50"
                    >
                      Roșu
                    </button>
                    <button
                      onClick={() => handleOverride('ped', 'yellow')}
                      disabled={loading}
                      className="p-3 bg-yellow-500 text-gray-900 rounded-lg font-black hover:bg-yellow-600 disabled:opacity-50"
                    >
                      Galben
                    </button>
                    <button
                      onClick={() => handleOverride('ped', 'green')}
                      disabled={loading}
                      className="p-3 bg-green-600 text-white rounded-lg font-black hover:bg-green-700 disabled:opacity-50"
                    >
                      Verde
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* Car Light Control */}
                <div>
                  <h3 className="text-lg font-black text-blue-600 mb-3 flex items-center gap-2">
                    <Car className="w-5 h-5" /> Vehicule
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      onClick={() => handleOverride('car', 'red')}
                      disabled={loading}
                      className="p-3 bg-red-600 text-white rounded-lg font-black hover:bg-red-700 disabled:opacity-50"
                    >
                      Roșu
                    </button>
                    <button
                      onClick={() => handleOverride('car', 'yellow')}
                      disabled={loading}
                      className="p-3 bg-yellow-500 text-gray-900 rounded-lg font-black hover:bg-yellow-600 disabled:opacity-50"
                    >
                      Galben
                    </button>
                    <button
                      onClick={() => handleOverride('car', 'green')}
                      disabled={loading}
                      className="p-3 bg-green-600 text-white rounded-lg font-black hover:bg-green-700 disabled:opacity-50"
                    >
                      Verde
                    </button>
                  </div>
                </div>

                {/* Pedestrian Light Control */}
                <div>
                  <h3 className="text-lg font-black text-purple-600 mb-3 flex items-center gap-2">
                    <PersonStanding className="w-5 h-5" /> Pietoni
                  </h3>
                  {/* Semafoarele de pietoni nu au galben - adaptează grid-ul */}
                  <div className={`grid gap-2 ${isPedestrianLight ? 'grid-cols-2' : 'grid-cols-3'}`}>
                    <button
                      onClick={() => handleOverride('ped', 'red')}
                      disabled={loading}
                      className="p-3 bg-red-600 text-white rounded-lg font-black hover:bg-red-700 disabled:opacity-50"
                    >
                      Roșu
                    </button>
                    {/* Semafoarele de pietoni nu au galben - ascunde butonul dacă e semafor de pietoni */}
                    {!isPedestrianLight && (
                      <button
                        onClick={() => handleOverride('ped', 'yellow')}
                        disabled={loading}
                        className="p-3 bg-yellow-500 text-gray-900 rounded-lg font-black hover:bg-yellow-600 disabled:opacity-50"
                      >
                        Galben
                      </button>
                    )}
                    <button
                      onClick={() => handleOverride('ped', 'green')}
                      disabled={loading}
                      className="p-3 bg-green-600 text-white rounded-lg font-black hover:bg-green-700 disabled:opacity-50"
                    >
                      Verde
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Simulate Detection */}
        <div className="bg-white rounded-xl shadow-lg p-6 border-2 border-green-200">
          <h2 className="text-2xl font-black text-gray-800 mb-4">Simulare Detecție</h2>
          <p className="text-sm text-gray-600 mb-4">Testează sistemul simulând detecții</p>
          {isCarCar ? (
            <div className="space-y-4">
              {intersectionLights.map((light, index) => (
                <div key={light.id} className="p-4 bg-gray-50 rounded-lg border-2 border-gray-200">
                  <h3 className="text-lg font-semibold text-gray-700 mb-3">{light.name || `Semafor ${index + 1}`}</h3>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => handleSimulate('car', index)}
                      disabled={loading}
                      className="p-3 bg-blue-600 text-white rounded-xl font-black hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <Car className="w-5 h-5" /> Simulează Vehicul
                    </button>
                    <button
                      onClick={() => handleSimulate('none', index)}
                      disabled={loading}
                      className="p-3 bg-gray-600 text-white rounded-xl font-black hover:bg-gray-700 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <X className="w-5 h-5" /> Fără Detecție
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <button
                onClick={() => handleSimulate('car')}
                disabled={loading}
                className="p-4 bg-blue-600 text-white rounded-xl font-black hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <Car className="w-5 h-5" /> Simulează Vehicul
              </button>
              <button
                onClick={() => handleSimulate('ped')}
                disabled={loading}
                className="p-4 bg-purple-600 text-white rounded-xl font-black hover:bg-purple-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <PersonStanding className="w-5 h-5" /> Simulează Pieton
              </button>
              <button
                onClick={() => handleSimulate('none')}
                disabled={loading}
                className="p-4 bg-gray-600 text-white rounded-xl font-black hover:bg-gray-700 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <X className="w-5 h-5" /> Fără Detecție
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// --- Component: Zone Editor (for car_car intersections) ---
const ZoneEditor = ({ light, selectedIntersectionId, intersectionLights, setIsEditing, setLocalSettings }) => {
  const currentCustomZones = light.customZones || [];
  const [selectedLightForZone, setSelectedLightForZone] = useState(null);
  const [drawing, setDrawing] = useState(false);
  const [startPos, setStartPos] = useState(null);
  const [zones, setZones] = useState(currentCustomZones);
  const [selectedZoneIndex, setSelectedZoneIndex] = useState(null);
  const [resizing, setResizing] = useState(false);
  const canvasRef = React.useRef(null);
  const videoFeedUrl = selectedIntersectionId 
    ? `http://localhost:8000/video_feed?intersection_id=${selectedIntersectionId}` 
    : "http://localhost:8000/video_feed";
  
  const [isEditingZones, setIsEditingZones] = useState(false);
  
  // Sync zones when light.customZones changes from backend, but only if not editing
  React.useEffect(() => {
    if (!isEditingZones && light.customZones) {
      setZones(light.customZones);
    }
  }, [light.customZones, isEditingZones]);
  
  const getCanvasCoordinates = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  };
  
  const handleMouseDown = (e) => {
    if (selectedLightForZone !== light.id) return;
    const pos = getCanvasCoordinates(e);
    
    // Check if clicking on existing zone (for moving/resizing)
    for (let i = zones.length - 1; i >= 0; i--) {
      const zone = zones[i];
      const zoneRight = zone.x + zone.width;
      const zoneBottom = zone.y + zone.height;
      
      // Check if clicking on resize handle (bottom-right corner)
      const handleSize = 10;
      if (pos.x >= zoneRight - handleSize && pos.x <= zoneRight &&
          pos.y >= zoneBottom - handleSize && pos.y <= zoneBottom) {
        setResizing(true);
        setSelectedZoneIndex(i);
        return;
      }
      
      // Check if clicking inside zone (for moving)
      if (pos.x >= zone.x && pos.x <= zoneRight &&
          pos.y >= zone.y && pos.y <= zoneBottom) {
        setSelectedZoneIndex(i);
        setStartPos({ x: pos.x - zone.x, y: pos.y - zone.y });
        return;
      }
    }
    
    // Start drawing new zone
    setDrawing(true);
    setStartPos(pos);
    setSelectedZoneIndex(null);
  };
  
  const handleMouseMove = (e) => {
    if (selectedLightForZone !== light.id) return;
    const pos = getCanvasCoordinates(e);
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    if (resizing && selectedZoneIndex !== null) {
      // Resize zone
      const zone = zones[selectedZoneIndex];
      const newZones = [...zones];
      newZones[selectedZoneIndex] = {
        ...zone,
        width: Math.max(20, pos.x - zone.x),
        height: Math.max(20, pos.y - zone.y)
      };
      setZones(newZones);
      setIsEditingZones(true);
      
      // Update local settings immediately
      setIsEditing(true);
      const updatedLights = intersectionLights.map(l =>
        l.id === light.id ? { ...l, customZones: newZones } : l
      );
      setLocalSettings(prev => ({
        ...prev,
        _lights: updatedLights
      }));
    } else if (selectedZoneIndex !== null && startPos) {
      // Move zone
      const zone = zones[selectedZoneIndex];
      const newZones = [...zones];
      newZones[selectedZoneIndex] = {
        ...zone,
        x: Math.max(0, Math.min(canvas.width - zone.width, pos.x - startPos.x)),
        y: Math.max(0, Math.min(canvas.height - zone.height, pos.y - startPos.y))
      };
      setZones(newZones);
      setIsEditingZones(true);
      
      // Update local settings immediately
      setIsEditing(true);
      const updatedLights = intersectionLights.map(l =>
        l.id === light.id ? { ...l, customZones: newZones } : l
      );
      setLocalSettings(prev => ({
        ...prev,
        _lights: updatedLights
      }));
    }
  };
  
  const handleMouseUp = (e) => {
    if (drawing && startPos) {
      const pos = getCanvasCoordinates(e);
      const width = Math.abs(pos.x - startPos.x);
      const height = Math.abs(pos.y - startPos.y);
      
      if (width > 10 && height > 10) {
        const newZone = {
          x: Math.min(startPos.x, pos.x),
          y: Math.min(startPos.y, pos.y),
          width: width,
          height: height
        };
        const newZones = [...zones, newZone];
        setZones(newZones);
        setIsEditingZones(true);
        
        // Update local settings immediately
        setIsEditing(true);
        const updatedLights = intersectionLights.map(l =>
          l.id === light.id ? { ...l, customZones: newZones } : l
        );
        setLocalSettings(prev => ({
          ...prev,
          _lights: updatedLights
        }));
      }
    }
    setDrawing(false);
    setResizing(false);
    setStartPos(null);
  };
  
  // Redraw canvas
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    // Set canvas size to match video feed (640x480 is standard, but we'll use actual video dimensions if available)
    // For now, use 640x480 as standard
    canvas.width = 640;
    canvas.height = 480;
    
    // Draw video frame background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw existing zones
    zones.forEach((z, idx) => {
      ctx.strokeStyle = idx === selectedZoneIndex ? '#00ff00' : '#00aaff';
      ctx.lineWidth = 2;
      ctx.strokeRect(z.x, z.y, z.width, z.height);
      ctx.fillStyle = idx === selectedZoneIndex ? 'rgba(0, 255, 0, 0.2)' : 'rgba(0, 170, 255, 0.1)';
      ctx.fillRect(z.x, z.y, z.width, z.height);
      
      // Draw resize handle
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(z.x + z.width - 10, z.y + z.height - 10, 10, 10);
    });
    
    // Draw zone being created
    if (drawing && startPos) {
      const pos = getCanvasCoordinates({ clientX: 0, clientY: 0 });
      const width = pos.x - startPos.x;
      const height = pos.y - startPos.y;
      ctx.strokeStyle = '#00ff00';
      ctx.lineWidth = 2;
      ctx.strokeRect(startPos.x, startPos.y, width, height);
      ctx.fillStyle = 'rgba(0, 255, 0, 0.2)';
      ctx.fillRect(startPos.x, startPos.y, width, height);
    }
  }, [zones, selectedZoneIndex, drawing, startPos]);
  
  return (
    <div className="mb-6 last:mb-0 p-4 bg-gray-50 rounded-lg">
      <div className="flex items-center justify-between mb-3">
        <label className="block text-sm font-semibold text-gray-700">
          {light.name || `Semafor ${light.id + 1}`}:
        </label>
        <div className="flex gap-2">
          <button
            onClick={() => {
              setSelectedLightForZone(selectedLightForZone === light.id ? null : light.id);
              setSelectedZoneIndex(null); // Deselect zone when toggling edit mode
            }}
            className={`px-3 py-1 text-xs rounded ${
              selectedLightForZone === light.id
                ? 'bg-green-600 text-white'
                : 'bg-gray-300 text-gray-700'
            }`}
          >
            {selectedLightForZone === light.id ? 'Editare Activă' : 'Activează Editare'}
          </button>
          {selectedZoneIndex !== null && (
            <button
              onClick={() => {
                const newZones = zones.filter((_, idx) => idx !== selectedZoneIndex);
                setZones(newZones);
                setSelectedZoneIndex(null);
                setIsEditingZones(true);
                
                setIsEditing(true);
                const updatedLights = intersectionLights.map(l =>
                  l.id === light.id ? { ...l, customZones: newZones } : l
                );
                setLocalSettings(prev => ({
                  ...prev,
                  _lights: updatedLights
                }));
              }}
              className="px-3 py-1 text-xs rounded bg-red-500 text-white hover:bg-red-600"
            >
              Șterge Zona
            </button>
          )}
          {isEditingZones && (
            <button
              onClick={async () => {
                // Save zones to backend
                try {
                  const response = await fetch('http://localhost:8000/intersections', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Accept': 'application/json',
                    },
                    body: JSON.stringify({
                      id: selectedIntersectionId,
                      lights: intersectionLights.map(l =>
                        l.id === light.id ? { ...l, customZones: zones } : l
                      )
                    }),
                  });
                  
                  if (response.ok) {
                    setIsEditingZones(false);
                    alert('Zone salvate cu succes!');
                  } else {
                    alert('Eroare la salvarea zonelor');
                  }
                } catch (error) {
                  console.error('Eroare la salvarea zonelor:', error);
                  alert('Eroare la salvarea zonelor');
                }
              }}
              className="px-3 py-1 text-xs rounded bg-blue-500 text-white hover:bg-blue-600"
            >
              Salvează Zone
            </button>
          )}
        </div>
      </div>
      <div className="relative">
        <canvas
          ref={canvasRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          className="border-2 border-gray-300 rounded cursor-crosshair w-full"
          style={{ maxWidth: '640px', height: 'auto' }}
        />
        <img
          src={videoFeedUrl}
          alt="Video Feed"
          className="absolute inset-0 w-full h-full object-contain opacity-30 pointer-events-none"
          style={{ maxWidth: '640px' }}
        />
      </div>
      <p className="text-xs text-gray-500 mt-2">
        {zones.length} zonă/zone configurată/e
      </p>
    </div>
  );
};

// --- Component: Settings Page ---
const SettingsPage = () => {
  const { settings, api, intersections } = useContext(AppContext);
  const [showSaveConfirmation, setShowSaveConfirmation] = useState(false);
  const [localSettings, setLocalSettings] = useState(settings);
  const [saveError, setSaveError] = useState(null);
  const [selectedIntersectionId, setSelectedIntersectionId] = useState(null);
  const [isEditing, setIsEditing] = useState(false); // Flag to prevent auto-update during editing
  const [lastSyncedIntersectionId, setLastSyncedIntersectionId] = useState(null); // Track when intersection changes
  const [availableCameras, setAvailableCameras] = useState([]);
  const [loadingCameras, setLoadingCameras] = useState(false);

  const selectedIntersection = intersections?.find(i => i.id === selectedIntersectionId) || intersections?.[0];
  const intersectionType = selectedIntersection?.type || 'car_pedestrian';
  const isCarCar = intersectionType === 'car_car';
  const intersectionLights = selectedIntersection?.lights || [];
  const currentCameraIndex = selectedIntersection?.cameraIndex ?? 0;

  useEffect(() => {
    if (intersections && intersections.length > 0 && !selectedIntersectionId) {
      setSelectedIntersectionId(intersections[0].id);
    }
  }, [intersections, selectedIntersectionId]);

  // Fetch available cameras
  useEffect(() => {
    const fetchCameras = async () => {
      setLoadingCameras(true);
      try {
        const response = await fetch('http://localhost:8000/cameras');
        if (response.ok) {
          const data = await response.json();
          setAvailableCameras(data.cameras || []);
        }
      } catch (error) {
        console.warn('Could not fetch cameras:', error);
      } finally {
        setLoadingCameras(false);
      }
    };
    fetchCameras();
  }, []);

  useEffect(() => {
    // Only update local settings if:
    // 1. User is not currently editing
    // 2. Selected intersection actually changed (not just polling update)
    if (!isEditing && selectedIntersection && selectedIntersection.settings) {
      // Check if intersection actually changed
      if (selectedIntersectionId !== lastSyncedIntersectionId) {
        const backendSettings = selectedIntersection.settings;
        // cameraIndex is at the root level of intersection, not in settings
        const intersectionCameraIndex = selectedIntersection.cameraIndex !== undefined && selectedIntersection.cameraIndex !== null
          ? selectedIntersection.cameraIndex 
          : 0;
        
        const updatedSettings = {
          ...localSettings,
          id: selectedIntersection.id,
          name: selectedIntersection.name,
          cameraIndex: intersectionCameraIndex,
          carGreenTime: backendSettings.carGreenTime || localSettings.carGreenTime,
          pedGreenTime: backendSettings.pedGreenTime || localSettings.pedGreenTime,
          yellowTime: backendSettings.yellowTime || localSettings.yellowTime,
          allRedSafetyTime: backendSettings.allRedSafetyTime || localSettings.allRedSafetyTime,
          greenLinePreference: backendSettings.greenLinePreference || localSettings.greenLinePreference,
        };
        setLocalSettings(updatedSettings);
        setLastSyncedIntersectionId(selectedIntersectionId);
      } else {
        // Even if intersection didn't change, sync cameraIndex if it changed in backend
        const intersectionCameraIndex = selectedIntersection.cameraIndex !== undefined && selectedIntersection.cameraIndex !== null
          ? selectedIntersection.cameraIndex 
          : 0;
        if (localSettings.cameraIndex !== intersectionCameraIndex && !isEditing) {
          setLocalSettings(prev => ({
            ...prev,
            cameraIndex: intersectionCameraIndex
          }));
        }
      }
    } else if (!selectedIntersection && !isEditing) {
      setLocalSettings(settings);
    }
  }, [selectedIntersectionId, intersections, isEditing, lastSyncedIntersectionId, selectedIntersection]);

  const handleSave = async () => {
    setIsEditing(false); // Stop editing mode
    try {
      // Get current intersection ID from selector
      const intersectionId = selectedIntersectionId || (intersections && intersections.length > 0 
        ? intersections[0].id 
        : settings.id || 'depou-001');
      
      // Get current mode from selected intersection to preserve it
      const currentIntersection = intersections?.find(i => i.id === intersectionId);
      const currentMode = currentIntersection?.settings?.mode || "Automatic";
      
      // Map frontend settings to backend format
      const backendSettings = {
        mode: currentMode, // Preserve current mode, don't reset to Automatic
          greenLinePreference: localSettings.greenLinePreference || "Car",
          carGreenTime: localSettings.carGreenTime || 15,
          pedGreenTime: localSettings.pedGreenTime || 10,
          yellowTime: localSettings.yellowTime || 3,
          allRedSafetyTime: localSettings.allRedSafetyTime || 2
        };
        
        // Update backend settings
        await api.updateIntersectionSettings(intersectionId, backendSettings);
        
        // For car_car intersections, also update lights zones if modified
        if (isCarCar && localSettings._lights) {
          // Update lights configuration via a separate API call
          // We'll need to send the full intersection config with updated lights
          const response = await fetch('http://localhost:8000/intersections', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              id: intersectionId,
              lights: localSettings._lights
            }),
          });
          
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
        }

        // Update cameraIndex if changed
        if (localSettings.cameraIndex !== undefined && localSettings.cameraIndex !== currentCameraIndex) {
          const response = await fetch('http://localhost:8000/intersections', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              id: intersectionId,
              cameraIndex: localSettings.cameraIndex
            }),
          });
          
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
        }
      
      // Update local state (this will also sync to localStorage and backend)
      await api.updateSettings(localSettings);
      
      // Reset sync tracking to allow future updates
      setLastSyncedIntersectionId(intersectionId);
      
      setSaveError(null);
      setShowSaveConfirmation(true);
      setTimeout(() => setShowSaveConfirmation(false), 2000);
    } catch (error) {
      console.error('Eroare la salvarea setărilor:', error);
      setSaveError('Eroare la salvarea setărilor în backend. Verifică că serverul rulează.');
      setTimeout(() => setSaveError(null), 5000);
    }
  };
  
  const handleInputChange = (e) => {
    setIsEditing(true); // Mark as editing to prevent auto-update
    const { name, value, type, checked } = e.target;
    
    // Convert cameraIndex to number explicitly
    let processedValue = value;
    if (name === 'cameraIndex') {
      processedValue = parseInt(value, 10);
    } else if (type === 'checkbox') {
      processedValue = checked;
    } else if (type === 'number') {
      processedValue = Number(value);
    }
    
    setLocalSettings(prev => ({ 
        ...prev, 
        [name]: processedValue
    }));
  };
  
  // Reset editing flag after a delay (when user stops typing)
  useEffect(() => {
    if (isEditing) {
      const timer = setTimeout(() => {
        setIsEditing(false);
      }, 2000); // 2 seconds after last change
      return () => clearTimeout(timer);
    }
  }, [localSettings, isEditing]);
  
  const handleReset = async () => {
    if (window.confirm("Ești sigur că vrei să resetezi toate setările la valorile implicite? Această acțiune nu poate fi anulată.")) {
      try {
        // Get current intersection ID from selector
        const intersectionId = selectedIntersectionId || (intersections && intersections.length > 0 
          ? intersections[0].id 
          : settings.id || 'depou-001');
        
        // Map default settings to backend format
        const backendSettings = {
          mode: "Automatic",
          greenLinePreference: DEFAULT_SETTINGS.greenLinePreference || "Car",
          carGreenTime: DEFAULT_SETTINGS.carGreenTime || 15,
          pedGreenTime: DEFAULT_SETTINGS.pedGreenTime || 10,
          yellowTime: DEFAULT_SETTINGS.yellowTime || 3,
          allRedSafetyTime: DEFAULT_SETTINGS.allRedSafetyTime || 2
        };
        
        // Update backend
        await api.updateIntersectionSettings(intersectionId, backendSettings);
        
        // Update local state (this will also sync to localStorage)
        await api.updateSettings(DEFAULT_SETTINGS);
        setLocalSettings(DEFAULT_SETTINGS);
        
        setSaveError(null);
      } catch (error) {
        console.error('Eroare la resetarea setărilor:', error);
        setSaveError('Eroare la resetarea setărilor în backend. Verifică că serverul rulează.');
        setTimeout(() => setSaveError(null), 5000);
      }
    }
  };

  return (
    <div className="min-h-screen bg-linear-to-br from-green-50 via-emerald-50 to-teal-50 text-gray-900 p-6 md:p-10">
      <header className="mb-8">
        <h1 className="text-4xl font-black text-gray-800 flex items-center gap-3">
          <span className="text-4xl">🌵</span>
          <span className="bg-linear-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent">
            Configurare Sistem
          </span>
        </h1>
        <p className="text-gray-600 mt-2 font-medium">Ajustează timpii, detecția și modurile operaționale.</p>
      </header>
      
      <div className="max-w-4xl mx-auto">
        {/* Intersection Selector */}
        {intersections && intersections.length > 0 && (
          <div className="bg-white rounded-xl shadow-lg p-6 border-2 border-green-200 mb-6">
            <label className="block text-lg font-black text-gray-800 mb-3">
              Selectează Intersecția:
            </label>
            <select
              value={selectedIntersectionId || ''}
              onChange={(e) => {
                setIsEditing(false); // Reset editing when changing intersection
                setSelectedIntersectionId(e.target.value);
                setLastSyncedIntersectionId(null); // Force sync on intersection change
              }}
              className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold"
            >
              {intersections.map(intersection => (
                <option key={intersection.id} value={intersection.id}>
                  {intersection.name} ({intersection.type})
                </option>
              ))}
            </select>
            {selectedIntersection && (
              <p className="text-sm text-gray-600 mt-2">
                Mod curent: <span className="font-bold text-blue-600">{selectedIntersection.settings?.mode || 'Automatic'}</span>
              </p>
            )}
          </div>
        )}

        {/* Camera Selector */}
        {selectedIntersection && (
          <div className="bg-white rounded-xl shadow-lg p-6 border-2 border-green-200 mb-6">
            <label className="flex text-lg font-black text-gray-800 mb-3 items-center gap-2">
              <Camera className="w-5 h-5" />
              Selectează Camera:
            </label>
            {loadingCameras ? (
              <p className="text-gray-600">Se încarcă camerele disponibile...</p>
            ) : (
              <select
                name="cameraIndex"
                value={localSettings.cameraIndex !== undefined ? localSettings.cameraIndex : currentCameraIndex}
                onChange={async (e) => {
                  handleInputChange(e);
                  // Update camera immediately when changed
                  const newCameraIndex = parseInt(e.target.value, 10);
                  if (newCameraIndex !== currentCameraIndex && selectedIntersectionId) {
                    try {
                      const response = await fetch('http://localhost:8000/intersections', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          'Accept': 'application/json',
                        },
                        body: JSON.stringify({
                          id: selectedIntersectionId,
                          cameraIndex: newCameraIndex
                        }),
                      });
                      
                      if (response.ok) {
                        console.log(`Camera updated to index ${newCameraIndex} for intersection ${selectedIntersectionId}`);
                      } else {
                        console.error('Failed to update camera:', response.status);
                      }
                    } catch (error) {
                      console.error('Error updating camera:', error);
                    }
                  }
                }}
                className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold"
              >
                {availableCameras.length > 0 ? (
                  availableCameras.map(camera => (
                    <option key={camera.index} value={camera.index}>
                      {camera.name} (Index: {camera.index})
                    </option>
                  ))
                ) : (
                  <option value={currentCameraIndex}>
                    Camera {currentCameraIndex} (implicită)
                  </option>
                )}
              </select>
            )}
            <p className="text-sm text-gray-600 mt-2">
              Camera curentă: <span className="font-bold text-blue-600">Index {currentCameraIndex}</span>
            </p>
          </div>
        )}

        <div className="bg-white border-2 border-green-200 rounded-3xl shadow-xl p-8">
          <div className="space-y-8">
            <div className="bg-linear-to-br from-green-50 to-emerald-50 p-6 rounded-2xl border-2 border-green-200">
              <label className="flex text-sm font-black text-gray-800 mb-2 items-center gap-2">
                <MapPin className="w-5 h-5 text-green-600" />
                Nume Intersecție
              </label>
              <input 
                type="text"
                name="name"
                value={localSettings.name}
                onChange={handleInputChange}
                className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold"
              />
            </div>
            
            <div className="border-t-2 border-green-200 pt-6">
              <h4 className="text-2xl font-black text-gray-800 mb-4 flex items-center gap-2">
                <Zap className="w-6 h-6 text-green-600" />
                Logica Modului Automatic
              </h4>
              
              <div className="bg-white p-5 rounded-xl border-2 border-green-200 mb-4">
              <label className="block text-sm font-black text-gray-800 mb-2">
                Prioritate Implicită Linie Verde 🌵
              </label>
              <p className="text-xs text-gray-600 mb-3">Sistemul va rămâne pe Verde pentru această parte până când este detectată o cerere din partea opusă.</p>
              {isCarCar ? (
                <select
                  name="greenLinePreference"
                  value={localSettings.greenLinePreference}
                  onChange={handleInputChange}
                  className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold"
                >
                  {intersectionLights.map(light => (
                    <option key={light.id} value={String(light.id)}>
                      🚗 {light.name || `Semafor ${light.id + 1}`}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  name="greenLinePreference"
                  value={localSettings.greenLinePreference}
                  onChange={handleInputChange}
                  className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold"
                >
                  <option value="Car">🚗 Vehicule (Car)</option>
                  <option value="Pedestrian">🚶 Pietoni</option>
                </select>
              )}
              </div>
              
              {/* Configurare Zone Personalizate pentru car_car */}
              {isCarCar && (
                <div className="bg-white p-5 rounded-xl border-2 border-green-200 mb-4">
                  <label className="block text-sm font-black text-gray-800 mb-4">
                    Configurare Zone Personalizate pentru Semafoare 🗺️
                  </label>
                  <p className="text-xs text-gray-600 mb-4">
                    Desenează zone personalizate pentru fiecare semafor. Click și drag pentru a desena un dreptunghi. 
                    Poți muta și redimensiona zonele după ce le-ai creat.
                  </p>
                  {intersectionLights.map(light => (
                    <ZoneEditor
                      key={light.id}
                      light={light}
                      selectedIntersectionId={selectedIntersectionId}
                      intersectionLights={intersectionLights}
                      setIsEditing={setIsEditing}
                      setLocalSettings={setLocalSettings}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="border-t-2 border-green-200 pt-6">
              <h4 className="text-2xl font-black text-gray-800 mb-4 flex items-center gap-2">
                <Eye className="w-6 h-6 text-green-600" />
                Sisteme de Detecție
              </h4>

              <div className="bg-white p-5 rounded-xl border-2 border-green-200 mb-4">
              <label className="flex text-sm font-black text-gray-800 mb-2 items-center gap-2">
                <Cpu className="w-5 h-5 text-green-600" />
                Sensibilitate YOLO (%)
              </label>
              <input 
                type="number"
                min="50"
                max="100"
                name="yoloSensitivity"
                value={localSettings.yoloSensitivity}
                onChange={handleInputChange}
                className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold"
              />
              <p className="text-xs text-gray-600 mt-2">Valori mai mari = mai multe detectări, dar risc de falsuri pozitive</p>
              </div>
            </div>
            
            <div className="border-t-2 border-green-200 pt-6">
              <h4 className="text-2xl font-black text-gray-800 mb-4 flex items-center gap-2">
                <Timer className="w-6 h-6 text-green-600" />
                Parametri de Timp (Manual & Ciclu) ⏱️
              </h4>
              
              <div className="grid md:grid-cols-2 gap-4">
              <div className="bg-white p-5 rounded-xl border-2 border-green-200">
                <label className="flex text-sm font-black text-gray-800 mb-2 items-center gap-2">
                  <Car className="w-5 h-5 text-blue-600" />
                  Timp Verde Vehicule (sec)
                </label>
                <input 
                  type="number"
                  min="5"
                  max="60"
                  name="carGreenTime"
                  value={localSettings.carGreenTime}
                  onChange={handleInputChange}
                  className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold text-center text-xl"
                />
              </div>
              
              <div className="bg-white p-5 rounded-xl border-2 border-green-200">
                <label className="flex text-sm font-black text-gray-800 mb-2 items-center gap-2">
                  <PersonStanding className="w-5 h-5 text-purple-600" />
                  Timp Verde Pietoni (sec)
                </label>
                <input 
                  type="number"
                  min="5"
                  max="30"
                  name="pedGreenTime"
                  value={localSettings.pedGreenTime}
                  onChange={handleInputChange}
                  className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold text-center text-xl"
                />
              </div>

              <div className="bg-white p-5 rounded-xl border-2 border-green-200">
                <label className="flex text-sm font-black text-gray-800 mb-2 items-center gap-2">
                  <AlertCircle className="w-5 h-5 text-yellow-600" />
                  Timp Galben Vehicule (sec)
                </label>
                <input 
                  type="number"
                  min="2"
                  max="5"
                  name="yellowTime"
                  value={localSettings.yellowTime}
                  onChange={handleInputChange}
                  className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold text-center text-xl"
                />
              </div>

              <div className="bg-white p-5 rounded-xl border-2 border-green-200">
                <label className="flex text-sm font-black text-gray-800 mb-2 items-center gap-2">
                  <Shield className="w-5 h-5 text-red-600" />
                  Buffer Roșu Total (sec)
                </label>
                <input 
                  type="number"
                  min="1"
                  max="3"
                  name="allRedSafetyTime"
                  value={localSettings.allRedSafetyTime}
                  onChange={handleInputChange}
                  className="w-full p-3 border-2 border-green-300 bg-white text-gray-900 rounded-xl shadow-sm focus:ring-2 focus:ring-green-500 focus:border-green-500 font-semibold text-center text-xl"
                />
              </div>
              </div>
            </div>
            
            <div className="flex items-center gap-4 pt-6 border-t-2 border-green-200">
              <button
                onClick={handleSave}
                className="flex-1 py-4 bg-linear-to-r from-green-500 to-emerald-500 text-white font-black text-lg rounded-xl hover:shadow-xl transition-all hover:scale-105 flex items-center justify-center gap-2"
              >
                <CheckCircle2 className="w-5 h-5" />
                Salvează Setările 🌵
              </button>
              <button
                onClick={handleReset}
                className="py-4 px-8 bg-red-600 text-white font-black text-lg rounded-xl hover:bg-red-700 transition-all hover:shadow-xl hover:scale-105"
              >
                Resetare
              </button>
              {showSaveConfirmation && (
                <span className="text-green-600 font-black text-lg flex items-center gap-2 animate-pulse">
                  <CheckCircle2 className="w-5 h-5" />
                  Salvat! ✨
                </span>
              )}
              {saveError && (
                <span className="text-red-600 font-bold text-sm flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4" />
                  {saveError}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Main App Component ---
export default function App() {
  const [currentPage, setCurrentPage] = useState('landing');
  
  const apiData = useMockApi(); 

  const navigate = useCallback((path) => {
    setCurrentPage(path);
  }, []);

  const contextValue = useMemo(() => ({
    ...apiData,
    navigate,
  }), [apiData, navigate]);

  const renderPage = useMemo(() => {
    switch (currentPage) {
      case 'control':
        return <ControlPage />;
      case 'settings':
        return <SettingsPage />;
      case 'landing':
      default:
        return <SmartTrafficLanding navigate={navigate} />;
    }
  }, [currentPage, navigate]);

  return (
    <AppContext.Provider value={contextValue}>
      <div className="font-sans">
        {/* Navigation Header */}
        <nav className="sticky top-0 z-50 bg-white border-b-2 border-green-200 shadow-md">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between items-center h-16">
              <div className="flex items-center gap-2">
                <span className="text-2xl">🌵</span>
                <span className="text-2xl font-black bg-linear-to-r from-green-600 to-emerald-600 bg-clip-text text-transparent">SmartTraffic</span>
                <span className="text-sm text-gray-600 font-semibold ml-2">by Cactus Team</span>
              </div>
              <div className="flex space-x-4">
                {pages.map((page) => (
                  <button
                    key={page.path}
                    onClick={() => navigate(page.path)}
                    className={`flex items-center px-3 py-2 rounded-md text-sm font-medium transition-colors duration-200 ${
                      currentPage === page.path
                        ? 'bg-linear-to-r from-green-500 to-emerald-500 text-white shadow-lg shadow-green-200/50'
                        : 'text-gray-600 hover:bg-green-50 hover:text-green-600'
                    }`}
                  >
                    <page.icon className="w-5 h-5 mr-1" />
                    {page.name}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </nav>

        <main>
          {renderPage}
        </main>
      </div>
    </AppContext.Provider>
  );
}
