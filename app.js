(function () {
'use strict';

/* ================================================================
   Himalayan Earthquake Risk Explorer
   Part 1: configuration, data loading (USGS live, cache, snapshot,
   file), parsing, classes, regions, filters.
   Nothing in this file contains earthquake values. Every event comes
   from the USGS catalog, a saved USGS snapshot, or a USGS file.
================================================================ */

var CFG = Object.assign({ live: true, tiles: false, print: false, author: '' }, window.HEQ_CONFIG || {});
var GEO = Object.assign({ faults: [], zones: [], rivers: [], lakes: [], land: [], ranges: [], peaks: [], places: [] }, window.HEQ_GEO || {});
var SNAP = window.HEQ_SNAPSHOTS || {};
var REDUCE = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

function $(s, r) { return (r || document).querySelector(s); }
function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
function el(tag, o, kids) {
  var n = document.createElement(tag);
  if (o) for (var k in o) {
    if (k === 'text') n.textContent = o[k];
    else if (k === 'class') n.className = o[k];
    else if (k === 'style') n.style.cssText = o[k];
    else n.setAttribute(k, o[k]);
  }
  (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return n;
}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function median(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }); var m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

var nf = new Intl.NumberFormat('en-US');
function fmtDate(t) { return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
function fmtDateTime(t) { return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'; }
function shortPlace(p) { return (p || '').replace(/^\d+(\.\d+)? km [NSEW]{1,3} of /, '') || 'Unnamed location'; }
function isoDay(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { return isoDay(new Date(Date.now() - n * 864e5)); }

/* ---------- classes ---------- */
var MAG_CLASSES = [
  { name: 'Light', range: 'under 5' },
  { name: 'Moderate', range: '5 to 5.9' },
  { name: 'Strong', range: '6 to 6.9' },
  { name: 'Major', range: '7 to 7.9' },
  { name: 'Great', range: '8 and above' }
];
var DEPTH_CLASSES = [
  { name: 'Shallow', range: 'under 70 km' },
  { name: 'Intermediate', range: '70 to 300 km' },
  { name: 'Deep', range: 'over 300 km' }
];
function magClass(m) { return m < 5 ? 0 : m < 6 ? 1 : m < 7 ? 2 : m < 8 ? 3 : 4; }
function depthClass(d) { return d == null ? -1 : d < 70 ? 0 : d < 300 ? 1 : 2; }

/* ---------- regions (first match wins) ---------- */
var REGIONS = [
  { id: 'west', name: 'Western Himalaya', sub: 'Kashmir, Himachal, northern Pakistan', box: [30.5, 72, 37, 77.5] },
  { id: 'garhwal', name: 'Garhwal and Kumaon', sub: 'Uttarakhand and the western Nepal border', box: [29.4, 77.5, 31.8, 80.3] },
  { id: 'nepal', name: 'Nepal Himalaya', sub: 'The central seismic belt', box: [26.2, 80.3, 30.6, 88.2] },
  { id: 'sikkim', name: 'Sikkim and Bhutan', sub: 'Eastern Himalaya', box: [26.2, 88.2, 29.2, 92.5] },
  { id: 'east', name: 'Arunachal, Assam and the eastern end', sub: 'Including the Indo-Burman ranges', box: [24, 92.5, 30.5, 98] },
  { id: 'tibet', name: 'Tibetan Plateau', sub: 'Ladakh, Tibet and the Trans-Himalaya', box: [28.5, 77.5, 37, 98] },
  { id: 'other', name: 'Other parts of the view', sub: 'Plains, foothills and map edges', box: [-90, -180, 90, 180] }
];
function regionOf(lat, lon) {
  for (var i = 0; i < REGIONS.length; i++) {
    var b = REGIONS[i].box;
    if (lat >= b[0] && lat <= b[2] && lon >= b[1] && lon <= b[3]) return REGIONS[i].id;
  }
  return 'other';
}
function regionById(id) { for (var i = 0; i < REGIONS.length; i++) if (REGIONS[i].id === id) return REGIONS[i]; return null; }

/* ---------- query presets ---------- */
var BBOX = { minlat: 24, maxlat: 37, minlon: 72, maxlon: 98 };
var VIEW = { lat0: 19, lat1: 41, lon0: 65, lon1: 103 };   // matches the clipped map layers
var PRESETS = [
  { id: 'since1900', label: 'Since 1900', sub: 'M 6.0+', minmag: 6.0, from: function () { return '1900-01-01'; } },
  { id: 'y25', label: 'Past 25 years', sub: 'M 5.0+', minmag: 5.0, from: function () { return daysAgo(25 * 365.25); } },
  { id: 'y1', label: 'Past year', sub: 'M 4.5+', minmag: 4.5, from: function () { return daysAgo(365); } },
  { id: 'd30', label: 'Past 30 days', sub: 'M 4.0+', minmag: 4.0, from: function () { return daysAgo(30); } }
];
function presetById(id) { for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i]; return null; }
function queryUrl(p, format) {
  var q = [
    'format=' + (format || 'geojson'),
    'starttime=' + p.from(),
    'minmagnitude=' + p.minmag.toFixed(1),
    'minlatitude=' + BBOX.minlat, 'maxlatitude=' + BBOX.maxlat,
    'minlongitude=' + BBOX.minlon, 'maxlongitude=' + BBOX.maxlon,
    'eventtype=earthquake', 'orderby=time-asc', 'limit=20000'
  ];
  return 'https://earthquake.usgs.gov/fdsnws/event/1/query?' + q.join('&');
}

/* ---------- events ---------- */
function mk(t, lat, lon, depth, mag, magType, id, place, extra) {
  var d = depth == null || isNaN(depth) ? null : +depth;
  var e = {
    t: t, y: new Date(t).getUTCFullYear(), lat: +lat, lon: +lon, d: d, m: +mag, mt: magType || '',
    id: id || '', place: place || '', mc: magClass(+mag), dc: depthClass(d), reg: regionOf(+lat, +lon),
    q: ((place || '') + ' ' + (id || '')).toLowerCase(),
    url: id ? 'https://earthquake.usgs.gov/earthquakes/eventpage/' + encodeURIComponent(id) : ''
  };
  if (extra) for (var k in extra) e[k] = extra[k];
  return e;
}
function toRows(evs) { return evs.map(function (e) { return [e.t, e.lat, e.lon, e.d, e.m, e.mt, e.id, e.place]; }); }
function fromRows(rows) { return rows.map(function (r) { return mk(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]); }); }
function inView(e) { return e.lat >= VIEW.lat0 && e.lat <= VIEW.lat1 && e.lon >= VIEW.lon0 && e.lon <= VIEW.lon1; }

function parseGeoJSON(obj) {
  var out = [];
  (obj.features || []).forEach(function (f) {
    var p = f.properties || {}, c = (f.geometry && f.geometry.coordinates) || [];
    if (c.length < 2 || p.mag == null || p.time == null) return;
    out.push(mk(+p.time, c[1], c[0], c[2], p.mag, p.magType, f.id, p.place));
  });
  return out;
}
function parseCSVRows(text) {
  var rows = [], row = [], cell = '', q = false, i = 0, n = text.length, c;
  if (text.charCodeAt(0) === 0xFEFF) i = 1;
  for (; i < n; i++) {
    c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}
function parseTime(s) {
  if (s == null) return NaN;
  s = String(s).trim();
  if (/^\d{10,13}$/.test(s)) return s.length <= 10 ? +s * 1000 : +s;
  var t = Date.parse(s);
  if (isNaN(t)) t = Date.parse(s.replace(' ', 'T') + 'Z');
  return t;
}
function parseCSV(text) {
  var rows = parseCSVRows(text);
  if (rows.length < 2) return [];
  var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
  function col(names) { for (var i = 0; i < names.length; i++) { var k = head.indexOf(names[i]); if (k >= 0) return k; } return -1; }
  var ct = col(['time', 'origintime', 'datetime', 'date']), cla = col(['latitude', 'lat']), clo = col(['longitude', 'lon', 'lng']),
    cd = col(['depth', 'depth_km', 'depth/km']), cm = col(['mag', 'magnitude']), cmt = col(['magtype', 'magnitudetype']),
    cid = col(['id', 'eventid']), cp = col(['place', 'location', 'eventlocationname']), cty = col(['type', 'eventtype']);
  if (ct < 0 || cla < 0 || clo < 0 || cm < 0) return [];
  var out = [];
  for (var r = 1; r < rows.length; r++) {
    var x = rows[r];
    if (cty >= 0 && x[cty] && x[cty].trim() && x[cty].trim().toLowerCase() !== 'earthquake') continue;
    var t = parseTime(x[ct]), la = parseFloat(x[cla]), lo = parseFloat(x[clo]), m = parseFloat(x[cm]);
    if (isNaN(t) || isNaN(la) || isNaN(lo) || isNaN(m)) continue;
    out.push(mk(t, la, lo, cd >= 0 ? parseFloat(x[cd]) : null, m, cmt >= 0 ? x[cmt] : '', cid >= 0 ? x[cid] : '', cp >= 0 ? x[cp] : ''));
  }
  return out;
}

/* ---------- state ---------- */
var S = {
  all: [], view: [], draw: [], preset: null, meta: null, sel: null, req: 0, firstDraw: true,
  f: { q: '', minMag: 0, classes: [true, true, true, true, true], depths: [true, true, true], y0: 0, y1: 9999, region: 'all' },
  colorBy: 'mag',
  layers: { faults: true, water: true, ranges: true, peaks: true, cities: true, grid: true, tiles: false }
};
function passes(e, skip) {
  var f = S.f;
  if (e.m < f.minMag - 1e-9) return false;
  if (skip !== 'class' && !f.classes[e.mc]) return false;
  if (skip !== 'depth' && e.dc >= 0 && !f.depths[e.dc]) return false;
  if (e.y < f.y0 || e.y > f.y1) return false;
  if (skip !== 'region' && f.region !== 'all' && e.reg !== f.region) return false;
  if (f.q && e.q.indexOf(f.q) < 0) return false;
  return true;
}

/* ---------- tooltip helper shared by charts and the seismograph ---------- */
var tipEl = $('#tip');
function showTip(content, x, y) {
  tipEl.textContent = '';
  if (content.title) tipEl.appendChild(el('div', { class: 't', text: content.title }));
  (content.rows || []).forEach(function (r) {
    var left = el('span', null, [r.key ? el('i', { style: 'background:' + r.key }) : null, r.label]);
    tipEl.appendChild(el('div', { class: 'r' }, [left, el('b', { text: r.value })]));
  });
  tipEl.hidden = false;
  var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  var px = x + 14, py = y + 14;
  if (px + w > window.innerWidth - 8) px = x - w - 14;
  if (py + h > window.innerHeight - 8) py = y - h - 14;
  tipEl.style.left = Math.max(8, px) + 'px';
  tipEl.style.top = Math.max(8, py) + 'px';
}
function hideTip() { tipEl.hidden = true; }

/* ---------- storage (per-viewer convenience only) ---------- */
function cacheSave(id, evs) { try { localStorage.setItem('heq:v1:' + id, JSON.stringify({ at: Date.now(), rows: toRows(evs) })); } catch (e) { /* storage unavailable or full */ } }
function cacheLoad(id) {
  try {
    var raw = localStorage.getItem('heq:v1:' + id);
    if (!raw) return null;
    var o = JSON.parse(raw);
    return o && o.rows && o.rows.length ? { at: o.at, events: fromRows(o.rows) } : null;
  } catch (e) { return null; }
}

/* ---------- loading ---------- */
function fetchLive(p) {
  return new Promise(function (resolve, reject) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); reject(new Error('The request to USGS timed out.')); }, 25000);
    fetch(queryUrl(p, 'geojson'), ctl ? { signal: ctl.signal } : undefined).then(function (r) {
      if (r.status === 204) return { features: [] };
      if (!r.ok) throw new Error('USGS answered with status ' + r.status + '.');
      return r.json();
    }).then(function (j) { clearTimeout(timer); resolve(parseGeoJSON(j)); })
      .catch(function (err) { clearTimeout(timer); reject(err instanceof TypeError ? new Error('The browser could not reach USGS. Check the internet connection.') : err); });
  });
}

function setStatus(html, cls) {
  var s = $('#status');
  s.className = 'status' + (cls ? ' ' + cls : '');
  s.textContent = '';
  (Array.isArray(html) ? html : [html]).forEach(function (h) { s.appendChild(typeof h === 'string' ? document.createTextNode(h) : h); });
}

function loadEvents(evs, meta) {
  evs = evs.filter(inView).sort(function (a, b) { return a.t - b.t; });
  S.all = evs; S.meta = meta; S.sel = null;
  var f = S.f;
  f.q = ''; $('#q').value = '';
  f.classes = [true, true, true, true, true]; f.depths = [true, true, true]; f.region = 'all'; $('#region').value = 'all';
  var ms = evs.map(function (e) { return e.m; });
  var mn = ms.length ? Math.floor(Math.min.apply(null, ms) * 10) / 10 : 0, mx = ms.length ? Math.max.apply(null, ms) : 10;
  var sl = $('#minMag'); sl.min = mn; sl.max = Math.ceil(mx * 10) / 10; sl.step = 0.1; sl.value = mn; sl.disabled = !evs.length; f.minMag = mn;
  var ys = evs.map(function (e) { return e.y; });
  var y0 = ys.length ? Math.min.apply(null, ys) : 1900, y1 = ys.length ? Math.max.apply(null, ys) : 2026;
  ['yFrom', 'yTo'].forEach(function (id) { var r = $('#' + id); r.min = y0; r.max = y1; });
  $('#yFrom').value = y0; $('#yTo').value = y1; f.y0 = y0; f.y1 = y1;
  $('#yearBox').hidden = !(y1 - y0 >= 2);
  $('#empty').hidden = evs.length > 0;
  if (!evs.length) showEmpty(new Error('The data source returned no earthquakes for this window.'), presetById(S.preset));
  describeSource();
  hideInspector();
  applyFilters();
  Seis.reset(S.firstDraw && evs.length > 0);
  if (evs.length) S.firstDraw = false;
}

function describeSource() {
  var m = S.meta, n = nf.format(S.all.length);
  if (!m) { setStatus('No data loaded.', 'err'); return; }
  var dot = el('span', { class: 'dot' });
  if (m.kind === 'live') setStatus([dot, el('b', { text: 'Live from USGS' }), ' at ' + new Date(m.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' · ' + n + ' earthquakes'], 'live');
  else if (m.kind === 'cache') setStatus([dot, el('b', { text: 'Saved USGS copy' }), ' from ' + fmtDate(m.at) + '. USGS could not be reached just now. · ' + n + ' earthquakes']);
  else if (m.kind === 'snapshot') setStatus([dot, el('b', { text: 'USGS snapshot' }), ' downloaded on ' + fmtDate(m.at) + ' · ' + n + ' earthquakes']);
  else if (m.kind === 'file') setStatus([dot, el('b', { text: 'Your file' }), ' ' + m.name + ' · ' + n + ' earthquakes' + (m.dropped ? ' (' + m.dropped + ' outside the map area ignored)' : '')]);
}

function showEmpty(err, p) {
  S.all = []; S.meta = null; S.view = []; S.draw = [];
  var box = $('#empty'); box.hidden = false;
  var live = CFG.live;
  $('#emptyTitle').textContent = 'No earthquake data loaded';
  $('#emptyText').textContent = live
    ? (err && err.message ? err.message + ' ' : '') + 'The page reads earthquakes straight from the USGS catalog, so it needs an internet connection. You can also load a file you downloaded from USGS.'
    : 'This page cannot call the USGS catalog directly. Load a CSV or GeoJSON file downloaded from USGS and every chart, table and the map will use it.';
  $('#btnRetry').hidden = !live;
  var ul = $('#dlList'); ul.textContent = '';
  PRESETS.forEach(function (pp) {
    ul.appendChild(el('li', null, [el('a', { href: queryUrl(pp, 'csv'), target: '_blank', rel: 'noopener', text: pp.label + ', ' + pp.sub + ' (CSV)' })]));
  });
  setStatus('No data loaded.', 'err');
  applyFilters();
  Seis.reset(false);
}

function selectPreset(id) {
  var p = presetById(id); if (!p) return;
  S.preset = id;
  $$('#presets input').forEach(function (i) { i.checked = i.value === id; });
  var req = ++S.req;
  setStatus('Loading earthquakes…');
  $('#presets').setAttribute('aria-busy', 'true');
  var attempt = CFG.live ? fetchLive(p) : Promise.reject(new Error('live-disabled'));
  attempt.then(function (evs) {
    if (req !== S.req) return;
    cacheSave(p.id, evs);
    loadEvents(evs, { kind: 'live', at: Date.now() });
  }).catch(function (err) {
    if (req !== S.req) return;
    var c = cacheLoad(p.id);
    if (c) return loadEvents(c.events, { kind: 'cache', at: c.at });
    var s = SNAP[p.id];
    if (s && s.events && s.events.length) return loadEvents(fromRows(s.events), { kind: 'snapshot', at: Date.parse(s.fetched) || Date.now() });
    showEmpty(err, p);
  }).then(function () { $('#presets').removeAttribute('aria-busy'); });
}

function loadFile(file) {
  var rd = new FileReader();
  rd.onerror = function () { setStatus('The file could not be read.', 'err'); };
  rd.onload = function () {
    try {
      var txt = String(rd.result), evs;
      evs = txt.trim().charAt(0) === '{' ? parseGeoJSON(JSON.parse(txt)) : parseCSV(txt);
      if (!evs.length) throw new Error('No earthquakes found in that file. Expected a USGS CSV with the columns time, latitude, longitude and mag, or a USGS GeoJSON file.');
      var kept = evs.filter(inView), dropped = evs.length - kept.length;
      if (!kept.length) throw new Error('None of the ' + evs.length + ' earthquakes in that file are inside the Himalayan map area.');
      S.req++; S.preset = 'file';
      var fr = $('#presetFile'); fr.disabled = false; fr.checked = true;
      $('#presetFileText').textContent = file.name.length > 22 ? file.name.slice(0, 20) + '…' : file.name;
      $$('#presets input').forEach(function (i) { i.checked = i.value === 'file'; });
      loadEvents(kept, { kind: 'file', name: file.name, dropped: dropped });
    } catch (err) { setStatus(err.message || 'The file could not be read.', 'err'); }
  };
  rd.readAsText(file);
}


/* ================================================================
   Part 2: the map. A small canvas renderer with a Web Mercator
   projection, so the page needs no map library and no tile server.
   Layers: land, relief regions, lakes, rivers, graticule, faults,
   peaks, cities, earthquakes. No political boundaries are drawn.
================================================================ */

function trimNum(n) { return String(+(+n).toFixed(2)); }
function faultTypeName(t) {
  return ({ Reverse: 'Thrust / reverse', Subduction_Thrust: 'Subduction thrust', Normal: 'Normal', Sinistral: 'Strike-slip (left-lateral)', Dextral: 'Strike-slip (right-lateral)',
    'Sinistral-Reverse': 'Oblique (left-lateral, reverse)', 'Dextral-Reverse': 'Oblique (right-lateral, reverse)', 'Sinistral-Normal': 'Oblique (left-lateral, normal)' })[t] || t || 'Unknown';
}
function slipText(s) {
  if (!s) return 'Not given in the GEM database';
  var k = s[0], p = s[1], lo = s[2], hi = s[3];
  var lab = ({ net: 'net slip', shortening: 'shortening', 'strike-slip': 'strike-slip', 'dip-slip': 'dip-slip' })[k] || k;
  var main = p != null ? trimNum(p) : (lo != null && hi != null ? trimNum(lo) + ' to ' + trimNum(hi) : '');
  if (!main) return 'Not given in the GEM database';
  var rng = (p != null && lo != null && hi != null) ? ' (range ' + trimNum(lo) + ' to ' + trimNum(hi) + ')' : '';
  return main + ' mm per year, ' + lab + rng;
}
function faultKind(t) { return /Reverse|Thrust/.test(t || '') && !/^(Sinistral|Dextral)/.test(t || '') ? 'thrust' : t === 'Normal' ? 'normal' : 'strike'; }

var RANGE_SHOW = {
  'Himalayas': { label: 'HIMALAYAS', at: [84.4, 29.45], rot: 11, z: 0 },
  'Karakoram': { label: 'KARAKORAM', at: [77.2, 35.55], rot: 26, z: 0 },
  'Hindu Kush': { label: 'HINDU KUSH', at: [71.4, 35.8], rot: -35, z: 0 },
  'Pamir mountains': { label: 'PAMIR', at: [74.3, 38.3], rot: 0, z: 0 },
  'Kunlun Mountains': { label: 'KUNLUN', at: [86.5, 36.3], rot: -8, z: 0 },
  'Tibetan Plateau': { label: 'TIBETAN PLATEAU', at: [89, 32.8], rot: 0, z: 0 },
  'Tian Shan': { label: 'TIAN SHAN', at: [77.5, 40.6], rot: 0, z: 0 },
  'Altyn-Tagh': { label: 'ALTYN TAGH', at: [90.3, 38.4], rot: -10, z: 5.4 },
  'Qilian Mountains': { label: 'QILIAN', at: [98.4, 38.2], rot: 22, z: 5.4 },
  'Siwalik Hills': { label: 'Siwalik Hills', at: [82.2, 27.3], rot: 10, z: 6.4 },
  'Indo-Gangetic Plain': { label: 'INDO-GANGETIC PLAIN', at: [82.5, 26.2], rot: 6, z: 0 },
  'Tarim Basin': { label: 'TARIM BASIN', at: [83, 39.2], rot: 0, z: 0 },
  'Taklamakan': { label: 'TAKLAMAKAN DESERT', at: [82.5, 38.9], rot: 0, z: 99 },
  'Qaidam Basin': { label: 'QAIDAM BASIN', at: [95.4, 37.1], rot: 0, z: 5.6 },
  'Thar Desert': { label: 'THAR DESERT', at: [72.0, 27.2], rot: 0, z: 0 },
  'Kashmir Valley': { label: 'Kashmir Valley', at: [76.2, 33.9], rot: 0, z: 6.6 },
  'Naga hills': { label: 'Naga Hills', at: [94.6, 25.4], rot: 0, z: 6.4 },
  'Khasi Hills': { label: 'Khasi Hills', at: [92.1, 25.5], rot: 0, z: 6.4 },
  'Chin Hills': { label: 'Chin Hills', at: [93.2, 23.2], rot: 0, z: 6.4 },
  'Yarlung Tsangpo Grand Canyon': { label: 'Tsangpo Gorge', at: [95.4, 29.2], rot: 0, z: 6.6, nofill: true }
};
var HIMAL = { 'Kathmandu': 1, 'Srinagar': 1, 'Lhasa': 1, 'Thimphu': 1, 'Gangtok': 1, 'Leh': 1, 'Dehra Dun': 1, 'Islamabad': 1, 'Guwahati': 1, 'Pokhara': 1, 'Gilgit': 1, 'Siliguri': 1, 'Shillong': 1, 'Itanagar': 1, 'Delhi': 1, 'Chandigarh': 1, 'Jammu': 1 };
var DEF_BOX = [24, 72, 37.5, 98];

var MapView = (function () {
  var cv = $('#map'), shell = $('#shell'), ctx = cv.getContext('2d');
  var W = 0, H = 0, dpr = 1, F = null, COL = null, hits = [], dirty = false, flying = null, hovered = null, hoverFault = null, ready = false, hintTimer = 0;
  var view = { lon: 85, lat: 31, z: 5 };
  var ZMAX = 9.5;
  var tiles = {}, tileCount = 0;
  var tipEl2 = $('#mapTip');

  /* geometry helpers (world coordinates are 0..1 across the Mercator square) */
  function wxn(lon) { return (lon + 180) / 360; }
  function wyn(lat) { var s = Math.sin(lat * Math.PI / 180); return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI); }
  function lonFromWx(x) { return x * 360 - 180; }
  function latFromWy(y) { var n = Math.PI * (1 - 2 * y); return 180 / Math.PI * Math.atan(Math.sinh(n)); }
  function frame() { var s = 256 * Math.pow(2, view.z); return { s: s, cx: wxn(view.lon) * s, cy: wyn(view.lat) * s }; }
  function X(lon) { return (lon + 180) / 360 * F.s - F.cx + W / 2; }
  function Y(lat) { return wyn(lat) * F.s - F.cy + H / 2; }
  function unproject(sx, sy) { return [lonFromWx((F.cx + sx - W / 2) / F.s), latFromWy((F.cy + sy - H / 2) / F.s)]; }
  function minZoom() {
    var zx = Math.log(W / (256 * (wxn(VIEW.lon1) - wxn(VIEW.lon0)))) / Math.LN2;
    var zy = Math.log(H / (256 * (wyn(VIEW.lat0) - wyn(VIEW.lat1)))) / Math.LN2;
    return Math.max(zx, zy, 2.5);
  }
  function clampView() {
    view.z = clamp(view.z, minZoom(), ZMAX);
    var s = 256 * Math.pow(2, view.z);
    var x0 = wxn(VIEW.lon0) * s, x1 = wxn(VIEW.lon1) * s, y0 = wyn(VIEW.lat1) * s, y1 = wyn(VIEW.lat0) * s;
    var cx = wxn(view.lon) * s, cy = wyn(view.lat) * s;
    cx = (x1 - x0 <= W) ? (x0 + x1) / 2 : clamp(cx, x0 + W / 2, x1 - W / 2);
    cy = (y1 - y0 <= H) ? (y0 + y1) / 2 : clamp(cy, y0 + H / 2, y1 - H / 2);
    view.lon = lonFromWx(cx / s); view.lat = latFromWy(cy / s);
  }
  function invalidate() { if (!dirty) { dirty = true; requestAnimationFrame(render); } }
  function zoomAt(sx, sy, z) {
    F = frame(); var ll = unproject(sx, sy);
    z = clamp(z, minZoom(), ZMAX);
    var s = 256 * Math.pow(2, z);
    view.z = z; view.lon = lonFromWx((wxn(ll[0]) * s - (sx - W / 2)) / s); view.lat = latFromWy((wyn(ll[1]) * s - (sy - H / 2)) / s);
    clampView(); invalidate();
  }
  function panBy(dx, dy) { F = frame(); view.lon = lonFromWx((F.cx - dx) / F.s); view.lat = latFromWy((F.cy - dy) / F.s); clampView(); invalidate(); }
  function boxView(box, pad) {
    var lon0 = box[1], lon1 = box[3], ym0 = wyn(box[2]), ym1 = wyn(box[0]);
    var zx = Math.log((W - 2 * pad) / (256 * ((lon1 - lon0) / 360))) / Math.LN2;
    var zy = Math.log((H - 2 * pad) / (256 * (ym1 - ym0))) / Math.LN2;
    return { lon: (lon0 + lon1) / 2, lat: latFromWy((ym0 + ym1) / 2), z: Math.min(zx, zy) };
  }
  function flyTo(lon, lat, z, instant) {
    var to = { lon: lon, lat: lat, z: clamp(z, minZoom(), ZMAX) };
    if (instant || REDUCE || !ready) { view.lon = to.lon; view.lat = to.lat; view.z = to.z; clampView(); invalidate(); return; }
    var from = { lon: view.lon, lat: view.lat, z: view.z }, t0 = performance.now(), dur = 650;
    var token = flying = {};
    (function step(now) {
      if (flying !== token) return;
      var k = clamp((now - t0) / dur, 0, 1), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      view.lon = from.lon + (to.lon - from.lon) * e; view.lat = from.lat + (to.lat - from.lat) * e; view.z = from.z + (to.z - from.z) * e;
      clampView(); invalidate();
      if (k < 1) requestAnimationFrame(step); else flying = null;
    })(t0);
  }
  function fitBox(box, pad, instant) { var b = boxView(box, pad == null ? 20 : pad); flyTo(b.lon, b.lat, b.z, instant); }

  /* colours come from the page's CSS variables so both themes work */
  function readColors() {
    var cs = getComputedStyle(document.documentElement);
    function g(n) { return cs.getPropertyValue(n).trim(); }
    COL = { ocean: g('--ocean'), land: g('--land'), relief: g('--relief'), lowland: g('--lowland'), river: g('--river'), lake: g('--lake'), grid: g('--grid'),
      label: g('--label'), halo: g('--halo'), fault: g('--fault'), accent: g('--accent'), text: g('--text'), ground: g('--ground'),
      mag: [g('--m1'), g('--m2'), g('--m3'), g('--m4'), g('--m5')], depth: [g('--d1'), g('--d2'), g('--d3')] };
    var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(COL.ground);
    COL.dark = m ? (parseInt(m[1], 16) + parseInt(m[2], 16) + parseInt(m[3], 16)) < 300 : true;
  }

  /* faults pre-grouped by kind */
  var FK = { thrust: [], strike: [], normal: [] }, FSEG = [];
  GEO.faults.forEach(function (f) {
    f.kind = faultKind(f.t);
    f.l.forEach(function (ln) { FK[f.kind].push(ln); FSEG.push({ f: f, ln: ln }); });
  });
  var PLACES = GEO.places.slice().sort(function (a, b) { return ((HIMAL[b.n] ? 1e9 : 0) + b.p) - ((HIMAL[a.n] ? 1e9 : 0) + a.p); });
  var PEAKS = GEO.peaks.slice().sort(function (a, b) { return b.e - a.e; });

  function ringPath(r) {
    for (var i = 0; i < r.length; i++) { var x = X(r[i][0]), y = Y(r[i][1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.closePath();
  }
  function linePath(l) {
    for (var i = 0; i < l.length; i++) { var x = X(l[i][0]), y = Y(l[i][1]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
  }
  function haloText(txt, x, y, color, alpha) {
    ctx.lineJoin = 'round'; ctx.lineWidth = 3.5; ctx.strokeStyle = COL.halo; ctx.globalAlpha = 0.85 * (alpha == null ? 1 : alpha); ctx.strokeText(txt, x, y);
    ctx.globalAlpha = alpha == null ? 1 : alpha; ctx.fillStyle = color; ctx.fillText(txt, x, y); ctx.globalAlpha = 1;
  }
  function radius(m) {
    var k = clamp(0.82 + (view.z - 5) * 0.1, 0.8, 1.45);
    return clamp((2 + Math.pow(1.62, m - 3.5) * 1.4) * k, 2.5, 40);
  }
  function quakeColor(e) { return S.colorBy === 'depth' ? COL.depth[e.dc < 0 ? 0 : e.dc] : COL.mag[e.mc]; }

  function drawTiles() {
    var z = clamp(Math.round(view.z), 2, 13), ts = 256 * Math.pow(2, view.z - z), left = F.cx - W / 2, top = F.cy - H / 2, n = Math.pow(2, z);
    var x0 = Math.floor(left / ts), x1 = Math.floor((left + W) / ts), y0 = Math.floor(top / ts), y1 = Math.floor((top + H) / ts);
    if (tileCount > 500) { tiles = {}; tileCount = 0; }
    ctx.globalAlpha = COL.dark ? 0.55 : 0.92;
    for (var ty = y0; ty <= y1; ty++) {
      if (ty < 0 || ty >= n) continue;
      for (var tx = x0; tx <= x1; tx++) {
        var wxm = ((tx % n) + n) % n, key = z + '/' + wxm + '/' + ty, t = tiles[key];
        if (!t) {
          t = tiles[key] = { img: new Image(), ok: false }; tileCount++;
          (function (tt) { tt.img.onload = function () { tt.ok = true; invalidate(); }; })(t);
          t.img.src = 'https://' + 'abc'.charAt((wxm + ty) % 3) + '.tile.opentopomap.org/' + z + '/' + wxm + '/' + ty + '.png';
        }
        if (t.ok) ctx.drawImage(t.img, tx * ts - left, ty * ts - top, ts + 0.6, ts + 0.6);
      }
    }
    ctx.globalAlpha = 1;
  }

  function render() {
    dirty = false;
    if (!W || !H) return;
    if (!COL) readColors();
    F = frame();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COL.ocean; ctx.fillRect(0, 0, W, H);
    var tilesOn = CFG.tiles && S.layers.tiles, z = view.z;

    if (tilesOn) {
      ctx.fillStyle = COL.land; ctx.fillRect(0, 0, W, H);
      drawTiles();
    } else {
      ctx.beginPath(); GEO.land.forEach(ringPath); ctx.fillStyle = COL.land; ctx.fill('evenodd');
      if (S.layers.ranges) {
        GEO.ranges.forEach(function (r) {
          var cfg = RANGE_SHOW[r.n]; if (!cfg || cfg.nofill) return;
          var mount = r.c === 'Range/mtn' || r.c === 'Plateau';
          ctx.beginPath(); r.p.forEach(ringPath);
          ctx.fillStyle = mount ? COL.relief : COL.lowland; ctx.globalAlpha = mount ? (r.c === 'Plateau' ? 0.06 : 0.1) : 0.07; ctx.fill('evenodd'); ctx.globalAlpha = 1;
        });
      }
      if (S.layers.water) {
        ctx.beginPath(); GEO.lakes.forEach(function (l) { l.p.forEach(ringPath); }); ctx.fillStyle = COL.lake; ctx.fill('evenodd');
        ctx.strokeStyle = COL.river; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        GEO.rivers.forEach(function (r) {
          ctx.beginPath(); r.l.forEach(linePath);
          ctx.lineWidth = r.r != null && r.r <= 3 ? 1.6 : 1; ctx.globalAlpha = 0.85; ctx.stroke();
        });
        ctx.globalAlpha = 1;
      }
    }

    /* graticule */
    if (S.layers.grid) {
      var step = z < 4.6 ? 10 : z < 5.6 ? 5 : z < 6.8 ? 2 : z < 7.8 ? 1 : 0.5;
      var tl = unproject(0, 0), br = unproject(W, H);
      ctx.strokeStyle = COL.grid; ctx.globalAlpha = 0.14; ctx.lineWidth = 1; ctx.beginPath();
      var lo, la;
      for (lo = Math.ceil(tl[0] / step) * step; lo <= br[0]; lo += step) { var gx = Math.round(X(lo)) + 0.5; ctx.moveTo(gx, 0); ctx.lineTo(gx, H); }
      for (la = Math.ceil(br[1] / step) * step; la <= tl[1]; la += step) { var gy = Math.round(Y(la)) + 0.5; ctx.moveTo(0, gy); ctx.lineTo(W, gy); }
      ctx.stroke(); ctx.globalAlpha = 1;
      ctx.font = '11px ' + getComputedStyle(document.body).fontFamily; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
      for (lo = Math.ceil(tl[0] / step) * step; lo <= br[0]; lo += step) { var lx = X(lo); if (lx > 150 && lx < W - 70) haloText(trimNum(lo) + '°E', lx + 4, 14, COL.label, 0.8); }
      for (la = Math.ceil(br[1] / step) * step; la <= tl[1]; la += step) { var ly = Y(la); if (ly > 56 && ly < H - 130) haloText(trimNum(la) + '°N', 6, ly - 4, COL.label, 0.8); }
    }

    /* faults */
    if (S.layers.faults) {
      ctx.strokeStyle = COL.fault; ctx.lineJoin = 'round'; ctx.lineCap = 'butt'; ctx.globalAlpha = 0.95;
      var styles = { thrust: [2.3, []], strike: [1.6, [8, 5]], normal: [2.2, [1.5, 5]] };
      for (var kind in styles) {
        ctx.beginPath(); FK[kind].forEach(linePath);
        ctx.lineWidth = styles[kind][0]; ctx.setLineDash(styles[kind][1]); ctx.lineCap = kind === 'normal' ? 'round' : 'butt'; ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (hoverFault) { ctx.beginPath(); hoverFault.l.forEach(linePath); ctx.strokeStyle = COL.accent; ctx.lineWidth = 3.6; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1; }
    }

    /* labels with simple collision avoidance */
    var placed = [];
    function free(x, y, w, h) {
      for (var i = 0; i < placed.length; i++) { var p = placed[i]; if (x < p[0] + p[2] && x + w > p[0] && y < p[1] + p[3] && y + h > p[1]) return false; }
      placed.push([x, y, w, h]); return true;
    }
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    var bodyFont = getComputedStyle(document.body).fontFamily;
    if (S.layers.cities) {
      PLACES.forEach(function (p) {
        var x = X(p.x), y = Y(p.y); if (x < -40 || x > W + 40 || y < -20 || y > H + 20) return;
        var major = HIMAL[p.n] ? 1 : 0;
        if (!major && z < 5.2 && p.p < 2500000) return;
        ctx.font = (major ? '600 ' : '400 ') + '12px ' + bodyFont;
        var w = ctx.measureText(p.n).width;
        if (!free(x - 4, y - 12, w + 14, 18)) return;
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 6.2832); ctx.fillStyle = COL.label; ctx.fill(); ctx.strokeStyle = COL.halo; ctx.lineWidth = 1.2; ctx.stroke();
        haloText(p.n, x + 6, y + 4, COL.text, 1);
      });
    }
    if (S.layers.peaks) {
      PEAKS.forEach(function (p) {
        if (!(p.e >= 8000 || (p.e >= 7000 && z >= 5.6) || z >= 6.6)) return;
        var x = X(p.x), y = Y(p.y); if (x < -40 || x > W + 40 || y < -20 || y > H + 20) return;
        ctx.font = '400 11px ' + bodyFont;
        var txt = p.n + ' ' + nf.format(p.e) + ' m', w = ctx.measureText(txt).width;
        if (!free(x - 6, y - 12, w + 16, 18)) return;
        ctx.beginPath(); ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y + 4); ctx.lineTo(x - 5, y + 4); ctx.closePath();
        ctx.fillStyle = COL.label; ctx.fill(); ctx.strokeStyle = COL.halo; ctx.lineWidth = 1.2; ctx.stroke();
        haloText(txt, x + 8, y + 4, COL.label, 0.95);
      });
    }
    if (!tilesOn && S.layers.ranges) {
      ctx.textAlign = 'center';
      Object.keys(RANGE_SHOW).forEach(function (name) {
        var c = RANGE_SHOW[name]; if (z < c.z) return;
        var x = X(c.at[0]), y = Y(c.at[1]); if (x < -80 || x > W + 80 || y < -30 || y > H + 30) return;
        var caps = c.label === c.label.toUpperCase();
        ctx.save(); ctx.translate(x, y); ctx.rotate(c.rot * Math.PI / 180);
        ctx.font = (caps ? '600 ' : 'italic 400 ') + (caps ? 12 : 12) + 'px ' + bodyFont;
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = caps ? '3px' : '0px';
        haloText(c.label, 0, 0, COL.label, 0.6);
        if (ctx.letterSpacing !== undefined) ctx.letterSpacing = '0px';
        ctx.restore();
      });
      ctx.textAlign = 'left';
    }

    /* earthquakes: large first, small on top */
    hits = [];
    var arr = S.draw, i, e, r, x2, y2;
    ctx.lineWidth = 1.4; ctx.strokeStyle = COL.halo;
    for (i = 0; i < arr.length; i++) {
      e = arr[i]; x2 = X(e.lon); y2 = Y(e.lat); r = radius(e.m);
      if (x2 < -r || x2 > W + r || y2 < -r || y2 > H + r) continue;
      ctx.beginPath(); ctx.arc(x2, y2, r, 0, 6.2832);
      ctx.globalAlpha = 0.74; ctx.fillStyle = quakeColor(e); ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
      hits.push({ x: x2, y: y2, r: r, e: e });
    }
    function ring(e2, extra, w, a) {
      var rr = radius(e2.m) + extra; ctx.beginPath(); ctx.arc(X(e2.lon), Y(e2.lat), rr, 0, 6.2832);
      ctx.strokeStyle = COL.accent; ctx.lineWidth = w; ctx.globalAlpha = a; ctx.stroke(); ctx.globalAlpha = 1;
    }
    if (hovered && hovered !== (S.sel && S.sel.e)) ring(hovered, 3, 2, 0.9);
    if (S.sel && S.sel.type === 'event') { ring(S.sel.e, 4, 2.6, 1); ring(S.sel.e, 9, 1.4, 0.45); }
    if (S.sel && S.sel.type === 'fault') { ctx.beginPath(); S.sel.f.l.forEach(linePath); ctx.strokeStyle = COL.accent; ctx.lineWidth = 4; ctx.globalAlpha = 0.95; ctx.stroke(); ctx.globalAlpha = 1; }
  }

  /* ---------- hit testing ---------- */
  function hitEvent(x, y) {
    for (var i = hits.length - 1; i >= 0; i--) {
      var h = hits[i], rr = Math.max(h.r, 7) + 2, dx = h.x - x, dy = h.y - y;
      if (dx * dx + dy * dy <= rr * rr) return h.e;
    }
    return null;
  }
  function hitFault(x, y) {
    if (!S.layers.faults) return null;
    F = frame();
    var best = null, bd = 36;   // 6px squared
    for (var i = 0; i < FSEG.length; i++) {
      var ln = FSEG[i].ln;
      for (var j = 1; j < ln.length; j++) {
        var ax = X(ln[j - 1][0]), ay = Y(ln[j - 1][1]), bx = X(ln[j][0]), by = Y(ln[j][1]);
        if ((ax < x - 8 && bx < x - 8) || (ax > x + 8 && bx > x + 8) || (ay < y - 8 && by < y - 8) || (ay > y + 8 && by > y + 8)) continue;
        var vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy, t = L ? clamp(((x - ax) * vx + (y - ay) * vy) / L, 0, 1) : 0;
        var px = ax + t * vx - x, py = ay + t * vy - y, d = px * px + py * py;
        if (d < bd) { bd = d; best = FSEG[i].f; }
      }
    }
    return best;
  }

  /* ---------- map tooltip ---------- */
  function showMapTip(sx, sy, lines) {
    tipEl2.textContent = '';
    tipEl2.appendChild(el('b', { text: lines[0] }));
    for (var i = 1; i < lines.length; i++) tipEl2.appendChild(el('span', { text: lines[i] }));
    tipEl2.hidden = false;
    var w = tipEl2.offsetWidth, h = tipEl2.offsetHeight;
    var x = sx + 14, y = sy + 14;
    if (x + w > W - 8) x = sx - w - 14;
    if (y + h > H - 8) y = sy - h - 14;
    tipEl2.style.left = Math.max(8, x) + 'px'; tipEl2.style.top = Math.max(8, y) + 'px';
  }
  function hideMapTip() { tipEl2.hidden = true; }
  function updateHover(x, y) {
    var e = hitEvent(x, y), f = e ? null : hitFault(x, y);
    var changed = e !== hovered || f !== hoverFault;
    hovered = e; hoverFault = f;
    cv.style.cursor = e || f ? 'pointer' : '';
    if (e) showMapTip(x, y, ['M ' + e.m.toFixed(1) + ' · ' + e.place, fmtDate(e.t), e.d != null ? 'Depth ' + trimNum(e.d) + ' km' : 'Depth not given']);
    else if (f) showMapTip(x, y, [f.n || 'Unnamed fault trace', faultTypeName(f.t), slipText(f.s)]);
    else hideMapTip();
    if (changed) invalidate();
  }

  /* ---------- input ---------- */
  var P = {}, nP = 0, drag = null, pinch = null;
  function local(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  cv.addEventListener('pointerdown', function (e) {
    if (e.button > 0) return;
    var p = local(e); if (!P[e.pointerId]) nP++; P[e.pointerId] = p;
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    cv.focus({ preventScroll: true }); hideMapTip(); flying = null; $('#hint').classList.remove('show');
    if (nP === 1) drag = { x: p.x, y: p.y, moved: false };
    else if (nP === 2) { var ks = Object.keys(P); pinch = { d: Math.hypot(P[ks[0]].x - P[ks[1]].x, P[ks[0]].y - P[ks[1]].y), z: view.z }; drag = null; }
    cv.classList.add('dragging');
  });
  cv.addEventListener('pointermove', function (e) {
    var p = local(e);
    if (P[e.pointerId]) P[e.pointerId] = p;
    if (pinch && nP === 2) {
      var ks = Object.keys(P), a = P[ks[0]], b = P[ks[1]], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.d > 0) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.z + Math.log(d / pinch.d) / Math.LN2);
    } else if (drag) {
      var dx = p.x - drag.x, dy = p.y - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) > 4) drag.moved = true;
      if (drag.moved) { panBy(dx, dy); drag.x = p.x; drag.y = p.y; }
    } else if (e.pointerType === 'mouse') updateHover(p.x, p.y);
  });
  function endPointer(e) {
    var p = local(e);
    if (e.type === 'pointerup' && drag && !drag.moved && nP === 1) {
      F = frame();
      var ev = hitEvent(p.x, p.y);
      if (ev) selectEvent(ev, false);
      else { var f = hitFault(p.x, p.y); if (f) selectFault(f); else clearSel(); }
    }
    if (P[e.pointerId]) { delete P[e.pointerId]; nP = Math.max(0, nP - 1); }
    if (nP < 2) pinch = null;
    if (nP === 0) { drag = null; cv.classList.remove('dragging'); }
    else if (nP === 1) { var k = Object.keys(P)[0]; drag = { x: P[k].x, y: P[k].y, moved: true }; }
  }
  cv.addEventListener('pointerup', endPointer);
  cv.addEventListener('pointercancel', endPointer);
  cv.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse' && !drag) { hovered = null; hoverFault = null; hideMapTip(); invalidate(); } });
  cv.addEventListener('dblclick', function (e) { var p = local(e); zoomAt(p.x, p.y, view.z + 1); });
  function showHint() { var h = $('#hint'); h.classList.add('show'); clearTimeout(hintTimer); hintTimer = setTimeout(function () { h.classList.remove('show'); }, 1800); }
  cv.addEventListener('wheel', function (e) {
    if (!(e.ctrlKey || e.metaKey || document.activeElement === cv)) { showHint(); return; }
    e.preventDefault();
    var p = local(e), dz = clamp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0025), -0.7, 0.7);
    zoomAt(p.x, p.y, view.z + dz);
  }, { passive: false });
  cv.addEventListener('keydown', function (e) {
    var k = e.key, d = 90;
    if (k === 'ArrowLeft') panBy(d, 0); else if (k === 'ArrowRight') panBy(-d, 0); else if (k === 'ArrowUp') panBy(0, d); else if (k === 'ArrowDown') panBy(0, -d);
    else if (k === '+' || k === '=') zoomAt(W / 2, H / 2, view.z + 0.5); else if (k === '-' || k === '_') zoomAt(W / 2, H / 2, view.z - 0.5);
    else if (k === 'Escape') clearSel(); else return;
    e.preventDefault();
  });
  $('#zIn').addEventListener('click', function () { zoomAt(W / 2, H / 2, view.z + 0.8); });
  $('#zOut').addEventListener('click', function () { zoomAt(W / 2, H / 2, view.z - 0.8); });
  $('#zFit').addEventListener('click', function () { fitBox(DEF_BOX, 20); });

  /* ---------- legend and attribution ---------- */
  function renderLegend() {
    var lg = $('#legend'); lg.textContent = '';
    var row1 = el('div', { class: 'row' });
    var cls = S.colorBy === 'depth' ? DEPTH_CLASSES : MAG_CLASSES, vars = S.colorBy === 'depth' ? ['--d1', '--d2', '--d3'] : ['--m1', '--m2', '--m3', '--m4', '--m5'];
    row1.appendChild(el('span', { text: S.colorBy === 'depth' ? 'Depth:' : 'Magnitude:' }));
    cls.forEach(function (c, i) { row1.appendChild(el('span', { class: 'k' }, [el('i', { style: 'background:var(' + vars[i] + ')' }), c.name])); });
    lg.appendChild(row1);
    var sizes = [5, 6, 7, 8], x = 8, parts = '';
    sizes.forEach(function (m) { var r = clamp((2 + Math.pow(1.62, m - 3.5) * 1.4), 2.5, 40); x += r; parts += '<circle cx="' + x + '" cy="17" r="' + r.toFixed(1) + '" fill="none" stroke="currentColor" stroke-width="1.2"/><text x="' + x + '" y="' + (17 + r + 11) + '" text-anchor="middle" font-size="10" fill="currentColor">M' + m + '</text>'; x += r + 12; });
    var sz = el('div', { class: 'row' }, [el('span', { text: 'Size:' })]);
    var holder = el('span'); holder.innerHTML = '<svg width="' + Math.ceil(x) + '" height="48" viewBox="0 0 ' + Math.ceil(x) + ' 48" aria-hidden="true">' + parts + '</svg>';
    sz.appendChild(holder); lg.appendChild(sz);
    if (S.layers.faults) {
      var fr = el('div', { class: 'row' }, [el('span', { text: 'Faults:' })]);
      [['Thrust', '0'], ['Strike-slip', '8 5'], ['Normal', '1.5 5']].forEach(function (f) {
        var w = el('span', { class: 'k' }); w.innerHTML = '<svg width="24" height="8" aria-hidden="true"><line x1="1" y1="4" x2="23" y2="4" stroke="var(--fault)" stroke-width="2.2" stroke-linecap="' + (f[0] === 'Normal' ? 'round' : 'butt') + '"' + (f[1] === '0' ? '' : ' stroke-dasharray="' + f[1] + '"') + '/></svg>';
        w.appendChild(document.createTextNode(f[0])); fr.appendChild(w);
      });
      lg.appendChild(fr);
    }
  }
  function renderAttr() {
    var a = $('#attr'); a.textContent = '';
    function link(t, h) { return el('a', { href: h, target: '_blank', rel: 'noopener', text: t }); }
    a.appendChild(document.createTextNode('Earthquakes: ')); a.appendChild(link('USGS', 'https://earthquake.usgs.gov/'));
    a.appendChild(document.createTextNode(' · Faults: ')); a.appendChild(link('GEM, CC BY-SA 4.0', 'https://github.com/GEMScienceTools/gem-global-active-faults'));
    a.appendChild(document.createTextNode(' · Map data: ')); a.appendChild(link('Natural Earth', 'https://www.naturalearthdata.com/'));
    if (CFG.tiles && S.layers.tiles) {
      a.appendChild(document.createTextNode(' · Terrain: ')); a.appendChild(link('OpenTopoMap', 'https://opentopomap.org/'));
      a.appendChild(document.createTextNode(' (CC-BY-SA), © ')); a.appendChild(link('OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright'));
    }
  }

  function resize() {
    var r = shell.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
    if (!w || !h) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === W && h === H && cv.width === w * dpr) return;
    W = w; H = h; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    if (!ready) { ready = true; fitBox(DEF_BOX, 20, true); } else { clampView(); }
    invalidate();
  }
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(shell); else window.addEventListener('resize', resize);

  return {
    invalidate: invalidate, resize: resize, flyTo: flyTo, zoom: function () { return view.z; },
    fitDefault: function () { fitBox(DEF_BOX, 20); },
    fitRegion: function (id) { var r = regionById(id); if (!r || id === 'other') fitBox(DEF_BOX, 20); else fitBox(r.box, 30); },
    setEvents: function () {
      S.draw = S.view.slice().sort(function (a, b) { return b.m - a.m; });
      hovered = null; invalidate();
    },
    refreshTheme: function () { COL = null; invalidate(); },
    renderLegend: renderLegend, renderAttr: renderAttr, hideTip: hideMapTip
  };
})();


/* ================================================================
   Part 3: filters -> views, seismograph, charts, tables, regions,
   inspector, UI wiring.
================================================================ */

var rafPending = false;
function refresh() { if (rafPending) return; rafPending = true; requestAnimationFrame(function () { rafPending = false; applyFilters(); }); }

function applyFilters() {
  S.view = S.all.filter(function (e) { return passes(e); });
  if (S.sel && S.sel.type === 'event' && S.view.indexOf(S.sel.e) < 0) { S.sel = null; hideInspector(); }
  MapView.setEvents();
  renderChips(); renderStats(); renderTop(); renderCharts(); renderRegions();
  var mc = $('#mapCount'); mc.textContent = '';
  mc.appendChild(el('b', { text: nf.format(S.view.length) })); mc.appendChild(document.createTextNode(S.all.length && S.view.length !== S.all.length ? ' of ' + nf.format(S.all.length) + ' events' : ' events'));
  Seis.draw();
}

/* ---------- chips ---------- */
var chipEls = { c: [], d: [] };
function buildChips() {
  var cw = $('#classChips'), dw = $('#depthChips');
  MAG_CLASSES.forEach(function (c, i) {
    var b = el('button', { class: 'chip', type: 'button', 'aria-pressed': 'true', title: 'Magnitude ' + c.range }, [el('i', { style: 'background:var(--m' + (i + 1) + ')' }), c.name, el('small', { text: '0' })]);
    b.addEventListener('click', function () { S.f.classes[i] = !S.f.classes[i]; refresh(); });
    cw.appendChild(b); chipEls.c.push(b);
  });
  DEPTH_CLASSES.forEach(function (c, i) {
    var b = el('button', { class: 'chip', type: 'button', 'aria-pressed': 'true', title: 'Depth ' + c.range }, [el('i', { style: 'background:var(--d' + (i + 1) + ')' }), c.name, el('small', { text: '0' })]);
    b.addEventListener('click', function () { S.f.depths[i] = !S.f.depths[i]; refresh(); });
    dw.appendChild(b); chipEls.d.push(b);
  });
}
function renderChips() {
  var cC = [0, 0, 0, 0, 0], dC = [0, 0, 0];
  S.all.forEach(function (e) { if (passes(e, 'class')) cC[e.mc]++; if (e.dc >= 0 && passes(e, 'depth')) dC[e.dc]++; });
  chipEls.c.forEach(function (b, i) { b.setAttribute('aria-pressed', S.f.classes[i] ? 'true' : 'false'); b.lastChild.textContent = nf.format(cC[i]); });
  chipEls.d.forEach(function (b, i) { b.setAttribute('aria-pressed', S.f.depths[i] ? 'true' : 'false'); b.lastChild.textContent = nf.format(dC[i]); });
}

/* ---------- stats ---------- */
function ago(t) {
  var d = (Date.now() - t) / 864e5;
  if (d < 1) return 'Today';
  if (d < 60) return Math.floor(d) + (Math.floor(d) === 1 ? ' day ago' : ' days ago');
  if (d < 730) return Math.floor(d / 30.44) + ' months ago';
  return Math.floor(d / 365.25) + ' years ago';
}
function fmtKm(v) { return (v < 10 ? String(+v.toFixed(1)) : String(Math.round(v))) + ' km'; }
function renderStats() {
  var v = S.view, n = v.length;
  $('#stCount').textContent = nf.format(n);
  $('#stCountSub').textContent = !S.all.length ? 'No data loaded' : n === S.all.length ? 'All loaded earthquakes' : 'of ' + nf.format(S.all.length) + ' loaded';
  var big = null, last = null, depths = [];
  v.forEach(function (e) { if (!big || e.m > big.m) big = e; if (!last || e.t > last.t) last = e; if (e.d != null) depths.push(e.d); });
  $('#stMax').textContent = big ? 'M ' + big.m.toFixed(1) : '–';
  $('#stMaxSub').textContent = big ? fmtDate(big.t) + ', ' + shortPlace(big.place) : ' ';
  var md = median(depths);
  $('#stDepth').textContent = md == null ? '–' : fmtKm(md);
  $('#stDepthSub').textContent = md == null ? ' ' : 'Half are shallower than this';
  $('#stLatest').textContent = last ? ago(last.t) : '–';
  $('#stLatestSub').textContent = last ? fmtDate(last.t) + ', ' + shortPlace(last.place) : ' ';
  var sr = $('#seisRange');
  sr.textContent = S.all.length ? fmtDate(S.all[0].t) + ' to ' + fmtDate(S.all[S.all.length - 1].t) : '';
}

/* ---------- inspector + selection ---------- */
function hideInspector() { var i = $('#inspector'); i.hidden = true; i.textContent = ''; }
function kv(rows) {
  var dl = el('dl', { class: 'kv' });
  rows.forEach(function (r) { if (r[1] == null) return; dl.appendChild(el('dt', { text: r[0] })); var dd = el('dd'); if (typeof r[1] === 'string') dd.textContent = r[1]; else dd.appendChild(r[1]); dl.appendChild(dd); });
  return dl;
}
function renderInspector() {
  var box = $('#inspector'); box.textContent = '';
  if (!S.sel) { box.hidden = true; return; }
  var close = el('button', { class: 'iconbtn close', type: 'button', 'aria-label': 'Close details' }, ['×']);
  close.addEventListener('click', clearSel);
  box.appendChild(close);
  if (S.sel.type === 'event') {
    var e = S.sel.e, mc = MAG_CLASSES[e.mc], reg = regionById(e.reg);
    box.appendChild(el('div', { class: 'insp-mag' }, [el('span', { class: 'num', text: e.m.toFixed(1) }), el('span', { class: 'cls' }, [el('i', { style: 'background:var(--m' + (e.mc + 1) + ')' }), mc.name + ' earthquake'])]));
    box.appendChild(el('h4', { text: e.place || 'Unnamed location' }));
    box.appendChild(kv([
      ['Date', fmtDateTime(e.t)],
      ['Depth', e.d == null ? 'Not given' : trimNum(e.d) + ' km' + (e.dc >= 0 ? ' (' + DEPTH_CLASSES[e.dc].name.toLowerCase() + ')' : '')],
      ['Epicentre', Math.abs(e.lat).toFixed(3) + '°' + (e.lat >= 0 ? 'N' : 'S') + ', ' + Math.abs(e.lon).toFixed(3) + '°' + (e.lon >= 0 ? 'E' : 'W')],
      ['Magnitude type', e.mt ? e.mt : null],
      ['Region', reg ? reg.name : null],
      ['Event ID', e.id || null],
      ['Record', e.url ? el('a', { href: e.url, target: '_blank', rel: 'noopener', text: 'Open on USGS' }) : null]
    ]));
  } else {
    var f = S.sel.f;
    box.appendChild(el('div', { class: 'insp-mag' }, [el('span', { class: 'cls' }, [el('i', { style: 'background:var(--fault)' }), 'Mapped fault trace'])]));
    box.appendChild(el('h4', { text: f.n || 'Unnamed fault trace' }));
    box.appendChild(kv([
      ['Type', faultTypeName(f.t)],
      ['Slip rate', slipText(f.s)],
      ['Source', 'GEM Global Active Faults Database' + (f.c ? ', ' + f.c : '') + (f.id ? ' (' + f.id + ')' : '')]
    ]));
  }
  box.hidden = false;
}
function selectEvent(e, fly, jump) {
  S.sel = { type: 'event', e: e }; renderInspector(); MapView.invalidate();
  if (fly) MapView.flyTo(e.lon, e.lat, Math.max(MapView.zoom(), 6.6));
  if (jump) $('#explore').scrollIntoView({ behavior: REDUCE ? 'auto' : 'smooth', block: 'start' });
  else if (window.innerWidth <= 1000 && !$('#inspector').hidden) $('#inspector').scrollIntoView({ behavior: REDUCE ? 'auto' : 'smooth', block: 'nearest' });
}
function selectFault(f) { S.sel = { type: 'fault', f: f }; renderInspector(); MapView.invalidate(); }
function clearSel() { S.sel = null; hideInspector(); MapView.invalidate(); }

/* ---------- largest events table ---------- */
function renderTop() {
  var body = $('#topBody'); body.textContent = '';
  var list = S.view.slice().sort(function (a, b) { return b.m - a.m || b.t - a.t; }).slice(0, 12);
  $('#topNote').textContent = S.view.length ? 'Showing ' + list.length + ' of ' + nf.format(S.view.length) : '';
  if (!list.length) {
    body.appendChild(el('tr', null, [el('td', { colspan: '5', class: 'muted', text: S.all.length ? 'No earthquakes match the current filters.' : 'No earthquake data is loaded yet.' })]));
    return;
  }
  list.forEach(function (e) {
    var btn = el('button', { class: 'rowbtn', type: 'button', text: e.place || 'Unnamed location' });
    btn.addEventListener('click', function () { selectEvent(e, true, true); });
    body.appendChild(el('tr', null, [
      el('td', { class: 'num' }, [el('span', { class: 'magcell' }, [el('i', { style: 'background:var(--m' + (e.mc + 1) + ')' }), e.m.toFixed(1)])]),
      el('td', { text: fmtDate(e.t) }),
      el('td', null, [btn]),
      el('td', { class: 'num', text: e.d == null ? '–' : trimNum(e.d) + ' km' }),
      el('td', null, [e.url ? el('a', { href: e.url, target: '_blank', rel: 'noopener', text: 'USGS page' }) : '–'])
    ]));
  });
}

/* ---------- seismograph strip ---------- */
var Seis = (function () {
  var cv = $('#seis'), ctx = cv.getContext('2d');
  var W = 0, H = 0, dpr = 1, prog = 1, animTok = null, hov = null, xs = [];
  var PADL = 16, PADR = 16, AX = 30;
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function sizeUp() {
    var r = cv.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
    if (!w || !h) return false;
    if (w === W && h === H) return true;
    dpr = Math.min(window.devicePixelRatio || 1, 2); W = w; H = h; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); return true;
  }
  function domain() {
    var a, b;
    if (S.all.length) { a = S.all[0].t; b = S.all[S.all.length - 1].t; } else { a = Date.UTC(1900, 0, 1); b = Date.now(); }
    if (b - a < 864e5) { a -= 864e5; b += 864e5; }
    return [a, b];
  }
  function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function ampOf(m) { return Math.pow(Math.max(m - 3.3, 0.3), 2.2); }
  function timeTicks(t0, t1, maxN) {
    var span = (t1 - t0) / (365.25 * 864e5), out = [], i;
    if (span > 3) {
      var steps = [1, 2, 5, 10, 20, 25, 50], st = 50;
      for (i = 0; i < steps.length; i++) if (span / steps[i] <= maxN) { st = steps[i]; break; }
      for (var y = Math.ceil(new Date(t0).getUTCFullYear() / st) * st; Date.UTC(y, 0, 1) <= t1; y += st) out.push({ t: Date.UTC(y, 0, 1), l: String(y) });
      return out;
    }
    var mn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    if (span > 0.25) {
      var sm = [1, 2, 3, 6].filter(function (s) { return span * 12 / s <= maxN; })[0] || 6, d0 = new Date(t0), idx = d0.getUTCFullYear() * 12 + d0.getUTCMonth() + 1;
      for (; ; idx += sm) { var yy = Math.floor(idx / 12), mm = idx % 12, tt = Date.UTC(yy, mm, 1); if (tt > t1) break; out.push({ t: tt, l: mn[mm] + ' ' + String(yy).slice(2) }); }
      return out;
    }
    var days = (t1 - t0) / 864e5, sd = [1, 2, 5, 7, 10, 14].filter(function (s) { return days / s <= maxN; })[0] || 14, start = Math.ceil(t0 / 864e5 / sd) * sd;
    for (var d = start; d * 864e5 <= t1; d += sd) { var dt = new Date(d * 864e5); out.push({ t: d * 864e5, l: dt.getUTCDate() + ' ' + mn[dt.getUTCMonth()] }); }
    return out;
  }
  function xOf(t, dm) { return PADL + (t - dm[0]) / (dm[1] - dm[0]) * (W - PADL - PADR); }

  function draw() {
    if (!sizeUp()) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    var dm = domain(), mid = (H - AX) / 2, halfH = mid - 4, R = 2, N = Math.max(2, Math.floor((W - PADL - PADR) * R));
    var paper = css('--paper'), trace = css('--trace'), muted = css('--muted'), text2 = css('--text-2'), halo = css('--panel');
    var dark = (function () { var m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css('--ground')); return m ? parseInt(m[1], 16) + parseInt(m[2], 16) + parseInt(m[3], 16) < 300 : true; })();

    /* recording paper */
    var ticks = timeTicks(dm[0], dm[1], Math.max(3, Math.floor((W - PADL - PADR) / 80)));
    ctx.lineWidth = 1; ctx.strokeStyle = paper;
    ctx.globalAlpha = dark ? 0.13 : 0.2; ctx.beginPath();
    ticks.forEach(function (tk) { var x = Math.round(xOf(tk.t, dm)) + 0.5; ctx.moveTo(x, 6); ctx.lineTo(x, H - AX); });
    [-0.5, 0.5].forEach(function (k) { var y = Math.round(mid + k * halfH) + 0.5; ctx.moveTo(PADL, y); ctx.lineTo(W - PADR, y); });
    ctx.stroke();
    ctx.globalAlpha = dark ? 0.3 : 0.4; ctx.beginPath(); ctx.moveTo(PADL, Math.round(mid) + 0.5); ctx.lineTo(W - PADR, Math.round(mid) + 0.5); ctx.stroke(); ctx.globalAlpha = 1;
    ctx.font = '11px ' + getComputedStyle(document.body).fontFamily; ctx.fillStyle = text2; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ticks.forEach(function (tk) { var x = xOf(tk.t, dm); ctx.fillText(tk.l, Math.min(W - 18, Math.max(18, x)), H - 10); });

    /* trace */
    var amp = new Float32Array(N), ev = S.view, i, j, e;
    var mAll = 8; if (S.all.length) { mAll = 0; S.all.forEach(function (q) { if (q.m > mAll) mAll = q.m; }); }
    var scale = (halfH - 22) / ampOf(Math.max(mAll, 5));
    xs = [];
    for (i = 0; i < ev.length; i++) {
      e = ev[i]; var pos = (xOf(e.t, dm) - PADL) * R, i0 = Math.round(pos);
      xs.push(xOf(e.t, dm));
      if (i0 < 0 || i0 >= N) continue;
      var A = ampOf(e.m) * scale, sign = (e.m >= 7 || ((e.t / 1000 | 0) % 2)) ? 1 : -1, tau = R * (2.2 + (e.m - 4) * 1.5), L = Math.min(N - i0, Math.ceil(tau * 5));
      for (j = 0; j < L; j++) amp[i0 + j] += sign * A * Math.exp(-j / tau) * Math.cos(j * 0.95);
    }
    var rnd = rng(1729), clipW = (W - PADL - PADR) * prog + PADL;
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, clipW, H - AX + 6); ctx.clip();
    ctx.beginPath(); ctx.lineWidth = 1.25; ctx.lineJoin = 'round'; ctx.strokeStyle = trace;
    var wob = 0;
    for (i = 0; i < N; i++) {
      wob = wob * 0.9 + (rnd() - 0.5) * 0.9;
      var y = mid - clamp(amp[i], -halfH + 4, halfH - 4) - (rnd() - 0.5) * 1.6 - wob * 0.6, x = PADL + i / R;
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke(); ctx.restore();

    /* labels for the largest events */
    if (ev.length && prog >= 1) {
      var big = ev.slice().sort(function (a, b) { return b.m - a.m; }), placed = [], spanY = (dm[1] - dm[0]) / (365.25 * 864e5);
      ctx.textAlign = 'center'; ctx.font = '700 12px ' + getComputedStyle(document.documentElement).getPropertyValue('--display');
      for (i = 0; i < big.length && placed.length < 4; i++) {
        e = big[i]; if (e.m < big[0].m - 1.4) break;
        var x0 = xOf(e.t, dm), ok = true;
        for (j = 0; j < placed.length; j++) if (Math.abs(placed[j] - x0) < 84) ok = false;
        if (!ok) continue;
        placed.push(x0);
        var ty = Math.max(14, mid - ampOf(e.m) * scale - 9), lbl = 'M' + e.m.toFixed(1) + (spanY > 3 ? ' · ' + e.y : ' · ' + fmtDate(e.t).slice(0, -5)), tw = ctx.measureText(lbl).width, tx = clamp(x0, tw / 2 + 6, W - tw / 2 - 6);
        ctx.lineJoin = 'round'; ctx.lineWidth = 4; ctx.strokeStyle = halo; ctx.strokeText(lbl, tx, ty); ctx.fillStyle = css('--text'); ctx.fillText(lbl, tx, ty);
      }
    }
    if (!S.all.length) {
      ctx.textAlign = 'center'; ctx.font = '500 14px ' + getComputedStyle(document.body).fontFamily; ctx.fillStyle = text2;
      ctx.fillText('No earthquakes loaded. The trace stays flat until data arrives.', W / 2, mid - 18);
    }
    if (hov) {
      var hx = xOf(hov.t, dm); ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(hx, 6); ctx.lineTo(hx, H - AX); ctx.stroke();
    }
  }
  function reset(animate) {
    prog = animate && !REDUCE ? 0 : 1; var tok = animTok = {};
    if (prog === 0) {
      var t0 = performance.now(), dur = 1500;
      (function step(now) { if (animTok !== tok) return; var k = clamp((now - t0) / dur, 0, 1); prog = 1 - Math.pow(1 - k, 3); draw(); if (k < 1) requestAnimationFrame(step); })(t0);
    } else draw();
  }
  function nearest(px) {
    var best = null, bd = 9;
    for (var i = 0; i < xs.length; i++) { var d = Math.abs(xs[i] - px); if (d < bd) { bd = d; best = S.view[i]; } }
    return best;
  }
  cv.addEventListener('pointermove', function (e) {
    var r = cv.getBoundingClientRect(), x = e.clientX - r.left, n = nearest(x);
    if (n !== hov) { hov = n; draw(); }
    cv.style.cursor = n ? 'pointer' : '';
    if (n) showTip({ title: n.place || 'Unnamed location', rows: [{ label: 'Magnitude', value: 'M ' + n.m.toFixed(1) }, { label: 'Depth', value: n.d == null ? '–' : trimNum(n.d) + ' km' }, { label: 'Date', value: fmtDate(n.t) }] }, e.clientX, e.clientY);
    else hideTip();
  });
  cv.addEventListener('pointerleave', function () { hov = null; hideTip(); draw(); });
  cv.addEventListener('click', function (e) { var r = cv.getBoundingClientRect(), n = nearest(e.clientX - r.left); if (n) selectEvent(n, true, true); });
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(function () { draw(); }).observe(cv);
  return { draw: draw, reset: reset };
})();

/* ---------- charts ---------- */
function niceScale(max, ticks) {
  if (max <= 0) return { max: 1, step: 1 };
  var raw = max / ticks, p = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), f = raw / p, s = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10, step = s * p;
  return { max: Math.ceil(max / step) * step, step: step };
}
function topRounded(x, y, w, h, r) {
  x = +x; y = +y; w = +w; h = +h;
  r = Math.min(r, h, w / 2);
  return 'M' + x + ' ' + (y + h) + 'V' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) + 'V' + (y + h) + 'Z';
}
function rightRounded(x, y, w, h, r) {
  x = +x; y = +y; w = +w; h = +h;
  r = Math.min(r, w, h / 2);
  return 'M' + x + ' ' + y + 'H' + (x + w - r) + 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + r) + 'V' + (y + h - r) + 'Q' + (x + w) + ' ' + (y + h) + ' ' + (x + w - r) + ' ' + (y + h) + 'H' + x + 'Z';
}
var CH = { time: null, mag: null, depth: null };
var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function buildTimeBins() {
  if (!S.all.length) return null;
  var t0 = S.all[0].t, t1 = S.all[S.all.length - 1].t, years = (t1 - t0) / (365.25 * 864e5), bins = [], idxOf, i;
  var y0 = new Date(t0).getUTCFullYear(), y1 = new Date(t1).getUTCFullYear();
  if (years > 3) {
    var sy = years > 100 ? 10 : years > 50 ? 5 : years > 30 ? 2 : 1, start = Math.floor(y0 / sy) * sy;
    for (var y = start; y <= y1; y += sy) bins.push({ tick: String(y), label: sy === 1 ? String(y) : y + ' to ' + (y + sy - 1) });
    idxOf = function (e) { return Math.floor((e.y - start) / sy); };
  } else if (years > 0.12) {
    var d0 = new Date(t0), s0 = d0.getUTCFullYear() * 12 + d0.getUTCMonth(), s1 = y1 * 12 + new Date(t1).getUTCMonth(), sm = (s1 - s0) > 30 ? 3 : 1;
    for (i = s0; i <= s1; i += sm) { var yy = Math.floor(i / 12), mm = i % 12; bins.push({ tick: MON[mm] + (mm === 0 || !bins.length ? ' ' + String(yy).slice(2) : ''), label: MON[mm] + ' ' + yy + (sm > 1 ? ' and the next ' + (sm - 1) + ' months' : '') }); }
    idxOf = function (e) { return Math.floor((e.y * 12 + new Date(e.t).getUTCMonth() - s0) / sm); };
  } else {
    var sd = 1, base = Math.floor(t0 / 864e5), n = Math.floor(t1 / 864e5) - base + 1;
    for (i = 0; i < n; i++) { var dt = new Date((base + i) * 864e5); bins.push({ tick: dt.getUTCDate() + ' ' + MON[dt.getUTCMonth()], label: dt.getUTCDate() + ' ' + MON[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear() }); }
    idxOf = function (e) { return Math.floor(e.t / 864e5) - base; };
  }
  bins.forEach(function (b) { b.c = [0, 0, 0, 0, 0]; b.n = 0; });
  return { bins: bins, idxOf: idxOf };
}

function svgOpen(W, H, label) { return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + label + '">'; }

function renderTimeChart() {
  var host = $('#chartTime'), W = Math.max(280, host.clientWidth || 600), H = 250, m = { l: 40, r: 8, t: 12, b: 30 };
  var tb = buildTimeBins();
  if (!tb) { host.innerHTML = ''; CH.time = null; $('#noteTime').textContent = 'No earthquake data is loaded yet.'; $('#tvTimeHead').textContent = ''; $('#tvTimeBody').textContent = ''; return; }
  var bins = tb.bins;
  S.view.forEach(function (e) { var i = tb.idxOf(e); if (i >= 0 && i < bins.length) { bins[i].c[e.mc]++; bins[i].n++; } });
  CH.time = bins;
  var maxN = 0, peak = 0; bins.forEach(function (b, i) { if (b.n > maxN) { maxN = b.n; peak = i; } });
  var sc = niceScale(Math.max(maxN, 1), 4), pw = W - m.l - m.r, ph = H - m.t - m.b, band = pw / bins.length, bw = Math.min(24, band * 0.7), base = H - m.b;
  function yv(v) { return base - v / sc.max * ph; }
  var s = svgOpen(W, H, 'Stacked bars of earthquakes over time, by magnitude class');
  for (var v = 0; v <= sc.max + 1e-9; v += sc.step) s += '<line class="' + (v === 0 ? 'axis' : 'grid') + '" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + yv(v) + '" y2="' + yv(v) + '"/><text x="' + (m.l - 6) + '" y="' + (yv(v) + 4) + '" text-anchor="end">' + nf.format(v) + '</text>';
  var every = Math.max(1, Math.ceil(46 / band));
  bins.forEach(function (b, i) {
    var cx = m.l + band * i + band / 2, x = cx - bw / 2, y = base, top = -1, c;
    for (c = 4; c >= 0; c--) if (b.c[c] > 0) { top = c; break; }
    for (c = 0; c < 5; c++) {
      if (!b.c[c]) continue;
      var h = b.c[c] / sc.max * ph, yt = y - h, gap = h > 4 ? 2 : 0;
      if (c === top) s += '<path class="c' + c + '" d="' + topRounded(x.toFixed(1), (yt + gap / 2).toFixed(1), bw.toFixed(1), (h - gap / 2).toFixed(1), 4) + '"/>';
      else s += '<rect class="c' + c + '" x="' + x.toFixed(1) + '" y="' + (yt + gap / 2).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(h - gap, 1).toFixed(1) + '"/>';
      y = yt;
    }
    if (i % every === 0 || i === bins.length - 1 && (bins.length - 1) % every === 0) s += '<text x="' + cx.toFixed(1) + '" y="' + (H - 10) + '" text-anchor="middle">' + b.tick + '</text>';
    if (i === peak && maxN > 0) s += '<text class="val" x="' + cx.toFixed(1) + '" y="' + (y - 5).toFixed(1) + '" text-anchor="middle">' + b.n + '</text>';
    s += '<rect class="hit" data-i="' + i + '" tabindex="0" x="' + (m.l + band * i).toFixed(1) + '" y="' + m.t + '" width="' + band.toFixed(1) + '" height="' + ph + '" aria-label="' + b.label + ': ' + b.n + ' earthquakes"/>';
  });
  host.innerHTML = s + '</svg>';
  var pk = bins[peak];
  $('#noteTime').innerHTML = '';
  if (maxN > 0) { var nt = $('#noteTime'); nt.appendChild(document.createTextNode('The busiest period in this selection is ')); nt.appendChild(el('b', { text: pk.label })); nt.appendChild(document.createTextNode(' with ' + nf.format(pk.n) + ' earthquakes.' + (bins.length > 8 && S.all.length && S.all[0].y < 1970 ? ' Older periods show fewer events partly because fewer were recorded.' : ''))); }
  else $('#noteTime').textContent = 'No earthquakes match the current filters.';
  var hd = $('#tvTimeHead'); hd.textContent = '';
  hd.appendChild(el('tr', null, [el('th', { text: 'Period' })].concat(MAG_CLASSES.map(function (c) { return el('th', { class: 'num', text: c.name }); }), [el('th', { class: 'num', text: 'Total' })])));
  var bd = $('#tvTimeBody'); bd.textContent = '';
  bins.forEach(function (b) { bd.appendChild(el('tr', null, [el('td', { text: b.label })].concat(b.c.map(function (n) { return el('td', { class: 'num', text: String(n) }); }), [el('td', { class: 'num', text: String(b.n) })]))); });
}

function renderMagChart() {
  var host = $('#chartMag'), W = Math.max(260, host.clientWidth || 400), H = 230, m = { l: 36, r: 8, t: 12, b: 28 }, v = S.view;
  var tb = $('#tvMagBody'); tb.textContent = '';
  if (!v.length) { host.innerHTML = ''; CH.mag = null; $('#noteMag').textContent = S.all.length ? 'No earthquakes match the current filters.' : 'No earthquake data is loaded yet.'; return; }
  var mn = Infinity, mx = -Infinity, big = null; v.forEach(function (e) { if (e.m < mn) mn = e.m; if (e.m > mx) mx = e.m; if (!big || e.m > big.m) big = e; });
  var lo = Math.floor(mn * 2) / 2, hi = Math.max(Math.ceil((mx + 1e-6) * 2) / 2, lo + 0.5), nb = Math.round((hi - lo) / 0.5), bins = [], i;
  for (i = 0; i < nb; i++) bins.push({ lo: lo + i * 0.5, n: 0 });
  v.forEach(function (e) { var k = Math.min(nb - 1, Math.floor((e.m - lo) / 0.5 + 1e-9)); bins[k].n++; });
  CH.mag = bins;
  var maxN = 0, peak = 0; bins.forEach(function (b, k) { if (b.n > maxN) { maxN = b.n; peak = k; } });
  var sc = niceScale(maxN, 4), pw = W - m.l - m.r, ph = H - m.t - m.b, band = pw / nb, bw = Math.min(24, band * 0.7), base = H - m.b;
  function yv(val) { return base - val / sc.max * ph; }
  var s = svgOpen(W, H, 'Bar chart of earthquakes by magnitude');
  for (var g = 0; g <= sc.max + 1e-9; g += sc.step) s += '<line class="' + (g === 0 ? 'axis' : 'grid') + '" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + yv(g) + '" y2="' + yv(g) + '"/><text x="' + (m.l - 6) + '" y="' + (yv(g) + 4) + '" text-anchor="end">' + nf.format(g) + '</text>';
  var every = Math.max(1, Math.ceil(34 / band));
  bins.forEach(function (b, k) {
    var cx = m.l + band * k + band / 2, h = b.n / sc.max * ph;
    if (b.n > 0) s += '<path class="c' + magClass(b.lo + 0.01) + '" d="' + topRounded((cx - bw / 2).toFixed(1), (base - h).toFixed(1), bw.toFixed(1), h.toFixed(1), 4) + '"/>';
    if (k % every === 0) s += '<text x="' + cx.toFixed(1) + '" y="' + (H - 9) + '" text-anchor="middle">' + b.lo.toFixed(1) + '</text>';
    if (k === peak && b.n > 0) s += '<text class="val" x="' + cx.toFixed(1) + '" y="' + (base - h - 5).toFixed(1) + '" text-anchor="middle">' + b.n + '</text>';
    s += '<rect class="hit" data-i="' + k + '" tabindex="0" x="' + (m.l + band * k).toFixed(1) + '" y="' + m.t + '" width="' + band.toFixed(1) + '" height="' + ph + '" aria-label="Magnitude ' + b.lo.toFixed(1) + ' to ' + (b.lo + 0.49).toFixed(1) + ': ' + b.n + ' earthquakes"/>';
    tb.appendChild(el('tr', null, [el('td', { text: b.lo.toFixed(1) + ' to ' + (b.lo + 0.4).toFixed(1) }), el('td', { class: 'num', text: String(b.n) })]));
  });
  host.innerHTML = s + '</svg>';
  var nt = $('#noteMag'); nt.textContent = '';
  nt.appendChild(document.createTextNode('The largest earthquake here is ')); nt.appendChild(el('b', { text: 'M ' + big.m.toFixed(1) })); nt.appendChild(document.createTextNode(' (' + fmtDate(big.t) + ', ' + shortPlace(big.place) + '). Each step up in magnitude has fewer events than the one before it.'));
}

function renderDepthChart() {
  var host = $('#chartDepth'), W = Math.max(260, host.clientWidth || 400), v = S.view.filter(function (e) { return e.d != null; });
  var tb = $('#tvDepthBody'); tb.textContent = '';
  var nt = $('#noteDepth'); nt.textContent = '';
  if (!v.length) { host.innerHTML = ''; CH.depth = null; nt.textContent = S.all.length ? 'No depth values for the current selection.' : 'No earthquake data is loaded yet.'; return; }
  var maxD = 0; v.forEach(function (e) { if (e.d > maxD) maxD = e.d; });
  var rows = maxD >= 100 ? 11 : Math.max(3, Math.floor(maxD / 10) + 1), bins = [], i;
  for (i = 0; i < rows; i++) bins.push({ lo: i * 10, hi: i === 10 ? Infinity : i * 10 + 10, n: 0 });
  v.forEach(function (e) { bins[Math.min(rows - 1, Math.floor(Math.max(e.d, 0) / 10), 10)].n++; });
  CH.depth = bins;
  var maxN = 0; bins.forEach(function (b) { if (b.n > maxN) maxN = b.n; });
  var m = { l: 70, r: 44, t: 6, b: 24 }, rh = 24, bh = 16, H = m.t + rows * rh + m.b, sc = niceScale(maxN, 3), pw = W - m.l - m.r;
  function xv(val) { return m.l + val / sc.max * pw; }
  var s = svgOpen(W, H, 'Bar chart of earthquakes by depth, shallowest at the top');
  for (var g = 0; g <= sc.max + 1e-9; g += sc.step) s += '<line class="' + (g === 0 ? 'axis' : 'grid') + '" x1="' + xv(g) + '" x2="' + xv(g) + '" y1="' + m.t + '" y2="' + (H - m.b) + '"/><text x="' + xv(g) + '" y="' + (H - 7) + '" text-anchor="middle">' + nf.format(g) + '</text>';
  bins.forEach(function (b, k) {
    var y = m.t + k * rh, w = b.n / sc.max * pw, lab = b.hi === Infinity ? '100+ km' : b.lo + ' to ' + b.hi + ' km', cls = b.lo < 70 ? 0 : 1;
    s += '<text x="' + (m.l - 8) + '" y="' + (y + rh / 2 + 4) + '" text-anchor="end">' + lab + '</text>';
    if (b.n > 0) { s += '<path class="dd' + cls + '" d="' + rightRounded(m.l, (y + (rh - bh) / 2).toFixed(1), Math.max(w, 2).toFixed(1), bh, 4) + '"/><text class="val" x="' + (m.l + Math.max(w, 2) + 6).toFixed(1) + '" y="' + (y + rh / 2 + 4) + '">' + nf.format(b.n) + '</text>'; }
    s += '<rect class="hit" data-i="' + k + '" tabindex="0" x="0" y="' + y + '" width="' + W + '" height="' + rh + '" aria-label="' + lab + ': ' + b.n + ' earthquakes"/>';
    tb.appendChild(el('tr', null, [el('td', { text: lab }), el('td', { class: 'num', text: String(b.n) })]));
  });
  host.innerHTML = s + '</svg>';
  var md = median(v.map(function (e) { return e.d; })), sh = v.filter(function (e) { return e.d < 35; }).length, nod = S.view.length - v.length;
  nt.appendChild(document.createTextNode('Half of these earthquakes are shallower than ')); nt.appendChild(el('b', { text: fmtKm(md) }));
  nt.appendChild(document.createTextNode('. ' + Math.round(sh / v.length * 100) + '% (' + nf.format(sh) + ') are shallower than 35 km.' + (nod ? ' ' + nod + ' have no depth recorded.' : '')));
}

function renderCharts() {
  var k = $('#keyTime'); if (!k.firstChild) MAG_CLASSES.forEach(function (c, i) { k.appendChild(el('span', null, [el('i', { style: 'background:var(--m' + (i + 1) + ')' }), c.name + ' (M ' + c.range + ')'])); });
  renderTimeChart(); renderMagChart(); renderDepthChart();
}
function attachTip(host, getTip) {
  host.addEventListener('pointermove', function (e) { var t = e.target.closest ? e.target.closest('[data-i]') : null; if (!t) { hideTip(); return; } var c = getTip(+t.getAttribute('data-i')); if (c) showTip(c, e.clientX, e.clientY); });
  host.addEventListener('pointerleave', hideTip);
  host.addEventListener('focusin', function (e) { var t = e.target.closest ? e.target.closest('[data-i]') : null; if (!t) return; var r = t.getBoundingClientRect(), c = getTip(+t.getAttribute('data-i')); if (c) showTip(c, r.left + r.width / 2, r.top); });
  host.addEventListener('focusout', hideTip);
}
function initChartTips() {
  attachTip($('#chartTime'), function (i) {
    var b = CH.time && CH.time[i]; if (!b) return null;
    var rows = [];
    for (var c = 4; c >= 0; c--) if (b.c[c]) rows.push({ key: 'var(--m' + (c + 1) + ')', label: MAG_CLASSES[c].name, value: nf.format(b.c[c]) });
    rows.push({ label: 'All', value: nf.format(b.n) });
    return { title: b.label, rows: rows };
  });
  attachTip($('#chartMag'), function (i) { var b = CH.mag && CH.mag[i]; return b ? { title: 'Magnitude ' + b.lo.toFixed(1) + ' to ' + (b.lo + 0.4).toFixed(1), rows: [{ key: 'var(--m' + (magClass(b.lo + 0.01) + 1) + ')', label: 'Earthquakes', value: nf.format(b.n) }] } : null; });
  attachTip($('#chartDepth'), function (i) { var b = CH.depth && CH.depth[i]; return b ? { title: b.hi === Infinity ? 'Depth 100 km and more' : 'Depth ' + b.lo + ' to ' + b.hi + ' km', rows: [{ key: 'var(--d' + (b.lo < 70 ? 1 : 2) + ')', label: 'Earthquakes', value: nf.format(b.n) }] } : null; });
}

/* ---------- regions ---------- */
function renderRegions() {
  var host = $('#regionGrid'); host.textContent = '';
  var data = REGIONS.map(function (r) {
    var evs = S.all.filter(function (e) { return e.reg === r.id && passes(e, 'region'); }), big = null;
    evs.forEach(function (e) { if (!big || e.m > big.m) big = e; });
    return { r: r, n: evs.length, big: big };
  });
  var max = Math.max.apply(null, data.map(function (d) { return d.n; }).concat([1]));
  data.forEach(function (d) {
    if (d.r.id === 'other' && d.n === 0) return;
    var b = el('button', { class: 'rcard', type: 'button', 'aria-pressed': S.f.region === d.r.id ? 'true' : 'false' }, [
      el('h3', { text: d.r.name }), el('p', { class: 'sub', text: d.r.sub }),
      el('div', { class: 'n' }, [nf.format(d.n), el('small', { text: 'earthquakes' })]),
      el('div', { class: 'big', text: d.big ? 'Largest: M ' + d.big.m.toFixed(1) + ', ' + d.big.y + ', ' + shortPlace(d.big.place) : (S.all.length ? 'None in the current filters' : 'No data loaded') }),
      el('div', { class: 'bar' }, [el('i', { style: 'width:' + (d.n / max * 100).toFixed(1) + '%' })])
    ]);
    b.addEventListener('click', function () {
      var nextId = S.f.region === d.r.id ? 'all' : d.r.id;
      S.f.region = nextId; $('#region').value = nextId; MapView.fitRegion(nextId === 'all' ? null : nextId); refresh();
      $('#explore').scrollIntoView({ behavior: REDUCE ? 'auto' : 'smooth', block: 'start' });
    });
    host.appendChild(b);
  });
}

/* ---------- fault zones + queries ---------- */
function renderZones() {
  var body = $('#zoneBody'); body.textContent = '';
  var kindLab = { net: 'net', shortening: 'shortening', 'strike-slip': 'strike-slip', 'dip-slip': 'dip-slip' };
  GEO.zones.slice(0, 18).forEach(function (z) {
    var rate = z.lo == null ? '–' : (z.lo === z.hi ? trimNum(z.lo) : trimNum(z.lo) + ' to ' + trimNum(z.hi)) + (z.k ? ' (' + (kindLab[z.k] || z.k) + ')' : '');
    body.appendChild(el('tr', null, [el('td', { text: z.n }), el('td', { text: faultTypeName(z.t) }), el('td', { class: 'num', text: String(z.segs) }), el('td', { text: rate })]));
  });
}
function copyText(text, btn) {
  var done = function (ok) { var old = btn.textContent; btn.textContent = ok ? 'Copied' : 'Press Ctrl+C'; setTimeout(function () { btn.textContent = old; }, 1600); };
  try { navigator.clipboard.writeText(text).then(function () { done(true); }, function () { selectCode(btn); done(false); }); } catch (e) { selectCode(btn); done(false); }
}
function selectCode(btn) { var c = btn.closest('.codebox').querySelector('code'), r = document.createRange(); r.selectNodeContents(c); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
function renderQueries() {
  var host = $('#queryList'); host.textContent = '';
  PRESETS.forEach(function (p) {
    var url = queryUrl(p, 'geojson'), copy = el('button', { class: 'btn small', type: 'button', text: 'Copy' });
    copy.addEventListener('click', function () { copyText(url, copy); });
    host.appendChild(el('div', { class: 'codebox' }, [
      el('div', { class: 'lbl' }, [el('span', { text: p.label + ', ' + p.sub }), el('span', { style: 'display:flex;gap:8px;align-items:center' }, [el('a', { href: queryUrl(p, 'csv'), target: '_blank', rel: 'noopener', text: 'CSV' }), copy])]),
      el('code', { text: url })
    ]));
  });
}

/* ---------- init ---------- */
function resetFilters() {
  var f = S.f; f.q = ''; $('#q').value = ''; f.classes = [true, true, true, true, true]; f.depths = [true, true, true]; f.region = 'all'; $('#region').value = 'all';
  var sl = $('#minMag'); sl.value = sl.min; f.minMag = parseFloat(sl.min) || 0; $('#minMagOut').textContent = 'M ' + f.minMag.toFixed(1) + '+';
  $('#yFrom').value = $('#yFrom').min; $('#yTo').value = $('#yTo').max; f.y0 = +$('#yFrom').min; f.y1 = +$('#yTo').max; updateYearOut();
  MapView.fitDefault(); refresh();
}
function updateYearOut() { $('#yearOut').textContent = $('#yFrom').value + ' to ' + $('#yTo').value; }

function init() {
  var pr = $('#presets');
  PRESETS.forEach(function (p) { pr.appendChild(el('label', null, [el('input', { type: 'radio', name: 'preset', value: p.id }), el('span', null, [p.label, el('small', { text: p.sub })])])); });
  pr.appendChild(el('label', null, [el('input', { type: 'radio', name: 'preset', value: 'file', id: 'presetFile', disabled: '' }), el('span', null, [el('span', { id: 'presetFileText', text: 'Your file' })])]));
  pr.addEventListener('change', function (e) { if (e.target.value && e.target.value !== 'file') selectPreset(e.target.value); });

  buildChips();
  var rs = $('#region'); rs.appendChild(el('option', { value: 'all', text: 'All regions' }));
  REGIONS.forEach(function (r) { rs.appendChild(el('option', { value: r.id, text: r.name })); });
  rs.addEventListener('change', function () { S.f.region = rs.value; MapView.fitRegion(rs.value === 'all' ? null : rs.value); refresh(); });

  var qT = 0;
  $('#q').addEventListener('input', function (e) { clearTimeout(qT); qT = setTimeout(function () { S.f.q = e.target.value.toLowerCase().trim(); refresh(); }, 120); });
  $('#minMag').addEventListener('input', function (e) { S.f.minMag = parseFloat(e.target.value); $('#minMagOut').textContent = 'M ' + S.f.minMag.toFixed(1) + '+'; refresh(); });
  ['yFrom', 'yTo'].forEach(function (id) {
    $('#' + id).addEventListener('input', function () {
      var a = $('#yFrom'), b = $('#yTo');
      if (+a.value > +b.value) { if (id === 'yFrom') b.value = a.value; else a.value = b.value; }
      S.f.y0 = +a.value; S.f.y1 = +b.value; updateYearOut(); refresh();
    });
  });
  $$('input[name="colorBy"]').forEach(function (r) { r.addEventListener('change', function () { if (r.checked) { S.colorBy = r.value; MapView.renderLegend(); MapView.invalidate(); } }); });
  var lm = { lyFaults: 'faults', lyWater: 'water', lyRanges: 'ranges', lyPeaks: 'peaks', lyCities: 'cities', lyGrid: 'grid', lyTiles: 'tiles' };
  Object.keys(lm).forEach(function (id) { $('#' + id).addEventListener('change', function (e) { S.layers[lm[id]] = e.target.checked; MapView.renderLegend(); MapView.renderAttr(); MapView.invalidate(); }); });
  if (CFG.tiles) $('#tilesRow').hidden = false;
  $('#btnReset').addEventListener('click', resetFilters);

  var fi = $('#fileInput');
  ['btnFile', 'btnHeroFile', 'btnEmptyFile'].forEach(function (id) { $('#' + id).addEventListener('click', function () { fi.click(); }); });
  fi.addEventListener('change', function () { if (fi.files && fi.files[0]) loadFile(fi.files[0]); fi.value = ''; });
  var shell = $('#shell');
  shell.addEventListener('dragover', function (e) { e.preventDefault(); });
  shell.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) loadFile(f); });
  $('#btnRetry').addEventListener('click', function () { selectPreset(S.preset && S.preset !== 'file' ? S.preset : 'since1900'); });
  var pb = $('#btnPrint'); if (pb) pb.addEventListener('click', function () { window.print(); });
  if (CFG.author) $('#byline').textContent = ' Developed by ' + CFG.author + '.';

  function themeChanged() { MapView.refreshTheme(); Seis.draw(); }
  if (window.matchMedia) { var mq = window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', themeChanged); }
  new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (typeof ResizeObserver !== 'undefined') { var ct = 0; new ResizeObserver(function () { cancelAnimationFrame(ct); ct = requestAnimationFrame(renderCharts); }).observe($('.charts')); }

  initChartTips(); renderZones(); renderQueries(); MapView.renderLegend(); MapView.renderAttr();
  $('#minMagOut').textContent = 'M 0.0+'; updateYearOut();
  selectPreset('since1900');
}
init();
})();
