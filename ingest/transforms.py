"""Indicadores derivados y estadísticas de resumen (snapshot)."""
import math

import numpy as np
import pandas as pd


def _align(a: pd.Series, b: pd.Series) -> pd.DataFrame:
    df = pd.concat([a.rename("a"), b.rename("b")], axis=1).sort_index().ffill()
    return df.dropna()


def derive(op: str, inputs: list[pd.Series], scale: float = 1.0) -> pd.Series:
    if op == "spread":
        df = _align(*inputs)
        s = df["a"] - df["b"]
    elif op == "ratio":
        df = _align(*inputs)
        s = df["a"] / df["b"].replace(0, np.nan)
    elif op == "yoy":
        a = inputs[0].dropna()
        base = a.asof(a.index - pd.DateOffset(years=1))
        s = pd.Series(a.values / base.values - 1, index=a.index) * 100
    else:
        raise ValueError(f"Operación desconocida: {op}")
    return (s * scale).replace([np.inf, -np.inf], np.nan).dropna()


def _val_at(s: pd.Series, date: pd.Timestamp):
    v = s.asof(date)
    return None if v is None or (isinstance(v, float) and math.isnan(v)) else float(v)


def snapshot(s: pd.Series, unit: str) -> dict:
    """Último valor y variaciones. Para % y pb la variación es absoluta; si no, en %."""
    s = s.dropna()
    last_d, last = s.index[-1], float(s.iloc[-1])
    absolute = unit in ("%", "pb")

    def chg(ref):
        if ref is None:
            return None
        if absolute:
            return last - ref
        return None if ref == 0 else (last / ref - 1) * 100

    prev = float(s.iloc[-2]) if len(s) > 1 else None
    ytd_ref = _val_at(s, pd.Timestamp(year=last_d.year, month=1, day=1) - pd.Timedelta(days=1))
    y1 = s[s.index > last_d - pd.DateOffset(years=1)]
    z = None
    if len(y1) > 5 and y1.std() > 0:
        z = (last - y1.mean()) / y1.std()
    return {
        "date": last_d.strftime("%Y-%m-%d"),
        "last": last,
        "chg_kind": "abs" if absolute else "pct",
        "d1": chg(prev),
        "w1": chg(_val_at(s, last_d - pd.Timedelta(days=7))),
        "m1": chg(_val_at(s, last_d - pd.DateOffset(months=1))),
        "ytd": chg(ytd_ref),
        "y1": chg(_val_at(s, last_d - pd.DateOffset(years=1))),
        "hi52": float(y1.max()),
        "lo52": float(y1.min()),
        "z1y": z,
    }
