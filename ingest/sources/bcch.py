"""API BDE del Banco Central de Chile (gratis con cuenta BDE habilitada para API).
https://si3.bcentral.cl/estadisticas/Principal1/Web_Services/index.htm
Usa las mismas credenciales de la BDE (correo y contraseña)."""
import datetime as dt
import math
import os

import pandas as pd
import requests

URL = "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx"


def fetch(code: str, start: str) -> pd.Series:
    user, pwd = os.environ.get("BCCH_USER"), os.environ.get("BCCH_PASS")
    if not user or not pwd:
        raise RuntimeError("Faltan BCCH_USER / BCCH_PASS")
    r = requests.get(
        URL,
        params={
            "user": user,
            "pass": pwd,
            "firstdate": start,
            "lastdate": dt.date.today().isoformat(),
            "timeseries": code,
            "function": "GetSeries",
        },
        timeout=60,
    )
    r.raise_for_status()
    j = r.json()
    if j.get("Codigo") not in (0, "0"):
        raise RuntimeError(f"BCCh: {j.get('Descripcion')}")
    obs = (j.get("Series") or {}).get("Obs") or []
    data = {}
    for o in obs:
        try:
            v = float(str(o.get("value")).replace(",", "."))
        except ValueError:
            continue
        if math.isnan(v):
            continue
        data[o["indexDateString"]] = v
    s = pd.Series(data, dtype="float64")
    s.index = pd.to_datetime(s.index, format="%d-%m-%Y")
    return s.sort_index()
