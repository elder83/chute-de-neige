#!/usr/bin/env python3
"""Génère spots-osm.json : toutes les stations de ski de France d'après
OpenStreetMap (landuse=winter_sports), avec l'altitude (Open-Meteo).
Les stations déjà présentes dans spots.json (liste manuelle) sont ignorées."""
import json, math, pathlib, re, unicodedata, urllib.parse, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = {"User-Agent": "chute-de-neige-app/1.0"}
QUERY = """
[out:json][timeout:180];
area["ISO3166-1"="FR"][admin_level=2]->.fr;
( way["landuse"="winter_sports"]["name"](area.fr);
  relation["landuse"="winter_sports"]["name"](area.fr); );
out tags bb;
"""


def km(a, b):
    r = math.pi / 180
    x = math.sin((b[0] - a[0]) * r / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin((b[1] - a[1]) * r / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))


def slug(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def region(lat, lon):
    if lon > 8.4 and lat < 43.1: return "Corse"
    if lat < 43.4 and lon < 3.3: return "Pyrénées"
    if lat > 47.6 and lon > 6.2: return "Vosges"
    if 46.2 < lat < 47.6 and lon < 6.25 and lon > 5.3: return "Jura"
    if lon < 4.6: return "Massif Central"
    return "Alpes"


def main():
    req = urllib.request.Request("https://overpass-api.de/api/interpreter",
                                 data=urllib.parse.urlencode({"data": QUERY}).encode(), headers=UA)
    els = json.load(urllib.request.urlopen(req, timeout=300))["elements"]
    print("éléments OSM :", len(els))
    cands = []
    for e in els:
        b = e.get("bounds")
        if not b: continue
        lat, lon = (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2
        if not (41.2 < lat < 51.5 and -5.5 < lon < 10): continue
        size = km((b["minlat"], b["minlon"]), (b["maxlat"], b["maxlon"]))
        if size < 0.8: continue  # luges, petits téléskis isolés
        t = e["tags"]
        cands.append({"name": t["name"].strip(), "lat": round(lat, 4), "lon": round(lon, 4), "size": size,
                      "ele": t.get("ele"), "web": t.get("website") or t.get("contact:website")})
    cands.sort(key=lambda c: -c["size"])

    curated = json.loads((ROOT / "spots.json").read_text())
    kept = []
    for c in cands:
        p = (c["lat"], c["lon"])
        if any(km(p, (s["lat"], s["lon"])) < 4 for s in curated): continue
        if any(km(p, (k["lat"], k["lon"])) < 2.5 or (k["name"].lower() == c["name"].lower() and km(p, (k["lat"], k["lon"])) < 15) for k in kept): continue
        kept.append(c)
    print("stations retenues :", len(kept))

    # altitude
    for i in range(0, len(kept), 100):
        ch = kept[i:i + 100]
        q = urllib.parse.urlencode({"latitude": ",".join(str(c["lat"]) for c in ch),
                                    "longitude": ",".join(str(c["lon"]) for c in ch)})
        el = json.load(urllib.request.urlopen(urllib.request.Request(f"https://api.open-meteo.com/v1/elevation?{q}", headers=UA), timeout=60))["elevation"]
        for c, e in zip(ch, el): c["alt"] = int(round(e))

    out, ids = [], {s["id"] for s in curated}
    for c in sorted(kept, key=lambda c: c["name"]):
        if c["alt"] < 500: continue
        near = min(curated, key=lambda s: km((c["lat"], c["lon"]), (s["lat"], s["lon"])))
        massif = near["massif"] if km((c["lat"], c["lon"]), (near["lat"], near["lon"])) < 30 else region(c["lat"], c["lon"])
        sid = "osm-" + slug(c["name"])
        while sid in ids: sid += "-2"
        ids.add(sid)
        s = {"id": sid, "name": c["name"], "type": "ski", "massif": massif, "lat": c["lat"], "lon": c["lon"], "alt": c["alt"]}
        if c["web"] and c["web"].startswith("http"): s["web"] = c["web"]
        out.append(s)
    (ROOT / "spots-osm.json").write_text("[\n" + ",\n".join(json.dumps(s, ensure_ascii=False) for s in out) + "\n]\n")
    print("écrit :", len(out))


if __name__ == "__main__":
    main()
