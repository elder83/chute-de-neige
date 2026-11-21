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
  mapKite: store.get('mapKite', true),
  mapSki: store.get('mapSki', true),
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
        out.push({ i, kind: 'kite', far, txt: `${round(wind)} km/h ${dirName(d.wind_direction_10m_dominant[i])} · ${round(snow)} cm` });
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
    <span title="Vent actuel, rafales ${round(c.wind_gusts_10m)} km/h">${kr ? `<i class="dot ${kr.cls}" title="${kr.txt}"></i>` : icon('i-wind')}<b>${round(c.wind_speed_10m)}</b> km/h ${arrow(c.wind_direction_10m)}${dirName(c.wind_direction_10m)}</span>
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
    html += `<div class="${cls}" title="${dayDate(w, i).toLocaleDateString('fr-FR')} · vent max ${round(d.wind_speed_10m_max[i])} km/h ${dirName(d.wind_direction_10m_dominant[i])}, rafales ${round(d.wind_gusts_10m_max[i])} km/h">
      <div class="d">${dayLabel(w, i)}</div>
      ${icon(wxId(d.weather_code[i]), 'i wx')}
      <div class="t">${round(d.temperature_2m_min[i])}/${round(d.temperature_2m_max[i])}°</div>
      <div class="sn${sn < 0.5 ? ' zero' : ''}">${sn < 0.5 ? '0' : round(sn)} cm</div>
      <div class="wd">${round(d.wind_speed_10m_max[i])}</div>
    </div>`;
  }
  node.querySelector('.days').innerHTML = html;
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
  if (state.view === 'map') renderMap(alertIds);
  return { list, alerts };
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function mapSpots() {
  return allInRadius()
    .filter((s) => (state.mapKite && isKite(s)) || (state.mapSki && isSki(s)))
    .filter((s) => !state.sessionsOnly || relevantSessions(s).length);
}
function renderMap(alertIds) {
  if (!window.L) { $('#map').textContent = 'Carte indisponible.'; return; }
  if (!state.map) {
    state.map = L.map('map', { zoomControl: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17, attribution: '© OpenStreetMap',
    }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }
  state.map.invalidateSize();
  state.markers.clearLayers();
  const list = mapSpots();
  $('#mapCount').textContent = `${list.length} sur la carte`;
  const muted = cssVar('--muted');
  const pts = [[state.loc.lat, state.loc.lon]];
  L.circleMarker([state.loc.lat, state.loc.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#111827', fillOpacity: 1 })
    .bindPopup('Ta position').addTo(state.markers);
  L.circle([state.loc.lat, state.loc.lon], { radius: state.radius * 1000, color: muted, weight: 1, dashArray: '4 4', fill: false })
    .addTo(state.markers);
  for (const s of list) {
    const w = state.weather[s.id];
    const next72 = w ? summarize(w).next72 : 0;
    const ses = relevantSessions(s);
    const st = alertIds.has(s.id) || next72 >= 5 ? 'snow' : ses.length ? 'sess' : '';
    const kite = isKite(s);
    const html = `<div class="mk ${kite ? 'kite' : 'ski'} ${st}">${icon(kite ? 'i-kite' : 'i-ski')}` +
      (next72 >= 5 ? `<span class="mk-n">+${round(next72)}</span>` : '') + '</div>';
    const div = document.createElement('div');
    const b = document.createElement('b'); b.textContent = s.name; div.append(b);
    div.insertAdjacentHTML('beforeend', `<br>${kite ? 'Spot snowkite' : 'Station'} · ${s.alt} m · ${round(s.dist)} km` +
      (w ? `<br>${round(w.current.temperature_2m)}° · vent ${round(w.current.wind_speed_10m)} km/h · ${round(snowDepth(w, T0))} cm au sol<br>+${round(next72)} cm prévus sur 3 j` : '') +
      (ses.length ? `<br>${ses.length} session${ses.length > 1 ? 's' : ''} · prochaine ${dayLong(w, ses[0].i)}` : '') +
      `<br><a href="#" data-goto="${esc(s.id)}">Voir la fiche</a>`);
    L.marker([s.lat, s.lon], {
      icon: L.divIcon({ html, className: 'mk-wrap', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -14] }),
      zIndexOffset: kite ? 500 : 0,
    }).bindPopup(div).addTo(state.markers);
    pts.push([s.lat, s.lon]);
  }
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
    for (const k of Object.keys(KITE_DEFAULT)) { $(`#k-${k}`).value = state.kite[k]; $(`#k-${k}-v`).textContent = state.kite[k]; }
    render();
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

  for (const [btn, key] of [['#mapKite', 'mapKite'], ['#mapSki', 'mapSki']]) {
    const el = $(btn); el.setAttribute('aria-pressed', state[key]);
    el.onclick = () => { state[key] = !state[key]; store.set(key, state[key]); el.setAttribute('aria-pressed', state[key]); render(); };
  }
  for (const k of Object.keys(KITE_DEFAULT)) {
    const el = $(`#k-${k}`), out = $(`#k-${k}-v`);
    el.value = state.kite[k]; out.textContent = state.kite[k];
    el.oninput = () => { out.textContent = el.value; };
    el.onchange = () => {
      state.kite[k] = +el.value;
      if (state.kite.windMin > state.kite.windMax) { state.kite.windMax = state.kite.windMin; $('#k-windMax').value = state.kite.windMax; $('#k-windMax-v').textContent = state.kite.windMax; }
      store.set('kite', state.kite); render();
    };
  }

  $('#btnGeo').onclick = geolocate;
  $('#locInput').oninput = (e) => searchCity(e.target.value);
  $('#btnRefresh').onclick = () => refresh(true);

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
  $('#map').addEventListener('click', goto);
}

async function init() {
  bindUI();
  showLoc();
  const [cur, osm] = await Promise.all(['spots.json', 'spots-osm.json'].map((f) =>
    fetch(f).then((r) => (r.ok ? r.json() : [])).catch(() => [])));
  state.spots = [...cur, ...osm];
  await refresh();
  setInterval(() => refresh(), CHECK_EVERY_MIN * 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
