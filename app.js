/* Chute de Neige — spots snowkite & ski, météo, sessions, webcams, alertes neige */
'use strict';

const HYERES = { lat: 43.1204, lon: 6.1286, label: 'Hyères' };
const CACHE_MIN = 30;           // durée de cache météo (minutes)
const CHECK_EVERY_MIN = 30;     // vérification des alertes appli ouverte
const DAYS = 14;                // jours de prévision
const PAST = 2;                 // jours passés (neige tombée)
const T0 = PAST;                // index d'aujourd'hui dans les tableaux "daily"
const KITE_DEFAULT = { windMin: 15, windMax: 40, gustMax: 55, minSnow: 10 }; // km/h, cm
const SKI = { freshMin: 10, maxSnowfall: 3, windMax: 45 };
/* Sports de vent : plages par défaut en km/h (≈ nœuds × 1,852) */
const SPORTS = {
  kite:     { label: 'Snowkite',        icon: 'i-snowkite', def: KITE_DEFAULT },
  kitesea:  { label: 'Kite (mer/lac)',  icon: 'i-kitesea',  def: { windMin: 22, windMax: 56, gustMax: 70 } }, // 12–30 nds
  wing:     { label: 'Wing',            icon: 'i-wing',     def: { windMin: 22, windMax: 52, gustMax: 65 } }, // 12–28 nds
  windsurf: { label: 'Planche à voile', icon: 'i-windsurf', def: { windMin: 26, windMax: 65, gustMax: 78 } }, // 14–35 nds
};

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const FILTER_DEFAULT = { sessionDays: 0, freshMin: 0, snow3Min: 0, depthMin: 0, altMin: 0, windNow: false };
const state = {
  spots: [],
  weather: {},
  loc: (() => { const l = store.get('loc', HYERES); l.label = String(l.label).replace(' (par défaut)', ''); return l; })(),
  radius: store.get('radius', 400),
  // sports choisis (vide = tous) et portée : favoris et/ou mes spots
  types: new Set(store.get('types', (() => { const t = store.get('type', 'all');
    return t === 'kite' ? ['kite'] : t === 'ski' ? ['ski'] : t === 'water' ? ['kitesea', 'wing', 'windsurf'] : []; })())),
  scope: new Set(store.get('scope', (() => { const t = store.get('type', 'all'); return t === 'fav' || t === 'mine' ? [t] : []; })())),
  sort: store.get('sort', 'dist'),
  // tris enchaînés (jusqu'à 3) et filtres
  sorts: store.get('sorts', [store.get('sort', 'dist')]),
  filters: { sessionDays: store.get('sessionsOnly', false) ? 14 : 0, freshMin: 0, snow3Min: 0, depthMin: 0, altMin: 0, windNow: false, ...store.get('filters', {}) },
  favs: new Set(store.get('favs', [])),
  bells: store.get('bells', {}),
  threshold: store.get('threshold', 20),
  alertAll: store.get('alertAll', false),
  kite: { ...KITE_DEFAULT, ...store.get('kite', {}) },
  ranges: Object.fromEntries(Object.entries(SPORTS).filter(([k]) => k !== 'kite')
    .map(([k, v]) => [k, { ...v.def, ...(store.get('ranges', {})[k] || {}) }])),
  sportTab: 'kite',                       // sport affiché dans les réglages
  mySpots: store.get('mySpots', []),      // spots ajoutés par l'utilisateur
  disc: { kitesea: true, wing: true, windsurf: true, ...store.get('disc', {}) }, // disciplines affichées
  sessionAlert: store.get('sessionAlert', true),
  sessionHorizon: store.get('sessionHorizon', 3),
  unit: store.get('unit', 'kn'),          // unité du vent : 'kn' (nœuds) ou 'kmh'
  mapDay: 'all',
  bannerOpen: store.get('bannerOpen', null),   // bandeau d'alertes déplié ?
  q: '',                                       // recherche de spot / station
  windAdj: store.get('windAdj', {}),           // correction du vent par spot, en % (relief, effet venturi…)
  ntfyTopic: store.get('ntfyTopic', ''),
  view: 'list',
  map: null, markers: null,
};

Object.defineProperty(state, 'sessionsOnly', { get: () => state.filters.sessionDays > 0 });

/* ---------- utilitaires ---------- */
function haversine(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const dirName = (deg) => deg == null ? '' : DIRS[Math.round(deg / 45) % 8];
const icon = (id, cls = 'i') => `<svg class="${cls}"><use href="#${id}"/></svg>`;
const arrow = (deg) => deg == null ? '' :
  `<svg class="i" style="transform:rotate(${deg + 180}deg)"><use href="#i-route"/></svg>`;
function wxId(code) {
  if (code == null) return 'w-cloud';
  if (code === 0) return 'w-sun';
  if (code <= 2) return 'w-partly';
  if (code === 3) return 'w-cloud';
  if (code <= 48) return 'w-fog';
  if (code <= 67) return 'w-rain';
  if (code <= 77) return 'w-snow';
  if (code <= 82) return 'w-rain';
  if (code <= 86) return 'w-snow';
  return 'w-storm';
}
const isRain = (c) => (c >= 51 && c <= 67) || (c >= 80 && c <= 82);
const KN = 1.852;
const wv = (kmh) => kmh == null ? '–' : Math.round(state.unit === 'kn' ? kmh / KN : kmh); // vitesse affichée
const U = () => (state.unit === 'kn' ? 'nds' : 'km/h');
const round = (v, d = 0) => v == null ? '–' : Number(v).toFixed(d);
const sum = (arr) => arr.reduce((a, b) => a + (b || 0), 0);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayDate = (w, i) => new Date(w.daily.time[i] + 'T12:00');
const dayLabel = (w, i) => i === T0 ? 'Auj.' : i === T0 + 1 ? 'Dem.'
  : dayDate(w, i).toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
const dayLong = (w, i) => i === T0 ? "aujourd'hui" : i === T0 + 1 ? 'demain'
  : dayDate(w, i).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }).replace('.', '');

const windSports = (s) => s.sports || (s.sport ? [s.sport] : []);
const enabledSports = (s) => windSports(s).filter((x) => state.disc[x]);
const primarySport = (s) => enabledSports(s)[0] || windSports(s)[0] || 'kitesea';
function rangeFor(s) {
  return s.type === 'wind' ? state.ranges[primarySport(s)] || SPORTS.kitesea.def : state.kite;
}
function kiteRating(wind, gust, k = state.kite) {
  if (wind == null) return null;
  if (wind < k.windMin) return { cls: 'warn', txt: 'Pas assez de vent' };
  if (wind > k.windMax || (gust != null && gust > k.gustMax)) return { cls: 'bad', txt: 'Trop fort / rafales' };
  return { cls: 'good', txt: 'Dans ta plage de vent' };
}
const isKite = (s) => s.type === 'kite' || s.type === 'both';
const isSki = (s) => s.type === 'ski' || s.type === 'both';
const isWind = (s) => s.type === 'wind';             // spot perso kite mer / wing / planche
const windy = (s) => isKite(s) || isWind(s);          // spots où le vent compte
const sportOf = (s) => (isWind(s) ? primarySport(s) : 'kite');

/* ---------- météo (Open-Meteo, sans clé) ---------- */
function summarize(w) {
  const sf = w.daily.snowfall_sum;
  return { past48: sum(sf.slice(0, T0)), next72: sum(sf.slice(T0, T0 + 3)) };
}

/* Neige au sol (cm) le jour i : prévision du modèle à midi, sinon estimation
   à partir de la hauteur actuelle + chutes prévues (sans fonte). */
function snowDepth(w, i) {
  const v = w.depth?.[i];
  if (v != null) return v * 100;
  let base = (w.current.snow_depth || 0) * 100;
  for (let j = T0; j < i; j++) base += w.daily.snowfall_sum[j] || 0;
  return base;
}

/* Neige au sol maintenant : totale, fraîche (tombée sur 72 h) et ancienne */
function snowPack(w) {
  const total = w.current.snow_depth != null ? w.current.snow_depth * 100 : snowDepth(w, T0);
  const fell = sum(w.daily.snowfall_sum.slice(0, T0 + 1)); // 2 jours passés + aujourd'hui
  const fresh = Math.min(total, fell);
  return { total, fresh, old: Math.max(0, total - fresh) };
}
function packHtml(w) {
  const { total, fresh, old } = snowPack(w);
  if (total < 0.5) return `${icon('i-mountain')}<span class="muted">pas de neige au sol</span>`;
  const pf = Math.round((fresh / total) * 100);
  return `${icon('i-mountain')}<b>${round(total)}</b> cm au sol
    <span class="pack" title="Fraîche (72 h) : ${round(fresh)} cm · ancienne : ${round(old)} cm"><i class="pf" style="width:${pf}%"></i></span>
    <span class="muted"><span class="fresh">${round(fresh)} fraîche</span> · ${round(old)} ancienne</span>`;
}

/* Détection des sessions sur 14 jours */
let sessCache = new Map(); // vidé à chaque rendu (les réglages peuvent avoir changé)
function sessionsFor(s, w) {
  if (!w) return [];
  const hit = sessCache.get(s.id);
  if (hit && hit.w === w) return hit.out;
  const out = computeSessions(s, w);
  sessCache.set(s.id, { w, out });
  return out;
}
function computeSessions(s, w) {
  const d = w.daily, out = [];
  const sf = (i) => d.snowfall_sum[i] || 0;
  for (let i = T0; i < d.time.length; i++) {
    const code = d.weather_code[i], wind = d.wind_speed_10m_max[i], gust = d.wind_gusts_10m_max[i];
    const far = i - T0 >= 7;
    if (isKite(s)) {
      // Kite : il faut de la neige au sol (fraîche ou non) et du vent dans la bonne plage
      const k = state.kite, snow = snowDepth(w, i);
      if (snow >= k.minSnow && wind >= k.windMin && wind <= k.windMax && gust <= k.gustMax) {
        out.push({ i, kind: 'kite', far, txt: `${wv(wind)} ${U()} ${dirName(d.wind_direction_10m_dominant[i])} · ${round(snow)} cm` });
      }
    }
    if (isWind(s)) {
      for (const sp of enabledSports(s)) {
        const k = state.ranges[sp];
        if (wind >= k.windMin && wind <= k.windMax && gust <= k.gustMax && code < 95) {
          out.push({ i, kind: 'wind', sport: sp, far, txt: `${wv(wind)} ${U()} ${dirName(d.wind_direction_10m_dominant[i])}` });
        }
      }
    }
    if (isSki(s)) {
      const fresh = sf(i - 1) + sf(i - 2);
      if (fresh >= SKI.freshMin && sf(i) < SKI.maxSnowfall && wind <= SKI.windMax && code < 95 && !isRain(code)) {
        out.push({ i, kind: 'ski', far, txt: `poudreuse ${round(fresh)} cm` });
      }
    }
  }
  return out;
}
function relevantSessions(s) {
  const all = sessionsFor(s, wx(s));
  if (!state.types.size) return all;
  return all.filter((x) => state.types.has(x.kind === 'wind' ? x.sport : x.kind));
}

/* Météo d'un spot avec la correction de vent de l'utilisateur appliquée */
const adjOf = (s) => 1 + (state.windAdj[s.id] || 0) / 100;
const wxAdjCache = new Map();
function wx(s) {
  const w = state.weather[s.id]; if (!w) return w;
  const f = adjOf(s); if (f === 1) return w;
  const hit = wxAdjCache.get(s.id);
  if (hit && hit.w === w && hit.f === f) return hit.out;
  const m = (a) => a.map((v) => (v == null ? v : v * f));
  const out = { ...w,
    current: { ...w.current, wind_speed_10m: w.current.wind_speed_10m * f, wind_gusts_10m: w.current.wind_gusts_10m * f },
    daily: { ...w.daily, wind_speed_10m_max: m(w.daily.wind_speed_10m_max), wind_gusts_10m_max: m(w.daily.wind_gusts_10m_max) } };
  wxAdjCache.set(s.id, { w, f, out });
  return out;
}

let wxMem = null; // cache météo en mémoire (évite de relire le stockage à chaque fois)
async function fetchWeather(spots) {
  const now = Date.now();
  const cache = wxMem || (wxMem = store.get('wxCache3', {}));
  const todo = spots.filter((s) => !(cache[s.id] && now - cache[s.id].t < CACHE_MIN * 60000));
  // spots mer/lac : pas besoin de la hauteur de neige horaire (données bien plus légères)
  const groups = [todo.filter((s) => !isWind(s)), todo.filter(isWind)];
  for (const [g, group] of groups.entries()) for (let i = 0; i < group.length; i += 40) {
    const chunk = group.slice(i, i + 40);
    const p = new URLSearchParams({
      latitude: chunk.map((s) => s.lat).join(','),
      longitude: chunk.map((s) => s.lon).join(','),
      elevation: chunk.map((s) => s.alt).join(','),
      current: 'temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,snowfall,snow_depth',
      ...(g === 0 ? { hourly: 'snow_depth' } : {}),
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant',
      timezone: 'Europe/Paris',
      past_days: String(PAST),
      forecast_days: String(DAYS),
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    let data = await res.json();
    if (!Array.isArray(data)) data = [data];
    data.forEach((w, j) => {
      // ne garder que la hauteur de neige à midi pour chaque jour (cache léger)
      const h = w.hourly;
      if (h) {
        w.depth = w.daily.time.map((day, d) => h.snow_depth[d * 24 + 12] ?? null); // midi de chaque jour
        delete w.hourly; delete w.hourly_units;
      }
      cache[chunk[j].id] = { t: now, w };
    });
  }
  for (const k of Object.keys(cache)) if (now - cache[k].t > 6 * 3600000) delete cache[k];
  if (todo.length) store.set('wxCache3', cache);
  for (const s of spots) if (cache[s.id]) state.weather[s.id] = cache[s.id].w;
}

/* Pour les spots suivis (★, 🔔, mes spots), aujourd'hui et demain sont recalculés avec
   Météo-France (AROME 1,5 km puis ARPEGE) : bien plus fin en relief que le mélange par défaut. */
async function refineShortRange() {
  const targets = allInRadius().filter((s) => (s.custom || state.favs.has(s.id) || state.bells[s.id] != null)
    && state.weather[s.id] && !state.weather[s.id].mf).slice(0, 40);
  if (!targets.length) return;
  try {
    const p = new URLSearchParams({
      latitude: targets.map((s) => s.lat).join(','), longitude: targets.map((s) => s.lon).join(','),
      elevation: targets.map((s) => s.alt).join(','),
      daily: 'wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant',
      models: 'meteofrance_seamless', timezone: 'Europe/Paris', forecast_days: '2',
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
    if (!r.ok) return;
    let data = await r.json(); if (!Array.isArray(data)) data = [data];
    data.forEach((mf, j) => {
      const w = state.weather[targets[j].id];
      mf.daily.time.forEach((day, k) => {
        const i = w.daily.time.indexOf(day); if (i < 0) return;
        for (const v of ['wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant']) {
          if (mf.daily[v]?.[k] != null) w.daily[v][i] = mf.daily[v][k];
        }
      });
      w.mf = true;
    });
    wxAdjCache.clear();
    store.set('wxCache3', wxMem);
  } catch { /* on garde le mélange par défaut */ }
}

/* ---------- filtrage ---------- */
function allSpots() { return [...state.mySpots, ...state.spots]; }
function allInRadius() {
  return allSpots()
    .map((s) => ({ ...s, dist: haversine(state.loc, s) }))
    .filter((s) => s.dist <= state.radius || s.custom || state.favs.has(s.id)) // mes spots et favoris : toujours visibles
    .filter((s) => !isWind(s) || enabledSports(s).length); // disciplines affichées
}
const norm = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
function matchScore(s, words) { // 0 = pas trouvé ; plus haut = meilleur
  const name = norm(s.name), all = `${name} ${norm(s.massif || '')} ${norm(s.aka || '')}`, flat = all.replace(/ /g, '');
  if (!words.every((w) => all.includes(w) || flat.includes(w))) return 0;
  const q = words.join(' ');
  return name.startsWith(q) ? 3 : name.includes(q) ? 2 : 1;
}
function searchResults(q = state.q) { // recherche dans toute la France, sans limite de rayon
  const words = norm(q).split(' ').filter(Boolean);
  if (!words.length) return [];
  return allSpots()
    .filter((s) => !isWind(s) || enabledSports(s).length)
    .map((s) => ({ s, sc: matchScore(s, words) }))
    .filter((x) => x.sc)
    .map(({ s, sc }) => ({ ...s, dist: haversine(state.loc, s), sc }))
    .sort((a, b) => b.sc - a.sc || a.dist - b.dist);
}
/* Sports pratiqués sur un spot : snowkite, ski, et disciplines mer/lac choisies */
function spotSports(s) {
  const out = [];
  if (isKite(s)) out.push('kite');
  if (isSki(s)) out.push('ski');
  if (isWind(s)) out.push(...enabledSports(s));
  return out;
}
function spotsInRadius() {
  if (state.q.trim()) return searchResults();
  return allInRadius()
    .filter((s) => !state.types.size || spotSports(s).some((x) => state.types.has(x)))
    .filter((s) => !state.scope.size || (state.scope.has('fav') && state.favs.has(s.id)) || (state.scope.has('mine') && s.custom));
}
const snowFilterOn = () => state.filters.freshMin || state.filters.snow3Min || state.filters.depthMin;
function activeFilters() {
  const f = state.filters;
  return ['sessionDays', 'freshMin', 'snow3Min', 'depthMin', 'altMin', 'windNow'].filter((k) => f[k]).length;
}
function applyFilters(list, { forMap = false } = {}) {
  const f = state.filters;
  return list.filter((s) => {
    if (f.altMin && (s.alt || 0) < f.altMin) return false;
    if (snowFilterOn() && isWind(s)) return false; // filtres neige : pas les spots mer / lac
    const w = wx(s);
    if (snowFilterOn() || f.windNow || (f.sessionDays && !forMap)) { if (!w) return false; }
    if (f.freshMin && snowPack(w).fresh < f.freshMin) return false;
    if (f.depthMin && snowPack(w).total < f.depthMin) return false;
    if (f.snow3Min && summarize(w).next72 < f.snow3Min) return false;
    if (f.windNow && (!windy(s) || kiteRating(w.current.wind_speed_10m, w.current.wind_gusts_10m, rangeFor(s))?.cls !== 'good')) return false;
    // la carte gère « session » jour par jour ; la liste : au moins une session dans les N jours
    if (f.sessionDays && !forMap && !relevantSessions(s).some((x) => x.i - T0 < f.sessionDays)) return false;
    return true;
  });
}
function visibleSpots() { return applyFilters(spotsInRadius()); }
/* Tris : chaque tri a une clé (plus petit = en premier) et une valeur affichée sur la fiche */
const sessDays = (s) => new Set(relevantSessions(s).map((x) => x.i)).size;
/* Chaque tri : clé « plus petit = en premier » (arrondie pour que les égalités passent au tri suivant),
   valeur affichée sur la fiche, besoin de la météo, réservé à la neige. */
const SORTS = {
  dist:     { label: 'Distance', key: (s) => Math.round(s.dist) },
  session:  { label: 'Prochaine session', need: true, key: (s) => relevantSessions(s)[0]?.i ?? 99,
              badge: (s, w) => { const x = relevantSessions(s)[0]; return x ? dayLong(w, x.i) : null; } },
  sessdays: { label: 'Jours de session (14 j)', need: true, key: (s) => -sessDays(s), badge: (s) => (sessDays(s) ? `${sessDays(s)} j de session` : null) },
  snow:     { label: 'Chute à venir (3 j)', need: true, snowOnly: true, key: (s, w) => -Math.round(summarize(w).next72), badge: (s, w) => `+${round(summarize(w).next72)} cm` },
  fresh:    { label: 'Neige fraîche (72 h)', need: true, snowOnly: true, key: (s, w) => -Math.round(snowPack(w).fresh), badge: (s, w) => `${round(snowPack(w).fresh)} cm frais` },
  depth:    { label: 'Neige au sol', need: true, snowOnly: true, key: (s, w) => -Math.round(snowPack(w).total), badge: (s, w) => `${round(snowPack(w).total)} cm au sol` },
  wind:     { label: 'Vent idéal maintenant', need: true, key: (s, w) => { const r = rangeFor(s); return (windy(s) ? 0 : 1000) + Math.round(Math.abs(w.current.wind_speed_10m - (r.windMin + r.windMax) / 2) / KN); },
              badge: (s, w) => `${wv(w.current.wind_speed_10m)} ${U()}` },
  alt:      { label: 'Altitude', key: (s) => -(s.alt || 0), badge: (s) => `${s.alt} m` },
  name:     { label: 'Nom (A→Z)', cmp: (a, b) => a.name.localeCompare(b.name, 'fr') },
};
const sortList = () => state.sorts.filter((k) => SORTS[k]).slice(0, 3);
function sortSpots(list) {
  const keys = sortList().length ? sortList() : ['dist'];
  const val = new Map();
  const v = (s, k) => {
    const id = s.id + k; if (val.has(id)) return val.get(id);
    const S = SORTS[k], w = wx(s);
    const x = (S.need && !w) || (S.snowOnly && isWind(s)) ? 1e12 : S.key(s, w); // sans donnée : en dernier
    val.set(id, x); return x;
  };
  return list.sort((a, b) => {
    for (const k of keys) {
      const S = SORTS[k];
      const d = S.cmp ? S.cmp(a, b) : v(a, k) - v(b, k);
      if (d) return d;
    }
    return a.dist - b.dist; // à égalité : le plus proche
  });
}
function sortBadge(s) {
  const w = wx(s);
  return sortList().map((k) => SORTS[k]).filter((S) => S.badge && !(S.need && !w) && !(S.snowOnly && isWind(s)))
    .slice(0, 2).map((S) => S.badge(s, w)).filter(Boolean).map((t) => `<span class="sort-badge">${esc(t)}</span>`).join('');
}

/* ---------- fenêtre « Trier & filtrer » ---------- */
const FILTER_UI = [
  ['sessionDays', 'Session possible dans les', 0, 14, 1, (v) => (v ? `${v} jour${v > 1 ? 's' : ''}` : 'peu importe')],
  ['freshMin', 'Neige fraîche (72 h) au moins', 0, 50, 5, (v) => (v ? `${v} cm` : 'peu importe')],
  ['snow3Min', 'Chute à venir (3 j) au moins', 0, 80, 5, (v) => (v ? `${v} cm` : 'peu importe')],
  ['depthMin', 'Neige au sol au moins', 0, 200, 10, (v) => (v ? `${v} cm` : 'peu importe')],
  ['altMin', 'Altitude au moins', 0, 2500, 100, (v) => (v ? `${v} m` : 'peu importe')],
];
function filterSummary() { // ex. « altitude ≥ 1500 m · neige fraîche ≥ 10 cm »
  const f = state.filters, out = [];
  if (f.sessionDays && f.sessionDays !== 14) out.push(`session ≤ ${f.sessionDays} j`);
  if (f.freshMin) out.push(`neige fraîche ≥ ${f.freshMin} cm`);
  if (f.snow3Min) out.push(`chute à venir ≥ ${f.snow3Min} cm`);
  if (f.depthMin) out.push(`neige au sol ≥ ${f.depthMin} cm`);
  if (f.altMin) out.push(`altitude ≥ ${f.altMin} m`);
  if (f.windNow) out.push('vent bon maintenant');
  return out.join(' · ');
}
/* Filtres du haut : multi-sélection ; Kite / Wing / Planche selon les disciplines choisies */
function syncTypeChips() {
  document.querySelectorAll('#typeFilter button').forEach((b) => {
    const t = b.dataset.type;
    if (['kitesea', 'wing', 'windsurf'].includes(t)) {
      b.hidden = !state.disc[t];
      if (!state.disc[t]) state.types.delete(t);
    }
    const on = t === 'all' ? !state.types.size && !state.scope.size : state.types.has(t) || state.scope.has(t);
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on);
  });
}
function syncSortButton() {
  const n = activeFilters(), keys = sortList();
  $('#sortLbl').textContent = keys.length ? keys.map((k) => SORTS[k].label.split(' (')[0]).join(' · ') : 'Distance';
  $('#sortCount').textContent = n; $('#sortCount').hidden = !n;
  $('#btnSessions').setAttribute('aria-pressed', state.sessionsOnly);
}
function renderSortDlg() {
  const keys = sortList();
  const order = [...keys, ...Object.keys(SORTS).filter((k) => !keys.includes(k))]; // choisis d'abord, dans l'ordre
  $('#sortChips').innerHTML = order.map((k) => [k, SORTS[k]]).map(([k, S]) => {
    const n = keys.indexOf(k) + 1;
    return `<button data-sort="${k}" aria-pressed="${!!n}">${n ? `<i class="num">${n}</i>` : ''}${S.label}</button>`;
  }).join('');
  $('#filterRows').innerHTML = `<label class="range"><span>Distance max <b>${state.radius} km</b></span>
      <input type="range" data-f="radius" min="50" max="1200" step="25" value="${state.radius}"></label>`
    + FILTER_UI.map(([k, label, min, max, step, fmt]) => `<label class="range${state.filters[k] ? ' on' : ''}"><span>${label} <b>${fmt(state.filters[k])}</b></span>
      <input type="range" data-f="${k}" min="${min}" max="${max}" step="${step}" value="${state.filters[k]}"></label>`).join('')
    + `<label class="switch"><span>Vent dans ma plage maintenant</span><input type="checkbox" data-f="windNow" ${state.filters.windNow ? 'checked' : ''}></label>`;
  $('#sortApply').textContent = `Voir ${visibleSpots().length} spot${visibleSpots().length > 1 ? 's' : ''}`;
}
function openSortDlg() {
  renderSortDlg();
  const d = $('#sortDlg'); if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
}
function saveSortFilter() {
  store.set('sorts', state.sorts); store.set('filters', state.filters);
  syncSortButton(); render();
}

/* ---------- alertes ---------- */
function thresholdFor(s) {
  if (state.bells[s.id] != null) return state.bells[s.id];
  return state.alertAll ? state.threshold : null;
}
function computeAlerts(list) {
  const out = [];
  for (const s of list) {
    const thr = thresholdFor(s); const w = state.weather[s.id];
    if (thr == null || !w || isWind(s)) continue;
    const { next72 } = summarize(w);
    if (next72 >= thr) out.push({ s, next72, thr });
  }
  return out.sort((a, b) => b.next72 - a.next72);
}
/* Type de session, affiché partout (bandeau, fiches, notifications) */
const SESS_TYPE = { kite: 'Snowkite', ski: 'Ski poudreuse', kitesea: 'Kite', wing: 'Wing', windsurf: 'Planche' };
const sessType = (x) => SESS_TYPE[x.kind === 'wind' ? x.sport : x.kind];
const sessIcon = (x) => (x.kind === 'ski' ? 'i-ski' : x.kind === 'wind' ? SPORTS[x.sport].icon : 'i-snowkite');
const sessCls = (x) => 't-' + (x.kind === 'wind' ? x.sport : x.kind); // couleur par type de session

/* Alerte « session possible » : favoris, spots avec cloche et mes spots */
function sessionAlertTargets() {
  return allInRadius().filter((s) => s.custom || state.favs.has(s.id) || state.bells[s.id] != null);
}
function computeSessionAlerts() {
  if (!state.sessionAlert) return [];
  const out = [];
  for (const s of sessionAlertTargets()) {
    const w = wx(s);
    const ses = sessionsFor(s, w).filter((x) => x.i - T0 < state.sessionHorizon);
    if (ses.length) out.push({ s, ses, w });
  }
  return out.sort((a, b) => a.ses[0].i - b.ses[0].i);
}
async function pushNotif(title, body, tag) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag });
    else new Notification(title, { body });
  } catch { try { new Notification(title, { body }); } catch {} }
}
async function notifySessions(list) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !list.length) return;
  const sent = store.get('sentSessions', {});
  const fresh = [];
  for (const a of list) for (const x of a.ses) {
    const key = `${a.s.id}:${a.w.daily.time[x.i]}`;
    if (!sent[key]) { fresh.push({ a, x }); sent[key] = Date.now(); }
  }
  for (const k of Object.keys(sent)) if (Date.now() - sent[k] > 20 * 864e5) delete sent[k];
  store.set('sentSessions', sent);
  if (!fresh.length) return;
  const body = fresh.slice(0, 6).map(({ a, x }) => `${sessType(x)} · ${a.s.name} · ${dayLong(a.w, x.i)} · ${x.txt}`).join('\n');
  const types = [...new Set(fresh.map(({ x }) => sessType(x)))].join(', ');
  await pushNotif(`Session possible : ${types}`, body, 'session');
}
async function notify(alerts) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const sent = store.get('sentAlerts', {});
  const day = new Date().toISOString().slice(0, 10);
  const fresh = alerts.filter((a) => sent[a.s.id] !== day);
  if (!fresh.length) return;
  const body = fresh.slice(0, 5).map((a) => `${a.s.name} : ${round(a.next72)} cm`).join('\n');
  const title = `Neige annoncée sur ${fresh.length} spot${fresh.length > 1 ? 's' : ''}`;
  await pushNotif(title, body, 'neige');
  fresh.forEach((a) => { sent[a.s.id] = day; });
  store.set('sentAlerts', sent);
}
/* Résumé compact, une entrée par type : « Snowkite auj., mer, jeu +2 » */
function sessSummary(ses, w) {
  const byType = new Map();
  for (const x of ses) { const k = sessType(x); if (!byType.has(k)) byType.set(k, { x, days: [] }); byType.get(k).days.push(x.i); }
  return [...byType.values()].map(({ x, days }) => {
    const ds = [...new Set(days)];
    return `<span class="sess-line ${sessCls(x)}">${icon(sessIcon(x))}<b>${sessType(x)}</b> ${ds.slice(0, 3).map((i) => dayLabel(w, i).toLowerCase()).join(', ')}${ds.length > 3 ? ` <span class="muted">+${ds.length - 3}</span>` : ''}</span>`;
  }).join('');
}
function groupByDay(ses) { // sessions d'un même jour regroupées (ex. Kite · Wing · Planche)
  const m = new Map();
  for (const x of ses) { if (!m.has(x.i)) m.set(x.i, []); m.get(x.i).push(x); }
  return [...m.values()];
}
function renderAlertsBanner(alerts, sessions = []) {
  const el = $('#alertsBanner');
  const total = alerts.length + sessions.length;
  el.hidden = !total;
  if (!total) return;
  const open = state.bannerOpen ?? total <= 2;
  const parts = [];
  if (sessions.length) parts.push(`${sessions.length} spot${sessions.length > 1 ? 's' : ''} avec session possible`);
  if (alerts.length) parts.push(`${alerts.length} alerte${alerts.length > 1 ? 's' : ''} neige`);
  el.innerHTML = `<button class="ab-head" aria-expanded="${open}">${icon('i-bell')}<span>${parts.join(' · ')}</span><svg class="i chev"><use href="#i-chev"/></svg></button>
    <div class="ab-body"${open ? '' : ' hidden'}>` + sessions.map((a) =>
    `<div class="alert sess-alert" data-goto="${esc(a.s.id)}"><b class="sa-name">${esc(a.s.name)}</b><span class="sa-list">${sessSummary(a.ses, a.w)}</span></div>`
  ).join('') + alerts.map((a) =>
    `<div class="alert" data-goto="${esc(a.s.id)}">${icon('i-snow')}<span><b>${esc(a.s.name)}</b> · ${round(a.next72)} cm sur 3 jours <span class="muted">(seuil ${a.thr} cm)</span></span></div>`
  ).join('') + '</div>';
  el.querySelector('.ab-head').onclick = () => {
    state.bannerOpen = !open; store.set('bannerOpen', state.bannerOpen);
    renderAlertsBanner(alerts, sessions);
  };
}

/* ---------- rendu ---------- */
function linksFor(s) {
  const L = [];
  const cam = s.webcam || `https://www.google.com/search?q=${encodeURIComponent('webcam live ' + s.name)}`;
  L.push(['i-camera', 'Webcams', cam]);
  if (s.web) L.push(['i-globe', 'Site', s.web]);
  L.push(['i-wind', 'Windy', `https://www.windy.com/${s.lat}/${s.lon}?${s.lat},${s.lon},11`]);
  L.push(['i-route', 'Itinéraire', `https://www.google.com/maps/dir/?api=1&origin=${state.loc.lat},${state.loc.lon}&destination=${s.lat},${s.lon}`]);
  if (!isWind(s)) L.push(['i-alert', 'Avalanche', 'https://meteofrance.com/meteo-montagne']);
  return L.map(([ic, t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${icon(ic)}${t}</a>`).join('');
}
function typeIcons(s) {
  if (isWind(s)) return enabledSports(s).map((x) => icon(SPORTS[x].icon)).join('');
  return (isKite(s) ? icon('i-snowkite') : '') + (isSki(s) ? icon('i-ski') : '');
}
const sportsLabel = (s) => enabledSports(s).map((x) => SESS_TYPE[x]).join(' · ');

function renderCard(s, alerting) {
  const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
  const w = wx(s);
  node.dataset.id = s.id;
  node.classList.toggle('alerting', alerting);
  const h = node.querySelector('.name');
  h.innerHTML = typeIcons(s);
  h.append(s.name);
  h.insertAdjacentHTML('afterend', sortBadge(s));
  node.querySelector('.meta').textContent = s.custom
    ? `Mon spot · ${s.type === 'ski' ? s.massif : sportsLabel(s) || SPORTS[sportOf(s)].label} · ${round(s.dist)} km`
    : isWind(s) ? `${s.massif} · ${sportsLabel(s)} · ${round(s.dist)} km`
    : `${s.massif} · ${s.alt} m · ${round(s.dist)} km`;
  node.classList.toggle('mine', !!s.custom);

  const fav = node.querySelector('.fav');
  fav.classList.toggle('on', state.favs.has(s.id));
  fav.title = state.favs.has(s.id) ? 'Suivi : favori + alerte session — retirer' : 'Suivre ce spot (favori + alerte session)';
  fav.onclick = () => toggleFav(s);
  const bell = node.querySelector('.bell');
  bell.hidden = isWind(s); // pas de neige sur les spots mer / lac
  const thr = state.bells[s.id];
  bell.classList.toggle('on', thr != null);
  bell.title = thr != null ? `Alerte chute de neige à ${thr} cm — modifier` : 'Alerte chute de neige';
  bell.onclick = () => {
    const v = prompt(`Alerte neige pour ${s.name}\nSeuil en cm sur 72 h (vide = supprimer l'alerte) :`, thr ?? state.threshold);
    if (v === null) return;
    const n = parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) state.bells[s.id] = n; else delete state.bells[s.id];
    store.set('bells', state.bells);
    if (Number.isFinite(n) && n > 0) askNotif();
    render();
  };

  if (!w) {
    node.querySelector('.now').innerHTML = '<span class="muted">Météo indisponible</span>';
    return node;
  }
  const c = w.current, sm = summarize(w);
  const kr = windy(s) ? kiteRating(c.wind_speed_10m, c.wind_gusts_10m, rangeFor(s)) : null;
  node.querySelector('.now').innerHTML = `
    <span>${icon(wxId(c.weather_code))}<b>${round(c.temperature_2m)}°</b></span>
    <span title="Vent actuel">${kr ? `<i class="dot ${kr.cls}" title="${kr.txt}"></i>` : icon('i-wind')}<b>${wv(c.wind_speed_10m)}</b> ${U()} ${arrow(c.wind_direction_10m)}${dirName(c.wind_direction_10m)} <span class="muted">raf. ${wv(c.wind_gusts_10m)}</span></span>` + (isWind(s) ? '' : `
    <span class="pack-row" title="Neige au sol (modèle) : fraîche = tombée sur 72 h">${packHtml(w)}</span>
    <span title="Neige prévue sur 3 jours (48 h passées : ${round(sm.past48)} cm)">${icon('i-snow')}<b class="plus">+${round(sm.next72)}</b> cm / 3 j</span>`);

  const sess = sessionsFor(s, w);
  const shown = relevantSessions(s);
  node.querySelector('.sessions').innerHTML = sessSummary(shown, w);

  const byDay = {};
  sess.forEach((x) => { byDay[x.i] = byDay[x.i] || (x.kind === 'wind' ? 'kite' : x.kind); });
  const d = w.daily;
  let html = '';
  for (let i = T0; i < d.time.length; i++) {
    const sn = d.snowfall_sum[i] || 0;
    const cls = ['day', i === T0 && 'today', byDay[i] && `s-${byDay[i]}`, i - T0 >= 7 && 'far'].filter(Boolean).join(' ');
    const kd = windy(s) ? kiteRating(d.wind_speed_10m_max[i], d.wind_gusts_10m_max[i], rangeFor(s)) : null;
    html += `<div class="${cls}" data-day="${i}">
      <div class="d">${dayLabel(w, i)}</div>
      ${icon(wxId(d.weather_code[i]), 'i wx')}
      <div class="t">${round(d.temperature_2m_min[i])}/${round(d.temperature_2m_max[i])}°</div>
      ${isWind(s) ? '' : `<div class="sn${sn < 0.5 ? ' zero' : ''}">${sn < 0.5 ? '0' : round(sn)} cm</div>`}
      <div class="wd${kd ? ' k-' + kd.cls : ''}">${arrow(d.wind_direction_10m_dominant[i])}${wv(d.wind_speed_10m_max[i])}</div>
      <div class="gu">raf ${wv(d.wind_gusts_10m_max[i])}</div>
    </div>`;
  }
  node.querySelector('.days').innerHTML = html;
  node.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    const day = e.target.closest('[data-day]');
    openDetail(s, day ? +day.dataset.day - T0 : 0);
  });
  return node;
}

/* La liste se construit par paquets de 20 fiches, au fil du défilement */
const PAGE = 20;
let listObserver;
function renderList(list, alertIds) {
  const el = $('#list');
  el.replaceChildren();
  listObserver?.disconnect();
  let shown = 0;
  const more = () => {
    const frag = document.createDocumentFragment();
    for (const s of list.slice(shown, shown + PAGE)) frag.append(renderCard(s, alertIds.has(s.id)));
    shown += PAGE;
    el.append(frag);
    if (shown < list.length) {
      const sentinel = document.createElement('div');
      sentinel.className = 'sentinel';
      el.append(sentinel);
      listObserver = new IntersectionObserver((e) => {
        if (e[0].isIntersecting) { listObserver.disconnect(); sentinel.remove(); more(); }
      }, { rootMargin: '600px' });
      listObserver.observe(sentinel);
    }
  };
  more();
}

function render() {
  sessCache = new Map();
  const list = sortSpots(visibleSpots());
  const alerts = computeAlerts(spotsInRadius());
  const alertIds = new Set(alerts.map((a) => a.s.id));
  const sessAlerts = computeSessionAlerts();
  renderAlertsBanner(alerts, sessAlerts);
  renderList(list, alertIds);
  const n = list.length, pl = n > 1 ? 's' : '';
  const where = `${state.radius} km autour de ${state.loc.label}`;
  let msg;
  if (state.scope.has('mine') && !state.scope.has('fav') && !state.mySpots.length) msg = 'Aucun spot perso : ajoute-en dans ⚙ Paramètres → Mes spots.';
  else if (state.scope.has('fav') && !state.scope.has('mine') && !state.favs.size) msg = 'Aucun favori : touche ☆ sur une fiche pour suivre un spot.';
  else if (state.q.trim()) msg = n ? `${n} résultat${pl} pour « ${state.q.trim()} » (toute la France)` : `Aucun spot ni station pour « ${state.q.trim()} »`;
  else if (!n) msg = activeFilters() ? `Aucun spot ne correspond aux filtres · ${where}` : `Aucun spot · ${where} — augmente le rayon dans ⚙`;
  else msg = state.sessionsOnly ? `${n} spot${pl} avec une session possible · ${where}` : `${n} spot${pl} · ${where}`;
  if (filterSummary() && !state.q.trim()) msg += ` · ${filterSummary()}`;
  $('#status').innerHTML = `${esc(msg)}${state.updated ? ` · <button class="link-inline" id="statusRefresh" title="Actualiser la météo">màj ${state.updated}</button>` : ''}`;
  $('#statusRefresh')?.addEventListener('click', () => refresh(true));
  if (state.view === 'map') renderMap();
  return { list, alerts, sessAlerts };
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* Statut d'un spot sur la carte selon MES conditions.
   day = 'all' (sur 14 jours) ou index du jour (0 = aujourd'hui). */
const MAP_STATUS = {
  good:    { label: 'Session possible (kite, wing, planche)', good: true },
  powder:  { label: 'Session possible (ski poudreuse)', good: true },
  snowing: { label: 'Neige qui tombe / à venir' },
  weak:    { label: 'Neige ok, vent trop faible' },
  strong:  { label: 'Vent trop fort / rafales' },
  nosnow:  { label: 'Pas assez de neige' },
  none:    { label: 'Rien de particulier' },
};
function mapStatus(s, w, day) {
  if (!w) return { st: 'none' };
  const d = w.daily;
  if (day === 'all') {
    const ses = relevantSessions(s);
    const nDays = (f) => new Set(ses.filter(f).map((x) => x.i)).size + ' j';
    if (ses.some((x) => x.kind !== 'ski')) return { st: 'good', n: nDays((x) => x.kind !== 'ski') };
    if (ses.some((x) => x.kind === 'ski')) return { st: 'powder', n: nDays((x) => x.kind === 'ski') };
    const n72 = summarize(w).next72;
    if (n72 >= 5) return { st: 'snowing', n: `+${round(n72)}` };
    return { st: 'none' };
  }
  const i = T0 + day;
  const ses = sessionsFor(s, w).filter((x) => x.i === i);
  const wind = d.wind_speed_10m_max[i], gust = d.wind_gusts_10m_max[i], sf = d.snowfall_sum[i] || 0;
  if (ses.some((x) => x.kind === 'kite' || x.kind === 'wind')) return { st: 'good', n: wv(wind) };
  if (ses.some((x) => x.kind === 'ski')) return { st: 'powder', n: `${round((d.snowfall_sum[i - 1] || 0) + (d.snowfall_sum[i - 2] || 0))}` };
  if (isWind(s)) {
    if (ses.some((x) => x.kind === 'wind')) return { st: 'good', n: wv(wind) };
    return { st: wind < rangeFor(s).windMin ? 'weak' : 'strong', n: wv(wind) };
  }
  if (isKite(s) && (!state.types.size || state.types.has('kite'))) {
    const k = state.kite;
    if (snowDepth(w, i) < k.minSnow) return { st: sf >= 3 ? 'snowing' : 'nosnow', n: sf >= 3 ? `+${round(sf)}` : null };
    if (wind < k.windMin) return { st: 'weak', n: wv(wind) };
    return { st: 'strong', n: wv(wind) };
  }
  if (sf >= 3) return { st: 'snowing', n: `+${round(sf)}` };
  return { st: 'none' };
}
function mapSpots() { return applyFilters(spotsInRadius(), { forMap: true }); } // mêmes filtres que la liste
function renderMapDays() {
  const w = Object.values(state.weather)[0];
  const el = $('#mapDays');
  if (!w) { el.innerHTML = ''; return; }
  const opts = [['all', '14 j']];
  for (let j = 0; j < w.daily.time.length - T0; j++) opts.push([String(j), j === 0 ? 'Auj.' : j === 1 ? 'Dem.' : dayLong(w, T0 + j)]);
  el.innerHTML = opts.map(([v, l]) => `<button data-d="${v}" aria-pressed="${String(state.mapDay) === v}">${l}</button>`).join('');
  el.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { state.mapDay = b.dataset.d === 'all' ? 'all' : +b.dataset.d; render(); };
  });
}
function renderMap() {
  if (!window.L) { $('#map').textContent = 'Carte indisponible.'; return; }
  if (!state.map) {
    state.map = L.map('map', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '© OpenStreetMap',
    }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }
  renderMapDays();
  state.map.invalidateSize();
  state.markers.clearLayers();
  const muted = cssVar('--muted');
  const pts = [[state.loc.lat, state.loc.lon]];
  L.circleMarker([state.loc.lat, state.loc.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#111827', fillOpacity: 1 })
    .bindPopup('Ta position').addTo(state.markers);
  L.circle([state.loc.lat, state.loc.lon], { radius: state.radius * 1000, color: muted, weight: 1, dashArray: '4 4', fill: false })
    .addTo(state.markers);
  const seen = new Map(); // statut -> formes présentes (légende)
  let shown = 0;
  for (const s of mapSpots()) {
    const w = wx(s);
    const { st, n } = mapStatus(s, w, state.mapDay);
    if (state.sessionsOnly && !MAP_STATUS[st].good) continue; // « Sessions possibles »
    const kite = isKite(s), shape = isWind(s) ? 'wind' : kite ? 'kite' : 'ski';
    if (!seen.has(st)) seen.set(st, new Set());
    seen.get(st).add(shape);
    shown++;
    const html = `<div class="mk ${shape}${s.custom ? ' mine' : ''} st-${st}">${icon(isWind(s) ? SPORTS[primarySport(s)].icon : kite ? 'i-snowkite' : 'i-ski')}` +
      (n != null ? `<span class="mk-n">${n}</span>` : '') + '</div>';
    const popup = () => {
    const div = document.createElement('div');
    const b = document.createElement('b'); b.textContent = s.name; div.append(b);
    const dayTxt = state.mapDay === 'all' ? 'sur 14 jours' : dayLong(w || Object.values(state.weather)[0], T0 + state.mapDay);
    div.insertAdjacentHTML('beforeend', `<br>${s.custom ? `Mon spot · ${sportsLabel(s)}` : isWind(s) ? sportsLabel(s) : kite ? 'Spot snowkite' : 'Station'} · ${s.alt} m · ${round(s.dist)} km` +
      `<br><span class="pop-st st-${st}">${MAP_STATUS[st].label}</span> <span class="muted">${dayTxt}</span>` +
      (w && state.mapDay !== 'all' && isWind(s) ? `<br>Vent max ${wv(w.daily.wind_speed_10m_max[T0 + state.mapDay])} ${U()} ${dirName(w.daily.wind_direction_10m_dominant[T0 + state.mapDay])} · raf. ${wv(w.daily.wind_gusts_10m_max[T0 + state.mapDay])}` : '') +
      (w && state.mapDay !== 'all' && !isWind(s) ? `<br>Vent max ${wv(w.daily.wind_speed_10m_max[T0 + state.mapDay])} ${U()} ${dirName(w.daily.wind_direction_10m_dominant[T0 + state.mapDay])} · raf. ${wv(w.daily.wind_gusts_10m_max[T0 + state.mapDay])} · ${round(snowDepth(w, T0 + state.mapDay))} cm au sol` : '') +
      (w && state.mapDay === 'all' ? `<br>Maintenant : ${round(w.current.temperature_2m)}° · vent ${wv(w.current.wind_speed_10m)} ${U()}` +
        (isWind(s) ? '' : `<br>${round(snowPack(w).total)} cm au sol dont ${round(snowPack(w).fresh)} cm de fraîche`) : '') +
      `<br><a href="#" data-goto="${esc(s.id)}" data-day="${state.mapDay === 'all' ? 0 : state.mapDay}">Détail heure par heure et modèles</a>`);
    return div;
    };
    L.marker([s.lat, s.lon], {
      icon: L.divIcon({ html, className: 'mk-wrap', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] }),
      zIndexOffset: MAP_STATUS[st].good ? 1000 : kite ? 500 : 0,
    }).bindPopup(popup).addTo(state.markers);
    pts.push([s.lat, s.lon]);
  }
  $('#mapCount').textContent = `${shown} affiché${shown > 1 ? 's' : ''}`;
  // légende : seulement les statuts présents, avec la forme des marqueurs
  const order = Object.keys(MAP_STATUS);
  $('#mapLegend').innerHTML = [...seen.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((st) =>
    `<span>${[...seen.get(st)].sort().map((f) => `<i class="lg ${f} st-${st}"></i>`).join('')}${MAP_STATUS[st].label}</span>`).join('')
    + `<span class="lg-note">◆ snowkite · ● station · ■ mer, lac et mes spots · chiffre : ${state.mapDay === 'all' ? 'jours de session ou cm sur 3 j' : `vent max (${U()}) ou cm de neige`}</span>`
    || '<span>Aucun spot ne correspond.</span>';
  if (!seen.size) $('#mapLegend').innerHTML = '<span>Aucun spot ne correspond à ces conditions.</span>';
  if (!state.mapFitted || state.mapFitted !== `${state.loc.lat},${state.loc.lon},${state.radius}`) {
    state.map.fitBounds(pts, { padding: [24, 24], maxZoom: 9 });
    state.mapFitted = `${state.loc.lat},${state.loc.lon},${state.radius}`;
  }
}

/* ---------- chargement ---------- */
async function refresh(force = false) {
  if (force) { wxMem = {}; store.set('wxCache3', {}); }
  const list = allInRadius();
  $('#status').textContent = `Chargement de la météo (${list.length} spots)…`;
  try {
    await fetchWeather(list);
  } catch (e) {
    console.error(e);
    render();
    $('#status').textContent = 'Impossible de charger la météo (connexion ?). Données en cache affichées.';
    return;
  }
  state.updated = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  await refineShortRange();
  const { alerts, sessAlerts } = render();
  notify(alerts);
  notifySessions(sessAlerts);
}

/* ---------- position ---------- */
function showLoc() {
  $('#locLabel').textContent = `${state.loc.label} · ${state.loc.lat.toFixed(3)}, ${state.loc.lon.toFixed(3)}`;
  $('#placeTxt').textContent = `${state.loc.label} · ${state.radius} km`;
}
function setLoc(loc) {
  state.loc = loc; store.set('loc', loc); showLoc(); refresh();
}
function geolocate() {
  if (!navigator.geolocation) return alert('Géolocalisation non disponible');
  $('#locLabel').textContent = 'Localisation…';
  navigator.geolocation.getCurrentPosition(
    (p) => setLoc({ lat: p.coords.latitude, lon: p.coords.longitude, label: 'ma position' }),
    () => { $('#locLabel').textContent = 'Localisation refusée — tape une ville.'; },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
}
let searchTimer;
function searchCity(q) {
  clearTimeout(searchTimer);
  const ul = $('#locResults');
  if (q.trim().length < 2) { ul.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=fr&format=json`);
      const j = await r.json();
      const res = j.results || [];
      ul.innerHTML = res.map((c, i) =>
        `<li data-i="${i}">${esc(c.name)} <span class="muted">${esc([c.admin2, c.admin1, c.country_code].filter(Boolean).join(', '))}</span></li>`).join('')
        || '<li class="muted">Aucun résultat</li>';
      ul.hidden = false;
      ul.onclick = (e) => {
        const li = e.target.closest('li[data-i]'); if (!li) return;
        const c = res[+li.dataset.i];
        ul.hidden = true; $('#locInput').value = c.name;
        setLoc({ lat: c.latitude, lon: c.longitude, label: c.name });
      };
    } catch { ul.hidden = true; }
  }, 300);
}

/* ---------- notifications ---------- */
function notifStateText() {
  if (!('Notification' in window)) return "Non supporté ici (sur iPhone : ajoute l'appli à l'écran d'accueil).";
  return { granted: 'Activées', denied: 'Bloquées dans les réglages du navigateur', default: '' }[Notification.permission];
}
async function askNotif() {
  if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  $('#notifState').textContent = notifStateText();
}

/* ---------- plages de vent par sport (affichées dans l'unité choisie) ---------- */
const SLIDERS = { // bornes en km/h ; converties pour l'affichage
  windMin: [5, 50], windMax: [15, 90], gustMax: [20, 110],
};
const SPORT_HELP = {
  kite: 'Snowkite : neige au sol (fraîche ou non) + vent dans ta plage.',
  kitesea: 'Kite sur l’eau : vent dans ta plage, rafales sous le maxi.',
  wing: 'Wing : vent dans ta plage, rafales sous le maxi.',
  windsurf: 'Planche à voile : vent dans ta plage, rafales sous le maxi.',
};
const rangeOf = (sport) => (sport === 'kite' ? state.kite : state.ranges[sport]);
function saveRanges() {
  store.set('kite', state.kite);
  store.set('ranges', state.ranges);
}
function setupKiteSliders() {
  const sport = state.sportTab, r = rangeOf(sport);
  document.querySelectorAll('#sportSel button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.sport === sport));
  $('#sportHelp').textContent = SPORT_HELP[sport];
  $('#minSnowRow').hidden = sport !== 'kite';
  for (const k of Object.keys(KITE_DEFAULT)) {
    if (k === 'minSnow' && sport !== 'kite') continue;
    const el = $(`#k-${k}`), out = $(`#k-${k}-v`), unit = $(`#k-${k}-u`);
    const isW = k !== 'minSnow';
    const toUI = (v) => (isW ? wv(v) : v), fromUI = (v) => (isW && state.unit === 'kn' ? Math.round(v * KN) : v);
    if (isW) { el.min = toUI(SLIDERS[k][0]); el.max = toUI(SLIDERS[k][1]); el.step = 1; unit.textContent = U(); }
    el.value = toUI(r[k]); out.textContent = el.value;
    el.oninput = () => { out.textContent = el.value; };
    el.onchange = () => {
      r[k] = fromUI(+el.value);
      if (r.windMin > r.windMax) r.windMax = r.windMin;
      saveRanges(); setupKiteSliders(); render();
      if (detail.spot) showDetailTab();
    };
  }
}

/* ---------- carte en fenêtre (choisir ou voir un spot) ---------- */
const pick = { map: null, marker: null, latlng: null, mode: 'view' };
function openMapDialog({ mode = 'view', spot = null } = {}) {
  const dlg = $('#mapDlg');
  pick.mode = mode; pick.latlng = null;
  $('#mapDlgTitle').textContent = mode === 'pick' ? 'Choisis l’emplacement du spot' : spot.name;
  $('#mapDlgHint').textContent = mode === 'pick' ? 'Touche la carte pour placer le spot, puis valide.' : `${spot.lat.toFixed(4)}, ${spot.lon.toFixed(4)}${spot.alt ? ' · ' + spot.alt + ' m' : ''}`;
  $('#mapDlgOk').hidden = mode !== 'pick'; $('#mapDlgOk').disabled = true;
  if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  if (!window.L) return;
  if (!pick.map) {
    pick.map = L.map('pickMap', { zoomControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(pick.map);
    pick.map.on('click', (e) => {
      if (pick.mode !== 'pick') return;
      pick.latlng = e.latlng;
      if (pick.marker) pick.marker.setLatLng(e.latlng); else pick.marker = L.marker(e.latlng).addTo(pick.map);
      $('#mapDlgHint').textContent = `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)} — valide ou touche ailleurs pour déplacer`;
      $('#mapDlgOk').disabled = false;
    });
  }
  if (pick.marker) { pick.marker.remove(); pick.marker = null; }
  const center = spot ? [spot.lat, spot.lon] : [state.loc.lat, state.loc.lon];
  setTimeout(() => {
    pick.map.invalidateSize();
    pick.map.setView(center, spot ? 13 : 10);
    if (spot) pick.marker = L.marker(center).addTo(pick.map).bindPopup(esc(spot.name));
  }, 60);
}
function closeMapDialog() { const d = $('#mapDlg'); d.close ? d.close() : d.removeAttribute('open'); }

/* ---------- mes spots ---------- */
function saveMySpots() { store.set('mySpots', state.mySpots); }
function renderMySpots() {
  const ul = $('#mySpotsList');
  ul.innerHTML = state.mySpots.map((m) =>
    `<li>${icon(SPORTS[sportOf(m)].icon)}<span><b>${esc(m.name)}</b> <span class="muted small">${SPORTS[sportOf(m)].label} · ${m.lat.toFixed(3)}, ${m.lon.toFixed(3)}</span></span>
     <button class="icon-btn" data-del="${esc(m.id)}" aria-label="Supprimer ${esc(m.name)}">${icon('i-trash')}</button></li>`).join('')
    || '<li class="muted small">Aucun spot perso pour l’instant.</li>';
  ul.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      const m = state.mySpots.find((x) => x.id === b.dataset.del);
      if (!m || !confirm(`Supprimer « ${m.name} » ?`)) return;
      state.mySpots = state.mySpots.filter((x) => x.id !== m.id); saveMySpots(); renderMySpots(); render();
    };
  });
}
async function addMySpot(lat, lon, name, sport) {
  let alt = 0;
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`);
    alt = Math.max(0, Math.round((await r.json()).elevation[0]));
  } catch {}
  const spot = {
    id: 'u-' + Date.now().toString(36), custom: true, name: name || 'Mon spot',
    type: sport === 'kite' ? 'kite' : 'wind', sport, massif: 'Mes spots',
    lat: +(+lat).toFixed(4), lon: +(+lon).toFixed(4), alt,
  };
  state.mySpots.push(spot); saveMySpots(); renderMySpots();
  toast(`« ${spot.name} » ajouté`);
  $('#msName').value = ''; $('#msPlace').value = '';
  await refresh();
  return spot;
}
function formSpot() { return { name: $('#msName').value.trim(), sport: $('#msSport').value }; }
let msTimer;
function searchSpotPlace(q) {
  clearTimeout(msTimer);
  const ul = $('#msResults');
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,; ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) { // coordonnées collées
    ul.innerHTML = `<li data-ll="${m[1]},${m[2]}">Utiliser ${m[1]}, ${m[2]}</li>`; ul.hidden = false;
  } else if (q.trim().length < 2) { ul.hidden = true; return; }
  else {
    msTimer = setTimeout(async () => {
      try {
        const j = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=fr&format=json`)).json();
        ul.innerHTML = (j.results || []).map((c) =>
          `<li data-ll="${c.latitude},${c.longitude}" data-n="${esc(c.name)}">${esc(c.name)} <span class="muted">${esc([c.admin2, c.admin1, c.country_code].filter(Boolean).join(', '))}</span></li>`).join('')
          || '<li class="muted">Aucun résultat — essaie « Placer sur la carte »</li>';
        ul.hidden = false;
      } catch { ul.hidden = true; }
    }, 300);
  }
  ul.onclick = (e) => {
    const li = e.target.closest('li[data-ll]'); if (!li) return;
    const [lat, lon] = li.dataset.ll.split(',').map(Number);
    const f = formSpot(); ul.hidden = true;
    addMySpot(lat, lon, f.name || li.dataset.n || 'Mon spot', f.sport);
  };
}

/* ---------- détail heure par heure ---------- */
const detail = { spot: null, day: 0, data: null };
const hourlyCache = {};
async function fetchHourly(s) {
  const c = hourlyCache[s.id];
  if (c && Date.now() - c.t < CACHE_MIN * 60000) return c.h;
  const p = new URLSearchParams({
    latitude: s.lat, longitude: s.lon, elevation: s.alt,
    hourly: 'temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,snowfall,snow_depth',
    timezone: 'Europe/Paris', forecast_days: String(DAYS),
  });
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const h = (await r.json()).hourly;
  hourlyCache[s.id] = { t: Date.now(), h };
  return h;
}
/* Favori : un spot du catalogue passe en ★ ; un lieu hors base est d'abord ajouté à « Mes spots » */
function isFav(s) { return state.favs.has(s.id); }
function toggleFav(s) {
  if (String(s.id).startsWith('geo-')) {
    let m = state.mySpots.find((x) => x.geoId === s.id);
    if (!m) {
      m = { id: 'u-' + Date.now().toString(36), geoId: s.id, custom: true, name: s.name, type: 'ski', massif: s.massif || 'Mes spots', lat: s.lat, lon: s.lon, alt: s.alt || 0 };
      state.mySpots.push(m); saveMySpots(); renderMySpots();
    }
    s.id = m.id; s.custom = true;
  }
  const on = !state.favs.has(s.id);
  on ? state.favs.add(s.id) : state.favs.delete(s.id);
  store.set('favs', [...state.favs]);
  toast(on ? `★ ${s.name} suivi (favori + alerte session)` : `${s.name} retiré des favoris`);
  if (on && String(s.id).startsWith('u-') && !state.weather[s.id]) refresh(); else render();
  return on;
}
function syncAdj() {
  const el = $('#adjVal'); if (!el || !detail.spot) return;
  const v = state.windAdj[detail.spot.id] || 0;
  el.textContent = v ? `${v > 0 ? '+' : ''}${v} %` : 'tel que prévu';
  el.classList.toggle('on', !!v);
}
function syncDetailFav() {
  const b = $('#dFav'); if (!b || !detail.spot) return;
  const on = isFav(detail.spot);
  b.classList.toggle('on', on);
  b.title = on ? 'Retirer des favoris' : 'Suivre ce spot (favori + alerte session)';
}

async function openDetail(s, day = 0, tab) {
  detail.spot = s; detail.day = day; detail.data = null; detail.models = null;
  detail.tab = tab || (windy(s) && day < 7 ? 'models' : 'hours');
  const dlg = $('#detailDlg');
  $('#dTitle').innerHTML = typeIcons(s); $('#dTitle').append(s.name);
  $('#dMeta').textContent = s.custom ? `Mon spot · ${s.type === 'ski' ? s.massif : SPORTS[sportOf(s)].label} · ${s.alt} m · ${round(s.dist)} km`
    : `${s.massif} · ${s.alt} m · ${round(s.dist)} km`;
  $('#dLinks').innerHTML = (s.info ? `<p class="d-info">${esc(s.info)}</p>` : '') + `<div class="links">${linksFor(s)}</div>`
    + (windy(s) || isSki(s) ? `<div class="adj"><span>Vent sur ce spot <small class="muted">(relief, effet de col…)</small></span>
      <span class="adj-ctl"><button class="icon-btn" data-adj="-10" aria-label="Moins de vent">−</button><b id="adjVal"></b><button class="icon-btn" data-adj="10" aria-label="Plus de vent">+</button></span></div>` : '');
  syncAdj();
  $('#dLinks').querySelectorAll('[data-adj]').forEach((b) => { b.onclick = () => {
    const v = Math.max(-50, Math.min(100, (state.windAdj[s.id] || 0) + +b.dataset.adj));
    if (v) state.windAdj[s.id] = v; else delete state.windAdj[s.id];
    store.set('windAdj', state.windAdj); syncAdj(); render(); showDetailTab();
  }; });
  syncDetailFav();
  if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  showDetailTab();
}
async function showDetailTab() {
  const s = detail.spot;
  if (!s) return;
  document.querySelectorAll('#dTabs button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.tab === detail.tab));
  $('#dDays').hidden = detail.tab !== 'hours';
  $('#dBody').scrollTop = 0;
  if (detail.tab === 'models') {
    if (detail.models) return renderModels();
    $('#dBody').innerHTML = '<p class="muted small">Chargement des modèles (AROME, ARPEGE, ICON, ECMWF, GFS)…</p>';
    try { detail.models = await fetchModels(s); if (detail.spot === s && detail.tab === 'models') renderModels(); }
    catch (e) { console.error(e); $('#dBody').innerHTML = '<p class="muted small">Prévisions multi-modèles indisponibles (connexion ?).</p>'; }
    return;
  }
  if (detail.data) return renderDetail();
  $('#dBody').innerHTML = '<p class="muted small">Chargement des prévisions horaires…</p>';
  $('#dDays').innerHTML = '';
  try { detail.data = await fetchHourly(s); if (detail.spot === s && detail.tab === 'hours') renderDetail(); }
  catch (e) { console.error(e); $('#dBody').innerHTML = '<p class="muted small">Prévisions horaires indisponibles (connexion ?).</p>'; }
}

/* ---------- grille de vent multi-modèles (façon Windguru) ---------- */
const MODELS = [
  ['meteofrance_arome_france_hd', 'AROME', 'Météo-France 1,5 km · 2 j'],
  ['icon_d2', 'ICON-D2', 'DWD 2 km · 2 j'],
  ['meteofrance_arpege_europe', 'ARPEGE', 'Météo-France 10 km · 4 j'],
  ['icon_eu', 'ICON-EU', 'DWD 7 km · 5 j'],
  ['ecmwf_ifs025', 'ECMWF', 'CEPMMT 25 km · 7 j'],
  ['gfs_seamless', 'GFS', 'NOAA 25 km · 7 j'],
];
const MIX_W = { meteofrance_arome_france_hd: 4, icon_d2: 3, meteofrance_arpege_europe: 2, icon_eu: 2, ecmwf_ifs025: 1.5, gfs_seamless: 1 };
const modelsCache = {};
async function fetchModels(s) {
  const c = modelsCache[s.id];
  if (c && Date.now() - c.t < CACHE_MIN * 60000) return c.h;
  const p = new URLSearchParams({
    latitude: s.lat, longitude: s.lon, elevation: s.alt,
    hourly: 'wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,precipitation,snowfall',
    models: MODELS.map((m) => m[0]).join(','),
    timezone: 'Europe/Paris', forecast_days: '7',
  });
  let r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
  if (!r.ok) { // un modèle indisponible ne doit pas tout bloquer : on réessaie sans ICON-D2
    p.set('models', MODELS.map((m) => m[0]).filter((m) => m !== 'icon_d2').join(','));
    r = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
  }
  if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
  const h = (await r.json()).hourly;
  modelsCache[s.id] = { t: Date.now(), h };
  return h;
}
const WG_STOPS = [ // nœuds -> couleur (échelle façon Windguru)
  [0, [255, 255, 255]], [5, [205, 238, 255]], [9, [143, 227, 232]], [13, [126, 240, 154]], [17, [214, 245, 92]],
  [21, [255, 225, 77]], [25, [255, 174, 59]], [29, [255, 107, 59]], [34, [240, 55, 156]], [40, [179, 58, 214]], [50, [106, 51, 199]],
];
function windColor(kn) {
  if (kn == null) return null;
  let i = WG_STOPS.findIndex(([v]) => v > kn);
  if (i === -1) return `rgb(${WG_STOPS.at(-1)[1]})`;
  if (i === 0) i = 1;
  const [a, ca] = WG_STOPS[i - 1], [b, cb] = WG_STOPS[i], t = (kn - a) / (b - a);
  return `rgb(${ca.map((x, j) => Math.round(x + (cb[j] - x) * t)).join(',')})`;
}
function wgCell(kmh, cls = '') {
  if (kmh == null) return `<td class="na ${cls}">·</td>`;
  const kn = kmh / KN;
  return `<td class="${cls}" style="background:${windColor(kn)};color:${kn >= 30 ? '#fff' : '#111'}">${wv(kmh)}</td>`;
}
/* « Mix Chute de neige » : moyenne pondérée des modèles (les plus fins comptent plus),
   direction en moyenne vectorielle, fiabilité selon l'écart entre modèles. */
function wMedian(pairs) { // médiane pondérée : [[valeur, poids], …]
  const a = pairs.filter(([x]) => x != null).sort((p, q) => p[0] - q[0]);
  if (!a.length) return null;
  const half = a.reduce((t, [, w]) => t + w, 0) / 2;
  let c = 0;
  for (const [x, w] of a) { c += w; if (c >= half) return x; }
  return a.at(-1)[0];
}
/* « Mix » : médiane pondérée des modèles (les plus fins comptent plus) — un modèle isolé
   ne tire plus tout ; direction en moyenne vectorielle ; vote = part (pondérée) des modèles
   qui donnent une session ; fiabilité selon l'écart entre modèles. */
function mixAt(get, i, r) {
  let sw = 0, u = 0, v = 0, ok = 0;
  const ws = [], gs = [];
  for (const [m] of MODELS) {
    const x = get('wind_speed_10m', m, i); if (x == null) continue;
    const wt = MIX_W[m] || 1, g = get('wind_gusts_10m', m, i);
    sw += wt; ws.push([x, wt]); gs.push([g, wt]);
    if (r && x >= r.windMin && x <= r.windMax && (g == null || g <= r.gustMax)) ok += wt;
    const d = get('wind_direction_10m', m, i);
    if (d != null) { const a = (d * Math.PI) / 180; u += wt * x * Math.sin(a); v += wt * x * Math.cos(a); }
  }
  if (!sw) return null;
  const med = wMedian(ws);
  const mean = ws.reduce((t, [x, wt]) => t + x * wt, 0) / sw;
  const sd = Math.sqrt(ws.reduce((a, [x, wt]) => a + wt * (x - mean) ** 2, 0) / sw) / KN; // en nœuds
  const conf = ws.length < 2 ? 'one' : sd < 2.5 ? 'hi' : sd < 5 ? 'mid' : 'lo';
  return { wind: med, gust: wMedian(gs), dir: (Math.atan2(u, v) * 180 / Math.PI + 360) % 360, conf, n: ws.length, vote: Math.round((ok / sw) * 100) };
}
/* Ensembles : chaque centre fait tourner son modèle 30 à 50 fois avec de petites variations.
   Probabilité de session par jour = part des scénarios où, en journée (9h–18h), le vent reste
   au moins 2 h dans ta plage. */
const ENS_MODELS = ['ecmwf_ifs025', 'icon_seamless', 'gfs_seamless'];
const ensCache = {};
async function fetchEnsemble(s) {
  const c = ensCache[s.id];
  if (c && Date.now() - c.t < 3 * 3600e3) return c.h;
  const base = { latitude: s.lat, longitude: s.lon, elevation: s.alt, hourly: 'wind_speed_10m,wind_gusts_10m', timezone: 'Europe/Paris', forecast_days: '10' };
  let h = null;
  for (const models of [ENS_MODELS.join(','), 'ecmwf_ifs025']) { // repli si un ensemble est indisponible
    try {
      const r = await fetch(`https://ensemble-api.open-meteo.com/v1/ensemble?${new URLSearchParams({ ...base, models })}`);
      if (r.ok) { h = (await r.json()).hourly; break; }
    } catch {}
  }
  if (!h) throw new Error('ensembles indisponibles');
  ensCache[s.id] = { t: Date.now(), h };
  return h;
}
function ensProba(s, h) {
  const r = rangeFor(s), f = adjOf(s), wd = wx(s);
  const members = Object.keys(h).filter((k) => k.startsWith('wind_speed_10m'));
  const days = [...new Set(h.time.map((t) => t.slice(0, 10)))];
  return days.map((day) => {
    const idx = h.time.map((t, i) => [t, i]).filter(([t]) => t.startsWith(day) && +t.slice(11, 13) >= 9 && +t.slice(11, 13) <= 18).map(([, i]) => i);
    let snow = true;
    if (isKite(s) && wd) { const di = wd.daily.time.indexOf(day); snow = di < 0 || snowDepth(wd, di) >= state.kite.minSnow; }
    let n = 0, ok = 0;
    for (const k of members) {
      const ws = h[k], gs = h[k.replace('wind_speed_10m', 'wind_gusts_10m')];
      if (!ws || idx.every((i) => ws[i] == null)) continue;
      n++;
      const good = idx.filter((i) => {
        const x = ws[i] == null ? null : ws[i] * f, g = gs?.[i] == null ? null : gs[i] * f;
        return x != null && x >= r.windMin && x <= r.windMax && (g == null || g <= r.gustMax);
      }).length;
      if (snow && good >= 2) ok++;
    }
    return { day, n, p: n ? Math.round((ok / n) * 100) : null, snow };
  });
}
async function renderEnsemble(s) {
  const box = $('#ensBox'); if (!box || !windy(s)) return;
  box.innerHTML = '<p class="muted small">Calcul des probabilités sur 10 jours…</p>';
  try {
    const h = await fetchEnsemble(s);
    if (detail.spot !== s || detail.tab !== 'models' || !$('#ensBox')) return;
    const rows = ensProba(s, h);
    const n = Math.max(...rows.map((x) => x.n));
    const today = new Date().toLocaleDateString('sv-SE');
    $('#ensBox').innerHTML = `<h4>Probabilité de session · 10 jours</h4>
      <div class="ens-rows">${rows.map((x) => {
        const lbl = x.day === today ? 'Auj.' : new Date(x.day + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }).replace('.', '');
        return `<div class="ens-row"><span class="ens-d">${lbl}</span><span class="ens-bar"><i style="width:${x.p || 0}%"></i></span><b>${x.p == null ? '–' : x.p + ' %'}</b>${x.snow ? '' : '<small class="muted">neige</small>'}</div>`;
      }).join('')}</div>
      <p class="muted small">Part des ${n} scénarios (ECMWF, ICON, GFS) où le vent reste au moins 2 h entre 9h et 18h dans ta plage${isKite(s) ? ', avec assez de neige au sol' : ''}. Plus fiable que le Mix au-delà de 3 jours.</p>`;
  } catch {
    if ($('#ensBox')) $('#ensBox').innerHTML = '<p class="muted small">Probabilités sur 10 jours indisponibles pour le moment.</p>';
  }
}
function renderModels() {
  const s = detail.spot, h = detail.models, f = adjOf(s);
  const isW = (v) => v === 'wind_speed_10m' || v === 'wind_gusts_10m';
  const get = (v, m, i) => { const a = h[`${v}_${m}`]; const x = a ? a[i] : null; return x != null && isW(v) ? x * f : x; };
  const first = (v, i) => { for (const [m] of MODELS) { const x = get(v, m, i); if (x != null) return x; } return null; };
  const now = Date.now() - 3 * 3600e3;
  const cols = h.time.map((t, i) => [t, i]).filter(([t]) => +t.slice(11, 13) % 3 === 0 && new Date(t).getTime() >= now);
  const days = [];
  for (const [t] of cols) {
    const d = t.slice(0, 10);
    if (!days.length || days.at(-1).d !== d) days.push({ d, n: 0 });
    days.at(-1).n++;
  }
  const today = new Date().toLocaleDateString('sv-SE');
  const dLbl = (d) => (d === today ? 'Auj.'
    : new Date(d + 'T12:00').toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }).replace('.', ''));
  const r = rangeFor(s);
  // snowkite : pas de session sans assez de neige au sol ce jour-là
  const wd = wx(s);
  const snowOk = (t) => {
    if (!isKite(s) || !wd) return true;
    const i = wd.daily.time.indexOf(t.slice(0, 10));
    return i < 0 || snowDepth(wd, i) >= state.kite.minSnow;
  };
  const mixes = cols.map(([t, i]) => mixAt(get, i, windy(s) && snowOk(t) ? r : null));
  const dayStart = new Set(); let acc = 0; for (const d of days) { dayStart.add(acc); acc += d.n; }
  const ds = (k) => (dayStart.has(k) && k ? 'ds' : '');
  const CONF = { hi: ['élevée', 'hi'], mid: ['moyenne', 'mid'], lo: ['faible', 'lo'], one: ['1 seul modèle', 'one'] };
  let rows = `<tr class="m-first mix"><th title="Moyenne pondérée des modèles : les plus fins (AROME, ICON-D2) comptent le plus">Mix<small>mon modèle</small></th>${mixes.map((mx, k) => wgCell(mx?.wind, ds(k))).join('')}</tr>`
    + `<tr class="m-gust"><th class="sub">rafales</th>${mixes.map((mx, k) => wgCell(mx?.gust, 'g ' + ds(k))).join('')}</tr>`
    + `<tr class="m-dir"><th class="sub">dir.</th>${mixes.map((mx, k) => `<td class="dir ${ds(k)}">${mx ? arrow(mx.dir) : ''}</td>`).join('')}</tr>`
    + `<tr class="conf"><th class="sub">fiabilité</th>${mixes.map((mx, k) => `<td class="${ds(k)}">${mx ? `<i class="cf ${CONF[mx.conf][1]}" title="Fiabilité ${CONF[mx.conf][0]} (${mx.n} modèle${mx.n > 1 ? 's' : ''})"></i>` : ''}</td>`).join('')}</tr>`;
  for (const [m, name, info] of MODELS) {
    if (!cols.some(([, i]) => get('wind_speed_10m', m, i) != null)) continue;
    rows += `<tr class="m-first"><th title="${info}">${name}<small>${info.split(' · ')[1] || ''}</small></th>${cols.map(([, i], k) => wgCell(get('wind_speed_10m', m, i), ds(k))).join('')}</tr>`;
    rows += `<tr class="m-gust"><th class="sub">rafales</th>${cols.map(([, i], k) => wgCell(get('wind_gusts_10m', m, i), 'g ' + ds(k))).join('')}</tr>`;
    rows += `<tr class="m-dir"><th class="sub">dir.</th>${cols.map(([, i], k) => { const d = get('wind_direction_10m', m, i); return `<td class="dir ${ds(k)}">${d == null ? '' : arrow(d)}</td>`; }).join('')}</tr>`;
  }
  const tRow = cols.map(([, i], k) => `<td class="${ds(k)}">${round(first('temperature_2m', i))}</td>`).join('');
  const pRow = cols.map(([, i], k) => {
    const p = [0, 1, 2].reduce((a, o) => a + (first('precipitation', i + o) || 0), 0);
    return `<td class="${ds(k)}" style="${p >= 0.2 ? `background:rgba(59,130,246,${Math.min(0.6, 0.15 + p / 10)})` : ''}">${p >= 0.2 ? round(p, p < 10 ? 1 : 0) : ''}</td>`;
  }).join('');
  const snRow = cols.map(([, i], k) => {
    const sn = [0, 1, 2].reduce((a, o) => a + (first('snowfall', i + o) || 0), 0);
    return `<td class="${ds(k)}${sn >= 0.2 ? ' snow' : ''}">${sn >= 0.2 ? round(sn, sn < 10 ? 1 : 0) : ''}</td>`;
  }).join('');
  $('#dBody').innerHTML = `
    ${windy(s) ? `<p class="d-kite">${icon(SPORTS[sportOf(s)].icon)}<span>Ta plage ${SPORTS[sportOf(s)].label} : <b>${wv(r.windMin)}–${wv(r.windMax)} ${U()}</b>, rafales ≤ ${wv(r.gustMax)} <span class="muted">· ligne « session » = % des modèles (pondérés) qui te donnent une session</span></span></p>` : ''}
    <div class="wg-wrap"><table class="wg">
      <thead>
        <tr class="wg-days"><th></th>${days.map((d) => `<th colspan="${d.n}" class="ds">${dLbl(d.d)}</th>`).join('')}</tr>
        <tr class="hrs"><th>${U()}</th>${cols.map(([t], k) => `<th class="${ds(k)}">${+t.slice(11, 13)}h</th>`).join('')}</tr>
        ${windy(s) ? `<tr class="vote"><th title="Part des modèles (pondérée) qui donnent une session">session</th>${mixes.map((mx, k) => {
          const pct = mx ? mx.vote : null;
          return `<td class="${ds(k)}" style="${pct ? `background:rgba(22,163,74,${(0.12 + pct / 100 * 0.6).toFixed(2)});color:${pct >= 60 ? '#fff' : 'inherit'}` : ''}">${pct == null ? '' : pct ? pct : '·'}</td>`;
        }).join('')}</tr>` : ''}
      </thead>
      <tbody>
        ${rows}
        <tr class="extra"><th>Temp. °C</th>${tRow}</tr>
        <tr class="extra"><th>Pluie mm/3h</th>${pRow}</tr>
        ${isWind(s) ? '' : `<tr class="extra"><th>Neige cm/3h</th>${snRow}</tr>`}
      </tbody>
    </table></div>
    <div class="wg-scale">${[0, 5, 10, 15, 20, 25, 30, 35, 40].map((kn) =>
      `<span style="background:${windColor(kn)};color:${kn >= 30 ? '#fff' : '#111'}">${state.unit === 'kn' ? kn : Math.round(kn * KN)}</span>`).join('')}<em>${U()}</em></div>
    <div id="ensBox" class="ens"></div>
    <p class="muted small"><b>Mix</b> = mon modèle : médiane pondérée des modèles disponibles, les plus fins comptant le plus (AROME ×4, ICON-D2 ×3, ARPEGE et ICON-EU ×2, ECMWF ×1,5, GFS ×1) ; un modèle isolé ne fausse pas le résultat. <b>Session %</b> : part des modèles, pondérée, qui te donnent une session. <b>Fiabilité</b> : <i class="cf hi"></i> modèles d'accord, <i class="cf mid"></i> écart moyen, <i class="cf lo"></i> modèles en désaccord. ${f !== 1 ? `Vent corrigé de ${state.windAdj[s.id] > 0 ? '+' : ''}${state.windAdj[s.id]} % pour ce spot. ` : ''}Pas de 3 h, fais défiler vers la droite. Données Open-Meteo.</p>`;
  renderEnsemble(s);
}
function hourKiteClass(s, wind, gust, depth) {
  if (!windy(s)) return '';
  const k = rangeFor(s);
  if (isKite(s) && depth != null && depth * 100 < k.minSnow) return 'k-nosnow';
  if (wind < k.windMin) return 'k-warn';
  if (wind > k.windMax || gust > k.gustMax) return 'k-bad';
  return 'k-good';
}
function renderDetail() {
  const s = detail.spot, w = wx(s), f = adjOf(s);
  const h = f === 1 ? detail.data : { ...detail.data,
    wind_speed_10m: detail.data.wind_speed_10m.map((v) => v * f), wind_gusts_10m: detail.data.wind_gusts_10m.map((v) => v * f) };
  if (!h) return;
  const days = [...new Set(h.time.map((t) => t.slice(0, 10)))];
  const sess = w ? sessionsFor(s, w) : [];
  const sessDays = new Set(sess.map((x) => x.i - T0));
  $('#dDays').innerHTML = days.map((d, i) => {
    const dt = new Date(d + 'T12:00');
    const lbl = i === 0 ? 'Auj.' : i === 1 ? 'Dem.' : dt.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }).replace('.', '');
    return `<button data-i="${i}" aria-pressed="${i === detail.day}" class="${sessDays.has(i) ? 'has-sess' : ''}">${lbl}</button>`;
  }).join('');
  $('#dDays').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { detail.day = +b.dataset.i; renderDetail(); };
  });
  $('#dDays').querySelector('[aria-pressed=true]')?.scrollIntoView({ inline: 'center', block: 'nearest' });

  const day = days[detail.day];
  const idx = h.time.map((t, i) => (t.startsWith(day) ? i : -1)).filter((i) => i >= 0);
  const nowH = new Date().getHours();
  const maxW = Math.max(30, ...idx.map((i) => h.wind_gusts_10m[i] || 0));
  // résumé de la journée (heures de jour 9h-17h)
  const dayIdx = idx.filter((i) => { const hr = +h.time[i].slice(11, 13); return hr >= 9 && hr <= 17; });
  const avg = dayIdx.length ? dayIdx.reduce((a, i) => a + h.wind_speed_10m[i], 0) / dayIdx.length : null;
  const gmax = Math.max(...idx.map((i) => h.wind_gusts_10m[i] || 0));
  const depth = h.snow_depth[idx[12]];
  const snowDay = idx.reduce((a, i) => a + (h.snowfall[i] || 0), 0);
  const goodHours = idx.filter((i) => hourKiteClass(s, h.wind_speed_10m[i], h.wind_gusts_10m[i], h.snow_depth[i]) === 'k-good'
    && +h.time[i].slice(11, 13) >= 8 && +h.time[i].slice(11, 13) <= 18).length;
  $('#dBody').innerHTML = `
    <div class="d-sum">
      <div><span class="muted">Vent 9h–17h</span><b>${avg == null ? '–' : wv(avg)} ${U()}</b></div>
      <div><span class="muted">Rafales max</span><b>${wv(gmax)} ${U()}</b></div>
      <div><span class="muted">Neige au sol</span><b>${depth == null ? '–' : round(depth * 100)} cm</b></div>
      <div><span class="muted">Chute du jour</span><b>${round(snowDay)} cm</b></div>
    </div>
    ${windy(s) ? `<p class="d-kite ${goodHours ? 'ok' : ''}">${icon(SPORTS[sportOf(s)].icon)}${goodHours ? `${goodHours} h navigables entre 8h et 18h` : 'Pas de créneau entre 8h et 18h'} <span class="muted">(${SPORTS[sportOf(s)].label} : ${wv(rangeFor(s).windMin)}–${wv(rangeFor(s).windMax)} ${U()}, raf. ≤ ${wv(rangeFor(s).gustMax)}${isKite(s) ? `, neige ≥ ${state.kite.minSnow} cm` : ''})</span></p>` : ''}
    <div class="hours">
      <div class="hr head muted"><span>h</span><span></span><span>°C</span><span>Vent ${U()}</span><span>Raf.</span><span>Neige</span></div>
      ${idx.map((i) => {
        const hr = +h.time[i].slice(11, 13);
        const ws = h.wind_speed_10m[i], gu = h.wind_gusts_10m[i], sn = h.snowfall[i] || 0;
        const kc = hourKiteClass(s, ws, gu, h.snow_depth[i]);
        const night = hr < 7 || hr > 19;
        return `<div class="hr${night ? ' night' : ''}${detail.day === 0 && hr === nowH ? ' now' : ''}">
          <span>${hr}h</span>
          ${icon(wxId(h.weather_code[i]), 'i wx')}
          <span>${round(h.temperature_2m[i])}°</span>
          <span class="wcell ${kc}"><i class="bar" style="width:${Math.min(100, (ws / maxW) * 100)}%"></i>${arrow(h.wind_direction_10m[i])}<b>${wv(ws)}</b> <small>${dirName(h.wind_direction_10m[i])}</small></span>
          <span class="muted">${wv(gu)}</span>
          <span class="${sn >= 0.1 ? 'sn' : 'muted'}">${sn >= 0.1 ? round(sn, 1) : '·'}</span>
        </div>`;
      }).join('')}
    </div>
    <p class="muted small">${windy(s) ? 'Barre verte : vent dans ta plage · orange : trop faible · rouge : trop fort ou rafales · grise : pas assez de neige. ' : ''}Prévision Open-Meteo à ${s.alt} m${detail.day >= 7 ? ' — au-delà de 7 jours, indicative' : ''}.</p>`;
  // aujourd'hui : on garde le résumé en haut, l'heure actuelle est surlignée
  $('#dBody').scrollTop = 0;
}

/* ---------- aide : qu'est-ce qu'une session ? ---------- */
function renderHelp() {
  const r = (sp) => (sp === 'kite' ? state.kite : state.ranges[sp]);
  const line = (sp, extra = '') => `<li class="t-${sp}">${icon(SPORTS[sp].icon)}<span><b>${SESS_TYPE[sp]}</b> : vent entre <b>${wv(r(sp).windMin)} et ${wv(r(sp).windMax)} ${U()}</b>, rafales ≤ ${wv(r(sp).gustMax)} ${U()}${extra}</span></li>`;
  $('#helpBody').innerHTML = `
    <p>Une <b>session possible</b>, c'est un jour où la météo prévue correspond à <b>tes critères</b> pour ta discipline. Ce n'est pas une garantie : vérifie toujours sur place (vent réel, neige, BRA).</p>
    <h3>Tes critères actuels</h3>
    <ul class="help-list">
      ${line('kite', `, et au moins <b>${state.kite.minSnow} cm de neige au sol</b> (fraîche ou non)`)}
      <li class="t-ski">${icon('i-ski')}<span><b>Ski poudreuse</b> : au moins <b>10 cm tombés</b> les 2 jours d'avant, puis une journée calme (pas de grosse chute, ni pluie, vent &lt; 45 km/h)</span></li>
      ${['kitesea', 'wing', 'windsurf'].filter((x) => state.disc[x]).map((x) => line(x)).join('')}
    </ul>
    <p class="muted small">Tu changes ces critères dans ⚙ → Mes plages de vent.</p>
    <h3>Où les voir</h3>
    <ul class="help-list plain">
      <li><b>Sur une fiche</b> : « Sessions possibles » liste les jours, et ces jours sont colorés dans la bande des 14 jours.</li>
      <li><b>Bouton « Sessions possibles »</b> : ne garde que les spots qui en ont au moins une (14 jours dans la liste, jour choisi sur la carte).</li>
      <li><b>Sur la carte</b> : marqueur plein vert = session de vent, bleu = poudreuse.</li>
      <li><b>Bandeau en haut</b> : sessions possibles sur les spots que tu suis.</li>
    </ul>
    <h3>Suivre et alertes</h3>
    <ul class="help-list plain">
      <li><b>☆ Suivre</b> un spot : il passe en favori et tu es prévenu quand une session est possible (${state.sessionHorizon} prochains jours).</li>
      <li><b>🔔</b> (montagne) : alerte quand il va tomber beaucoup de neige (seuil en cm sur 3 jours).</li>
    </ul>`;
}
function openHelp() {
  renderHelp();
  const d = $('#helpDlg'); if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
}

/* ---------- partage ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
async function shareApp() {
  const url = location.origin + location.pathname.replace(/index\.html$/, '');
  try { await navigator.clipboard.writeText(url); toast('Lien copié'); }
  catch { prompt("Copie le lien de l'appli :", url); }
  // feuille de partage native sur téléphone (Messages, WhatsApp…)
  if (navigator.share) {
    try { await navigator.share({ title: 'Chute de neige', text: 'Spots snowkite & ski : météo, sessions et alertes neige', url }); } catch {}
  }
}

/* ---------- init ---------- */
function goTo(id) { // ouvre directement le détail du spot
  const sp = allSpots().map((x) => ({ ...x, dist: haversine(state.loc, x) })).find((x) => x.id === id);
  if (sp) openDetail(sp, 0);
}
function bindUI() {
  const radius = $('#radius');
  radius.value = state.radius; $('#radiusVal').textContent = state.radius;
  radius.oninput = () => { $('#radiusVal').textContent = radius.value; };
  radius.onchange = () => { state.radius = +radius.value; store.set('radius', state.radius); showLoc(); refresh(); };

  $('#typeFilter').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const t = b.dataset.type;
    if (t === 'all') { state.types.clear(); state.scope.clear(); }
    else if (t === 'fav' || t === 'mine') state.scope.has(t) ? state.scope.delete(t) : state.scope.add(t);
    else state.types.has(t) ? state.types.delete(t) : state.types.add(t);
    store.set('types', [...state.types]); store.set('scope', [...state.scope]);
    syncTypeChips(); render(); window.scrollTo({ top: 0 });
  });
  syncTypeChips();
  // raccourci « Sessions possibles » = filtre session dans les 14 jours (+ tri par prochaine session)
  $('#btnSessions').onclick = () => {
    const on = !state.sessionsOnly;
    state.filters.sessionDays = on ? 14 : 0;
    if (on && !state.sorts.includes('session')) state.sorts = ['session', ...state.sorts].slice(0, 3);
    if (!on) state.sorts = state.sorts.filter((k) => k !== 'session');
    saveSortFilter();
  };
  $('#btnSort').onclick = openSortDlg;
  const sdlg = $('#sortDlg');
  sdlg.addEventListener('click', (e) => {
    if (e.target === sdlg || e.target.closest('[data-close]') || e.target.id === 'sortApply') { sdlg.close ? sdlg.close() : sdlg.removeAttribute('open'); window.scrollTo({ top: 0 }); return; }
    const c = e.target.closest('[data-sort]');
    if (c) { // 1er appui = ajouté à la fin ; nouvel appui = retiré
      const k = c.dataset.sort;
      state.sorts = state.sorts.includes(k) ? state.sorts.filter((x) => x !== k) : [...sortList(), k].slice(-3);
      saveSortFilter(); renderSortDlg(); return;
    }
    if (e.target.id === 'sortReset') {
      state.sorts = ['dist']; state.filters = { ...FILTER_DEFAULT };
      saveSortFilter(); renderSortDlg();
    }
  });
  sdlg.addEventListener('input', (e) => { // affichage de la valeur pendant le glissement
    const el = e.target.closest('[data-f]'); if (!el || el.type !== 'range') return;
    const k = el.dataset.f, row = FILTER_UI.find((r) => r[0] === k);
    el.closest('label').querySelector('b').textContent = k === 'radius' ? `${el.value} km` : row[5](+el.value);
  });
  sdlg.addEventListener('change', (e) => {
    const el = e.target.closest('[data-f]'); if (!el) return;
    const k = el.dataset.f;
    if (k === 'radius') { state.radius = +el.value; store.set('radius', state.radius); $('#radius').value = state.radius; $('#radiusVal').textContent = state.radius; showLoc(); refresh().then(renderSortDlg); return; }
    state.filters[k] = el.type === 'checkbox' ? el.checked : +el.value;
    if (k === 'sessionDays' && state.filters.sessionDays && !state.sorts.includes('session')) state.sorts = ['session', ...state.sorts].slice(0, 3);
    saveSortFilter(); renderSortDlg();
  });
  syncSortButton();

  const dlg = $('#settingsDlg');
  const openSettings = () => { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); };
  $('#btnSettings').onclick = openSettings;
  $('#placePill').onclick = openSettings;
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close ? dlg.close() : dlg.removeAttribute('open');
  });
  $('#kiteReset').onclick = () => {
    if (state.sportTab === 'kite') state.kite = { ...KITE_DEFAULT };
    else state.ranges[state.sportTab] = { ...SPORTS[state.sportTab].def };
    saveRanges(); setupKiteSliders(); render();
  };
  document.querySelectorAll('#sportSel button').forEach((b) => {
    b.onclick = () => { state.sportTab = b.dataset.sport; setupKiteSliders(); };
  });
  renderMySpots();
  $('#msPlace').oninput = (e) => searchSpotPlace(e.target.value);
  $('#msHere').onclick = () => {
    if (!navigator.geolocation) return alert('Géolocalisation non disponible');
    navigator.geolocation.getCurrentPosition((p) => {
      const f = formSpot(); addMySpot(p.coords.latitude, p.coords.longitude, f.name || 'Mon spot', f.sport);
    }, () => toast('Localisation refusée'), { timeout: 10000 });
  };
  $('#msPick').onclick = () => openMapDialog({ mode: 'pick' });
  $('#mapDlgOk').onclick = () => {
    if (!pick.latlng) return;
    const f = formSpot(); closeMapDialog();
    const name = f.name || prompt('Nom du spot :', 'Mon spot');
    if (name === null) return;
    addMySpot(pick.latlng.lat, pick.latlng.lng, name.trim() || 'Mon spot', f.sport);
  };
  $('#mapDlg').addEventListener('click', (e) => {
    if (e.target === $('#mapDlg') || e.target.closest('[data-close]')) closeMapDialog();
  });
  $('#dMapBtn').onclick = () => { if (detail.spot) openMapDialog({ spot: detail.spot }); };
  $('#dFav').onclick = () => { if (!detail.spot) return; toggleFav(detail.spot); syncDetailFav(); };
  document.querySelectorAll('#discSel button').forEach((b) => {
    b.setAttribute('aria-pressed', !!state.disc[b.dataset.disc]);
    b.onclick = () => {
      const k = b.dataset.disc, on = !state.disc[k];
      state.disc[k] = on; store.set('disc', state.disc);
      b.setAttribute('aria-pressed', on);
      const names = Object.keys(state.disc).filter((x) => state.disc[x]).map((x) => SESS_TYPE[x]);
      toast(names.length ? `Disciplines affichées : ${names.join(', ')}` : 'Aucune discipline : spots mer & lacs masqués');
      syncTypeChips(); render();
    };
  });
  const nt = $('#ntfyTopic'); nt.value = state.ntfyTopic;
  nt.onchange = () => { state.ntfyTopic = nt.value.trim(); store.set('ntfyTopic', state.ntfyTopic); };
  const sa = $('#sessionAlert'); sa.checked = state.sessionAlert;
  sa.onchange = () => { state.sessionAlert = sa.checked; store.set('sessionAlert', sa.checked); if (sa.checked) askNotif(); render(); };
  const hz = $('#horizon'); hz.value = state.sessionHorizon; $('#horizonVal').textContent = state.sessionHorizon;
  hz.oninput = () => { $('#horizonVal').textContent = hz.value; };
  hz.onchange = () => { state.sessionHorizon = +hz.value; store.set('sessionHorizon', state.sessionHorizon); render(); };
  const thr = $('#threshold');
  thr.value = state.threshold; $('#thrVal').textContent = state.threshold;
  thr.oninput = () => { $('#thrVal').textContent = thr.value; };
  thr.onchange = () => { state.threshold = +thr.value; store.set('threshold', state.threshold); render(); };
  const all = $('#alertAll'); all.checked = state.alertAll;
  all.onchange = () => { state.alertAll = all.checked; store.set('alertAll', state.alertAll); if (all.checked) askNotif(); render(); };
  $('#btnNotif').onclick = askNotif;
  $('#notifState').textContent = notifStateText();
  $('#btnExport').onclick = async () => {
    const cfg = {
      // position arrondie à ~10 km : la config est publique, on n'y met jamais la position GPS exacte
      home: { lat: +state.loc.lat.toFixed(1), lon: +state.loc.lon.toFixed(1), label: state.loc.label === 'ma position' ? 'zone (position arrondie)' : state.loc.label },
      radius_km: state.radius,
      default_threshold_cm: state.threshold,
      alert_all_in_radius: state.alertAll,
      spots: state.bells,
      ntfy_topic: state.ntfyTopic || undefined,
      session_alert: state.sessionAlert,
      session_horizon_days: state.sessionHorizon,
      session_spots: [...state.favs, ...Object.keys(state.bells)].filter((v, i, a) => a.indexOf(v) === i),
      ranges_kmh: { kite: state.kite, ...state.ranges },
      disciplines: Object.keys(state.disc).filter((k) => state.disc[k]),
      wind_adj_pct: state.windAdj,
      my_spots: state.mySpots.map(({ id, name, type, sport, sports, lat, lon, alt }) => ({ id, name, type, sport, sports, lat, lon, alt })),
    };
    const txt = JSON.stringify(cfg, null, 2);
    try { await navigator.clipboard.writeText(txt); $('#exportMsg').textContent = 'Copié. Colle-le dans alerts-config.json.'; }
    catch { prompt('Copie ce texte dans alerts-config.json :', txt); }
  };

  setupKiteSliders();
  document.querySelectorAll('#unitSel button').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.unit === state.unit);
    b.onclick = () => {
      state.unit = b.dataset.unit; store.set('unit', state.unit);
      document.querySelectorAll('#unitSel button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      setupKiteSliders(); render();
      if (detail.spot) showDetailTab();
    };
  });

  $('#btnGeo').onclick = geolocate;
  $('#locInput').oninput = (e) => searchCity(e.target.value);
  $('#btnShare').onclick = shareApp;
  $('#btnHelp').onclick = openHelp;
  $('#helpDlg').addEventListener('click', (e) => {
    if (e.target === $('#helpDlg') || e.target.closest('[data-close]')) { const d = $('#helpDlg'); d.close ? d.close() : d.removeAttribute('open'); }
  });
  // recherche : liste de suggestions sous la barre
  const sq = $('#searchInput'), box = $('#suggest');
  let sqTimer, geoSeq = 0;
  const closeSuggest = () => { box.hidden = true; };
  const showSuggest = async () => {
    if (document.activeElement !== sq) return; // la recherche a été validée ou quittée
    const q = sq.value.trim();
    $('#searchClear').hidden = !sq.value;
    if (q.length < 2) { box.hidden = true; if (!q && state.q) { state.q = ''; render(); } return; }
    const res = searchResults(q);
    const star = (x) => `<button class="sg-fav icon-btn${isFav(x) ? ' on' : ''}" data-fav="${esc(x.id)}" aria-label="Favori">${icon('i-star')}</button>`;
    const rows = res.slice(0, 8).map((x) => `<li data-id="${esc(x.id)}">${typeIcons(x)}<span class="sg-txt"><b>${esc(x.name)}</b><small>${esc(x.massif || '')} · ${round(x.dist)} km</small></span>${star(x)}</li>`);
    if (res.length > 8) rows.push(`<li class="sg-all" data-all="1">Voir les ${res.length} résultats dans la liste</li>`);
    box.innerHTML = rows.join('') + '<li class="sg-geo muted" hidden></li>';
    box.hidden = false;
    // pas assez de résultats : proposer un lieu (n'importe quelle station ou commune de France)
    if (res.length < 3) {
      const seq = ++geoSeq;
      try {
        const j = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=3&language=fr&format=json&countryCode=FR`)).json();
        if (seq !== geoSeq || box.hidden) return;
        const places = (j.results || []).filter((c) => !res.some((x) => haversine(x, { lat: c.latitude, lon: c.longitude }) < 3));
        if (places.length) {
          box.querySelector('.sg-geo')?.remove();
          box.insertAdjacentHTML('beforeend', places.map((c) =>
            `<li data-geo="${c.latitude},${c.longitude},${Math.round(c.elevation || 0)}" data-n="${esc(c.name)}" data-m="${esc([c.admin2, c.admin1].filter(Boolean).join(', '))}">${icon('i-pin')}<span class="sg-txt"><b>${esc(c.name)}</b><small>${esc([c.admin2, c.admin1].filter(Boolean).join(', '))} · voir la météo ici</small></span></li>`).join(''));
        } else if (!res.length) box.innerHTML = '<li class="muted">Aucun spot, station ou lieu trouvé</li>';
      } catch { if (!res.length) box.innerHTML = '<li class="muted">Aucun spot ni station trouvé</li>'; }
    }
  };
  sq.oninput = () => { clearTimeout(sqTimer); sqTimer = setTimeout(showSuggest, 180); };
  sq.onfocus = () => { if (sq.value.trim().length >= 2) showSuggest(); };
  sq.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(sqTimer); geoSeq++; applySearch(sq.value); closeSuggest(); sq.blur(); }
    if (e.key === 'Escape') closeSuggest();
  };
  const applySearch = async (q) => { // filtre la liste avec la recherche
    state.q = q; render(); window.scrollTo({ top: 0 });
    const missing = searchResults().filter((x) => !state.weather[x.id]);
    if (missing.length) { try { await fetchWeather(missing.slice(0, 200)); render(); } catch {} }
  };
  box.addEventListener('mousedown', (e) => e.preventDefault()); // garder le focus pendant le choix
  box.addEventListener('click', async (e) => {
    const fb = e.target.closest('[data-fav]');
    if (fb) { // étoile : favori sans fermer la liste
      const x = searchResults(sq.value).find((y) => y.id === fb.dataset.fav);
      if (x) fb.classList.toggle('on', toggleFav(x));
      return;
    }
    const li = e.target.closest('li'); if (!li) return;
    if (li.dataset.all) { applySearch(sq.value); closeSuggest(); sq.blur(); return; }
    closeSuggest(); sq.blur();
    let spot;
    if (li.dataset.id) spot = searchResults(sq.value).find((x) => x.id === li.dataset.id);
    else if (li.dataset.geo) {
      const [lat, lon, alt] = li.dataset.geo.split(',').map(Number);
      spot = { id: `geo-${lat.toFixed(3)},${lon.toFixed(3)}`, name: li.dataset.n, massif: li.dataset.m, type: 'ski', lat, lon, alt, dist: haversine(state.loc, { lat, lon }) };
    }
    if (!spot) return;
    if (!state.weather[spot.id] && !spot.id.startsWith('geo-')) { try { await fetchWeather([spot]); } catch {} }
    openDetail(spot, 0);
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) closeSuggest(); });
  $('#searchClear').onclick = () => { sq.value = ''; $('#searchClear').hidden = true; closeSuggest(); if (state.q) { state.q = ''; render(); } sq.focus(); };
  const ddlg = $('#detailDlg');
  ddlg.addEventListener('click', (e) => {
    if (e.target === ddlg || e.target.closest('[data-close]')) { ddlg.close ? ddlg.close() : ddlg.removeAttribute('open'); }
  });
  ddlg.addEventListener('close', () => { detail.spot = null; });
  document.querySelectorAll('#dTabs button').forEach((b) => {
    b.onclick = () => { detail.tab = b.dataset.tab; showDetailTab(); };
  });

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      state.view = b.dataset.view;
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $('#list').hidden = state.view !== 'list';
      $('#mapWrap').hidden = state.view !== 'map';
      requestAnimationFrame(render); // la carte doit être visible pour calculer sa taille
    };
  });
  const goto = (e) => {
    const a = e.target.closest('[data-goto]'); if (!a) return;
    e.preventDefault(); goTo(a.dataset.goto);
  };
  $('#alertsBanner').addEventListener('click', goto);
  $('#map').addEventListener('click', (e) => { // depuis la carte : ouvrir directement le détail
    const a = e.target.closest('[data-goto]'); if (!a) return;
    e.preventDefault();
    const sp = spotsInRadius().find((x) => x.id === a.dataset.goto) || allInRadius().find((x) => x.id === a.dataset.goto);
    if (sp) openDetail(sp, +(a.dataset.day || 0));
  });
}

/* Mode propriétaire : la section ntfy n'est visible que sur le téléphone du propriétaire.
   Ouvrir une fois l'appli avec « ?moi » l'active ; « ?moi=0 » la désactive. */
function ownerMode() {
  const q = new URLSearchParams(location.search);
  if (q.has('moi')) {
    store.set('owner', q.get('moi') !== '0');
    q.delete('moi');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
  }
  $('#ntfyBlock').hidden = !store.get('owner', false);
}

async function init() {
  ownerMode();
  bindUI();
  showLoc();
  const [cur, osm, eau] = await Promise.all(['spots.json', 'spots-osm.json', 'spots-eau.json'].map((f) =>
    fetch(f).then((r) => (r.ok ? r.json() : [])).catch(() => [])));
  state.spots = [...cur, ...eau, ...osm];
  await refresh();
  setInterval(() => refresh(), CHECK_EVERY_MIN * 60000);
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => reg.update()).catch(() => {});
    // quand une nouvelle version prend la main, on recharge une fois
    const hadController = !!navigator.serviceWorker.controller; // pas de rechargement à la 1re visite
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !reloaded) { reloaded = true; location.reload(); }
    });
  }
}
init();
