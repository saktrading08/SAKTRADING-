const E = require('./engine.js');
const DAY = E.DAY;
const start = 1704067200; // 2024-01-01
const N = 600;

// deterministic PRNG
let seed = 42; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const gauss = () => { const u = rnd() || 1e-9, v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// Build: stable supply random walk; price with normal vol except planted quiet windows;
// volume normal except planted spikes 4 days after staging windows.
const planted = [120, 260, 420]; // staging starts
const stable = [], prices = [], vol = [];
let S = 3e9, P = 100;
for (let i = 0; i < N; i++) {
  const t = start + i * DAY;
  let inQuiet = planted.some(p => i >= p - 14 && i < p + 3);
  let inflow = planted.some(p => i >= p - 5 && i <= p) ? 60e6 : gauss() * 15e6;
  S += inflow;
  P *= Math.exp((inQuiet ? 0.004 : 0.04) * gauss());
  let v = 1e9 * (1 + 0.15 * gauss());
  if (planted.some(p => i >= p + 4 && i <= p + 6)) v *= 3;
  stable.push({ date: t, totalCirculatingUSD: { peggedUSD: S } });
  prices.push({ timestamp: t + 3600, price: P });
  vol.push([t, v]);
}

const rows = E.alignDaily({ stable, prices, vols: { test: vol } });
console.log('aligned rows', rows.length);
const ind = E.computeIndicators(rows);
const log = E.stateTransitions(ind);
const bt = E.backtest(ind);
console.log('episodes', bt.episodeCount, 'hitRate', bt.episodeHitRate, 'medianLead', bt.medianLead,
  'dayHit', bt.dayHitRate && bt.dayHitRate.toFixed(2), 'base', bt.baseRate && bt.baseRate.toFixed(2), 'lift', bt.lift && bt.lift.toFixed(2));
for (const e of bt.episodes) console.log(' ep', Math.round((e.start - start) / DAY), 'days', e.days, 'z', e.inflowZ.toFixed(2), 'volPct', e.volPct.toFixed(0), 'hit', e.hit, 'lead', e.leadDays);
console.log('transitions', log.length, log.slice(-6).map(l => l.state + '@' + Math.round((l.date - start) / DAY)).join(', '));
const last = E.latest(ind);
console.log('latest', last.state, 'z', last.inflowZ.toFixed(2), 'volPct', last.volPct.toFixed(0), 'volRatio', last.volRatio.toFixed(2));

// sanity assertions
const caught = planted.filter(p => bt.episodes.some(e => Math.abs((e.start - start) / DAY - p) <= 6 && e.hit)).length;
if (caught < 2) { console.error('FAIL: planted episodes not caught'); process.exit(1); }
if (bt.lift < 1.5) { console.error('FAIL: lift too low'); process.exit(1); }
console.log('OK');
