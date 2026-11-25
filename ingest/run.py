"""Descarga todo el catálogo, calcula derivados y escribe JSON estáticos.

Uso:  python -m ingest.run --catalog catalog/indicators.yaml --out site/data

Salida:
  <out>/catalog.json        metadatos + estado de cada indicador
  <out>/snapshot.json       último valor y variaciones (para tablas tipo monitor)
  <out>/series/<ID>.json    historia completa {"d": [fechas], "v": [valores]}

Si una serie falla y está definida FALLBACK_BASE_URL (la URL del sitio publicado),
se reutiliza la última versión publicada para no perderla.
"""
import argparse
import datetime as dt
import json
import logging
import math
import os
import sys
from pathlib import Path

import pandas as pd
import requests
import yaml

from ingest import transforms
from ingest.sources import bcch, fred, yahoo

log = logging.getLogger("ingest")


def _clean(x, nd=6):
    if x is None or (isinstance(x, float) and (math.isnan(x) or math.isinf(x))):
        return None
    return round(float(x), nd)


def _fallback(sid: str) -> pd.Series | None:
    base = os.environ.get("FALLBACK_BASE_URL", "").rstrip("/")
    if not base:
        return None
    try:
        r = requests.get(f"{base}/data/series/{sid}.json", timeout=20)
        r.raise_for_status()
        j = r.json()
        return pd.Series(j["v"], index=pd.to_datetime(j["d"]), dtype="float64")
    except Exception as e:  # noqa: BLE001
        log.warning("  sin respaldo para %s: %s", sid, e)
        return None


def fetch_all(series_cfg: list[dict], start: str) -> tuple[dict, dict]:
    data: dict[str, pd.Series] = {}
    status: dict[str, str] = {}

    # Yahoo: una sola descarga para todos los tickers
    ycfg = [c for c in series_cfg if c["src"] == "yahoo"]
    if ycfg:
        log.info("Yahoo: %d tickers", len(ycfg))
        try:
            got = yahoo.fetch_many([c["code"] for c in ycfg], start)
        except Exception as e:  # noqa: BLE001
            log.error("Yahoo falló completo: %s", e)
            got = {}
        for c in ycfg:
            if c["code"] in got:
                data[c["id"]], status[c["id"]] = got[c["code"]], "ok"
            else:
                status[c["id"]] = "error: sin datos de Yahoo"

    fetchers = {"fred": fred.fetch, "bcch": bcch.fetch}
    for c in series_cfg:
        if c["src"] == "yahoo":
            continue
        try:
            s = fetchers[c["src"]](c["code"], c.get("start", start))
            if s.empty:
                raise RuntimeError("serie vacía")
            data[c["id"]], status[c["id"]] = s, "ok"
            log.info("  ok  %-10s %s:%s (%d obs)", c["id"], c["src"], c["code"], len(s))
        except Exception as e:  # noqa: BLE001
            status[c["id"]] = f"error: {e}"
            log.error("  ERR %-10s %s:%s -> %s", c["id"], c["src"], c["code"], e)

    # Respaldo con la última versión publicada
    for sid, st in list(status.items()):
        if st != "ok":
            s = _fallback(sid)
            if s is not None and not s.empty:
                data[sid] = s
                status[sid] = "stale (" + st + ")"
                log.warning("  usando versión publicada anterior para %s", sid)
    return data, status


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--catalog", default="catalog/indicators.yaml")
    ap.add_argument("--out", default="site/data")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")

    cfg = yaml.safe_load(Path(args.catalog).read_text(encoding="utf-8"))
    start = cfg.get("defaults", {}).get("start", "2000-01-01")
    series_cfg = cfg.get("series", [])
    derived_cfg = cfg.get("derived", []) or []

    ids = [c["id"] for c in series_cfg + derived_cfg]
    dup = {i for i in ids if ids.count(i) > 1}
    if dup:
        log.error("IDs duplicados en el catálogo: %s", dup)
        return 2

    data, status = fetch_all(series_cfg, start)

    for c in derived_cfg:
        missing = [a for a in c["args"] if a not in data]
        if missing:
            status[c["id"]] = f"error: faltan {missing}"
            continue
        try:
            data[c["id"]] = transforms.derive(c["op"], [data[a] for a in c["args"]], c.get("scale", 1.0))
            status[c["id"]] = "ok"
        except Exception as e:  # noqa: BLE001
            status[c["id"]] = f"error: {e}"

    out = Path(args.out)
    (out / "series").mkdir(parents=True, exist_ok=True)
    catalog, snap = [], []
    for c in series_cfg + [dict(d, src="derived") for d in derived_cfg]:
        sid = c["id"]
        meta = {k: c.get(k) for k in ("id", "name", "cat", "src", "code", "unit", "op", "args")}
        meta = {k: v for k, v in meta.items() if v is not None}
        meta["dec"] = c.get("dec", 2)
        meta["status"] = status.get(sid, "error")
        s = data.get(sid)
        if s is not None and not s.dropna().empty:
            s = s.dropna()
            meta.update(first=s.index[0].strftime("%Y-%m-%d"), last=s.index[-1].strftime("%Y-%m-%d"), n=len(s))
            (out / "series" / f"{sid}.json").write_text(
                json.dumps(
                    {"id": sid, "d": [d.strftime("%Y-%m-%d") for d in s.index], "v": [_clean(v) for v in s.values]},
                    separators=(",", ":"),
                )
            )
            row = transforms.snapshot(s, c.get("unit", ""))
            snap.append({"id": sid, **{k: (_clean(v) if not isinstance(v, str) else v) for k, v in row.items()}})
        catalog.append(meta)

    now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    (out / "catalog.json").write_text(json.dumps({"generated": now, "indicators": catalog}, ensure_ascii=False, indent=1))
    (out / "snapshot.json").write_text(json.dumps({"generated": now, "rows": snap}, ensure_ascii=False, separators=(",", ":")))

    ok = sum(1 for v in status.values() if v == "ok")
    stale = sum(1 for v in status.values() if v.startswith("stale"))
    bad = {k: v for k, v in status.items() if v.startswith("error")}
    log.info("\nResumen: %d ok, %d con datos anteriores, %d con error (de %d)", ok, stale, len(bad), len(ids))
    for k, v in bad.items():
        log.info("  %s: %s", k, v)

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"### Actualización de datos\n\n{ok} ok · {stale} con datos anteriores · {len(bad)} con error\n\n")
            for k, v in {**bad, **{k: v for k, v in status.items() if v.startswith('stale')}}.items():
                f.write(f"- `{k}`: {v}\n")

    # Falla el job (y no publica) solo si se cayó más de la mitad
    return 1 if (ok + stale) < len(ids) / 2 else 0


if __name__ == "__main__":
    sys.exit(main())
