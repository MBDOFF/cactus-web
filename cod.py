from fastapi import FastAPI
from pydantic import BaseModel
import serial
import time
import atexit

# Configurare serial
ser = serial.Serial('/dev/ttyUSB0', 9600, timeout=1)
time.sleep(2)  # așteaptă Arduino

app = FastAPI()

# Status pinuri
# 0 = OFF, 1 = ON (aplicat conform noii logici)
pin_status = {
    10: 0,  # pedestri (off = rosu, on = verde)
    8: 0,   # masini rosu (off = aprins, on = stins)
    9: 0    # masini galben/verde (0 = galben, 1 = verde)
}

class PinRequest(BaseModel):
    pin: int
    value: int  # 0/1

def set_pin(pin: int, value: int):
    """Trimite comanda la Arduino și actualizează statusul."""
    ser.write(f"{pin},{'HIGH' if value else 'LOW'}\n".encode())
    pin_status[pin] = value

@app.get("/status")
def get_status():
    return pin_status

@app.post("/pin")
def set_pin_direct(req: PinRequest):
    set_pin(req.pin, req.value)
    return {"pin": req.pin, "value": req.value}

@app.post("/control")
def control(req: PinRequest):
    """
    Control simplificat conform noii logici:
    - 10 = pedestri
    - 8 = masini rosu
    - 9 = masini galben/verde
    """
    set_pin(req.pin, req.value)
    # Reguli simple: dacă pedestri verde, masini rosu ON
    if req.pin == 10 and req.value == 1:
        set_pin(8, 1)  # masini rosu OFF
        set_pin(9, 1)  # masini verde ON
    elif req.pin == 10 and req.value == 0:
        set_pin(8, 0)  # masini rosu ON
        set_pin(9, 0)  # masini galben ON
    return {"pin": req.pin, "value": req.value}

# Cleanup la inchidere
@atexit.register
def cleanup():
    for pin in pin_status.keys():
        set_pin(pin, 0)
    ser.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8014)
