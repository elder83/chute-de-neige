#!/usr/bin/env python3
"""Alertes ntfy, lancées par .github/workflows/alertes-neige.yml :
  1. neige prévue (72 h) au-dessus du seuil sur les spots configurés ;
  2. « session possible » (vent dans la plage, + neige au sol pour le snowkite)
     sur les favoris / spots avec cloche et mes spots perso.

Variables d'environnement :
  NTFY_TOPIC  sujet ntfy secret (obligatoire pour envoyer)
  NTFY_SERVER serveur ntfy (défaut https://ntfy.sh)
"""
import json, math, os, sys, urllib.parse, urllib.request, datetime, pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
STATE = ROOT / ".alert-state.json"
KN = 1.852
DIRS = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]
DEFAULT_RANGES = {  # km/h
    "kite": {"windMin": 15, "windMax": 40, "gustMax": 55, "minSnow": 10},
    "kitesea": {"windMin": 22, "windMax": 56, "gustMax": 70},
    "wing": {"windMin": 22, "windMax": 52, "gustMax": 65},
    "windsurf": {"windMin": 26, "windMax": 65, "gustMax": 78},
}
LABEL = {"kite": "snowkite", "kitesea": "kite", "wing": "wing", "windsurf": "planche"}


def haversine(a, b):
    r = math.pi / 180
    dlat, dlon = (b["lat"] - a["lat"]) * r, (b["lon"] - a["lon"]) * r
    x = math.sin(dlat / 2) ** 2 + math.cos(a["lat"] * r) * math.cos(b["lat"] * r) * math.sin(dlon / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))


def forecast(spots, params):
    """Prévisions Open-Meteo pour une liste de spots (par paquets de 40)."""
    out = []
    for i in range(0, len(spots), 40):
        chunk = spots[i:i + 40]
        q = urllib.parse.urlencode({
            "latitude": ",".join(str(s["lat"]) for s in chunk),
            "longitude": ",".join(str(s["lon"]) for s in chunk),
            "elevation": ",".join(str(s.get("alt", 0)) for s in chunk),
            "timezone": "Europe/Paris", **params,
        })
        with urllib.request.urlopen(f"https://api.open-meteo.com/v1/forecast?{q}", timeout=60) as r:
            data = json.load(r)
        out += data if isinstance(data, list) else [data]
    return out


def send(title, body, tags):
    topic = os.environ.get("NTFY_TOPIC")
    if not topic:
        print("NTFY_TOPIC absent : alerte non envoyée.", file=sys.stderr)
        return False
    server = os.environ.get("NTFY_SERVER", "https://ntfy.sh").rstrip("/")
    req = urllib.request.Request(f"{server}/{topic}", data=body.encode(), method="POST",
                                 headers={"Title": title, "Tags": tags, "Priority": "high"})
    urllib.request.urlopen(req, timeout=30)
    return True


def snow_alerts(cfg, spots, state):
    home, radius = cfg["home"], cfg.get("radius_km", 400)
    targets = []
    for s in spots:
        thr = cfg.get("spots", {}).get(s["id"])
        if thr is None and cfg.get("alert_all_in_radius") and haversine(home, s) <= radius:
            thr = cfg.get("default_threshold_cm", 20)
        if thr is not None:
            targets.append((s, thr))
    if not targets:
        print("Neige : aucun spot à surveiller.")
        return
    data = forecast([s for s, _ in targets], {"daily": "snowfall_sum", "forecast_days": 3})
    hits = []
    for (s, thr), w in zip(targets, data):
        snow = sum(v or 0 for v in w["daily"]["snowfall_sum"])
        print(f"{s['name']:35s} {snow:5.1f} cm (seuil {thr})")
        if snow >= thr:
            hits.append((s, snow))
    today = datetime.date.today().isoformat()
    fresh = [(s, n) for s, n in hits if state.get(s["id"]) != today]
    if not fresh:
        print("Neige : pas de nouvelle alerte.")
        return
    fresh.sort(key=lambda x: -x[1])
    body = "\n".join(f"{s['name']} : {n:.0f} cm" for s, n in fresh)
    if send(f"Neige annoncee sur {len(fresh)} spot(s) - 72 h", body, "snowflake"):
        for s, _ in fresh:
            state[s["id"]] = today
        print(f"Neige : notification envoyée ({len(fresh)} spot(s)).")


def session_alerts(cfg, spots, state):
    if not cfg.get("session_alert"):
        print("Sessions : alerte désactivée.")
        return
    horizon = int(cfg.get("session_horizon_days", 3))
    ranges = {**DEFAULT_RANGES, **cfg.get("ranges_kmh", {})}
    ids = set(cfg.get("session_spots", []))
    targets = [s for s in spots if s["id"] in ids and s.get("type") in ("kite", "both")]
    targets += cfg.get("my_spots", [])
    if not targets:
        print("Sessions : aucun spot à surveiller.")
        return
    data = forecast(targets, {
        "daily": "wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,weather_code",
        "hourly": "snow_depth", "forecast_days": horizon,
    })
    hits = []
    for s, w in zip(targets, data):
        sport = s.get("sport") or "kite"
        r = ranges.get(sport, DEFAULT_RANGES["kitesea"])
        d, h = w["daily"], w.get("hourly", {})
        for i, day in enumerate(d["time"]):
            wind, gust, code = d["wind_speed_10m_max"][i], d["wind_gusts_10m_max"][i], d["weather_code"][i]
            if wind is None or gust is None:
                continue
            ok = r["windMin"] <= wind <= r["windMax"] and gust <= r["gustMax"] and (code or 0) < 95
            if ok and sport == "kite":
                try:
                    depth = h["snow_depth"][h["time"].index(f"{day}T12:00")] or 0
                except (KeyError, ValueError):
                    depth = 0
                ok = depth * 100 >= r.get("minSnow", 10)
            if ok:
                dirn = DIRS[round((d["wind_direction_10m_dominant"][i] or 0) / 45) % 8]
                hits.append((s, day, f"{wind / KN:.0f} nds {dirn}, raf. {gust / KN:.0f}"))
                print(f"Session {s['name']} {day} : {wind / KN:.0f} nds")
    fresh = [(s, day, t) for s, day, t in hits if f"{s['id']}:{day}" not in state]
    if not fresh:
        print("Sessions : pas de nouvelle session.")
        return
    jours = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"]
    lab = lambda day: f"{jours[datetime.date.fromisoformat(day).weekday()]} {int(day[8:])}"
    body = "\n".join(f"{s['name']} ({LABEL.get(s.get('sport') or 'kite', 'kite')}) · {lab(day)} · {t}" for s, day, t in fresh)
    if send(f"Session possible sur {len({s['id'] for s, _, _ in fresh})} spot(s)", body, "kite,wind_face"):
        for s, day, _ in fresh:
            state[f"{s['id']}:{day}"] = datetime.date.today().isoformat()
        print(f"Sessions : notification envoyée ({len(fresh)} créneau(x)).")


def main():
    cfg = json.loads((ROOT / "alerts-config.json").read_text())
    spots = json.loads((ROOT / "spots.json").read_text())
    osm = ROOT / "spots-osm.json"
    if osm.exists():
        spots += json.loads(osm.read_text())
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    snow_alerts(cfg, spots, state)
    session_alerts(cfg, spots, state)
    # on oublie les clés de plus de 20 jours
    limit = (datetime.date.today() - datetime.timedelta(days=20)).isoformat()
    state = {k: v for k, v in state.items() if v >= limit}
    STATE.write_text(json.dumps(state))


if __name__ == "__main__":
    main()
