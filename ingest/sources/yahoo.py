"""Yahoo Finance vía yfinance (sin key; no oficial, puede fallar a ratos).
Se descargan todos los tickers juntos para hacer pocas consultas."""
import pandas as pd
import yfinance as yf


def fetch_many(codes: list[str], start: str) -> dict[str, pd.Series]:
    df = yf.download(
        codes,
        start=start,
        interval="1d",
        auto_adjust=False,
        progress=False,
        threads=True,
        group_by="column",
    )
    out: dict[str, pd.Series] = {}
    if df is None or df.empty:
        return out
    close = df["Close"]
    if isinstance(close, pd.Series):  # un solo ticker
        close = close.to_frame(codes[0])
    for code in codes:
        if code in close.columns:
            s = close[code].dropna().astype("float64")
            if not s.empty:
                s.index = pd.to_datetime(s.index).tz_localize(None).normalize()
                out[code] = s[~s.index.duplicated(keep="last")].sort_index()
    return out
