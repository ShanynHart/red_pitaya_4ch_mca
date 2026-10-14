'use strict';
const $ = id => document.getElementById(id);
const colors = ['#087e86', '#d47b35', '#7961b5', '#bd4c70'];
const selected = new Set([1, 2, 3, 4]);
const number = value => Number(value).toLocaleString(undefined, {maximumFractionDigits: 1});
let state = null;
let channelKey = '';
let view = null;      // [low, high] in V·µs, or null for the full range
// Integrals arrive in nominal V·µs. By default they are shown as ADC counts x samples:
// 8192 counts per volt and 0.008 µs per sample give 1,024,000 per V·µs.
const UNITS = {adc: {scale: 1024000, name: 'ADC counts × samples'}, vus: {scale: 1, name: 'nominal V·µs'}, kev: {name: 'keV'}};
let unit = UNITS.adc;
// Energy calibration: points per channel {x (V·µs), energy (keV)} and a polynomial in X = ADC counts × samples.
const calibration = {order: 1, points: {}};
try { Object.assign(calibration, JSON.parse(localStorage.getItem('mca-calibration-v1') || '{}')); } catch { /* storage unavailable */ }
let calibrated = {};  // channel -> {coefficients, order, rms}
// The keV axis follows the first selected input that has a calibration.
const axisCalibration = () => state && state.channels.filter(row => selected.has(row.channel)).map(row => calibrated[row.channel]).find(Boolean);
const polynomial = (coefficients, x) => coefficients.reduce((sum, a, k) => sum + a * (x * 1024000) ** k, 0);
function toDisplay(x) {
  if (unit === UNITS.kev) { const cal = axisCalibration(); if (cal) return polynomial(cal.coefficients, x); }
  return x * (unit.scale || 1024000);
}
function fromDisplay(value, low, high) {
  if (unit === UNITS.kev && axisCalibration()) {
    // Bisection; the calibration is checked to be increasing over the plotted range.
    for (let i = 0; i < 60; i++) { const mid = (low + high) / 2; if (toDisplay(mid) < value) low = mid; else high = mid; }
    return (low + high) / 2;
  }
  return value / (unit.scale || 1024000);
}
const unitName = () => unit === UNITS.kev && !axisCalibration() ? UNITS.adc.name : unit.name;
// Tick marks at round values of the displayed unit across [low, high] (V·µs).
function axisTicks(low, high) {
  const a = toDisplay(low), b = toDisplay(high), raw = (b - a) / 5;
  if (!(raw > 0)) return [];
  const magnitude = 10 ** Math.floor(Math.log10(raw)), n = raw / magnitude;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * magnitude, digits = Math.max(0, -Math.floor(Math.log10(step)));
  const marks = [];
  for (let v = Math.ceil(a / step) * step; v <= b + step * 1e-9; v += step) {
    if (Math.abs(v) < step * 1e-9) v = 0;  // avoid a '-0' label
    marks.push({x: fromDisplay(v, low, high), label: v.toLocaleString(undefined, {minimumFractionDigits: digits, maximumFractionDigits: digits})});
  }
  return marks;
}
const readout = value => { const shown = toDisplay(value); return shown.toLocaleString(undefined, {maximumFractionDigits: unit === UNITS.kev && axisCalibration() ? 1 : Math.max(0, 4 - Math.floor(Math.log10(Math.max(1e-9, Math.abs(shown)))))}); };
const readoutWidth = (centre, width) => { const shown = toDisplay(centre + width / 2) - toDisplay(centre - width / 2); return shown.toLocaleString(undefined, {maximumFractionDigits: Math.max(0, 3 - Math.floor(Math.log10(Math.max(1e-9, Math.abs(shown)))))}); };
let geometry = null;  // last drawn spectrum axis, for mouse mapping
let drag = null;
let region = null;    // [low, high] peak region for gain tracking
let picking = false;
let gain = null;
let shape = null, shapeRange = [0, 1.1], shapeDrag = null, shapeGeometry = null;
let gate = null;      // pulse-shape gate {x: [low, high] V·µs, y: [low, high] ratio}
let fits = {};       // Gaussian + line fits in the peak region, by channel

// Axis titles: below the tick labels, and rotated beside the left (and optional right) scale.
function axisTitles(ctx, pad, w, h, bottom, left, right) {
  ctx.save(); ctx.fillStyle = '#172c3a'; ctx.font = '12px -apple-system, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(bottom, pad.left + w / 2, pad.top + h + 42);
  ctx.save(); ctx.translate(14, pad.top + h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(left, 0, 0); ctx.restore();
  if (right) { ctx.translate(pad.left + w + pad.right - 10, pad.top + h / 2); ctx.rotate(Math.PI / 2); ctx.fillText(right, 0, 0); }
  ctx.restore();
}

function chart(canvas, xmax, ymax, xlabel, logarithmic = false, xmin = 0, marks = null) {
  const box = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * ratio);
  canvas.height = Math.round(box.height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const pad = {left: 76, right: 16, top: 16, bottom: 52};
  const w = box.width - pad.left - pad.right, h = box.height - pad.top - pad.bottom;
  const scale = value => logarithmic ? Math.log10(1 + value) : value;
  const top = Math.max(1, scale(ymax));
  const x = value => pad.left + (value - xmin) / (xmax - xmin) * w;
  const y = value => pad.top + h - scale(value) / top * h;
  ctx.font = '11px -apple-system, sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const sy = pad.top + h * (1 - i / 4);
    ctx.strokeStyle = '#e9eff0'; ctx.beginPath(); ctx.moveTo(pad.left, sy); ctx.lineTo(pad.left + w, sy); ctx.stroke();
    const value = logarithmic ? Math.pow(10, top * i / 4) - 1 : top * i / 4;
    ctx.fillStyle = '#627580'; ctx.textAlign = 'right'; ctx.fillText(number(value), pad.left - 10, sy + 4);
  }
  for (const mark of marks || Array.from({length: 6}, (_, i) => ({x: xmin + (xmax - xmin) * i / 5, label: xlabel(xmin + (xmax - xmin) * i / 5)}))) {
    const px = x(mark.x);
    ctx.textAlign = px > pad.left + w - 20 ? 'right' : 'center'; ctx.fillText(mark.label, px, pad.top + h + 21);
  }
  if (canvas.id === 'spectrum') axisTitles(ctx, pad, w, h, unit === UNITS.kev && axisCalibration() ? 'Energy (keV)' : `Long-gate integral (${unitName()})`, logarithmic ? 'Counts per bin (log scale)' : 'Counts per bin');
  else axisTitles(ctx, pad, w, h, 'Time before latest batch (s)', 'Accepted counts per second');
  return {ctx, x, y, pad, w, h, xmin, xmax};
}

// The zoomable range ends where pulses clip at the ADC limit (estimated per channel by the receiver).
function axisLimit() {
  const limits = state.channels.filter(row => selected.has(row.channel) && row.full_scale).map(row => row.full_scale);
  return limits.length ? Math.min(state.histogram_max, Math.max(...limits) * 1.08) : state.histogram_max;
}

function draw() {
  if (!state) return;
  const rows = state.channels.filter(row => selected.has(row.channel));
  const full = state.histogram_max, bins = state.histogram_bins, width = full / bins;
  const lo = view ? view[0] : 0, hi = view ? view[1] : axisLimit();
  const first = Math.max(0, Math.floor(lo / width)), last = Math.min(bins, Math.ceil(hi / width));
  // Merge bins so that a drawn step is never narrower than about two pixels.
  const pixels = Math.max(50, $('spectrum').getBoundingClientRect().width - 92);
  const group = Math.max(1, Math.ceil((last - first) / (pixels / 2)));
  const merged = rows.map(row => {
    const sums = [];
    for (let i = first; i < last; i += group) {
      let total = 0;
      for (let j = i; j < Math.min(i + group, last); j++) total += row.histogram[j];
      sums.push(total);
    }
    return sums;
  });
  const maxCount = Math.max(1, ...merged.flat());
  const spectrum = chart($('spectrum'), hi, maxCount * 1.1, null, $('log-scale').checked, lo, axisTicks(lo, hi));
  geometry = {left: spectrum.pad.left, width: spectrum.w, lo, hi, first, group, binWidth: width, merged, rows};
  rows.forEach((row, n) => {
    const {ctx, x, y} = spectrum;
    ctx.save(); ctx.beginPath(); ctx.rect(spectrum.pad.left, 0, spectrum.w, spectrum.pad.top + spectrum.h + 1); ctx.clip();
    ctx.strokeStyle = colors[row.channel - 1]; ctx.lineWidth = 1.7; ctx.beginPath();
    merged[n].forEach((count, i) => {
      const left = x((first + i * group) * width), right = x((first + (i + 1) * group) * width);
      if (!i) ctx.moveTo(left, y(0));
      ctx.lineTo(left, y(count)); ctx.lineTo(right, y(count));
    });
    ctx.stroke(); ctx.restore();
  });
  if (region) {
    const {ctx, x} = spectrum, a = Math.max(spectrum.pad.left, x(region[0])), b = Math.min(spectrum.pad.left + spectrum.w, x(region[1]));
    if (b > a) { ctx.fillStyle = 'rgba(212,123,53,.16)'; ctx.fillRect(a, spectrum.pad.top, b - a, spectrum.h); ctx.strokeStyle = '#d47b35'; ctx.lineWidth = 1; ctx.strokeRect(a, spectrum.pad.top, b - a, spectrum.h); }
  }
  for (const row of rows) {
    // Mark where this channel's pulses start to clip.
    if (!row.full_scale || row.full_scale < lo || row.full_scale > hi) continue;
    const {ctx, x} = spectrum, px = x(row.full_scale);
    ctx.save(); ctx.strokeStyle = '#bd4c70'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(px, spectrum.pad.top); ctx.lineTo(px, spectrum.pad.top + spectrum.h); ctx.stroke();
    ctx.fillStyle = '#bd4c70'; ctx.textAlign = 'right'; ctx.fillText(`IN${row.channel} ADC full scale`, px - 6, spectrum.pad.top + 12); ctx.restore();
  }
  rows.forEach((row, n) => {
    const fit = fits[row.channel];
    if (!fit) return;
    const {ctx, x, y} = spectrum, bins = geometry.group;
    ctx.save(); ctx.beginPath(); ctx.rect(spectrum.pad.left, 0, spectrum.w, spectrum.pad.top + spectrum.h + 1); ctx.clip();
    for (const [part, style] of [[fit.total, []], [fit.background, [2, 3]]]) {
      ctx.strokeStyle = '#172c3a'; ctx.lineWidth = 1.4; ctx.setLineDash(style); ctx.beginPath();
      for (let i = 0; i <= 200; i++) {
        const value = region[0] + (region[1] - region[0]) * i / 200, py = y(part(value) * bins);
        if (i) ctx.lineTo(x(value), py); else ctx.moveTo(x(value), py);
      }
      ctx.stroke();
    }
    ctx.restore();
  });
  if (drag && !drag.pan) {
    const {ctx} = spectrum, a = Math.min(drag.start, drag.now), b = Math.max(drag.start, drag.now);
    ctx.fillStyle = picking ? 'rgba(212,123,53,.25)' : 'rgba(8,126,134,.14)'; ctx.fillRect(a, spectrum.pad.top, b - a, spectrum.h);
  }
  const latest = Math.max(0, ...state.channels.map(row => row.history.length ? row.history[row.history.length - 1][0] : 0));
  const points = rows.flatMap(row => row.history.filter(point => point[0] >= latest - 120));
  const rates = chart($('rate-chart'), 0, Math.max(1, ...points.map(point => point[1])) * 1.1, number, false, -120);
  for (const row of rows) {
    const {ctx, x, y} = rates;
    ctx.strokeStyle = colors[row.channel - 1]; ctx.lineWidth = 1.7; ctx.beginPath();
    let first = true;
    for (const [t, cps] of row.history) {
      if (t < latest - 120) continue;
      if (first) ctx.moveTo(x(t - latest), y(cps)); else ctx.lineTo(x(t - latest), y(cps));
      first = false;
    }
    ctx.stroke();
  }
}

function render() {
  const rows = state.channels;
  const stale = state.age_s !== null && state.age_s > 3;
  const live = state.phase === 'running' && !stale;
  $('connection').textContent = state.error || (live ? '● Receiving' : stale ? 'Waiting for data…' : state.phase === 'starting' ? 'Starting acquisition…' : state.phase === 'complete' ? 'Acquisition complete' : state.phase);
  $('connection').className = `connection ${live ? 'live' : 'warn'}`;
  $('rate').textContent = stale ? '—' : number(rows.reduce((n, row) => n + row.cps, 0));
  $('accepted').textContent = number(rows.reduce((n, row) => n + row.accepted, 0));
  $('rejected').textContent = number(rows.reduce((n, row) => n + row.rejected, 0));
  const clipped = rows.reduce((n, row) => n + row.clipped, 0), seen = rows.reduce((n, row) => n + row.accepted + row.rejected, 0);
  const share = seen ? clipped / seen * 100 : 0;
  $('clipped').textContent = number(clipped);
  $('clipped-note').textContent = seen ? `${share.toFixed(share < 1 ? 2 : 1)} % of pulses reached the ADC limit` : 'Reached the ADC limit';
  $('clipped-card').classList.toggle('warn', share > 1);
  updateFits();
  $('drops').textContent = state.status.fifo_dropped_events == null ? '—' : number(state.status.fifo_dropped_events);
  const temperature = state.status.temperature;
  if (!temperature) { $('temperature').textContent = '—'; $('temperature-note').textContent = 'Not reported by the board'; }
  else if (temperature.error) { $('temperature').textContent = '—'; $('temperature-note').textContent = temperature.error; }
  else {
    $('temperature').textContent = temperature.local_c.toFixed(2);
    $('temperature-note').textContent = temperature.remote_c == null ? 'TMP451 local sensor · remote diode not connected' : `TMP451 local sensor · remote diode ${temperature.remote_c.toFixed(2)} °C`;
  }
  const key = rows.map(row => row.channel).join(',');
  if (channelKey !== key) {
    channelKey = key; $('channels').replaceChildren();
    for (const row of rows) {
      const label = document.createElement('label'); label.className = 'channel';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selected.has(row.channel);
      checkbox.setAttribute('aria-label', `Show input ${row.channel}`);
      checkbox.onchange = () => { if (checkbox.checked) selected.add(row.channel); else selected.delete(row.channel); draw(); drawGain(); };
      const swatch = document.createElement('span'); swatch.className = `swatch ch${row.channel}`;
      const info = document.createElement('span');
      const title = document.createElement('strong'); title.textContent = `IN${row.channel}`;
      const detail = document.createElement('small'); detail.id = `detail-${row.channel}`;
      info.append(title, detail); label.append(checkbox, swatch, info); $('channels').append(label);
    }
  }
  for (const row of rows) $('detail-' + row.channel).textContent = `${stale ? '—' : number(row.cps)} cps · ${number(row.live_fraction * 100)}% live`;
  const under = rows.reduce((n, row) => n + row.underflow, 0), over = rows.reduce((n, row) => n + row.overflow, 0);
  const limit = axisLimit();
  $('range-note').textContent = `${view ? 'zoomed · ' : ''}${limit < state.histogram_max ? 'range ends at the ADC full scale, ' + readout(limit) + ' · ' : ''}${state.histogram_bins} bins · ${number(under)} below range · ${number(over)} above range`;
  const elapsed = Math.max(0, ...rows.map(row => row.history.length ? row.history[row.history.length - 1][0] : 0));
  const gaps = state.status.sequence_gaps || 0;
  $('run-info').textContent = `${number(elapsed)} s acquired · ${number(gaps)} sequence gaps · ${state.recording ? 'Raw recording: ' + state.recording : 'Raw recording off'}`;
  draw();
}

async function refresh() {
  try {
    const response = await fetch('/api/state', {cache: 'no-store', signal: AbortSignal.timeout(3000)});
    if (!response.ok) throw new Error('Dashboard unavailable');
    state = await response.json(); render();
  } catch {
    $('connection').textContent = 'Receiver disconnected'; $('connection').className = 'connection warn';
    $('rate').textContent = '—';
    document.querySelectorAll('.channel small').forEach(element => { element.textContent = 'Disconnected'; });
  } finally { setTimeout(refresh, 500); }
}
// Zoom and pan on the spectrum's integral axis. Counts rescale to the visible range.
const pointer = event => event.clientX - $('spectrum').getBoundingClientRect().left;
const toValue = px => geometry.lo + (px - geometry.left) / geometry.width * (geometry.hi - geometry.lo);
function setView(low, high) {
  const full = axisLimit(), least = 4 * state.histogram_max / state.histogram_bins;
  if (high - low < least) { const mid = (low + high) / 2; low = mid - least / 2; high = mid + least / 2; }
  if (high - low >= full) { view = null; draw(); refreshShape(true); return; }
  if (low < 0) { high -= low; low = 0; }
  if (high > full) { low -= high - full; high = full; }
  view = [Math.max(0, low), Math.min(full, high)]; draw(); refreshShape(true);
}
$('spectrum').addEventListener('mousedown', event => {
  if (!geometry) return;
  drag = {start: pointer(event), now: pointer(event), pan: event.shiftKey, lo: geometry.lo, hi: geometry.hi};
});
window.addEventListener('mousemove', event => {
  if (!geometry || !state) return;
  const px = pointer(event);
  if (drag) {
    drag.now = px;
    if (drag.pan) { const shift = (drag.start - px) / geometry.width * (drag.hi - drag.lo); setView(drag.lo + shift, drag.hi + shift); }
    else draw();
  }
  if (event.target === $('spectrum') && px >= geometry.left && px <= geometry.left + geometry.width) {
    const value = toValue(px), i = Math.floor((value / geometry.binWidth - geometry.first) / geometry.group);
    const counts = geometry.rows.map((row, n) => `IN${row.channel}: ${number(geometry.merged[n][i] || 0)}`).join(' · ');
    $('cursor-note').textContent = `${readout(value)} · ${counts}${geometry.group > 1 ? ` (${geometry.group} bins merged)` : ''}`;
  }
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  const finished = drag; drag = null;
  if (!finished.pan && Math.abs(finished.now - finished.start) > 4) {
    const a = toValue(Math.min(finished.start, finished.now)), b = toValue(Math.max(finished.start, finished.now));
    if (picking) {
      region = [Math.max(geometry.lo, a), Math.min(geometry.hi, b)]; picking = false; updateFits();
      $('pick-region').classList.remove('active'); gain = null; draw(); refreshGain(true);
    } else setView(Math.max(geometry.lo, a), Math.min(geometry.hi, b));
  } else draw();
});
$('spectrum').addEventListener('wheel', event => {
  if (!geometry) return;
  event.preventDefault();
  const at = toValue(Math.max(geometry.left, Math.min(geometry.left + geometry.width, pointer(event))));
  const factor = event.deltaY < 0 ? 0.8 : 1.25;
  setView(at - (at - geometry.lo) * factor, at + (geometry.hi - at) * factor);
}, {passive: false});
$('spectrum').addEventListener('dblclick', () => { view = null; draw(); refreshShape(true); });
$('reset-zoom').onclick = () => { view = null; draw(); refreshShape(true); };
$('fit-data').onclick = () => {
  if (!state) return;
  // Show the occupied part of the axis, with a small margin.
  let low = Infinity, high = -Infinity;
  for (const row of state.channels.filter(row => selected.has(row.channel))) {
    const a = row.histogram.findIndex(count => count > 0);
    if (a < 0) continue;
    low = Math.min(low, a); high = Math.max(high, row.histogram.findLastIndex(count => count > 0) + 1);
  }
  if (low === Infinity) return;
  const width = state.histogram_max / state.histogram_bins, margin = Math.max(2, (high - low) * 0.05);
  setView((low - margin) * width, (high + margin) * width);
};
// Gain tracking: follow the centroid of the chosen peak region against time and temperature.
function gainQuery() {
  const chosen = Number($('gain-bin').value);
  let merge = chosen;
  if (!chosen) {
    // Auto: aim for about 300 counts in the region per time bin.
    if (!gain) merge = 6;
    else {
      const counts = Math.max(1, ...gain.channels.map(c => c.rows.reduce((n, r) => n + r.counts, 0)));
      const elapsed = Math.max(10, ...state.channels.map(row => row.history.length ? row.history[row.history.length - 1][0] : 0));
      merge = Math.max(1, Math.min(360, Math.ceil(300 / (counts / (elapsed / 10)))));
    }
  }
  return `low=${region[0]}&high=${region[1]}&merge=${merge}`;
}
// Weighted straight-line fit; returns slope and its standard error.
function fitLine(points) {
  let w = 0, x = 0, y = 0, xx = 0, xy = 0;
  for (const p of points) { const k = 1 / (p.e * p.e); w += k; x += k * p.x; y += k * p.y; xx += k * p.x * p.x; xy += k * p.x * p.y; }
  const d = w * xx - x * x;
  return d > 0 ? {slope: (w * xy - x * y) / d, error: Math.sqrt(w / d)} : null;
}
function drawGain() {
  const canvas = $('gain-chart'), box = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  if (!region || !gain) { $('gain-note').textContent = ''; return; }
  const pad = {left: 76, right: 86, top: 16, bottom: 52}, w = box.width - pad.left - pad.right, h = box.height - pad.top - pad.bottom;
  const series = gain.channels.filter(c => selected.has(c.channel)).map(c => {
    const good = c.rows.filter(r => r.centroid !== null && r.error);
    const weight = good.reduce((n, r) => n + r.counts, 0);
    const reference = weight ? good.reduce((n, r) => n + r.centroid * r.counts, 0) / weight : 1;
    return {channel: c.channel, reference, points: good.map(r => ({t: r.time_s, y: (r.centroid / reference - 1) * 100, e: r.error / reference * 100, temp: r.temperature_c, n: r.counts}))};
  });
  const all = series.flatMap(s => s.points);
  if (!all.length) { $('gain-summary').textContent = 'No counts in the selected region yet.'; return; }
  const tmax = Math.max(gain.bin_s, ...all.map(p => p.t + gain.bin_s / 2));
  const spanY = Math.max(0.2, ...all.map(p => Math.abs(p.y) + p.e)) * 1.15;
  const temps = all.map(p => p.temp).filter(v => v !== null);
  const tlo = temps.length ? Math.min(...temps) - 0.1 : 0, thi = temps.length ? Math.max(...temps) + 0.1 : 1;
  const x = t => pad.left + t / tmax * w, y = v => pad.top + h * (1 - (v + spanY) / (2 * spanY)), yt = v => pad.top + h * (1 - (v - tlo) / (thi - tlo));
  ctx.font = '11px -apple-system, sans-serif'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const sy = pad.top + h * (1 - i / 4);
    ctx.strokeStyle = '#e9eff0'; ctx.beginPath(); ctx.moveTo(pad.left, sy); ctx.lineTo(pad.left + w, sy); ctx.stroke();
    ctx.fillStyle = '#627580'; ctx.textAlign = 'right'; ctx.fillText((-spanY + 2 * spanY * i / 4).toFixed(2) + ' %', pad.left - 10, sy + 4);
    if (temps.length) { ctx.textAlign = 'left'; ctx.fillText((tlo + (thi - tlo) * i / 4).toFixed(2) + ' °C', pad.left + w + 10, sy + 4); }
  }
  for (let i = 0; i <= 5; i++) { ctx.textAlign = 'center'; ctx.fillText(number(tmax * i / 5), x(tmax * i / 5), pad.top + h + 21); }
  axisTitles(ctx, pad, w, h, 'Elapsed time (s)', 'Peak centroid change (%)', temps.length ? 'Detector temperature (°C)' : null);
  if (temps.length) {
    ctx.strokeStyle = '#8a98a0'; ctx.lineWidth = 1.5; ctx.beginPath(); let first = true;
    for (const p of series[0].points) { if (p.temp === null) continue; if (first) ctx.moveTo(x(p.t), yt(p.temp)); else ctx.lineTo(x(p.t), yt(p.temp)); first = false; }
    ctx.stroke();
  }
  const notes = [];
  for (const s of series) {
    ctx.strokeStyle = ctx.fillStyle = colors[s.channel - 1]; ctx.lineWidth = 1.2;
    for (const p of s.points) {
      ctx.beginPath(); ctx.moveTo(x(p.t), y(p.y - p.e)); ctx.lineTo(x(p.t), y(p.y + p.e)); ctx.stroke();
      ctx.beginPath(); ctx.arc(x(p.t), y(p.y), 2.6, 0, 2 * Math.PI); ctx.fill();
    }
    const withTemp = s.points.filter(p => p.temp !== null).map(p => ({x: p.temp, y: p.y, e: p.e}));
    const range = withTemp.length ? Math.max(...withTemp.map(p => p.x)) - Math.min(...withTemp.map(p => p.x)) : 0;
    const fit = withTemp.length >= 3 && range >= 0.2 ? fitLine(withTemp) : null;
    notes.push(`IN${s.channel}: centroid ${readout(s.reference)}` + (fit ? ` · gain ${fit.slope >= 0 ? '+' : ''}${fit.slope.toFixed(2)} ± ${fit.error.toFixed(2)} % per °C` : withTemp.length ? ` · temperature span ${range.toFixed(2)} °C is too small for a slope yet` : ' · no temperature readings'));
  }
  $('gain-summary').textContent = `Region ${readout(region[0])}–${readout(region[1])} ${unitName()} · ` + notes.join(' · ');
  $('gain-note').textContent = `${gain.bin_s} s time bins · window re-centred on the peak in each bin · error bars are statistical`;
}
async function refreshGain(once = false) {
  if (region) {
    try {
      const query = gainQuery();
      const response = await fetch('/api/gain?' + query, {cache: 'no-store', signal: AbortSignal.timeout(5000)});
      if (response.ok) { gain = await response.json(); $('gain-csv').href = '/api/gain.csv?' + query; drawGain(); }
    } catch { /* the main refresh loop reports a lost connection */ }
  }
  if (!once) setTimeout(refreshGain, 2000);
}
$('pick-region').onclick = () => { picking = !picking; $('pick-region').classList.toggle('active', picking); };
$('clear-region').onclick = () => { region = null; gain = null; updateFits(); $('gain-summary').textContent = 'Press Select peak region, then drag across a peak in the spectrum.'; draw(); drawGain(); };
$('gain-bin').onchange = () => refreshGain(true);
window.addEventListener('resize', drawGain);
refreshGain();
// Pulse shape map with a gate and its two projections: ratio on the left, integral below.
// Its horizontal range follows the spectrum's zoom.
function shapeSpan() {
  if (view) return view;
  const limit = axisLimit();
  if (limit < state.histogram_max) return [0, limit];
  // No full-scale estimate yet: show the occupied part of the axis instead.
  let high = 0;
  for (const row of state.channels) high = Math.max(high, row.histogram.findLastIndex(count => count > 0) + 1);
  const width = state.histogram_max / state.histogram_bins;
  return [0, high ? high * width * 1.05 : state.histogram_max];
}
function canvasContext(canvas) {
  const box = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  ctx.font = '11px -apple-system, sans-serif'; ctx.lineWidth = 1;
  return {ctx, box};
}
function rotatedTitle(ctx, text, x, y, angle) {
  ctx.save(); ctx.fillStyle = '#172c3a'; ctx.font = '12px -apple-system, sans-serif'; ctx.textAlign = 'center';
  ctx.translate(x, y); ctx.rotate(angle); ctx.fillText(text, 0, 0); ctx.restore();
}
function steps(ctx, values, place) {
  ctx.beginPath();
  values.forEach((value, i) => { const [a, b] = place(i, value); if (i) { ctx.lineTo(...a); } else ctx.moveTo(...a); ctx.lineTo(...b); });
  ctx.stroke();
}
function drawShape() {
  const map = canvasContext($('shape-chart')), left = canvasContext($('shape-y')), below = canvasContext($('shape-x'));
  if (!shape) return;
  const ctx = map.ctx, pad = {left: 76, right: 16, top: 16, bottom: 30};
  const w = map.box.width - pad.left - pad.right, h = map.box.height - pad.top - pad.bottom;
  const xspan = shape.high - shape.low, yspan = shape.ratio_high - shape.ratio_low;
  const xOf = v => pad.left + (v - shape.low) / xspan * w, yOf = v => pad.top + h * (1 - (v - shape.ratio_low) / yspan);
  shapeGeometry = {left: pad.left, top: pad.top, width: w, height: h};
  const marks = axisTicks(shape.low, shape.high);
  for (let i = 0; i <= 4; i++) {
    const sy = pad.top + h * (1 - i / 4);
    ctx.strokeStyle = '#e9eff0'; ctx.beginPath(); ctx.moveTo(pad.left, sy); ctx.lineTo(pad.left + w, sy); ctx.stroke();
    ctx.fillStyle = '#627580'; ctx.textAlign = 'right'; ctx.fillText((shape.ratio_low + yspan * i / 4).toFixed(3), pad.left - 10, sy + 4);
  }
  for (const mark of marks) { const px = xOf(mark.x); ctx.fillStyle = '#627580'; ctx.textAlign = px > pad.left + w - 20 ? 'right' : 'center'; ctx.fillText(mark.label, px, pad.top + h + 18); }
  rotatedTitle(ctx, 'Short / long integral ratio', 14, pad.top + h / 2, -Math.PI / 2);
  const cw = w / shape.columns, ch = h / shape.rows, xbin = xspan / shape.columns, ybin = yspan / shape.rows;
  const inX = column => !gate || (shape.low + (column + .5) * xbin >= gate.x[0] && shape.low + (column + .5) * xbin < gate.x[1]);
  const inY = row => !gate || (shape.ratio_low + (row + .5) * ybin >= gate.y[0] && shape.ratio_low + (row + .5) * ybin < gate.y[1]);
  const projections = [];
  let total = 0, inside = 0;
  for (const channel of shape.channels.filter(c => selected.has(c.channel))) {
    const peak = Math.max(1, ...channel.cells.map(cell => cell[2]));
    const across = new Array(shape.columns).fill(0), up = new Array(shape.rows).fill(0);
    ctx.fillStyle = colors[channel.channel - 1];
    for (const [x, y, count] of channel.cells) {
      // Logarithmic shading, so single events stay visible beside dense bands.
      ctx.globalAlpha = 0.18 + 0.82 * Math.log(1 + count) / Math.log(1 + peak);
      ctx.fillRect(pad.left + x * cw, pad.top + h - (y + 1) * ch, Math.ceil(cw), Math.ceil(ch));
      total += count;
      if (inY(y)) across[x] += count;
      if (inX(x)) up[y] += count;
      if (inX(x) && inY(y)) inside += count;
    }
    projections.push({channel: channel.channel, across, up});
  }
  ctx.globalAlpha = 1;
  if (gate) {
    ctx.save(); ctx.strokeStyle = '#172c3a'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    ctx.strokeRect(xOf(gate.x[0]), yOf(gate.y[1]), xOf(gate.x[1]) - xOf(gate.x[0]), yOf(gate.y[0]) - yOf(gate.y[1])); ctx.restore();
  }
  if (shapeDrag) {
    ctx.fillStyle = 'rgba(8,126,134,.14)';
    ctx.fillRect(Math.min(shapeDrag.x0, shapeDrag.x1), Math.min(shapeDrag.y0, shapeDrag.y1), Math.abs(shapeDrag.x1 - shapeDrag.x0), Math.abs(shapeDrag.y1 - shapeDrag.y0));
  }
  // Below: integral projection, aligned with the map's horizontal axis.
  {
    const c = below.ctx, p = {left: pad.left, right: pad.right, top: 10, bottom: 52};
    const pw = below.box.width - p.left - p.right, ph = below.box.height - p.top - p.bottom;
    const top = Math.max(1, ...projections.flatMap(r => r.across)) * 1.1;
    for (let i = 0; i <= 3; i++) {
      const sy = p.top + ph * (1 - i / 3);
      c.strokeStyle = '#e9eff0'; c.beginPath(); c.moveTo(p.left, sy); c.lineTo(p.left + pw, sy); c.stroke();
      c.fillStyle = '#627580'; c.textAlign = 'right'; c.fillText(number(top * i / 3), p.left - 10, sy + 4);
    }
    for (const mark of marks) { const px = p.left + (mark.x - shape.low) / xspan * pw; c.fillStyle = '#627580'; c.textAlign = px > p.left + pw - 20 ? 'right' : 'center'; c.fillText(mark.label, px, p.top + ph + 21); }
    axisTitles(c, p, pw, ph, `${unit === UNITS.kev && axisCalibration() ? 'Energy (keV)' : `Long-gate integral (${unitName()})`}${gate ? ' · inside the gate\'s ratio range' : ''}`, 'Counts');
    for (const r of projections) {
      c.strokeStyle = colors[r.channel - 1]; c.lineWidth = 1.5;
      steps(c, r.across, (i, v) => [[p.left + i * pw / shape.columns, p.top + ph * (1 - v / top)], [p.left + (i + 1) * pw / shape.columns, p.top + ph * (1 - v / top)]]);
    }
  }
  // Left: ratio projection, aligned with the map's vertical axis; bars grow leftwards.
  {
    const c = left.ctx, p = {left: 30, right: 6, top: pad.top, bottom: pad.bottom};
    const pw = left.box.width - p.left - p.right, ph = left.box.height - p.top - p.bottom;
    const top = Math.max(1, ...projections.flatMap(r => r.up)) * 1.1;
    for (let i = 0; i <= 2; i++) {
      const sx = p.left + pw * (1 - i / 2);
      c.strokeStyle = '#e9eff0'; c.beginPath(); c.moveTo(sx, p.top); c.lineTo(sx, p.top + ph); c.stroke();
      c.fillStyle = '#627580'; c.textAlign = 'center'; c.fillText(number(top * i / 2), sx, p.top + ph + 18);
    }
    rotatedTitle(c, gate ? 'Counts · inside the gate\'s integral range' : 'Counts', 12, p.top + ph / 2, -Math.PI / 2);
    for (const r of projections) {
      c.strokeStyle = colors[r.channel - 1]; c.lineWidth = 1.5;
      steps(c, r.up, (i, v) => [[p.left + pw * (1 - v / top), p.top + ph * (1 - i / shape.rows)], [p.left + pw * (1 - v / top), p.top + ph * (1 - (i + 1) / shape.rows)]]);
    }
  }
  $('shape-note').textContent = `${number(total)} events shown` + (gate
    ? ` · gate: ${number(inside)} events (${total ? (inside / total * 100).toFixed(1) : 0} %) · ratio ${gate.y[0].toFixed(3)}–${gate.y[1].toFixed(3)} · integral ${readout(gate.x[0])}–${readout(gate.x[1])}`
    : ' · no gate');
}
async function refreshShape(once = false) {
  if (state) {
    try {
      const [low, high] = shapeSpan();
      const response = await fetch(`/api/shape?low=${low}&high=${high}&ratio_low=${shapeRange[0]}&ratio_high=${shapeRange[1]}&columns=400&rows=160`, {cache: 'no-store', signal: AbortSignal.timeout(5000)});
      if (response.ok) { shape = await response.json(); drawShape(); }
    } catch { /* the main refresh loop reports a lost connection */ }
  }
  if (!once) setTimeout(refreshShape, 1500);
}
const shapePoint = event => { const box = $('shape-chart').getBoundingClientRect(); return [event.clientX - box.left, event.clientY - box.top]; };
const shapeX = px => shape.low + (px - shapeGeometry.left) / shapeGeometry.width * (shape.high - shape.low);
const shapeValue = py => shapeRange[0] + (1 - (py - shapeGeometry.top) / shapeGeometry.height) * (shapeRange[1] - shapeRange[0]);
function setShapeRange(low, high) {
  low = Math.max(0, low); high = Math.min(2, high);
  if (high - low < 0.01) return;
  shapeRange = [low, high]; refreshShape(true);
}
$('shape-chart').addEventListener('mousedown', event => {
  if (!shapeGeometry) return;
  const [x, y] = shapePoint(event); shapeDrag = {x0: x, y0: y, x1: x, y1: y};
});
window.addEventListener('mousemove', event => { if (shapeDrag) { [shapeDrag.x1, shapeDrag.y1] = shapePoint(event); drawShape(); } });
window.addEventListener('mouseup', () => {
  if (!shapeDrag) return;
  const d = shapeDrag; shapeDrag = null;
  if (Math.abs(d.x1 - d.x0) > 4 && Math.abs(d.y1 - d.y0) > 4) {
    gate = {x: [shapeX(Math.min(d.x0, d.x1)), shapeX(Math.max(d.x0, d.x1))],
            y: [shapeValue(Math.max(d.y0, d.y1)), shapeValue(Math.min(d.y0, d.y1))]};
  }
  drawShape();
});
$('shape-chart').addEventListener('wheel', event => {
  if (!shapeGeometry) return;
  event.preventDefault();
  const at = shapeValue(shapePoint(event)[1]), factor = event.deltaY < 0 ? 0.8 : 1.25;
  setShapeRange(at - (at - shapeRange[0]) * factor, at + (shapeRange[1] - at) * factor);
}, {passive: false});
$('shape-chart').addEventListener('dblclick', () => { gate = null; setShapeRange(0, 1.1); });
$('shape-clear-gate').onclick = () => { gate = null; drawShape(); };
$('shape-reset').onclick = () => setShapeRange(0, 1.1);
window.addEventListener('resize', drawShape);
refreshShape();

// Peak fit in the selected region: a Gaussian on a first-order polynomial background,
// least squares with Poisson weights, solved by Levenberg-Marquardt.
function solve(matrix, vector) {
  const n = vector.length, m = matrix.map((row, i) => [...row, vector[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-300) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let k = col; k <= n; k++) m[r][k] -= f * m[col][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}
function fitPeak(histogram, width, low, high) {
  const first = Math.max(0, Math.floor(low / width)), last = Math.min(histogram.length, Math.ceil(high / width));
  const span = high - low, mid = (low + high) / 2, us = [], ys = [];
  // Fit in u = (x - mid) / span, which keeps the parameters of similar size.
  for (let i = first; i < last; i++) { us.push(((i + .5) * width - mid) / span); ys.push(histogram[i]); }
  const n = us.length;
  if (n < 8 || ys.reduce((a, v) => a + v, 0) < 30) return null;
  const k = Math.max(2, Math.floor(n * .15)), mean = list => list.reduce((a, v) => a + v, 0) / list.length;
  const c1 = (mean(ys.slice(-k)) - mean(ys.slice(0, k))) / (mean(us.slice(-k)) - mean(us.slice(0, k)));
  const c0 = mean(ys.slice(0, k)) - c1 * mean(us.slice(0, k));
  const net = ys.map((v, i) => Math.max(0, v - c0 - c1 * us[i])), area = net.reduce((a, v) => a + v, 0) || 1;
  const mu = net.reduce((a, v, i) => a + v * us[i], 0) / area;
  const sigma = Math.max(Math.sqrt(net.reduce((a, v, i) => a + v * (us[i] - mu) ** 2, 0) / area), 1 / n);
  let p = [Math.max(1, ...net), mu, sigma, c0, c1];
  const weight = ys.map(v => 1 / Math.max(v, 1));
  const model = (q, u) => { const g = Math.exp(-0.5 * ((u - q[1]) / q[2]) ** 2); return [q[0] * g + q[3] + q[4] * u, g]; };
  const chi2 = q => us.reduce((a, u, i) => a + weight[i] * (ys[i] - model(q, u)[0]) ** 2, 0);
  const normal = q => {
    const jtj = Array.from({length: 5}, () => new Array(5).fill(0)), jtr = new Array(5).fill(0);
    us.forEach((u, i) => {
      const [f, g] = model(q, u), d = (u - q[1]) / q[2];
      const jac = [g, q[0] * g * d / q[2], q[0] * g * d * d / q[2], 1, u];
      for (let a = 0; a < 5; a++) { jtr[a] += weight[i] * jac[a] * (ys[i] - f); for (let b = 0; b < 5; b++) jtj[a][b] += weight[i] * jac[a] * jac[b]; }
    });
    return [jtj, jtr];
  };
  let lambda = 1e-3, current = chi2(p);
  for (let iteration = 0; iteration < 200; iteration++) {
    const [jtj, jtr] = normal(p);
    const step = solve(jtj.map((row, a) => row.map((v, b) => a === b ? v * (1 + lambda) : v)), jtr);
    if (!step) return null;
    const trial = p.map((v, a) => v + step[a]); trial[2] = Math.abs(trial[2]);
    const next = chi2(trial);
    if (next < current) { const converged = current - next < 1e-9 * current; p = trial; current = next; lambda /= 3; if (converged) break; }
    else if ((lambda *= 4) > 1e10) break;
  }
  if (!(p[0] > 0) || Math.abs(p[1]) > 0.5 || p[2] > 0.5) return null;
  const ndf = n - 5, [jtj] = normal(p), variance = current / Math.max(1, ndf);
  const error = a => { const unitVector = [0, 0, 0, 0, 0]; unitVector[a] = 1; const column = solve(jtj, unitVector); return column ? Math.sqrt(Math.max(0, column[a] * variance)) : NaN; };
  const centroid = mid + p[1] * span, sigmaX = p[2] * span;
  const [A, , , b0, b1] = p;
  return {
    centroid, centroidError: error(1) * span, sigma: sigmaX, sigmaError: error(2) * span,
    fwhm: 2.3548 * sigmaX, resolution: 2.3548 * sigmaX / centroid * 100,
    net: A * p[2] * Math.sqrt(2 * Math.PI) * span / width, chi2ndf: current / Math.max(1, ndf),
    total: x => { const u = (x - mid) / span; return A * Math.exp(-0.5 * ((u - p[1]) / p[2]) ** 2) + b0 + b1 * u; },
    background: x => b0 + b1 * (x - mid) / span,
  };
}
function updateFits() {
  fits = {};
  if (!region || !state) { $('fit-note').textContent = ''; return; }
  const width = state.histogram_max / state.histogram_bins, lines = [];
  for (const row of state.channels.filter(r => selected.has(r.channel))) {
    const fit = fitPeak(row.histogram, width, region[0], region[1]);
    if (!fit) { lines.push(`IN${row.channel}: not enough counts in the region for a fit yet`); continue; }
    fits[row.channel] = fit;
    lines.push(`IN${row.channel} fit (Gaussian + line): centroid ${readout(fit.centroid)} ± ${readoutWidth(fit.centroid, fit.centroidError)} · FWHM ${readoutWidth(fit.centroid, fit.fwhm)} (${fit.resolution.toFixed(2)} %) · net peak ${number(fit.net)} counts · χ²/ndf ${fit.chi2ndf.toFixed(2)}`);
  }
  $('fit-note').textContent = lines.join('\n');
}
function showUnit() { document.querySelectorAll('.unit-name').forEach(element => { element.textContent = unitName(); }); }
$('axis-unit').onchange = () => { unit = UNITS[$('axis-unit').value]; showUnit(); updateFits(); draw(); drawShape(); drawGain(); };

// Energy calibration from fitted peaks: E(keV) = a0 + a1 X + a2 X^2 + a3 X^3, X in ADC counts x samples.
function fitCalibration(points, order) {
  if (!points.length) return null;
  // With one point the line goes through zero; otherwise use the highest order the points allow.
  if (points.length === 1) return {coefficients: [0, points[0].energy / (points[0].x * 1024000)], order: 1, origin: true, rms: 0};
  const used = Math.min(order, points.length - 1), scale = 1e5;  // fit in X / 1e5 for conditioning
  const n = used + 1, matrix = Array.from({length: n}, () => new Array(n).fill(0)), vector = new Array(n).fill(0);
  for (const point of points) {
    const powers = Array.from({length: n}, (_, k) => (point.x * 1024000 / scale) ** k);
    for (let a = 0; a < n; a++) { vector[a] += powers[a] * point.energy; for (let b = 0; b < n; b++) matrix[a][b] += powers[a] * powers[b]; }
  }
  const solution = solve(matrix, vector);
  if (!solution) return null;
  const coefficients = solution.map((value, k) => value / scale ** k);
  const residuals = points.map(point => polynomial(coefficients, point.x) - point.energy);
  return {coefficients, order: used, origin: false, rms: Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / points.length)};
}
function saveCalibration() { try { localStorage.setItem('mca-calibration-v1', JSON.stringify(calibration)); } catch { /* storage unavailable */ } }
function renderCalibration() {
  calibrated = {};
  $('cal-order').value = String(calibration.order);
  const rows = [], notes = [];
  for (const [channel, points] of Object.entries(calibration.points)) {
    if (!points.length) continue;
    const cal = fitCalibration(points, calibration.order);
    if (cal) {
      calibrated[channel] = cal;
      // An energy scale must increase across the usable range.
      const top = state ? axisLimit() : 4;
      let rising = true;
      for (let i = 1; i <= 200; i++) if (polynomial(cal.coefficients, top * i / 200) <= polynomial(cal.coefficients, top * (i - 1) / 200)) rising = false;
      const terms = cal.coefficients.map((a, k) => `${a.toExponential(4)}${k ? ' X' + (k > 1 ? (k === 2 ? '²' : '³') : '') : ''}`).join(' + ');
      notes.push(`IN${channel}: E = ${terms}${cal.origin ? ' (one point, through zero)' : ''}${cal.order < calibration.order ? ` (order ${cal.order}: need ${calibration.order + 1} points for order ${calibration.order})` : ''} · rms residual ${cal.rms.toFixed(2)} keV${rising ? '' : ' · WARNING: not increasing over the range'}`);
    }
    points.forEach((point, i) => {
      const fitted = cal ? polynomial(cal.coefficients, point.x) : null;
      rows.push(`<tr><td>IN${channel}</td><td>${(point.x * 1024000).toLocaleString(undefined, {maximumFractionDigits: 0})}</td><td>${point.energy.toFixed(1)}</td><td>${fitted === null ? '—' : fitted.toFixed(1)}</td><td>${fitted === null ? '—' : (fitted - point.energy).toFixed(2)}</td><td><button type="button" class="button small" data-channel="${channel}" data-index="${i}">Remove</button></td></tr>`);
    });
  }
  $('cal-table').innerHTML = rows.length ? `<table><tr><th>Input</th><th>Peak centroid (ADC counts × samples)</th><th>Energy (keV)</th><th>Calibration (keV)</th><th>Residual (keV)</th><th></th></tr>${rows.join('')}</table>` : '';
  $('cal-summary').textContent = notes.length ? notes.join('\n') : 'Select a peak region, enter the line energy and press Add fitted peak. Points are kept in this browser.';
  $('cal-table').querySelectorAll('button').forEach(button => button.onclick = () => {
    calibration.points[button.dataset.channel].splice(Number(button.dataset.index), 1); saveCalibration(); renderCalibration(); refreshAxes();
  });
  $('axis-unit').querySelector('option[value="kev"]').disabled = !Object.keys(calibrated).length;
}
function refreshAxes() { showUnit(); updateFits(); draw(); drawShape(); drawGain(); }
$('cal-add').onclick = () => {
  const energy = Number($('cal-energy').value);
  if (!(energy > 0)) { $('cal-summary').textContent = 'Enter the energy of the peak in keV first.'; return; }
  const channels = Object.keys(fits);
  if (!channels.length) { $('cal-summary').textContent = 'Select a peak region with a successful Gaussian fit first.'; return; }
  for (const channel of channels) (calibration.points[channel] ||= []).push({x: fits[channel].centroid, error: fits[channel].centroidError, energy});
  saveCalibration(); renderCalibration(); refreshAxes();
};
$('cal-order').onchange = () => { calibration.order = Number($('cal-order').value); saveCalibration(); renderCalibration(); refreshAxes(); };
$('cal-clear').onclick = () => { calibration.points = {}; saveCalibration(); if (unit === UNITS.kev) { unit = UNITS.adc; $('axis-unit').value = 'adc'; } renderCalibration(); refreshAxes(); };
$('cal-export').onclick = () => {
  const body = JSON.stringify({order: calibration.order, points: calibration.points,
    calibrations: Object.fromEntries(Object.entries(calibrated).map(([c, cal]) => [c, {...cal, variable: 'ADC counts x samples (long gate)'}]))}, null, 2);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([body], {type: 'application/json'})); link.download = 'mca-energy-calibration.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
};
renderCalibration();
showUnit();
$('log-scale').onchange = draw;
window.addEventListener('resize', draw);
refresh();
