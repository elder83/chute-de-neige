#!/usr/bin/env python3
"""Vérifie la neige prévue (72 h) sur les spots configurés et envoie une
notification ntfy. Lancé par .github/workflows/alertes-neige.yml.

Variables d'environnement :
  NTFY_TOPIC  sujet ntfy secret (obligatoire pour envoyer)
  NTFY_SERVER serveur ntfy (défaut https://ntfy.sh)
"""
import json, math, os, sys, urllib.parse, urllib.request, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
STATE = ROOT / ".alert-state.json"


def haversine(a, b):
    r = math.pi / 180
    dlat, dlon = (b["lat"] - a["lat"]) * r, (b["lon"] - a["lon"]) * r
    x = math.sin(dlat / 2) ** 2 + math.cos(a["lat"] * r) * math.cos(b["lat"] * r) * math.sin(dlon / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))


def main():
    cfg = json.loads((ROOT / "alerts-config.json").read_text())
    spots = json.loads((ROOT / "spots.json").read_text())
    osm = ROOT / "spots-osm.json"
    if osm.exists():
        spots += json.loads(osm.read_text())
    home, radius = cfg["home"], cfg.get("radius_km", 400)
    targets = []
    for s in spots:
        thr = cfg.get("spots", {}).get(s["id"])
        if thr is None and cfg.get("alert_all_in_radius") and haversine(home, s) <= radius:
            thr = cfg.get("default_threshold_cm", 20)
        if thr is not None:
            targets.append((s, thr))
    if not targets:
        print("Aucun spot à surveiller.")
        return

    hits = []
    for i in range(0, len(targets), 40):
        chunk = targets[i:i + 40]
        q = urllib.parse.urlencode({
            "latitude": ",".join(str(s["lat"]) for s, _ in chunk),
            "longitude": ",".join(str(s["lon"]) for s, _ in chunk),
            "elevation": ",".join(str(s["alt"]) for s, _ in chunk),
            "daily": "snowfall_sum",
            "forecast_days": 3,
            "timezone": "Europe/Paris",
        })
        with urllib.request.urlopen(f"https://api.open-meteo.com/v1/forecast?{q}", timeout=30) as r:
            data = json.load(r)
        if isinstance(data, dict):
            data = [data]
        for (s, thr), w in zip(chunk, data):
            snow = sum(v or 0 for v in w["daily"]["snowfall_sum"])
            print(f"{s['name']:35s} {snow:5.1f} cm (seuil {thr})")
            if snow >= thr:
                hits.append((s, snow))

    # une seule notification par spot et par jour
    today = datetime.date.today().isoformat()
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    fresh = [(s, n) for s, n in hits if state.get(s["id"]) != today]
    if not fresh:
        print("Pas de nouvelle alerte.")
        return
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        print("NTFY_TOPIC absent : alerte non envoyée.", file=sys.stderr)
        return
    fresh.sort(key=lambda x: -x[1])
    body = "\n".join(f"{s['name']} : {n:.0f} cm" for s, n in fresh)
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    req = urllib.request.Request(f"{server}/{topic}", data=body.encode(), method="POST", headers={
        "Title": f"Neige annoncee sur {len(fresh)} spot(s) - 72 h",
        "Tags": "snowflake",
        "Priority": "high",
    })
    urllib.request.urlopen(req, timeout=30)
    for s, _ in fresh:
        state[s["id"]] = today
    STATE.write_text(json.dumps(state))
    print(f"Notification envoyée ({len(fresh)} spot(s)).")


if __name__ == "__main__":
    main()
