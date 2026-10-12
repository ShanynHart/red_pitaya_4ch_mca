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
const UNITS = {adc: {scale: 1024000, name: 'ADC counts × samples'}, vus: {scale: 1, name: 'nominal V·µs'}};
let unit = UNITS.adc;
// Axis ticks for a span; the readout form gives one value to about five figures.
const ticks = span => { const digits = Math.max(0, Math.min(5, 1 - Math.floor(Math.log10(span * unit.scale)))); return value => (value * unit.scale).toLocaleString(undefined, {maximumFractionDigits: digits}); };
const readout = value => { const shown = value * unit.scale; return shown.toLocaleString(undefined, {maximumFractionDigits: Math.max(0, 4 - Math.floor(Math.log10(Math.max(1e-9, Math.abs(shown)))))}); };
let geometry = null;  // last drawn spectrum axis, for mouse mapping
let drag = null;
let region = null;    // [low, high] peak region for gain tracking
let picking = false;
let gain = null;
let shape = null, shapeRange = [0, 1.1], shapeDrag = null, shapeGeometry = null;

// Axis titles: below the tick labels, and rotated beside the left (and optional right) scale.
function axisTitles(ctx, pad, w, h, bottom, left, right) {
  ctx.save(); ctx.fillStyle = '#172c3a'; ctx.font = '12px -apple-system, sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(bottom, pad.left + w / 2, pad.top + h + 42);
  ctx.save(); ctx.translate(14, pad.top + h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(left, 0, 0); ctx.restore();
  if (right) { ctx.translate(pad.left + w + pad.right - 10, pad.top + h / 2); ctx.rotate(Math.PI / 2); ctx.fillText(right, 0, 0); }
  ctx.restore();
}

function chart(canvas, xmax, ymax, xlabel, logarithmic = false, xmin = 0) {
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
  for (let i = 0; i <= 5; i++) {
    const value = xmin + (xmax - xmin) * i / 5;
    ctx.textAlign = 'center'; ctx.fillText(xlabel(value), x(value), pad.top + h + 21);
  }
  if (canvas.id === 'spectrum') axisTitles(ctx, pad, w, h, `Long-gate integral (${unit.name})`, logarithmic ? 'Counts per bin (log scale)' : 'Counts per bin');
  else axisTitles(ctx, pad, w, h, 'Time before latest batch (s)', 'Accepted counts per second');
  return {ctx, x, y, pad, w, h, xmin, xmax};
}

function draw() {
  if (!state) return;
  const rows = state.channels.filter(row => selected.has(row.channel));
  const full = state.histogram_max, bins = state.histogram_bins, width = full / bins;
  const lo = view ? view[0] : 0, hi = view ? view[1] : full;
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
  const label = ticks(hi - lo);
  const spectrum = chart($('spectrum'), hi, maxCount * 1.1, label, $('log-scale').checked, lo);
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
  $('range-note').textContent = `${view ? 'zoomed · ' : ''}${state.histogram_bins} bins · ${number(under)} below range · ${number(over)} above range`;
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
  const full = state.histogram_max, least = 4 * full / state.histogram_bins;
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
      region = [Math.max(geometry.lo, a), Math.min(geometry.hi, b)]; picking = false;
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
  $('gain-summary').textContent = `Region ${readout(region[0])}–${readout(region[1])} ${unit.name} · ` + notes.join(' · ');
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
$('clear-region').onclick = () => { region = null; gain = null; $('gain-summary').textContent = 'Press Select peak region, then drag across a peak in the spectrum.'; draw(); drawGain(); };
$('gain-bin').onchange = () => refreshGain(true);
window.addEventListener('resize', drawGain);
refreshGain();
// Pulse shape map. Its horizontal range follows the spectrum's zoom.
function shapeSpan() {
  if (view) return view;
  // Unzoomed: show the occupied part of the axis instead of the full, mostly empty range.
  let high = 0;
  for (const row of state.channels) high = Math.max(high, row.histogram.findLastIndex(count => count > 0) + 1);
  const width = state.histogram_max / state.histogram_bins;
  return [0, high ? high * width * 1.05 : state.histogram_max];
}
function drawShape() {
  const canvas = $('shape-chart'), box = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(box.width * ratio); canvas.height = Math.round(box.height * ratio);
  const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio);
  if (!shape) return;
  const pad = {left: 76, right: 16, top: 16, bottom: 52}, w = box.width - pad.left - pad.right, h = box.height - pad.top - pad.bottom;
  shapeGeometry = {top: pad.top, height: h};
  ctx.font = '11px -apple-system, sans-serif'; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const sy = pad.top + h * (1 - i / 4);
    ctx.strokeStyle = '#e9eff0'; ctx.beginPath(); ctx.moveTo(pad.left, sy); ctx.lineTo(pad.left + w, sy); ctx.stroke();
    ctx.fillStyle = '#627580'; ctx.textAlign = 'right'; ctx.fillText((shape.ratio_low + (shape.ratio_high - shape.ratio_low) * i / 4).toFixed(3), pad.left - 10, sy + 4);
  }
  const span = shape.high - shape.low, tick = ticks(span);
  for (let i = 0; i <= 5; i++) { ctx.textAlign = 'center'; ctx.fillText(tick(shape.low + span * i / 5), pad.left + w * i / 5, pad.top + h + 21); }
  axisTitles(ctx, pad, w, h, `Long-gate integral (${unit.name})`, 'Short / long integral ratio');
  const cw = w / shape.columns, ch = h / shape.rows;
  let total = 0;
  for (const row of shape.channels.filter(c => selected.has(c.channel))) {
    const peak = Math.max(1, ...row.cells.map(cell => cell[2]));
    ctx.fillStyle = colors[row.channel - 1];
    for (const [x, y, count] of row.cells) {
      // Logarithmic shading, so single events stay visible beside dense bands.
      ctx.globalAlpha = 0.18 + 0.82 * Math.log(1 + count) / Math.log(1 + peak);
      ctx.fillRect(pad.left + x * cw, pad.top + h - (y + 1) * ch, Math.ceil(cw), Math.ceil(ch));
      total += count;
    }
  }
  ctx.globalAlpha = 1;
  if (shapeDrag) { const a = Math.min(shapeDrag.start, shapeDrag.now), b = Math.max(shapeDrag.start, shapeDrag.now); ctx.fillStyle = 'rgba(8,126,134,.14)'; ctx.fillRect(pad.left, a, w, b - a); }
  $('shape-note').textContent = `${number(total)} events shown · ratio ${shape.ratio_low.toFixed(3)}–${shape.ratio_high.toFixed(3)}`;
}
async function refreshShape(once = false) {
  if (state) {
    try {
      const [low, high] = shapeSpan();
      const response = await fetch(`/api/shape?low=${low}&high=${high}&ratio_low=${shapeRange[0]}&ratio_high=${shapeRange[1]}`, {cache: 'no-store', signal: AbortSignal.timeout(5000)});
      if (response.ok) { shape = await response.json(); drawShape(); }
    } catch { /* the main refresh loop reports a lost connection */ }
  }
  if (!once) setTimeout(refreshShape, 1500);
}
const shapeValue = py => shapeRange[0] + (1 - (py - shapeGeometry.top) / shapeGeometry.height) * (shapeRange[1] - shapeRange[0]);
function setShapeRange(low, high) {
  low = Math.max(0, low); high = Math.min(2, high);
  if (high - low < 0.01) return;
  shapeRange = [low, high]; refreshShape(true);
}
const shapePointer = event => event.clientY - $('shape-chart').getBoundingClientRect().top;
$('shape-chart').addEventListener('mousedown', event => { if (shapeGeometry) shapeDrag = {start: shapePointer(event), now: shapePointer(event)}; });
window.addEventListener('mousemove', event => { if (shapeDrag) { shapeDrag.now = shapePointer(event); drawShape(); } });
window.addEventListener('mouseup', () => {
  if (!shapeDrag) return;
  const finished = shapeDrag; shapeDrag = null;
  if (Math.abs(finished.now - finished.start) > 4) setShapeRange(shapeValue(Math.max(finished.start, finished.now)), shapeValue(Math.min(finished.start, finished.now)));
  else drawShape();
});
$('shape-chart').addEventListener('wheel', event => {
  if (!shapeGeometry) return;
  event.preventDefault();
  const at = shapeValue(shapePointer(event)), factor = event.deltaY < 0 ? 0.8 : 1.25;
  setShapeRange(at - (at - shapeRange[0]) * factor, at + (shapeRange[1] - at) * factor);
}, {passive: false});
$('shape-chart').addEventListener('dblclick', () => setShapeRange(0, 1.1));
$('shape-reset').onclick = () => setShapeRange(0, 1.1);
window.addEventListener('resize', drawShape);
refreshShape();
function showUnit() { document.querySelectorAll('.unit-name').forEach(element => { element.textContent = unit.name; }); }
$('axis-unit').onchange = () => { unit = UNITS[$('axis-unit').value]; showUnit(); draw(); drawShape(); drawGain(); };
showUnit();
$('log-scale').onchange = draw;
window.addEventListener('resize', draw);
refresh();
