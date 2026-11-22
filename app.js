/* Chute de Neige — spots snowkite & ski, météo, sessions, webcams, alertes neige */
'use strict';

const HYERES = { lat: 43.1204, lon: 6.1286, label: 'Hyères (par défaut)' };
const CACHE_MIN = 30;           // durée de cache météo (minutes)
const CHECK_EVERY_MIN = 30;     // vérification des alertes appli ouverte
const DAYS = 14;                // jours de prévision
const PAST = 2;                 // jours passés (neige tombée)
const T0 = PAST;                // index d'aujourd'hui dans les tableaux "daily"
const KITE_DEFAULT = { windMin: 15, windMax: 40, gustMax: 55, minSnow: 10 }; // km/h, cm
const SKI = { freshMin: 10, maxSnowfall: 3, windMax: 45 };

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  spots: [],
  weather: {},
  loc: store.get('loc', HYERES),
  radius: store.get('radius', 400),
  type: store.get('type', 'all'),
  sort: store.get('sort', 'dist'),
  sessionsOnly: store.get('sessionsOnly', false),
  favs: new Set(store.get('favs', [])),
  bells: store.get('bells', {}),
  threshold: store.get('threshold', 20),
  alertAll: store.get('alertAll', false),
  kite: { ...KITE_DEFAULT, ...store.get('kite', {}) },
  unit: store.get('unit', 'kn'),          // unité du vent : 'kn' (nœuds) ou 'kmh'
  mapKite: store.get('mapKite', true),
  mapSki: store.get('mapSki', true),
  mapDay: 'all',
  mapGoodOnly: store.get('mapGoodOnly', false),
  view: 'list',
  map: null, markers: null,
};

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

function kiteRating(wind, gust) {
  if (wind == null) return null;
  const k = state.kite;
  if (wind < k.windMin) return { cls: 'warn', txt: 'Pas assez de vent' };
  if (wind > k.windMax || (gust != null && gust > k.gustMax)) return { cls: 'bad', txt: 'Trop fort / rafales' };
  return { cls: 'good', txt: 'Bon pour le kite' };
}
const isKite = (s) => s.type === 'kite' || s.type === 'both';
const isSki = (s) => s.type === 'ski' || s.type === 'both';

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

/* Détection des sessions sur 14 jours */
function sessionsFor(s, w) {
  if (!w) return [];
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
  const all = sessionsFor(s, state.weather[s.id]);
  if (state.type === 'kite') return all.filter((x) => x.kind === 'kite');
  if (state.type === 'ski') return all.filter((x) => x.kind === 'ski');
  return all;
}

async function fetchWeather(spots) {
  const now = Date.now();
  const cache = store.get('wxCache3', {});
  const todo = spots.filter((s) => !(cache[s.id] && now - cache[s.id].t < CACHE_MIN * 60000));
  for (let i = 0; i < todo.length; i += 40) {
    const chunk = todo.slice(i, i + 40);
    const p = new URLSearchParams({
      latitude: chunk.map((s) => s.lat).join(','),
      longitude: chunk.map((s) => s.lon).join(','),
      elevation: chunk.map((s) => s.alt).join(','),
      current: 'temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,snowfall,snow_depth',
      hourly: 'snow_depth',
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
        w.depth = w.daily.time.map((day) => { const k = h.time.indexOf(`${day}T12:00`); return k < 0 ? null : h.snow_depth[k]; });
        delete w.hourly; delete w.hourly_units;
      }
      cache[chunk[j].id] = { t: now, w };
    });
  }
  for (const k of Object.keys(cache)) if (now - cache[k].t > 6 * 3600000) delete cache[k];
  store.set('wxCache3', cache);
  try { localStorage.removeItem('wxCache'); localStorage.removeItem('wxCache2'); } catch {}
  for (const s of spots) if (cache[s.id]) state.weather[s.id] = cache[s.id].w;
}

/* ---------- filtrage ---------- */
function allInRadius() {
  return state.spots
    .map((s) => ({ ...s, dist: haversine(state.loc, s) }))
    .filter((s) => s.dist <= state.radius);
}
function spotsInRadius() {
  return allInRadius()
    .filter((s) => state.type === 'all'
      || (state.type === 'kite' && isKite(s))
      || (state.type === 'ski' && isSki(s))
      || (state.type === 'fav' && state.favs.has(s.id)));
}
function visibleSpots() {
  const list = spotsInRadius();
  return state.sessionsOnly ? list.filter((s) => relevantSessions(s).length) : list;
}
function sortSpots(list) {
  const key = {
    dist: (s) => s.dist,
    snow: (s) => -(state.weather[s.id] ? summarize(state.weather[s.id]).next72 : -1),
    wind: (s) => {
      const w = state.weather[s.id]; if (!w) return 999;
      const v = w.current.wind_speed_10m;
      return isKite(s) ? Math.abs(v - 25) : 500 + Math.abs(v - 25);
    },
    session: (s) => { const x = relevantSessions(s)[0]; return x ? x.i * 10000 + s.dist : 1e9 + s.dist; },
  }[state.sort];
  return list.sort((a, b) => key(a) - key(b));
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
    if (thr == null || !w) continue;
    const { next72 } = summarize(w);
    if (next72 >= thr) out.push({ s, next72, thr });
  }
  return out.sort((a, b) => b.next72 - a.next72);
}
async function notify(alerts) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const sent = store.get('sentAlerts', {});
  const day = new Date().toISOString().slice(0, 10);
  const fresh = alerts.filter((a) => sent[a.s.id] !== day);
  if (!fresh.length) return;
  const body = fresh.slice(0, 5).map((a) => `${a.s.name} : ${round(a.next72)} cm`).join('\n');
  const title = `Neige annoncée sur ${fresh.length} spot${fresh.length > 1 ? 's' : ''}`;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, { body, icon: 'icons/icon-192.png', tag: 'neige' });
    else new Notification(title, { body });
  } catch { try { new Notification(title, { body }); } catch {} }
  fresh.forEach((a) => { sent[a.s.id] = day; });
  store.set('sentAlerts', sent);
}
function renderAlertsBanner(alerts) {
  const el = $('#alertsBanner');
  el.hidden = !alerts.length;
  el.innerHTML = alerts.map((a) =>
    `<div class="alert" data-goto="${esc(a.s.id)}">${icon('i-snow')}<span><b>${esc(a.s.name)}</b> · ${round(a.next72)} cm sur 3 jours <span class="muted">(seuil ${a.thr} cm)</span></span></div>`
  ).join('');
}

/* ---------- rendu ---------- */
function linksFor(s) {
  const L = [];
  const cam = s.webcam || `https://www.google.com/search?q=${encodeURIComponent('webcam live ' + s.name)}`;
  L.push(['i-camera', 'Webcams', cam]);
  if (s.web) L.push(['i-globe', 'Site', s.web]);
  L.push(['i-wind', 'Windy', `https://www.windy.com/${s.lat}/${s.lon}?${s.lat},${s.lon},11`]);
  L.push(['i-route', 'Itinéraire', `https://www.google.com/maps/dir/?api=1&origin=${state.loc.lat},${state.loc.lon}&destination=${s.lat},${s.lon}`]);
  L.push(['i-alert', 'Avalanche', 'https://meteofrance.com/meteo-montagne']);
  return L.map(([ic, t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${icon(ic)}${t}</a>`).join('');
}
function typeIcons(s) {
  return (isKite(s) ? icon('i-kite') : '') + (isSki(s) ? icon('i-ski') : '');
}

function renderCard(s, alerting) {
  const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
  const w = state.weather[s.id];
  node.dataset.id = s.id;
  node.classList.toggle('alerting', alerting);
  const h = node.querySelector('.name');
  h.innerHTML = typeIcons(s);
  h.append(s.name);
  node.querySelector('.meta').textContent = `${s.massif} · ${s.alt} m · ${round(s.dist)} km`;
  node.querySelector('.info').textContent = s.info || '';
  node.querySelector('.links').innerHTML = linksFor(s);

  const fav = node.querySelector('.fav');
  fav.classList.toggle('on', state.favs.has(s.id));
  fav.onclick = () => {
    state.favs.has(s.id) ? state.favs.delete(s.id) : state.favs.add(s.id);
    store.set('favs', [...state.favs]); render();
  };
  const bell = node.querySelector('.bell');
  const thr = state.bells[s.id];
  bell.classList.toggle('on', thr != null);
  bell.title = thr != null ? `Alerte à ${thr} cm — modifier` : 'Créer une alerte neige';
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
  const kr = isKite(s) ? kiteRating(c.wind_speed_10m, c.wind_gusts_10m) : null;
  node.querySelector('.now').innerHTML = `
    <span>${icon(wxId(c.weather_code))}<b>${round(c.temperature_2m)}°</b></span>
    <span title="Vent actuel">${kr ? `<i class="dot ${kr.cls}" title="${kr.txt}"></i>` : icon('i-wind')}<b>${wv(c.wind_speed_10m)}</b> ${U()} ${arrow(c.wind_direction_10m)}${dirName(c.wind_direction_10m)} <span class="muted">raf. ${wv(c.wind_gusts_10m)}</span></span>
    <span title="Neige au sol (estimée)">${icon('i-mountain')}<b>${c.snow_depth != null ? round(c.snow_depth * 100) : '–'}</b> cm</span>
    <span title="Neige prévue sur 3 jours (48 h passées : ${round(sm.past48)} cm)">${icon('i-snow')}<b class="plus">+${round(sm.next72)}</b> cm / 3 j</span>`;

  const sess = sessionsFor(s, w);
  const shown = relevantSessions(s);
  node.querySelector('.sessions').innerHTML = shown.slice(0, 6).map((x) =>
    `<span class="sess ${x.kind}${x.far ? ' far' : ''}" title="${x.far ? 'Prévision lointaine, indicative' : ''}">${icon(x.kind === 'kite' ? 'i-kite' : 'i-ski')}<b>${dayLong(w, x.i)}</b> ${x.txt}</span>`
  ).join('') + (shown.length > 6 ? `<span class="sess muted">+${shown.length - 6}</span>` : '');

  const byDay = {};
  sess.forEach((x) => { byDay[x.i] = byDay[x.i] || x.kind; });
  const d = w.daily;
  let html = '';
  for (let i = T0; i < d.time.length; i++) {
    const sn = d.snowfall_sum[i] || 0;
    const cls = ['day', i === T0 && 'today', byDay[i] && `s-${byDay[i]}`, i - T0 >= 7 && 'far'].filter(Boolean).join(' ');
    const kd = isKite(s) ? kiteRating(d.wind_speed_10m_max[i], d.wind_gusts_10m_max[i]) : null;
    html += `<div class="${cls}" data-day="${i}" title="${dayDate(w, i).toLocaleDateString('fr-FR')} · vent max ${wv(d.wind_speed_10m_max[i])} ${U()} ${dirName(d.wind_direction_10m_dominant[i])}, rafales ${wv(d.wind_gusts_10m_max[i])} ${U()} — toucher pour le détail heure par heure">
      <div class="d">${dayLabel(w, i)}</div>
      ${icon(wxId(d.weather_code[i]), 'i wx')}
      <div class="t">${round(d.temperature_2m_min[i])}/${round(d.temperature_2m_max[i])}°</div>
      <div class="sn${sn < 0.5 ? ' zero' : ''}">${sn < 0.5 ? '0' : round(sn)} cm</div>
      <div class="wd${kd ? ' k-' + kd.cls : ''}">${arrow(d.wind_direction_10m_dominant[i])}${wv(d.wind_speed_10m_max[i])}</div>
      <div class="gu">raf ${wv(d.wind_gusts_10m_max[i])}</div>
    </div>`;
  }
  node.querySelector('.days').innerHTML = html;
  node.querySelector('.days').insertAdjacentHTML('afterend', `<p class="days-legend muted">Vent max et rafales en ${U()} · touche la fiche pour le détail heure par heure</p>`);
  node.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    const day = e.target.closest('[data-day]');
    openDetail(s, day ? +day.dataset.day - T0 : 0);
  });
  return node;
}

function render() {
  const list = sortSpots(visibleSpots());
  const alerts = computeAlerts(spotsInRadius());
  const alertIds = new Set(alerts.map((a) => a.s.id));
  renderAlertsBanner(alerts);
  $('#list').replaceChildren(...list.map((s) => renderCard(s, alertIds.has(s.id))));
  const n = list.length, pl = n > 1 ? 's' : '';
  $('#status').textContent = state.sessionsOnly
    ? (n ? `${n} spot${pl} avec au moins une session dans les 14 jours · ${state.radius} km autour de ${state.loc.label}`
         : 'Aucune session prévue dans les 14 jours dans ce rayon.')
    : (n ? `${n} spot${pl} dans un rayon de ${state.radius} km autour de ${state.loc.label}`
         : 'Aucun spot dans ce rayon — augmente la distance.');
  if (state.view === 'map') renderMap();
  return { list, alerts };
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/* Statut d'un spot sur la carte selon MES conditions.
   day = 'all' (sur 14 jours) ou index du jour (0 = aujourd'hui). */
const MAP_STATUS = {
  good:    { label: 'Session kite', good: true },
  powder:  { label: 'Poudreuse', good: true },
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
    if (ses.some((x) => x.kind === 'kite')) return { st: 'good', n: ses.filter((x) => x.kind === 'kite').length + ' j' };
    if (ses.some((x) => x.kind === 'ski')) return { st: 'powder', n: ses.filter((x) => x.kind === 'ski').length + ' j' };
    const n72 = summarize(w).next72;
    if (n72 >= 5) return { st: 'snowing', n: `+${round(n72)}` };
    return { st: 'none' };
  }
  const i = T0 + day;
  const ses = sessionsFor(s, w).filter((x) => x.i === i);
  const wind = d.wind_speed_10m_max[i], gust = d.wind_gusts_10m_max[i], sf = d.snowfall_sum[i] || 0;
  if (ses.some((x) => x.kind === 'kite')) return { st: 'good', n: wv(wind) };
  if (ses.some((x) => x.kind === 'ski')) return { st: 'powder', n: `${round((d.snowfall_sum[i - 1] || 0) + (d.snowfall_sum[i - 2] || 0))}` };
  if (isKite(s) && state.type !== 'ski') {
    const k = state.kite;
    if (snowDepth(w, i) < k.minSnow) return { st: sf >= 3 ? 'snowing' : 'nosnow', n: sf >= 3 ? `+${round(sf)}` : null };
    if (wind < k.windMin) return { st: 'weak', n: wv(wind) };
    return { st: 'strong', n: wv(wind) };
  }
  if (sf >= 3) return { st: 'snowing', n: `+${round(sf)}` };
  return { st: 'none' };
}
function mapSpots() {
  return allInRadius()
    .filter((s) => (state.mapKite && isKite(s)) || (state.mapSki && isSki(s)))
    .filter((s) => !state.sessionsOnly || relevantSessions(s).length);
}
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
  $('#mapGood').setAttribute('aria-pressed', state.mapGoodOnly);
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
    const w = state.weather[s.id];
    const { st, n } = mapStatus(s, w, state.mapDay);
    if (state.mapGoodOnly && !MAP_STATUS[st].good) continue;
    const kite = isKite(s);
    if (!seen.has(st)) seen.set(st, new Set());
    seen.get(st).add(kite ? 'kite' : 'ski');
    shown++;
    const html = `<div class="mk ${kite ? 'kite' : 'ski'} st-${st}">${icon(kite ? 'i-kite' : 'i-ski')}` +
      (n != null ? `<span class="mk-n">${n}</span>` : '') + '</div>';
    const div = document.createElement('div');
    const b = document.createElement('b'); b.textContent = s.name; div.append(b);
    const dayTxt = state.mapDay === 'all' ? 'sur 14 jours' : dayLong(w || Object.values(state.weather)[0], T0 + state.mapDay);
    div.insertAdjacentHTML('beforeend', `<br>${kite ? 'Spot snowkite' : 'Station'} · ${s.alt} m · ${round(s.dist)} km` +
      `<br><span class="pop-st st-${st}">${MAP_STATUS[st].label}</span> <span class="muted">${dayTxt}</span>` +
      (w && state.mapDay !== 'all' ? `<br>Vent max ${wv(w.daily.wind_speed_10m_max[T0 + state.mapDay])} ${U()} ${dirName(w.daily.wind_direction_10m_dominant[T0 + state.mapDay])} · raf. ${wv(w.daily.wind_gusts_10m_max[T0 + state.mapDay])} · ${round(snowDepth(w, T0 + state.mapDay))} cm au sol` : '') +
      (w && state.mapDay === 'all' ? `<br>Maintenant : ${round(w.current.temperature_2m)}° · vent ${wv(w.current.wind_speed_10m)} ${U()} · ${round(snowDepth(w, T0))} cm au sol` : '') +
      `<br><a href="#" data-goto="${esc(s.id)}" data-day="${state.mapDay === 'all' ? 0 : state.mapDay}">Détail heure par heure</a>`);
    L.marker([s.lat, s.lon], {
      icon: L.divIcon({ html, className: 'mk-wrap', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] }),
      zIndexOffset: MAP_STATUS[st].good ? 1000 : kite ? 500 : 0,
    }).bindPopup(div).addTo(state.markers);
    pts.push([s.lat, s.lon]);
  }
  $('#mapCount').textContent = `${shown} affiché${shown > 1 ? 's' : ''}`;
  // légende : seulement les statuts présents, avec la forme des marqueurs
  const order = Object.keys(MAP_STATUS);
  $('#mapLegend').innerHTML = [...seen.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((st) =>
    `<span>${[...seen.get(st)].sort().map((f) => `<i class="lg ${f} st-${st}"></i>`).join('')}${MAP_STATUS[st].label}</span>`).join('')
    + `<span class="lg-note">◆ spot kite · ● station · chiffre : ${state.mapDay === 'all' ? 'jours de session ou cm sur 3 j' : `vent max (${U()}) ou cm de neige`}</span>`
    || '<span>Aucun spot ne correspond.</span>';
  if (!seen.size) $('#mapLegend').innerHTML = '<span>Aucun spot ne correspond à ces conditions.</span>';
  if (!state.mapFitted || state.mapFitted !== `${state.loc.lat},${state.loc.lon},${state.radius}`) {
    state.map.fitBounds(pts, { padding: [24, 24], maxZoom: 9 });
    state.mapFitted = `${state.loc.lat},${state.loc.lon},${state.radius}`;
  }
}

/* ---------- chargement ---------- */
async function refresh(force = false) {
  if (force) store.set('wxCache3', {});
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
  const { alerts } = render();
  notify(alerts);
}

/* ---------- position ---------- */
function showLoc() {
  $('#locLabel').textContent = `${state.loc.label} · ${state.loc.lat.toFixed(3)}, ${state.loc.lon.toFixed(3)}`;
  $('#placeTxt').textContent = `${state.loc.label.replace(' (par défaut)', '')} · ${state.radius} km`;
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

/* ---------- réglages kite (affichés dans l'unité choisie) ---------- */
const SLIDERS = { // bornes en km/h ; converties pour l'affichage
  windMin: [5, 40], windMax: [15, 75], gustMax: [20, 95],
};
function setupKiteSliders() {
  for (const k of Object.keys(KITE_DEFAULT)) {
    const el = $(`#k-${k}`), out = $(`#k-${k}-v`), unit = $(`#k-${k}-u`);
    const isWind = k !== 'minSnow';
    const toUI = (v) => (isWind ? wv(v) : v), fromUI = (v) => (isWind && state.unit === 'kn' ? Math.round(v * KN) : v);
    if (isWind) { el.min = toUI(SLIDERS[k][0]); el.max = toUI(SLIDERS[k][1]); el.step = 1; unit.textContent = U(); }
    el.value = toUI(state.kite[k]); out.textContent = el.value;
    el.oninput = () => { out.textContent = el.value; };
    el.onchange = () => {
      state.kite[k] = fromUI(+el.value);
      if (state.kite.windMin > state.kite.windMax) state.kite.windMax = state.kite.windMin;
      store.set('kite', state.kite); setupKiteSliders(); render();
      if (detail.spot) renderDetail();
    };
  }
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
async function openDetail(s, day = 0) {
  detail.spot = s; detail.day = day; detail.data = null;
  const dlg = $('#detailDlg');
  $('#dTitle').innerHTML = typeIcons(s); $('#dTitle').append(s.name);
  $('#dMeta').textContent = `${s.massif} · ${s.alt} m · ${round(s.dist)} km`;
  $('#dBody').innerHTML = '<p class="muted small">Chargement des prévisions horaires…</p>';
  $('#dDays').innerHTML = '';
  if (dlg.showModal) { if (!dlg.open) dlg.showModal(); } else dlg.setAttribute('open', '');
  try {
    detail.data = await fetchHourly(s);
    if (detail.spot === s) renderDetail();
  } catch (e) {
    console.error(e);
    $('#dBody').innerHTML = '<p class="muted small">Prévisions horaires indisponibles (connexion ?).</p>';
  }
}
function hourKiteClass(s, wind, gust, depth) {
  if (!isKite(s)) return '';
  const k = state.kite;
  if (depth != null && depth * 100 < k.minSnow) return 'k-nosnow';
  if (wind < k.windMin) return 'k-warn';
  if (wind > k.windMax || gust > k.gustMax) return 'k-bad';
  return 'k-good';
}
function renderDetail() {
  const s = detail.spot, h = detail.data, w = state.weather[s.id];
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
    ${isKite(s) ? `<p class="d-kite ${goodHours ? 'ok' : ''}">${icon('i-kite')}${goodHours ? `${goodHours} h navigables entre 8h et 18h` : 'Pas de créneau kite entre 8h et 18h'} <span class="muted">(${wv(state.kite.windMin)}–${wv(state.kite.windMax)} ${U()}, raf. ≤ ${wv(state.kite.gustMax)}, neige ≥ ${state.kite.minSnow} cm)</span></p>` : ''}
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
    <p class="muted small">${isKite(s) ? 'Barre verte : vent dans ta plage kite · orange : trop faible · rouge : trop fort ou rafales · grise : pas assez de neige. ' : ''}Prévision Open-Meteo à ${s.alt} m${detail.day >= 7 ? ' — au-delà de 7 jours, indicative' : ''}.</p>`;
  // aujourd'hui : on garde le résumé en haut, l'heure actuelle est surlignée
  $('#dBody').scrollTop = 0;
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
function goTo(id) {
  if (state.view !== 'list') document.querySelector('.tabs button[data-view="list"]').click();
  let card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!card) { // la fiche est masquée par un filtre : on revient sur « Tout »
    document.querySelector('#typeFilter button[data-type="all"]').click();
    card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  }
  setTimeout(() => card?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
}
function bindUI() {
  const radius = $('#radius');
  radius.value = state.radius; $('#radiusVal').textContent = state.radius;
  radius.oninput = () => { $('#radiusVal').textContent = radius.value; };
  radius.onchange = () => { state.radius = +radius.value; store.set('radius', state.radius); showLoc(); refresh(); };

  document.querySelectorAll('#typeFilter button').forEach((b) => {
    b.classList.toggle('active', b.dataset.type === state.type);
    b.onclick = () => {
      state.type = b.dataset.type; store.set('type', state.type);
      document.querySelectorAll('#typeFilter button').forEach((x) => x.classList.toggle('active', x === b));
      refresh();
    };
  });
  const ses = $('#btnSessions');
  ses.setAttribute('aria-pressed', state.sessionsOnly);
  ses.onclick = () => {
    state.sessionsOnly = !state.sessionsOnly; store.set('sessionsOnly', state.sessionsOnly);
    ses.setAttribute('aria-pressed', state.sessionsOnly);
    if (state.sessionsOnly && state.sort === 'dist') { state.sort = 'session'; $('#sort').value = 'session'; store.set('sort', 'session'); }
    render();
  };
  const sort = $('#sort'); sort.value = state.sort;
  sort.onchange = () => { state.sort = sort.value; store.set('sort', state.sort); render(); };

  const dlg = $('#settingsDlg');
  const openSettings = () => { if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', ''); };
  $('#btnSettings').onclick = openSettings;
  $('#placePill').onclick = openSettings;
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close ? dlg.close() : dlg.removeAttribute('open');
  });
  $('#kiteReset').onclick = () => {
    state.kite = { ...KITE_DEFAULT }; store.set('kite', state.kite);
    setupKiteSliders(); render();
  };
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
      home: { lat: +state.loc.lat.toFixed(4), lon: +state.loc.lon.toFixed(4), label: state.loc.label },
      radius_km: state.radius,
      default_threshold_cm: state.threshold,
      alert_all_in_radius: state.alertAll,
      spots: state.bells,
    };
    const txt = JSON.stringify(cfg, null, 2);
    try { await navigator.clipboard.writeText(txt); $('#exportMsg').textContent = 'Copié. Colle-le dans alerts-config.json.'; }
    catch { prompt('Copie ce texte dans alerts-config.json :', txt); }
  };

  for (const [btn, key] of [['#mapKite', 'mapKite'], ['#mapSki', 'mapSki'], ['#mapGood', 'mapGoodOnly']]) {
    const el = $(btn); el.setAttribute('aria-pressed', state[key]);
    el.onclick = () => { state[key] = !state[key]; store.set(key, state[key]); el.setAttribute('aria-pressed', state[key]); render(); };
  }
  setupKiteSliders();
  document.querySelectorAll('#unitSel button').forEach((b) => {
    b.setAttribute('aria-pressed', b.dataset.unit === state.unit);
    b.onclick = () => {
      state.unit = b.dataset.unit; store.set('unit', state.unit);
      document.querySelectorAll('#unitSel button').forEach((x) => x.setAttribute('aria-pressed', x === b));
      setupKiteSliders(); render();
      if (detail.spot) renderDetail();
    };
  });

  $('#btnGeo').onclick = geolocate;
  $('#locInput').oninput = (e) => searchCity(e.target.value);
  $('#btnRefresh').onclick = () => refresh(true);
  $('#btnShare').onclick = shareApp;
  const ddlg = $('#detailDlg');
  ddlg.addEventListener('click', (e) => {
    if (e.target === ddlg || e.target.closest('[data-close]')) { ddlg.close ? ddlg.close() : ddlg.removeAttribute('open'); }
  });
  ddlg.addEventListener('close', () => { detail.spot = null; });

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
    const sp = allInRadius().find((x) => x.id === a.dataset.goto);
    if (sp) openDetail(sp, +(a.dataset.day || 0));
  });
}

async function init() {
  bindUI();
  showLoc();
  const [cur, osm] = await Promise.all(['spots.json', 'spots-osm.json'].map((f) =>
    fetch(f).then((r) => (r.ok ? r.json() : [])).catch(() => [])));
  state.spots = [...cur, ...osm];
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
