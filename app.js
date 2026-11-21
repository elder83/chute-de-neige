/* Chute de Neige — spots snowkite & ski, météo, webcams, alertes neige */
'use strict';

const HYERES = { lat: 43.1204, lon: 6.1286, label: 'Hyères (par défaut)' };
const CACHE_MIN = 30;           // durée de cache météo (minutes)
const CHECK_EVERY_MIN = 30;     // vérification des alertes appli ouverte
const KITE_MIN = 12, KITE_MAX = 40, KITE_GUST_MAX = 55; // km/h

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  spots: [],
  weather: {},                       // id -> données Open-Meteo
  loc: store.get('loc', HYERES),
  radius: store.get('radius', 400),
  type: store.get('type', 'all'),
  sort: store.get('sort', 'dist'),
  favs: new Set(store.get('favs', [])),
  bells: store.get('bells', {}),     // id -> seuil cm
  threshold: store.get('threshold', 20),
  alertAll: store.get('alertAll', false),
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
const arrow = (deg) => deg == null ? '' : `<span style="display:inline-block;transform:rotate(${deg + 180}deg)">↑</span>`;
function wxIcon(code) {
  if (code == null) return '·';
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code <= 48) return '🌫️';
  if (code <= 57) return '🌦️';
  if (code <= 67) return '🌧️';
  if (code <= 77) return '❄️';
  if (code <= 82) return '🌧️';
  if (code <= 86) return '🌨️';
  return '⛈️';
}
const round = (v, d = 0) => v == null ? '–' : Number(v).toFixed(d);
const sum = (arr) => arr.reduce((a, b) => a + (b || 0), 0);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function kiteRating(wind, gust) {
  if (wind == null) return null;
  if (wind < KITE_MIN) return { cls: 'warn', txt: 'Pas assez de vent' };
  if (wind > KITE_MAX || (gust != null && gust > KITE_GUST_MAX)) return { cls: 'bad', txt: 'Trop fort / rafales' };
  return { cls: 'good', txt: 'Bon pour le kite' };
}
const isKite = (s) => s.type === 'kite' || s.type === 'both';
const isSki = (s) => s.type === 'ski' || s.type === 'both';

/* ---------- météo (Open-Meteo, sans clé) ---------- */
// past_days=2 → daily[0..1] = les 2 derniers jours, daily[2] = aujourd'hui
function summarize(w) {
  const d = w.daily;
  return {
    past48: sum(d.snowfall_sum.slice(0, 2)),
    next72: sum(d.snowfall_sum.slice(2, 5)),
    next7: sum(d.snowfall_sum.slice(2, 9)),
    todayWind: d.wind_speed_10m_max[2],
  };
}

async function fetchWeather(spots) {
  const now = Date.now();
  const cache = store.get('wxCache', {});
  const todo = spots.filter((s) => !(cache[s.id] && now - cache[s.id].t < CACHE_MIN * 60000));
  for (let i = 0; i < todo.length; i += 40) {
    const chunk = todo.slice(i, i + 40);
    const p = new URLSearchParams({
      latitude: chunk.map((s) => s.lat).join(','),
      longitude: chunk.map((s) => s.lon).join(','),
      elevation: chunk.map((s) => s.alt).join(','),
      current: 'temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,snowfall,snow_depth',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,snowfall_sum,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant',
      timezone: 'Europe/Paris',
      past_days: '2',
      forecast_days: '7',
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${p}`);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    let data = await res.json();
    if (!Array.isArray(data)) data = [data];
    data.forEach((w, j) => { cache[chunk[j].id] = { t: now, w }; });
  }
  // purge des vieilles entrées
  for (const k of Object.keys(cache)) if (now - cache[k].t > 6 * 3600000) delete cache[k];
  store.set('wxCache', cache);
  for (const s of spots) if (cache[s.id]) state.weather[s.id] = cache[s.id].w;
}

/* ---------- filtrage ---------- */
function visibleSpots() {
  return state.spots
    .map((s) => ({ ...s, dist: haversine(state.loc, s) }))
    .filter((s) => s.dist <= state.radius)
    .filter((s) => state.type === 'all'
      || (state.type === 'kite' && isKite(s))
      || (state.type === 'ski' && isSki(s))
      || (state.type === 'fav' && state.favs.has(s.id)));
}
function sortSpots(list) {
  const key = {
    dist: (s) => s.dist,
    snow: (s) => -(state.weather[s.id] ? summarize(state.weather[s.id]).next72 : -1),
    wind: (s) => {
      const w = state.weather[s.id]; if (!w) return 999;
      const v = w.current.wind_speed_10m; // le plus proche de 25 km/h en premier
      return isKite(s) ? Math.abs(v - 25) : 500 + Math.abs(v - 25);
    },
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
  const title = `❄️ Neige annoncée sur ${fresh.length} spot${fresh.length > 1 ? 's' : ''}`;
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
    `<div class="alert" data-goto="${a.s.id}">❄️ <b>${esc(a.s.name)}</b> : ${round(a.next72)} cm prévus sur 3 jours <span class="muted">(seuil ${a.thr} cm · ${round(a.s.dist)} km)</span></div>`
  ).join('');
}

/* ---------- rendu ---------- */
function linksFor(s) {
  const L = [];
  const cam = s.webcam || `https://www.google.com/search?q=${encodeURIComponent('webcam live ' + s.name)}`;
  L.push(['📷 Webcams', cam]);
  if (s.web) L.push(['🌐 Site station', s.web]);
  L.push(['💨 Windy', `https://www.windy.com/${s.lat}/${s.lon}?${s.lat},${s.lon},11`]);
  L.push(['🚗 Itinéraire', `https://www.google.com/maps/dir/?api=1&origin=${state.loc.lat},${state.loc.lon}&destination=${s.lat},${s.lon}`]);
  L.push(['⚠️ Bulletin avalanche', 'https://meteofrance.com/meteo-montagne']);
  return L.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${t}</a>`).join('');
}

function renderCard(s, alerting) {
  const node = $('#cardTpl').content.firstElementChild.cloneNode(true);
  const w = state.weather[s.id];
  node.dataset.id = s.id;
  node.classList.toggle('alerting', alerting);
  node.querySelector('.name').textContent = `${isKite(s) ? '🪁' : ''}${isSki(s) ? '⛷️' : ''} ${s.name}`;
  node.querySelector('.meta').textContent = `${s.massif} · ${s.alt} m · ${round(s.dist)} km`;
  node.querySelector('.info').textContent = s.info || '';
  node.querySelector('.links').innerHTML = linksFor(s);

  const fav = node.querySelector('.fav');
  fav.textContent = state.favs.has(s.id) ? '⭐' : '☆';
  fav.onclick = () => {
    state.favs.has(s.id) ? state.favs.delete(s.id) : state.favs.add(s.id);
    store.set('favs', [...state.favs]); render();
  };
  const bell = node.querySelector('.bell');
  const thr = state.bells[s.id];
  bell.textContent = thr != null ? '🔔' : '🔕';
  bell.title = thr != null ? `Alerte à ${thr} cm — cliquer pour modifier` : 'Créer une alerte neige';
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
    <span>${wxIcon(c.weather_code)} <b>${round(c.temperature_2m)}°C</b></span>
    <span>💨 <b>${round(c.wind_speed_10m)}</b> km/h ${arrow(c.wind_direction_10m)} ${dirName(c.wind_direction_10m)} <span class="muted">(raf. ${round(c.wind_gusts_10m)})</span></span>
    <span>🏔️ Neige au sol : <b>${c.snow_depth != null ? round(c.snow_depth * 100) : '–'}</b> cm</span>
    <span>48 h : <b>${round(sm.past48)}</b> cm</span>
    <span class="badge snow">+${round(sm.next72)} cm / 3 j</span>
    ${kr ? `<span class="badge ${kr.cls}">${kr.txt}</span>` : ''}`;

  const d = w.daily;
  let html = '';
  for (let i = 2; i < d.time.length; i++) {
    const date = new Date(d.time[i] + 'T12:00');
    const lbl = i === 2 ? 'Auj.' : date.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
    const sn = d.snowfall_sum[i] || 0;
    const kd = isKite(s) ? kiteRating(d.wind_speed_10m_max[i], d.wind_gusts_10m_max[i]) : null;
    html += `<div class="day${i === 2 ? ' today' : ''}" title="${date.toLocaleDateString('fr-FR')} · vent max ${round(d.wind_speed_10m_max[i])} km/h ${dirName(d.wind_direction_10m_dominant[i])}, rafales ${round(d.wind_gusts_10m_max[i])} km/h">
      <div class="d">${lbl}</div>
      <div class="w">${wxIcon(d.weather_code[i])}</div>
      <div>${round(d.temperature_2m_min[i])}/${round(d.temperature_2m_max[i])}°</div>
      <div class="sn${sn < 0.5 ? ' zero' : ''}">${sn < 0.5 ? '0' : round(sn)} cm</div>
      <div>${kd ? (kd.cls === 'good' ? '🪁' : kd.cls === 'bad' ? '🌪️' : '·') : ''}${round(d.wind_speed_10m_max[i])}</div>
    </div>`;
  }
  node.querySelector('.days').innerHTML = html;
  return node;
}

function render() {
  const list = sortSpots(visibleSpots());
  const alerts = computeAlerts(list);
  const alertIds = new Set(alerts.map((a) => a.s.id));
  renderAlertsBanner(alerts);
  const el = $('#list');
  el.replaceChildren(...list.map((s) => renderCard(s, alertIds.has(s.id))));
  $('#status').textContent = list.length
    ? `${list.length} spot${list.length > 1 ? 's' : ''} dans un rayon de ${state.radius} km autour de ${state.loc.label}`
    : `Aucun spot dans ce rayon — augmente la distance.`;
  if (state.view === 'map') renderMap(list, alertIds);
  return { list, alerts };
}

function renderMap(list, alertIds) {
  if (!window.L) { $('#map').textContent = 'Carte indisponible (hors ligne).'; return; }
  if (!state.map) {
    state.map = L.map('map');
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '© OpenStreetMap',
    }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }
  state.markers.clearLayers();
  const pts = [[state.loc.lat, state.loc.lon]];
  L.circleMarker([state.loc.lat, state.loc.lon], { radius: 7, color: '#c0392b', fillOpacity: 1 })
    .bindPopup('📍 Toi').addTo(state.markers);
  L.circle([state.loc.lat, state.loc.lon], { radius: state.radius * 1000, color: '#2a8bd8', weight: 1, fillOpacity: 0.04 })
    .addTo(state.markers);
  for (const s of list) {
    const w = state.weather[s.id]; const sm = w ? summarize(w) : null;
    const snow = sm ? sm.next72 : 0;
    const color = alertIds.has(s.id) ? '#3b82f6' : snow >= 5 ? '#60a5fa' : isKite(s) ? '#d97706' : '#0f4c81';
    L.circleMarker([s.lat, s.lon], { radius: 6 + Math.min(snow, 50) / 5, color, fillOpacity: 0.8 })
      .bindPopup(`<b>${esc(s.name)}</b><br>${s.alt} m · ${round(s.dist)} km<br>` +
        (w ? `${wxIcon(w.current.weather_code)} ${round(w.current.temperature_2m)}°C · 💨 ${round(w.current.wind_speed_10m)} km/h<br>❄️ +${round(snow)} cm / 3 j<br>` : '') +
        `<a href="#" data-goto="${s.id}">Voir la fiche</a>`)
      .addTo(state.markers);
    pts.push([s.lat, s.lon]);
  }
  state.map.fitBounds(pts, { padding: [20, 20], maxZoom: 9 });
  setTimeout(() => state.map.invalidateSize(), 50);
}

/* ---------- chargement ---------- */
async function refresh(force = false) {
  if (force) store.set('wxCache', {});
  const list = visibleSpots();
  $('#status').textContent = 'Chargement de la météo…';
  try {
    await fetchWeather(list);
  } catch (e) {
    console.error(e);
    $('#status').textContent = 'Impossible de charger la météo (connexion ?). Données en cache affichées.';
  }
  const { alerts } = render();
  notify(alerts);
}

/* ---------- position ---------- */
function setLoc(loc) {
  state.loc = loc; store.set('loc', loc);
  $('#locLabel').textContent = `${loc.label} (${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)})`;
  refresh();
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
  if (!('Notification' in window)) return 'Non supporté sur ce navigateur (sur iPhone : ajoute l\'appli à l\'écran d\'accueil).';
  return { granted: '✅ activées', denied: '❌ bloquées dans les réglages du navigateur', default: '' }[Notification.permission];
}
async function askNotif() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
  $('#notifState').textContent = notifStateText();
}

/* ---------- init ---------- */
function bindUI() {
  const radius = $('#radius');
  radius.value = state.radius; $('#radiusVal').textContent = state.radius;
  radius.oninput = () => { $('#radiusVal').textContent = radius.value; };
  radius.onchange = () => { state.radius = +radius.value; store.set('radius', state.radius); refresh(); };

  document.querySelectorAll('#typeFilter button').forEach((b) => {
    b.classList.toggle('active', b.dataset.type === state.type);
    b.onclick = () => {
      state.type = b.dataset.type; store.set('type', state.type);
      document.querySelectorAll('#typeFilter button').forEach((x) => x.classList.toggle('active', x === b));
      refresh();
    };
  });
  const sort = $('#sort'); sort.value = state.sort;
  sort.onchange = () => { state.sort = sort.value; store.set('sort', state.sort); render(); };

  $('#btnAlerts').onclick = () => { $('#alertPanel').hidden = !$('#alertPanel').hidden; };
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
    try { await navigator.clipboard.writeText(txt); $('#exportMsg').textContent = 'Copié ! Colle-le dans alerts-config.json.'; }
    catch { prompt('Copie ce texte dans alerts-config.json :', txt); }
  };

  $('#btnGeo').onclick = geolocate;
  $('#locInput').oninput = (e) => searchCity(e.target.value);
  $('#btnRefresh').onclick = () => refresh(true);

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      state.view = b.dataset.view;
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $('#list').hidden = state.view !== 'list';
      $('#map').hidden = state.view !== 'map';
      render();
    };
  });
  $('#alertsBanner').addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]'); if (!a) return;
    if (state.view !== 'list') document.querySelector('.tabs button[data-view="list"]').click();
    document.querySelector(`.card[data-id="${CSS.escape(a.dataset.goto)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  $('#map').addEventListener('click', (e) => {
    const a = e.target.closest('[data-goto]'); if (!a) return;
    e.preventDefault();
    document.querySelector('.tabs button[data-view="list"]').click();
    document.querySelector(`.card[data-id="${CSS.escape(a.dataset.goto)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

async function init() {
  bindUI();
  $('#locLabel').textContent = `${state.loc.label} (${state.loc.lat.toFixed(3)}, ${state.loc.lon.toFixed(3)})`;
  const res = await fetch('spots.json');
  state.spots = await res.json();
  await refresh();
  setInterval(() => refresh(), CHECK_EVERY_MIN * 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
