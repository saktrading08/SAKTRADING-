/* Memecoin Regime Engine — pure functions, no DOM, no network.
   Shared by collector.js (Node) and index.html (browser).

   Signals (validated on Solana data Jan 2024 – Oct 2026):
     regime   = 7d avg pump.fun+PumpSwap volume / prior 30d avg.  >= hot  -> LIVE ;  < dead -> DEAD
     trend    = SOL above its 50-day average (filter), and 30d return (parabolic check)
     surge    = Solana stablecoin supply 30d growth >= surgePct   (caution flag)
   Context only (no alerting): 7d stablecoin inflow z-score, SOL 14d realized-vol percentile. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiqEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const DAY = 86400;
  function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
  function std(a) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, a.length - 1)); }
  function median(a) { const s = a.slice().sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; }
  function pctRank(x, a) { let b = 0; for (const v of a) if (v < x) b++; return a.length ? 100 * b / a.length : NaN; }

  // stable: [{date, totalCirculatingUSD:{peggedUSD}}]  prices: [{timestamp, price}]  vols: {name: [[t, usd]]}
  function alignDaily({ stable, prices, vols, start, end, dropLast }) {
    const dayKey = t => Math.floor(t / DAY) * DAY;
    const map = new Map(); const row = d => { if (!map.has(d)) map.set(d, { date: d }); return map.get(d); };
    for (const r of stable || []) { const v = r.totalCirculatingUSD && r.totalCirculatingUSD.peggedUSD; if (typeof v === 'number') row(dayKey(+r.date)).stable = v; }
    for (const p of prices || []) if (typeof p.price === 'number') row(dayKey(p.timestamp)).price = p.price;
    for (const [name, series] of Object.entries(vols || {})) for (const [t, v] of series) if (typeof v === 'number') { const r = row(dayKey(t)); r.vol = (r.vol || 0) + v; r['vol_' + name] = v; }
    let rows = [...map.values()].sort((a, b) => a.date - b.date);
    if (start) rows = rows.filter(r => r.date >= start);
    if (end) rows = rows.filter(r => r.date <= end);
    let lastS = null, lastP = null;
    for (const r of rows) { if (r.stable == null) r.stable = lastS; else lastS = r.stable; if (r.price == null) r.price = lastP; else lastP = r.price; }
    rows = rows.filter(r => r.stable != null && r.price != null);
    // the current UTC day is a partial day for volume feeds: drop it unless told otherwise
    if (dropLast !== false && rows.length) { const today = dayKey(Date.now() / 1000); if (rows[rows.length - 1].date >= today) rows.pop(); }
    // memecoin feeds publish a day behind the others: trim trailing rows that lack them
    const memeKeys = ['vol_pump.fun', 'vol_pumpswap'];
    if (rows.some(r => memeKeys.some(k => r[k] != null))) {
      while (rows.length && !memeKeys.some(k => rows[rows.length - 1][k] != null)) rows.pop();
    }
    return rows;
  }

  const DEFAULTS = {
    hot: 1.5,          // regime ratio at/above which the window is LIVE
    warm: 1.3,         // early-warning level
    dead: 0.7,         // at/below which the market is DEAD
    surgePct: 0.15,    // 30d stablecoin growth caution flag
    maWindow: 50,      // SOL trend average
    parabolic: 0.30,   // SOL 30d return above this = extended
    inflowWindow: 7, inflowBaseline: 90, volWindow: 14, volBaseline: 365
  };

  function computeIndicators(rows, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    const n = rows.length, out = rows.map(r => Object.assign({}, r));
    const meme = out.map(o => (o['vol_pump.fun'] || 0) + (o.vol_pumpswap || 0));
    const hasMeme = out.map(o => o['vol_pump.fun'] != null || o.vol_pumpswap != null);
    for (let i = 1; i < n; i++) out[i].ret = Math.log(out[i].price / out[i - 1].price);
    const net = new Array(n).fill(null);
    for (let i = c.inflowWindow; i < n; i++) net[i] = out[i].stable - out[i - c.inflowWindow].stable;
    for (let i = 0; i < n; i++) {
      const o = out[i];
      o.meme = hasMeme[i] ? meme[i] : null;
      // regime ratio: 7d avg meme volume (i-6..i) / 30d avg ending 7 days earlier (i-36..i-7)
      if (i >= 36 && hasMeme.slice(i - 36, i + 1).every(Boolean)) {
        const a7 = mean(meme.slice(i - 6, i + 1)), a30 = mean(meme.slice(i - 36, i - 6));
        o.meme7 = a7; o.meme30 = a30; o.regime = a30 > 0 ? a7 / a30 : null;
      } else { o.meme7 = null; o.meme30 = null; o.regime = null; }
      // SOL trend
      o.ma = i >= c.maWindow - 1 ? mean(out.slice(i - c.maWindow + 1, i + 1).map(x => x.price)) : null;
      o.aboveMA = o.ma != null ? o.price > o.ma : null;
      o.ret30 = i >= 30 ? o.price / out[i - 30].price - 1 : null;
      o.ret7 = i >= 7 ? o.price / out[i - 7].price - 1 : null;
      // stablecoin
      o.stable30 = i >= 30 ? o.stable / out[i - 30].stable - 1 : null;
      o.surge = o.stable30 != null && o.stable30 >= c.surgePct;
      o.inflow7 = net[i];
      if (i >= c.inflowWindow + c.inflowBaseline) { const b = net.slice(i - c.inflowBaseline, i); const sd = std(b); o.inflowZ = sd > 0 ? (net[i] - mean(b)) / sd : 0; } else o.inflowZ = null;
      // realized vol
      if (i >= c.volWindow) { const r = out.slice(i - c.volWindow + 1, i + 1).map(x => x.ret).filter(x => x != null); o.rvol = r.length > 2 ? std(r) * Math.sqrt(365) : null; } else o.rvol = null;
    }
    for (let i = 0; i < n; i++) {
      const o = out[i];
      const base = out.slice(Math.max(0, i - c.volBaseline), i).map(x => x.rvol).filter(x => x != null);
      o.volPct = o.rvol != null && base.length >= 60 ? pctRank(o.rvol, base) : null;
      o.state = classify(o, c);
    }
    return out;
  }

  // LIVE: regime >= hot.  DEAD: regime <= dead.  WARMING: warm <= regime < hot.  COOLING: everything else below 1 trending down.  NEUTRAL otherwise.
  function classify(o, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    if (o.regime == null) return 'Warming up';
    if (o.regime >= c.hot) return 'Live';
    if (o.regime <= c.dead) return 'Dead';
    if (o.regime >= c.warm) return 'Warming';
    return 'Neutral';
  }

  function stateTransitions(ind) {
    const log = []; let prev = null;
    for (let i = 0; i < ind.length; i++) { const s = ind[i].state; if (s !== prev) { log.push({ date: ind[i].date, state: s, from: prev, i }); prev = s; } }
    return log;
  }

  // Evidence: what happened in the week AFTER the ratio first crossed a level
  function backtest(ind, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    const n = ind.length;
    const nxt = i => (i + 7 < n && ind[i + 7].meme30 && ind[i].meme30) ? mean(ind.slice(i + 1, i + 8).map(x => x.meme)) / ind[i].meme30 : null;
    const rows = ind.map((o, i) => ({ o, i, next: nxt(i) })).filter(r => r.o.regime != null && r.next != null);
    const baseNext = rows.map(r => r.next);
    const level = (test) => {
      const eps = [];
      for (let k = 0; k < rows.length; k++) {
        const r = rows[k], prev = k > 0 ? rows[k - 1].o : null;
        if (test(r.o) && !(prev && test(prev))) {
          // peak 7d avg within 21 days
          let peakLag = 0, peak = 0;
          for (let j = r.i; j <= Math.min(n - 1, r.i + 21); j++) if (ind[j].meme7 != null && ind[j].meme7 > peak) { peak = ind[j].meme7; peakLag = j - r.i; }
          eps.push({ date: r.o.date, regime: r.o.regime, next: r.next, peakLag, aboveMA: r.o.aboveMA, ret30: r.o.ret30, sol7: (r.i + 7 < n) ? ind[r.i + 7].price / r.o.price - 1 : null });
        }
      }
      const days = rows.filter(r => test(r.o));
      return {
        episodes: eps, days: days.length,
        nextMedian: days.length ? median(days.map(r => r.next)) : null,
        pStay: days.length ? days.filter(r => r.next >= c.hot).length / days.length : null,
        medianPeakLag: eps.length ? median(eps.map(e => e.peakLag)) : null
      };
    };
    return {
      cfg: c,
      base: { nextMedian: median(baseNext), pHot: baseNext.filter(v => v >= c.hot).length / baseNext.length, pExpand: baseNext.filter(v => v >= c.warm).length / baseNext.length },
      live: level(o => o.regime >= c.hot),
      dead: Object.assign(level(o => o.regime <= c.dead), { pExpand: (() => { const d = rows.filter(r => r.o.regime <= c.dead); return d.length ? d.filter(r => r.next >= c.warm).length / d.length : null; })() }),
      trend: (() => {
        const a = rows.filter(r => r.o.aboveMA === true), b = rows.filter(r => r.o.aboveMA === false);
        const f = s => s.length ? s.filter(r => r.next >= c.warm).length / s.length : null;
        return { aboveN: a.length, above: f(a), belowN: b.length, below: f(b) };
      })()
    };
  }

  function latest(ind) { return ind[ind.length - 1]; }
  return { DAY, DEFAULTS, alignDaily, computeIndicators, classify, stateTransitions, backtest, latest, stats: { mean, std, median, pctRank } };
});
