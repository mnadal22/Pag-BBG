"""FRED (Fed de St. Louis). Key gratis: https://fredaccount.stlouisfed.org/apikeys
Límite: 120 consultas/minuto, así que espaciamos las llamadas."""
import os
import time

import pandas as pd
import requests

URL = "https://api.stlouisfed.org/fred/series/observations"
_last_call = 0.0


def fetch(code: str, start: str) -> pd.Series:
    global _last_call
    key = os.environ.get("FRED_API_KEY")
    if not key:
        raise RuntimeError("Falta FRED_API_KEY")
    wait = 0.6 - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()

    for attempt in range(3):
        r = requests.get(
            URL,
            params={"series_id": code, "api_key": key, "file_type": "json", "observation_start": start},
            timeout=30,
        )
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(5 * (attempt + 1))
            continue
        r.raise_for_status()
        break
    else:
        r.raise_for_status()

    obs = r.json().get("observations", [])
    data = {o["date"]: float(o["value"]) for o in obs if o.get("value") not in (".", "", None)}
    s = pd.Series(data, dtype="float64")
    s.index = pd.to_datetime(s.index)
    return s.sort_index()
