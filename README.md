# ❄️ Chute de Neige

Petite appli web (installable sur téléphone) pour suivre les **spots de snowkite** et les **stations de ski** en France (≈ 215 sites : une liste choisie à la main + toutes les stations d'OpenStreetMap) :

- 📍 position par GPS ou par ville (Hyères par défaut) + **rayon réglable** (50 → 1200 km)
- 🌡️ météo actuelle, **neige au sol**, neige tombée sur 48 h, prévisions **14 jours** (neige, températures, vent)
- 🪁 indicateur **vent kite** (bon entre 12 et 40 km/h, rafales < 55 km/h) et tri par conditions de vent
- 📷 liens **webcams**, site de la station, Windy, itinéraire Google Maps, bulletin avalanche
- 📅 mode **Sessions 14 j** : n'affiche que les spots où une session kite (neige au sol + vent dans ta plage) ou poudreuse (≥ 10 cm frais puis accalmie) est prévue dans les 2 semaines
- 🗺️ vue **carte** avec boutons pour afficher les spots kite (losanges) et/ou les stations (ronds) ; vert = session prévue, bleu = neige à venir
- ⚙️ réglages de session kite : vent mini/maxi, rafales maxi, neige au sol mini
- ⭐ favoris et 🔔 **alertes chute de neige par station** (seuil en cm sur 72 h), avec notification
- fonctionne hors ligne avec les dernières données

Météo : [Open-Meteo](https://open-meteo.com/) (gratuit, sans clé, modèles Météo-France AROME/ARPEGE, ECMWF…), calculée à l'altitude de chaque spot.

## Mettre l'appli en ligne (GitHub Pages, gratuit)

1. Sur GitHub : **Settings → Pages → Build and deployment → Deploy from a branch**, choisir la branche et le dossier `/ (root)`.
2. L'appli est disponible sur `https://<ton-pseudo>.github.io/chute-de-neige/`.
3. Sur le téléphone, ouvrir ce lien puis **« Ajouter à l'écran d'accueil »** (Safari : bouton Partager ; Chrome : menu ⋮).

Pour tester en local : `python3 -m http.server` puis ouvrir http://localhost:8000.

## Alertes

**Dans l'appli** : bouton 🔔 sur une fiche pour fixer un seuil pour cette station, ou cocher « alerter pour tous les spots dans mon rayon ». Les notifications partent quand l'appli est ouverte (vérification toutes les 30 min).

**Même appli fermée (push sur le téléphone, via ntfy)** :

1. Installer l'appli gratuite **ntfy** (Android / iPhone) et s'abonner à un sujet secret, ex. `neige-hyeres-8f3k`.
2. Sur GitHub : **Settings → Secrets and variables → Actions → New repository secret**, nom `NTFY_TOPIC`, valeur = ton sujet.
3. Dans l'appli, menu 🔔 Alertes → « Copier ma config d'alertes », et coller le résultat dans `alerts-config.json`.
4. Le workflow `.github/workflows/alertes-neige.yml` vérifie toutes les 3 h et t'envoie une notification (une par spot et par jour maximum). Lancement manuel possible dans l'onglet **Actions**.

## Liste des stations

- `spots.json` : spots de snowkite et stations choisis à la main (modifiable).
- `spots-osm.json` : toutes les autres stations de France, générées depuis OpenStreetMap par le workflow **Mise à jour des stations** (onglet Actions → Run workflow).

## Ajouter / modifier un spot

Tout est dans `spots.json` :

```json
{"id":"monspot","name":"Mon spot","type":"kite","massif":"…","lat":45.0,"lon":6.4,"alt":2000,
 "info":"description", "web":"https://site-station", "webcam":"https://lien-direct-webcam"}
```

`type` : `kite`, `ski` ou `both`. Sans champ `webcam`, le bouton 📷 lance une recherche des webcams en direct de la station.

⚠️ Les distances sont à vol d'oiseau. Vérifie toujours le bulletin d'estimation du risque d'avalanche (BRA) et l'ouverture des cols avant de partir.
