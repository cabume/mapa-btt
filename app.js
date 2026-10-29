'use strict';
// Mi Mapa BTT: las rutas de Strava que tú eliges, con sus fotos, sobre el mapa.
// Todo se guarda en este navegador (IndexedDB); se habla directamente con la API de Strava.

const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf1 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 0 });
const fmtKm = m => nf1.format(m / 1000) + ' km';
const fmtM = m => nf0.format(m) + ' m';
const fmtH = s => `${Math.floor(s / 3600)} h ${String(Math.round(s % 3600 / 60)).padStart(2, '0')} min`;
const localDate = a => new Date(a.tl.slice(0, 19));
const fmtFecha = (a, largo) => localDate(a).toLocaleDateString('es-ES', largo ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function toast(msg, ms = 4000) {
  const t = $('#toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.h); toast.h = setTimeout(() => t.style.display = 'none', ms);
}
const setStatus = msg => $('#status').textContent = msg || '';

// ---------- almacenamiento ----------
const idb = (() => {
  let p;
  const open = () => p ||= new Promise((res, rej) => {
    const r = indexedDB.open('mimapabtt', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode); const r = fn(t.objectStore('kv'));
      t.oncomplete = () => res(r.result); t.onerror = () => rej(t.error);
    });
  };
  return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => s.put(v, k)), del: k => tx('readwrite', s => s.delete(k)) };
})();

const cfg = Object.assign({ clientId: '', clientSecret: '', base: 'topo', colorBy: 'tipo', lastSync: 0, showCand: true, view: null },
  JSON.parse(localStorage.getItem('mimapabtt.cfg') || '{}'));
const saveCfg = () => localStorage.setItem('mimapabtt.cfg', JSON.stringify(cfg));

const S = {
  auth: null, acts: [], byId: new Map(), gears: {}, sel: {}, streams: {}, photos: {},
  tab: 'mapa', detail: null, settings: false, loading: new Set(),
  f: { q: '', year: '', type: '', gear: '', photos: false, inView: false }, limit: 150,
};
const saveSel = () => idb.set('sel', S.sel);

// ---------- tipos y colores ----------
const TIPOS = {
  MountainBikeRide: ['BTT', '#e8590c'], EMountainBikeRide: ['eBTT', '#d6336c'], EBikeRide: ['eBike', '#7048e8'],
  Ride: ['Bici', '#1c7ed6'], GravelRide: ['Gravel', '#2b8a3e'],
};
const RIDES = new Set([...Object.keys(TIPOS), 'Handcycle', 'Velomobile']);
const tipoDe = a => TIPOS[a.type] || ['Bici', '#868e96'];
const PALETA = ['#e8590c', '#1c7ed6', '#2b8a3e', '#ae3ec9', '#f59f00', '#0c8599', '#e03131', '#5c940d', '#7048e8', '#c2255c'];
function colorOf(a) {
  if (cfg.colorBy === 'año') {
    const ys = [...new Set(S.acts.map(x => x.tl.slice(0, 4)))].sort();
    return PALETA[ys.indexOf(a.tl.slice(0, 4)) % PALETA.length];
  }
  if (cfg.colorBy === 'bici') {
    const gs = Object.keys(S.gears).sort();
    return a.gear && gs.includes(a.gear) ? PALETA[gs.indexOf(a.gear) % PALETA.length] : '#868e96';
  }
  return tipoDe(a)[1];
}

// ---------- utilidades geográficas ----------
function decode(str) {
  let i = 0, lat = 0, lng = 0; const out = [];
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let b, s = 0, r = 0;
      do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << s; s += 5; } while (b >= 32);
      const d = (r & 1) ? ~(r >> 1) : (r >> 1);
      if (k === 0) lat += d; else lng += d;
    }
    out.push([lat / 1e5, lng / 1e5]);
  }
  return out;
}
function geom(a) {
  const st = S.streams[a.id];
  if (st) return st.ll;
  return a._g ||= a.poly ? decode(a.poly) : [];
}
function bbox(a) {
  if (a._b) return a._b;
  const g = a.poly ? (a._g ||= decode(a.poly)) : [];
  if (!g.length) return null;
  let s = 90, w = 180, n = -90, e = -180;
  for (const [la, lo] of g) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  return a._b = L.latLngBounds([s, w], [n, e]);
}
function distM(a, b) {
  const R = 6371000, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// ---------- Strava ----------
const REDIRECT = location.origin + location.pathname.replace(/index\.html$/, '');
const APP_WEB = 'https://cabume.github.io/mapa-btt/'; // versión publicada (móvil)

function stravaConnect() {
  const id = $('#cfgId')?.value.trim() || cfg.clientId, sec = $('#cfgSecret')?.value.trim() || cfg.clientSecret;
  if (!/^\d+$/.test(id) || sec.length < 20) return toast('Pega el Client ID (solo números) y el Client Secret de tu aplicación de Strava.');
  cfg.clientId = id; cfg.clientSecret = sec; saveCfg();
  location.href = `https://www.strava.com/oauth/authorize?client_id=${id}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT)}&approval_prompt=auto&scope=read,profile:read_all,activity:read_all`;
}
async function stravaCallback() {
  const q = new URLSearchParams(location.search);
  if (!q.has('code') && !q.has('error')) return false;
  history.replaceState(null, '', location.pathname);
  if (q.get('error')) { toast('No se dio permiso en Strava.'); return false; }
  if (!/activity:read/.test(q.get('scope') || '')) { toast('Hace falta marcar el permiso de ver tus actividades. Vuelve a conectar.', 8000); return false; }
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code: q.get('code'), grant_type: 'authorization_code' }),
  });
  if (!r.ok) { toast('Strava no aceptó la conexión (' + r.status + '). Revisa el Client Secret.', 8000); return false; }
  const j = await r.json();
  S.auth = { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at, athlete: j.athlete && (j.athlete.firstname + ' ' + j.athlete.lastname).trim() };
  await idb.set('auth', S.auth);
  return true;
}
async function token() {
  const a = S.auth;
  if (!a) throw new Error('Primero conecta con Strava (⚙️).');
  if (a.expires_at * 1000 > Date.now() + 60000) return a.access_token;
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token', refresh_token: a.refresh_token }),
  });
  if (!r.ok) throw new Error('Strava no renueva el permiso (' + r.status + '). Vuelve a conectar en ⚙️.');
  const j = await r.json();
  Object.assign(a, { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at });
  await idb.set('auth', a);
  return a.access_token;
}
let limitUntil = 0;
async function api(path) {
  if (Date.now() < limitUntil) throw Object.assign(new Error(limitMsg()), { limit: true });
  const r = await fetch('https://www.strava.com/api/v3' + path, { headers: { Authorization: 'Bearer ' + await token() } });
  if (r.status === 429) {
    const d = new Date(); d.setMinutes(Math.floor(d.getMinutes() / 15) * 15 + 15, 5, 0);
    limitUntil = d.getTime();
    throw Object.assign(new Error(limitMsg()), { limit: true });
  }
  if (r.status === 401) throw new Error('Strava rechazó el permiso (401). Vuelve a conectar en ⚙️.');
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('Strava respondió ' + r.status);
  return r.json();
}
const limitMsg = () => `Strava limita las peticiones: sigo a las ${new Date(limitUntil).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}.`;

function compact(x) {
  return {
    id: x.id, n: x.name, t: Math.floor(Date.parse(x.start_date) / 1000), tl: x.start_date_local, type: x.sport_type || x.type,
    d: x.distance || 0, e: x.total_elevation_gain || 0, mt: x.moving_time || 0, et: x.elapsed_time || 0,
    poly: x.map && x.map.summary_polyline || '', ph: x.total_photo_count || 0, gear: x.gear_id || '',
  };
}
async function syncActs(full) {
  if (!S.auth || syncActs.busy) return;
  syncActs.busy = true;
  try {
    setStatus('Leyendo tus salidas de Strava…');
    const me = await api('/athlete');
    if (me) { S.gears = Object.fromEntries((me.bikes || []).map(b => [b.id, b.name])); await idb.set('gears', S.gears); }
    const map0 = new Map(full ? [] : S.acts.map(a => [a.id, a]));
    const after = full || !S.acts.length ? 0 : Math.max(...S.acts.map(a => a.t)) - 7 * 86400; // repasa la última semana por si cambiaste nombres
    let page = 1, nuevas = 0;
    for (;;) {
      const arr = await api(`/athlete/activities?per_page=200&page=${page}&after=${after}`) || [];
      for (const x of arr) {
        if (!RIDES.has(x.sport_type || x.type)) continue;
        const c = compact(x);
        if (!c.poly) continue; // rodillo o sin GPS
        if (!map0.has(c.id)) nuevas++;
        map0.set(c.id, c);
      }
      setStatus(`Leyendo tus salidas de Strava… ${map0.size}`);
      if (arr.length < 200) break;
      page++;
    }
    S.acts = [...map0.values()].sort((a, b) => b.t - a.t);
    S.byId = new Map(S.acts.map(a => [a.id, a]));
    await idb.set('acts', S.acts);
    cfg.lastSync = Date.now(); saveCfg();
    setStatus(`${S.acts.length} salidas con GPS en Strava` + (nuevas && S.acts.length !== nuevas ? ` · ${nuevas} nuevas` : ''));
    render(); drawRoutes();
  } catch (e) { setStatus(e.message); }
  finally { syncActs.busy = false; }
}

// Detalle de una salida: track completo (con hora y altitud) y fotos
function decimate(st) {
  const ll = st.latlng?.data || [], t = st.time?.data || [], alt = st.altitude?.data || [], dist = st.distance?.data || [];
  const out = { ll: [], t: [], alt: [], dist: [] };
  let last = null;
  for (let i = 0; i < ll.length; i++) {
    if (last && i < ll.length - 1 && distM(last, ll[i]) < 8) continue;
    last = ll[i];
    out.ll.push([+ll[i][0].toFixed(5), +ll[i][1].toFixed(5)]);
    out.t.push(t[i] ?? 0); out.alt.push(alt.length ? Math.round((alt[i] ?? 0) * 10) / 10 : null); out.dist.push(Math.round(dist[i] ?? 0));
  }
  return out;
}
async function loadDetail(id, fotosOtraVez) {
  const a = S.byId.get(id); if (!a || S.loading.has(id)) return;
  S.loading.add(id);
  try {
    if (!S.streams[id]) {
      const st = await api(`/activities/${id}/streams?keys=latlng,time,altitude,distance&key_by_type=true`);
      if (st && st.latlng) { S.streams[id] = decimate(st); await idb.set('st/' + id, S.streams[id]); }
    }
    if (!S.photos[id] || fotosOtraVez) {
      let ph = [];
      if (a.ph > 0 || fotosOtraVez) {
        const big = await api(`/activities/${id}/photos?size=2048&photo_sources=true`) || [];
        const small = big.length ? await api(`/activities/${id}/photos?size=480&photo_sources=true`) || [] : [];
        const th = new Map(small.map(p => [p.unique_id, p.urls && Object.values(p.urls)[0]]));
        ph = big.filter(p => p.urls).map(p => {
          const url = Object.values(p.urls)[0];
          const loc = Array.isArray(p.location) && p.location.length === 2 && (p.location[0] || p.location[1]) ? p.location : null;
          return { u: p.unique_id || url, big: url, th: th.get(p.unique_id) || url, cap: p.caption || '', at: p.created_at || null, ll: loc, vid: !!(p.video_url || p.media_type === 2) };
        });
        a.ph = ph.length;
      }
      S.photos[id] = ph; await idb.set('ph/' + id, ph);
    }
  } finally { S.loading.delete(id); }
}

// Cola en segundo plano: baja detalle y fotos de las rutas elegidas sin pasarse del límite de Strava
const cola = [];
function encolar(id) { if (S.auth && S.byId.has(id) && !cola.includes(id) && (!S.streams[id] || !S.photos[id])) { cola.push(id); procesarCola(); } }
async function procesarCola() {
  if (procesarCola.on) return; procesarCola.on = true;
  while (cola.length) {
    if (Date.now() < limitUntil) { setStatus(limitMsg()); await sleep(limitUntil - Date.now()); }
    const id = cola[0];
    if (!S.sel[id]) { cola.shift(); continue; }
    setStatus(`Bajando fotos y track de tus rutas… quedan ${cola.length}`);
    try { await loadDetail(id); cola.shift(); refresh(id); }
    catch (e) { if (!e.limit) { cola.shift(); setStatus(e.message); await sleep(3000); } }
    await sleep(1200);
  }
  procesarCola.on = false;
  setStatus(`${S.acts.length} salidas con GPS en Strava · ${Object.keys(S.sel).length} en tu mapa`);
}
function refresh(id) { drawRoutes(); drawPhotos(); if (!id || S.detail === id || S.tab === 'mapa') render(); }

// ---------- mapa ----------
const map = L.map('map', { zoomControl: true, worldCopyJump: true }).setView([43, 4], 6);
map.createPane('cand').style.zIndex = 390;
map.createPane('sel').style.zIndex = 400;
map.createPane('hl').style.zIndex = 410;
const rCand = L.canvas({ pane: 'cand', tolerance: 6 }), rSel = L.canvas({ pane: 'sel', tolerance: 8 }), rHl = L.canvas({ pane: 'hl', tolerance: 8 });
const A_OSM = '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
const BASES = {
  topo: ['OpenTopoMap (relieve)', L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', { maxZoom: 17, attribution: A_OSM + ' · © OpenTopoMap' })],
  cyclosm: ['CyclOSM (caminos BTT)', L.tileLayer('https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', { maxZoom: 18, attribution: A_OSM + ' · CyclOSM' })],
  osm: ['OpenStreetMap', L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: A_OSM })],
  sat: ['Satélite (Esri)', L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: '© Esri, Maxar, Earthstar Geographics' })],
  ign: ['IGN Topográfico (solo España)', L.tileLayer('https://www.ign.es/wmts/mapa-raster?layer=MTN&style=default&tilematrixset=GoogleMapsCompatible&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image%2Fjpeg&TileMatrix={z}&TileCol={x}&TileRow={y}', { maxZoom: 17, attribution: '© Instituto Geográfico Nacional' })],
};
(BASES[cfg.base] || BASES.topo)[1].addTo(map);
L.control.layers(Object.fromEntries(Object.values(BASES)), null, { position: 'topright' }).addTo(map);
map.on('baselayerchange', e => { cfg.base = Object.keys(BASES).find(k => BASES[k][1] === e.layer); saveCfg(); });
L.control.scale({ imperial: false }).addTo(map);
if (cfg.view) map.setView(cfg.view.c, cfg.view.z);
map.on('moveend', () => {
  cfg.view = { c: map.getCenter(), z: map.getZoom() }; saveCfg();
  if (S.tab === 'elegir' && S.f.inView && !S.detail && !S.settings) { clearTimeout(map._lt); map._lt = setTimeout(render, 250); }
});

const REGIONES = {
  'España': [[35.9, -9.4], [43.8, 3.4]],
  'Sur de Francia': [[42.3, -1.8], [45.6, 7.7]],
  'Norte de Italia': [[44.0, 6.6], [47.1, 13.9]],
};
const regDiv = L.DomUtil.create('div', 'regions', $('#map'));
regDiv.innerHTML = Object.keys(REGIONES).map(k => `<button data-r="${k}">${k}</button>`).join('') + '<button data-r="">⤢ Mis rutas</button>';
L.DomEvent.disableClickPropagation(regDiv);
regDiv.onclick = e => { const r = e.target.dataset?.r; if (r === undefined) return; r ? fitTo(L.latLngBounds(REGIONES[r]), 0) : fitSel(); };

// En el móvil el panel tapa la parte de abajo del mapa: se encuadra en lo que queda libre
const movil = () => matchMedia('(max-width: 800px)').matches;
function fitTo(b, pad, maxZoom) {
  const abajo = movil() ? sheetPx($('#side').dataset.h) : 0;
  map.fitBounds(b, { paddingTopLeft: [pad, pad + (movil() ? 40 : 0)], paddingBottomRight: [pad, pad + abajo], maxZoom });
}
// Panel del móvil: min (solo el título) | mid | max; se arrastra desde la barrita o el título
const SHEET_MIN = 58;
const sheetPx = h => h === 'min' ? SHEET_MIN : h === 'max' ? innerHeight * .88 : innerHeight * .46;
function setSheet(h) { if (movil()) $('#side').dataset.h = h; }
function cycleSheet() { setSheet($('#side').dataset.h === 'min' ? 'mid' : 'min'); }
{
  const side = $('#side'); let y0 = null, h0 = 0, moved = false;
  const zona = e => e.target.closest('#handle, header') && !e.target.closest('button');
  side.addEventListener('pointerdown', e => {
    if (!movil() || !zona(e)) return;
    y0 = e.clientY; h0 = side.offsetHeight; moved = false;
    side.setPointerCapture(e.pointerId); side.style.transition = 'none';
  });
  side.addEventListener('pointermove', e => {
    if (y0 == null) return;
    const dy = e.clientY - y0; if (Math.abs(dy) > 6) moved = true;
    if (moved) side.style.height = Math.max(SHEET_MIN, Math.min(innerHeight * .92, h0 - dy)) + 'px';
  });
  const fin = () => {
    if (y0 == null) return;
    const h = side.offsetHeight, subiendo = h > h0; y0 = null;
    side.style.transition = ''; side.style.height = '';
    if (!moved) return cycleSheet();
    // se queda en la posición más cercana en el sentido en que movías el dedo
    const orden = ['min', 'mid', 'max'].filter(k => subiendo ? sheetPx(k) >= h - 40 : sheetPx(k) <= h + 40);
    setSheet(subiendo ? orden[0] || 'max' : orden[orden.length - 1] || 'min');
  };
  side.addEventListener('pointerup', fin); side.addEventListener('pointercancel', fin);
}
map.on('click', () => { if (movil() && $('#side').dataset.h !== 'min') setSheet('min'); });
function fitSel() {
  const ids = Object.keys(S.sel).map(Number).filter(id => S.byId.has(id));
  if (!ids.length) return toast('Aún no has elegido rutas: ve a «☆ Elegir rutas».');
  let b = null; for (const id of ids) { const x = bbox(S.byId.get(id)); if (x) b = b ? b.extend(x) : L.latLngBounds(x.getSouthWest(), x.getNorthEast()); }
  if (b) fitTo(b, 30);
}

const legend = L.control({ position: 'bottomleft' });
legend.onAdd = () => L.DomUtil.create('div', 'legend');
legend.addTo(map);
function drawLegend() {
  const el = legend.getContainer();
  const used = Object.keys(S.sel).map(id => S.byId.get(+id)).filter(Boolean);
  if (!used.length) { el.style.display = 'none'; return; }
  const items = new Map();
  for (const a of used) {
    const k = cfg.colorBy === 'año' ? a.tl.slice(0, 4) : cfg.colorBy === 'bici' ? (S.gears[a.gear] || 'Sin bici') : tipoDe(a)[0];
    items.set(k, colorOf(a));
  }
  el.style.display = '';
  el.innerHTML = [...items].sort((x, y) => String(y[0]).localeCompare(String(x[0]))).map(([k, c]) => `<div><i style="background:${c}"></i>${esc(k)}</div>`).join('');
}

const candLayer = L.layerGroup().addTo(map), selLayer = L.layerGroup().addTo(map), hlLayer = L.layerGroup().addTo(map), photoLayer = L.layerGroup().addTo(map);
let cursor = null;

function drawRoutes() {
  candLayer.clearLayers(); selLayer.clearLayers();
  const cand = S.tab === 'elegir' && cfg.showCand;
  for (const a of S.acts) {
    const isSel = !!S.sel[a.id];
    if (!isSel && !(cand && passes(a, true))) continue;
    const g = geom(a); if (g.length < 2) continue;
    let l;
    if (isSel) {
      L.polyline(g, { renderer: rSel, color: '#fff', weight: 6, opacity: .8, interactive: false }).addTo(selLayer);
      l = L.polyline(g, { renderer: rSel, color: colorOf(a), weight: 3.5, opacity: 1 }).addTo(selLayer);
    } else {
      l = L.polyline(g, { renderer: rCand, color: '#3b4048', weight: 2.2, opacity: .5 }).addTo(candLayer);
    }
    l.bindTooltip(`${isSel ? '★ ' : ''}${esc(a.n)}<br><small>${fmtFecha(a)} · ${fmtKm(a.d)}</small>`, { sticky: true });
    l.on('click', e => { L.DomEvent.stop(e); openDetail(a.id, false); });
  }
  drawHl(); drawLegend(); drawStats();
}
function drawHl() {
  hlLayer.clearLayers();
  const a = S.detail && S.byId.get(S.detail); if (!a) return;
  const g = geom(a);
  L.polyline(g, { renderer: rHl, color: '#000', weight: 10, opacity: .35, interactive: false }).addTo(hlLayer);
  L.polyline(g, { renderer: rHl, color: colorOf(a), weight: 5.5, opacity: 1, interactive: false }).addTo(hlLayer);
  if (g.length) L.circleMarker(g[0], { renderer: rHl, radius: 6, color: '#fff', weight: 2, fillColor: '#2b8a3e', fillOpacity: 1 }).bindTooltip('Salida').addTo(hlLayer);
}

// Dónde va cada foto: su GPS si lo tiene; si no, el punto del track a la hora en que se hizo
function photoPos(a, p) {
  if (p.ll) return { ll: p.ll, approx: false };
  const st = S.streams[a.id];
  const dt = p.at ? (Date.parse(p.at) / 1000 - a.t) : null;
  if (st && st.ll.length) {
    if (dt == null) return { ll: st.ll[Math.floor(st.ll.length / 2)], approx: true };
    let lo = 0, hi = st.t.length - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (st.t[m] < dt) lo = m + 1; else hi = m; }
    return { ll: st.ll[lo], approx: true };
  }
  const g = geom(a); if (!g.length) return null;
  const f = dt == null || !a.et ? .5 : Math.min(1, Math.max(0, dt / a.et));
  return { ll: g[Math.round(f * (g.length - 1))], approx: true };
}
function allPhotos() {
  const ids = new Set(Object.keys(S.sel).map(Number)); if (S.detail) ids.add(S.detail);
  const out = [];
  for (const id of ids) {
    const a = S.byId.get(id); if (!a || !S.photos[id]) continue;
    for (const p of S.photos[id]) { const pos = photoPos(a, p); if (pos) out.push({ a, p, ...pos }); }
  }
  return out;
}
function drawPhotos() {
  photoLayer.clearLayers();
  const all = allPhotos(); if (!all.length) return;
  const cells = new Map(), size = 60;
  for (const x of all) {
    const pt = map.project(x.ll, map.getZoom());
    const k = Math.floor(pt.x / size) + ':' + Math.floor(pt.y / size);
    if (!cells.has(k)) cells.set(k, []); cells.get(k).push(x);
  }
  for (const grp of cells.values()) {
    const f = grp[0];
    const icon = L.divIcon({ className: '', iconSize: [52, 52], iconAnchor: [26, 26],
      html: `<div class="phm${grp.every(x => x.approx) ? ' approx' : ''}"><img src="${esc(f.p.th)}" loading="lazy" referrerpolicy="no-referrer">${grp.length > 1 ? `<b>${grp.length}</b>` : ''}</div>` });
    const m = L.marker(f.ll, { icon, riseOnHover: true }).addTo(photoLayer);
    m.bindTooltip(grp.length > 1 ? `${grp.length} fotos` : esc(f.a.n), { direction: 'top', offset: [0, -26] });
    m._grp = grp;
    m.on('click', () => {
      if (grp.length > 1 && map.getZoom() < 15) {
        const b = L.latLngBounds(grp.map(x => x.ll));
        if (b.getNorthEast().equals(b.getSouthWest(), 1e-4)) lbOpen(grp, 0); else fitTo(b, 60, 16);
      } else lbOpen(grp, 0);
    });
  }
}
map.on('zoomend', drawPhotos);

// ---------- barra lateral ----------
function drawStats() {
  const sel = Object.keys(S.sel).map(id => S.byId.get(+id)).filter(Boolean);
  const km = sel.reduce((s, a) => s + a.d, 0), m = sel.reduce((s, a) => s + a.e, 0);
  const fotos = sel.reduce((s, a) => s + (S.photos[a.id]?.length ?? a.ph), 0);
  $('#stats').textContent = sel.length ? `${sel.length} rutas · ${fmtKm(km)} · ${fmtM(m)} · ${fotos} fotos` : 'Elige qué rutas quieres en tu mapa';
}
function setTab(t) { if ($('#side').dataset.h === 'min') setSheet('mid'); S.tab = t; S.detail = null; S.settings = false; S.limit = 150; render(); drawRoutes(); drawPhotos(); }

function passes(a, ignoreView) {
  const f = S.f;
  if (f.q && !a.n.toLowerCase().includes(f.q.toLowerCase())) return false;
  if (f.year && a.tl.slice(0, 4) !== f.year) return false;
  if (f.type && tipoDe(a)[0] !== f.type) return false;
  if (f.gear && a.gear !== f.gear) return false;
  if (f.photos && !a.ph) return false;
  if (f.inView && !ignoreView) { const b = bbox(a); if (!b || !map.getBounds().intersects(b)) return false; }
  return true;
}

function rowHtml(a) {
  const on = !!S.sel[a.id];
  return `<div class="row${S.detail === a.id ? ' cur' : ''}" data-id="${a.id}">
    <button class="star${on ? ' on' : ''}" data-star="${a.id}" title="${on ? 'Quitar de mi mapa' : 'Añadir a mi mapa'}">${on ? '★' : '☆'}</button>
    <span class="dot" style="background:${colorOf(a)}"></span>
    <div class="t"><b>${esc(a.n)}</b><small>${fmtFecha(a)} · ${fmtKm(a.d)} · ${fmtM(a.e)}${a.ph ? ` · 📷 ${a.ph}` : ''}</small></div></div>`;
}

function render() {
  $('#tabMapa').classList.toggle('on', S.tab === 'mapa' && !S.settings);
  $('#tabElegir').classList.toggle('on', S.tab === 'elegir' && !S.settings);
  drawStats();
  const body = $('#body');
  if (S.settings || !S.auth) return body.innerHTML = settingsHtml();
  if (S.detail) return body.innerHTML = detailHtml(S.byId.get(S.detail)), bindPerfil();
  if (S.tab === 'mapa') {
    const sel = Object.keys(S.sel).map(id => S.byId.get(+id)).filter(Boolean).sort((a, b) => b.t - a.t);
    if (!sel.length) return body.innerHTML = `<div class="card"><h2>Tu mapa está vacío</h2>
      <p>Ve a <b>☆ Elegir rutas</b> y marca con la estrella las salidas que quieras ver aquí. En el mapa salen en gris todas tus salidas para que las encuentres por la zona; también puedes buscarlas por nombre, año o bici.</p>
      <p class="muted">De las rutas que elijas se bajan el track completo y las fotos que subiste a Strava.</p>
      <button class="pri" onclick="setTab('elegir')">☆ Elegir rutas</button></div>`;
    let html = '', y = '';
    for (const a of sel) { const yy = a.tl.slice(0, 4); if (yy !== y) { html += `<div class="year">${yy}</div>`; y = yy; } html += rowHtml(a); }
    return body.innerHTML = html;
  }
  // elegir
  const years = [...new Set(S.acts.map(a => a.tl.slice(0, 4)))].sort().reverse();
  const tipos = [...new Set(S.acts.map(a => tipoDe(a)[0]))].sort();
  const list = S.acts.filter(a => passes(a));
  const opt = (v, t, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(t)}</option>`;
  body.innerHTML = `<div class="filters">
      <input type="search" id="fq" placeholder="🔍 Buscar por nombre…" value="${esc(S.f.q)}">
      <select id="fyear">${opt('', 'Todos los años', S.f.year)}${years.map(y => opt(y, y, S.f.year)).join('')}</select>
      <select id="ftype">${opt('', 'Todos los tipos', S.f.type)}${tipos.map(t => opt(t, t, S.f.type)).join('')}</select>
      ${Object.keys(S.gears).length ? `<select id="fgear" style="grid-column:1/3">${opt('', 'Todas las bicis', S.f.gear)}${Object.entries(S.gears).map(([k, n]) => opt(k, n, S.f.gear)).join('')}</select>` : ''}
      <label><input type="checkbox" id="fphotos"${S.f.photos ? ' checked' : ''}> Solo con fotos</label>
      <label><input type="checkbox" id="fview"${S.f.inView ? ' checked' : ''}> Solo las de la zona visible</label>
      <label style="grid-column:1/3"><input type="checkbox" id="fcand"${cfg.showCand ? ' checked' : ''}> Ver en gris en el mapa las que no he elegido</label>
    </div>
    <div class="muted" style="font-size:13px">${list.length} salidas${list.length !== S.acts.length ? ` de ${S.acts.length}` : ''}. Marca ☆ para añadirla a tu mapa; pulsa la salida para verla.</div>
    ${list.slice(0, S.limit).map(rowHtml).join('')}
    ${list.length > S.limit ? `<div class="actions"><button onclick="S.limit+=300;render()">Mostrar más (${list.length - S.limit})</button></div>` : ''}`;
  const upd = () => { S.limit = 150; render(); drawRoutes(); };
  $('#fq').oninput = e => { S.f.q = e.target.value; clearTimeout(render.qt); render.qt = setTimeout(() => { upd(); const i = $('#fq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 300); };
  $('#fyear').onchange = e => { S.f.year = e.target.value; upd(); };
  $('#ftype').onchange = e => { S.f.type = e.target.value; upd(); };
  if ($('#fgear')) $('#fgear').onchange = e => { S.f.gear = e.target.value; upd(); };
  $('#fphotos').onchange = e => { S.f.photos = e.target.checked; upd(); };
  $('#fview').onchange = e => { S.f.inView = e.target.checked; upd(); };
  $('#fcand').onchange = e => { cfg.showCand = e.target.checked; saveCfg(); drawRoutes(); };
}

$('#body').addEventListener('click', e => {
  const st = e.target.closest('[data-star]');
  if (st) { e.stopPropagation(); return toggleSel(+st.dataset.star); }
  const row = e.target.closest('.row[data-id]');
  if (row) openDetail(+row.dataset.id, true);
});

function toggleSel(id) {
  if (S.sel[id]) {
    if (S.sel[id].note && !confirm('Esta ruta tiene una nota tuya. ¿Quitarla del mapa igualmente?')) return;
    delete S.sel[id];
  } else { S.sel[id] = { added: Date.now(), note: '' }; encolar(id); }
  saveSel(); render(); drawRoutes(); drawPhotos();
}

async function openDetail(id, fit) {
  const a = S.byId.get(id); if (!a) return;
  S.detail = id; S.settings = false; render(); drawHl(); drawPhotos();
  if ($('#side').dataset.h === 'min') setSheet('mid');
  if (fit) { if ($('#side').dataset.h === 'max') setSheet('mid'); const b = bbox(a); if (b) fitTo(b, 40); }
  if (S.streams[id] && S.photos[id]) return;
  try { await loadDetail(id); } catch (e) { toast(e.message); }
  if (S.detail === id) { render(); drawRoutes(); drawPhotos(); }
}
function closeDetail() { S.detail = null; if (cursor) { cursor.remove(); cursor = null; } render(); drawHl(); drawPhotos(); }

function detailHtml(a) {
  const on = !!S.sel[a.id], fotos = S.photos[a.id], st = S.streams[a.id], cargando = S.loading.has(a.id);
  const grid = fotos ? (fotos.length ? `<div class="grid">${fotos.map((p, i) => `<div><img src="${esc(p.th)}" loading="lazy" referrerpolicy="no-referrer" data-ph="${i}" title="${esc(p.cap)}">${p.vid ? '<i>▶</i>' : p.ll ? '' : '<i title="Situada en el track por la hora">⌚</i>'}</div>`).join('')}</div>`
    : '<p class="muted">Sin fotos en Strava.</p>') : `<p class="muted">${cargando ? 'Cargando fotos…' : 'Fotos pendientes de cargar.'}</p>`;
  return `<div class="actions" style="margin-top:0"><button onclick="closeDetail()">‹ Volver</button></div>
    <h2>${esc(a.n)}</h2>
    <div class="muted">${fmtFecha(a, true).replace(/^./, c => c.toUpperCase())} ·${localDate(a).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}</div>
    <div class="chips">
      <span class="chip">📏 ${fmtKm(a.d)}</span><span class="chip">⛰️ ${fmtM(a.e)}</span><span class="chip">⏱️ ${fmtH(a.mt)}</span>
      <span class="chip" style="border-color:${tipoDe(a)[1]}">${tipoDe(a)[0]}</span>${S.gears[a.gear] ? `<span class="chip">🚲 ${esc(S.gears[a.gear])}</span>` : ''}
    </div>
    <div class="actions">
      <button class="${on ? '' : 'pri'}" onclick="toggleSel(${a.id})">${on ? '★ Quitar de mi mapa' : '☆ Añadir a mi mapa'}</button>
      <a class="btn" href="https://www.strava.com/activities/${a.id}" target="_blank">Ver en Strava ↗</a>
      ${st ? `<button onclick="gpx(${a.id})">⬇ GPX</button>` : ''}
    </div>
    ${st && st.alt.some(x => x != null) ? `<svg id="perfil"></svg>` : ''}
    ${on ? `<label class="muted" style="display:block;margin:10px 0 3px;font-size:13px">Mi nota</label><textarea id="nota" placeholder="Con quién fuiste, qué tal el terreno, anécdotas…">${esc(S.sel[a.id].note)}</textarea>` : ''}
    <div style="display:flex;align-items:center;margin-top:12px"><b style="flex:1">Fotos${fotos && fotos.length ? ` (${fotos.length})` : ''}</b>
      <button class="ico" title="Volver a leer las fotos de Strava" onclick="recargarFotos(${a.id})" style="font-size:15px">↻</button></div>
    ${grid}`;
}
async function recargarFotos(id) {
  try { setStatus('Leyendo fotos de Strava…'); await loadDetail(id, true); setStatus(''); } catch (e) { toast(e.message); }
  render(); drawPhotos(); drawStats();
}
$('#body').addEventListener('click', e => {
  const im = e.target.closest('img[data-ph]'); if (!im || !S.detail) return;
  const a = S.byId.get(S.detail);
  lbOpen(S.photos[a.id].map(p => ({ a, p, ...(photoPos(a, p) || {}) })), +im.dataset.ph);
});
$('#body').addEventListener('input', e => {
  if (e.target.id !== 'nota' || !S.sel[S.detail]) return;
  S.sel[S.detail].note = e.target.value; clearTimeout(saveSel.t); saveSel.t = setTimeout(saveSel, 500);
});

function bindPerfil() {
  const svg = $('#perfil'), a = S.byId.get(S.detail), st = a && S.streams[a.id]; if (!svg || !st) return;
  const W = svg.clientWidth || 360, H = 90, dMax = st.dist[st.dist.length - 1] || 1;
  const alts = st.alt.map(x => x ?? 0), lo = Math.min(...alts), hi = Math.max(...alts), rng = Math.max(hi - lo, 20);
  const X = d => d / dMax * W, Y = h => H - 6 - (h - lo) / rng * (H - 22);
  let p = `M0 ${H}`; for (let i = 0; i < alts.length; i += Math.max(1, Math.floor(alts.length / 600))) p += ` L${X(st.dist[i]).toFixed(1)} ${Y(alts[i]).toFixed(1)}`;
  p += ` L${W} ${H} Z`;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `<path d="${p}" fill="${colorOf(a)}" fill-opacity=".45" stroke="${colorOf(a)}"/>
    <text x="4" y="13" fill="#9aa596" font-size="11">${nf0.format(hi)} m</text><text x="4" y="${H - 4}" fill="#9aa596" font-size="11">${nf0.format(lo)} m</text>
    <line id="pl" y1="0" y2="${H}" stroke="#fff" stroke-width="1" visibility="hidden"/><text id="pt" y="13" fill="#fff" font-size="11" text-anchor="end"></text>`;
  svg.onpointermove = e => {
    const x = e.offsetX, d = x / W * dMax;
    let i = 0; while (i < st.dist.length - 1 && st.dist[i] < d) i++;
    const l = $('#pl'), t = $('#pt'); l.setAttribute('x1', x); l.setAttribute('x2', x); l.setAttribute('visibility', 'visible');
    t.setAttribute('x', Math.max(x - 4, 90)); t.textContent = `${nf1.format(st.dist[i] / 1000)} km · ${nf0.format(alts[i])} m`;
    if (!cursor) cursor = L.circleMarker(st.ll[i], { radius: 7, color: '#fff', weight: 3, fillColor: '#f08c00', fillOpacity: 1, pane: 'markerPane' }).addTo(map);
    else cursor.setLatLng(st.ll[i]);
  };
  svg.onpointerleave = svg.onpointercancel = () => { $('#pl')?.setAttribute('visibility', 'hidden'); $('#pt').textContent = ''; if (cursor) { cursor.remove(); cursor = null; } };
}

function gpx(id) {
  const a = S.byId.get(id), st = S.streams[id]; if (!st) return;
  const t0 = a.t * 1000;
  const pts = st.ll.map((ll, i) => `<trkpt lat="${ll[0]}" lon="${ll[1]}">${st.alt[i] != null ? `<ele>${st.alt[i]}</ele>` : ''}<time>${new Date(t0 + st.t[i] * 1000).toISOString()}</time></trkpt>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Mi Mapa BTT" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>${esc(a.n)}</name><trkseg>\n${pts}\n</trkseg></trk>\n</gpx>`;
  const el = document.createElement('a');
  el.href = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }));
  el.download = `${a.tl.slice(0, 10)} ${a.n.replace(/[\\/:*?"<>|]/g, '_')}.gpx`; el.click();
}

// ---------- visor de fotos ----------
const LB = { list: [], i: 0 };
{ // deslizar el dedo para pasar fotos
  let x0 = null;
  $('#lb').addEventListener('touchstart', e => { x0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  $('#lb').addEventListener('touchend', e => {
    if (x0 == null || LB.list.length < 2) return;
    const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 50) lbGo(dx < 0 ? 1 : -1);
  });
}
function lbOpen(list, i) { LB.list = list; LB.i = i; $('#lb').classList.add('on'); lbShow(); }
function lbClose() { $('#lb').classList.remove('on'); $('#lbMedia').innerHTML = ''; }
function lbGo(d) { LB.i = (LB.i + d + LB.list.length) % LB.list.length; lbShow(); }
function lbShow() {
  const { a, p } = LB.list[LB.i];
  $('#lbMedia').innerHTML = `<img src="${esc(p.big)}" referrerpolicy="no-referrer" alt="">`;
  const hora = p.at ? new Date(p.at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : '';
  $('#lbTxt').innerHTML = `<b>${esc(a.n)}</b> · ${fmtFecha(a)}${hora ? ' · ' + hora : ''} <span class="muted">(${LB.i + 1}/${LB.list.length})</span>
    ${p.vid ? ` · <a href="https://www.strava.com/activities/${a.id}" target="_blank" style="color:var(--acc)">▶ el vídeo se ve en Strava</a>` : ''}
    ${p.cap ? `<div>${esc(p.cap)}</div>` : ''}`;
  $('#lbOpen').href = p.big;
  document.querySelectorAll('#lb .nav').forEach(b => b.style.display = LB.list.length > 1 ? '' : 'none');
}
function lbMap() {
  const x = LB.list[LB.i]; lbClose();
  if (!x.ll) return;
  if (S.detail !== x.a.id) openDetail(x.a.id, false);
  map.setView(x.ll, Math.max(map.getZoom(), 16));
  setTimeout(() => photoLayer.eachLayer(m => { if (m._grp?.some(g => g.p === x.p)) m.getElement()?.firstChild?.classList.add('pulse'); }), 400);
}
document.addEventListener('keydown', e => {
  if ($('#lb').classList.contains('on')) {
    if (e.key === 'Escape') lbClose(); else if (e.key === 'ArrowLeft') lbGo(-1); else if (e.key === 'ArrowRight') lbGo(1);
  } else if (e.key === 'Escape' && S.detail && e.target.tagName !== 'TEXTAREA') closeDetail();
});

// ---------- ajustes ----------
function openSettings() { S.settings = !S.settings || !S.auth; if (S.detail) closeDetail(); render(); }
function settingsHtml() {
  const opt = (v, t) => `<option value="${v}"${cfg.colorBy === v ? ' selected' : ''}>${t}</option>`;
  const conectado = S.auth ? `<p>✅ Conectado${S.auth.athlete ? ' como <b>' + esc(S.auth.athlete) + '</b>' : ''}.</p>
      <p class="muted">${S.acts.length} salidas con GPS${cfg.lastSync ? ' · leído ' + new Date(cfg.lastSync).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : ''}.</p>
      <div class="actions"><button onclick="syncActs()">↻ Buscar salidas nuevas</button><button onclick="syncActs(true)">Releer todas</button>
      <button onclick="desconectar()">Desconectar</button></div>` : cfg.clientId && cfg.clientSecret ? `
      <p>Tu aplicación de Strava ya está configurada${Object.keys(S.sel).length ? ` y tienes <b>${Object.keys(S.sel).length} rutas</b> esperando` : ''}. Solo falta dar permiso:</p>
      <div class="actions"><button class="strava" onclick="stravaConnect()">Conectar con Strava</button>
      <button onclick="cfg.clientSecret='';saveCfg();render()">Cambiar clave</button></div>` : `
      <p>Para ver tus salidas hay que conectar con Strava una vez:</p>
      <ol>
        <li>Abre <a href="https://www.strava.com/settings/api" target="_blank" style="color:var(--acc)">strava.com/settings/api</a>. Si ya tienes la aplicación que creaste para <b>Mis Bicis</b>, sirve la misma; si no, crea una (nombre: Mi Mapa BTT, web: ${esc(location.origin)}, dominio de devolución: <code>${esc(location.hostname)}</code>).</li>
        <li>Copia aquí el <b>Client ID</b> y el <b>Client Secret</b> (pulsa «Mostrar»).</li>
        <li>Pulsa <b>Conectar con Strava</b> y acepta los permisos.</li>
      </ol>
      <label>Client ID</label><input type="text" id="cfgId" value="${esc(cfg.clientId)}" inputmode="numeric">
      <label>Client Secret</label><input type="password" id="cfgSecret" value="${esc(cfg.clientSecret)}">
      <div class="actions"><button class="strava" onclick="stravaConnect()">Conectar con Strava</button></div>
      <p class="muted" style="font-size:12px">Los datos se quedan en este aparato; solo se habla con Strava.</p>`;
  return `${S.auth ? '<div class="actions" style="margin-top:0"><button onclick="openSettings()">‹ Volver</button></div>' : ''}
    <div class="card"><h2>Strava</h2>${conectado}</div>
    ${S.auth ? `<div class="card"><h2>Mapa</h2>
      <label>Color de las rutas</label>
      <select onchange="cfg.colorBy=this.value;saveCfg();drawRoutes()">${opt('tipo', 'Por tipo (BTT, eBike…)')}${opt('año', 'Por año')}${opt('bici', 'Por bici')}</select>
      <p class="muted" style="font-size:13px">Las fotos con borde discontinuo no tenían GPS: se colocan en el punto del track donde estabas a la hora en que las hiciste.</p></div>
    ${Object.keys(S.sel).length ? `<div class="card"><h2>📱 Pasar al móvil</h2>
      <p class="muted" style="font-size:13px">Crea un enlace con tus rutas elegidas, tus notas y la clave de tu aplicación de Strava. Mándatelo (WhatsApp, correo…) y ábrelo en el móvil: solo tendrás que pulsar «Conectar con Strava». Envíatelo solo a ti.</p>
      <div class="actions"><button class="pri" onclick="enlaceMovil()">🔗 Crear enlace</button></div></div>` : ''}
    <div class="card"><h2>Copia de seguridad</h2>
      <p class="muted" style="font-size:13px">Guarda qué rutas has elegido y tus notas (las fotos y tracks se vuelven a bajar de Strava).</p>
      <div class="actions"><button onclick="exportar()">⬇ Exportar</button><button onclick="$('#imp').click()">⬆ Importar</button>
      <input type="file" id="imp" accept=".json" hidden onchange="importar(this.files[0])"></div></div>` : ''}`;
}
async function desconectar() {
  if (!confirm('¿Desconectar de Strava? Tus rutas elegidas y notas se conservan.')) return;
  try { await fetch('https://www.strava.com/oauth/deauthorize', { method: 'POST', headers: { Authorization: 'Bearer ' + await token() } }); } catch { }
  S.auth = null; await idb.del('auth'); render();
}
function exportar() {
  const el = document.createElement('a');
  el.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'mimapabtt', v: 1, sel: S.sel }, null, 1)], { type: 'application/json' }));
  el.download = `mi-mapa-btt-${new Date().toISOString().slice(0, 10)}.json`; el.click();
}
async function importar(file) {
  if (!file) return;
  try {
    const j = JSON.parse(await file.text());
    if (j.app !== 'mimapabtt' || !j.sel) throw new Error();
    await mezclarSel(j.sel);
  } catch { toast('Ese archivo no es una copia de Mi Mapa BTT.'); }
}
async function mezclarSel(sel) {
  let n = 0;
  for (const [id, v] of Object.entries(sel)) {
    if (!S.sel[id]) n++;
    const cur = S.sel[id] || {};
    S.sel[id] = Object.assign(cur, v, { note: v.note || cur.note || '' });
    encolar(+id);
  }
  await saveSel(); toast(n ? `${n} rutas añadidas a tu mapa.` : 'Ya tenías todas esas rutas.'); drawRoutes(); render();
}

// Enlace PC → móvil: todo va comprimido en el # (no llega a ningún servidor)
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function comprimir(txt) { return new Uint8Array(await new Response(new Blob([txt]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); }
async function descomprimir(bytes) { return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text(); }
async function enlaceMovil() {
  const sel = Object.fromEntries(Object.entries(S.sel).map(([id, v]) => [id, v.note ? { note: v.note } : {}]));
  const bytes = await comprimir(JSON.stringify({ app: 'mimapabtt', sel, id: cfg.clientId, sec: cfg.clientSecret }));
  let s = ''; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const url = APP_WEB + '#imp=' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (navigator.share && movil()) { try { await navigator.share({ title: 'Mi Mapa BTT', url }); return; } catch { } }
  try { await navigator.clipboard.writeText(url); toast('Enlace copiado: pégalo en un WhatsApp o correo para ti y ábrelo en el móvil.', 7000); }
  catch { prompt('Copia este enlace y ábrelo en el móvil:', url); }
}
async function importarEnlace() {
  const m = location.hash.match(/^#imp=([\w-]+)/); if (!m) return;
  history.replaceState(null, '', location.pathname);
  try {
    const j = JSON.parse(await descomprimir(unb64u(m[1])));
    if (j.app !== 'mimapabtt') throw new Error();
    if (j.id && !cfg.clientId) { cfg.clientId = j.id; cfg.clientSecret = j.sec || ''; saveCfg(); }
    await mezclarSel(j.sel || {});
  } catch { toast('El enlace está incompleto o dañado.'); }
}

// ---------- arranque ----------
(async () => {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { });
  S.auth = await idb.get('auth') || null;
  S.acts = await idb.get('acts') || [];
  S.byId = new Map(S.acts.map(a => [a.id, a]));
  S.gears = await idb.get('gears') || {};
  S.sel = await idb.get('sel') || {};
  for (const id of Object.keys(S.sel)) {
    const [st, ph] = await Promise.all([idb.get('st/' + id), idb.get('ph/' + id)]);
    if (st) S.streams[id] = st; if (ph) S.photos[id] = ph;
  }
  setSheet('mid');
  await importarEnlace();
  let nuevo = false;
  try { nuevo = await stravaCallback(); } catch (e) { toast('Error conectando con Strava: ' + e.message, 8000); }
  render(); drawRoutes(); drawPhotos();
  if (!cfg.view && Object.keys(S.sel).some(id => S.byId.has(+id))) fitSel();
  if (S.auth && (nuevo || !S.acts.length || Date.now() - cfg.lastSync > 6 * 3600e3)) {
    await syncActs();
    if (nuevo && !Object.keys(S.sel).length) setTab('elegir');
  } else setStatus(S.auth ? `${S.acts.length} salidas con GPS en Strava · ${Object.keys(S.sel).length} en tu mapa` : '');
  Object.keys(S.sel).forEach(id => encolar(+id));
})();
