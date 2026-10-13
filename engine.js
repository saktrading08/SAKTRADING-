/* Liquidity Staging Engine — pure functions, no DOM, no network.
   Used by the dashboard (browser) and by tests (Node). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LiqEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const DAY = 86400;

  // ---------- small stats helpers ----------
  function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
  function std(a) {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / Math.max(1, a.length - 1));
  }
  function median(a) {
    const s = a.slice().sort((x, y) => x - y);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  // percentile rank of x within array a (0..100)
  function pctRank(x, a) {
    if (!a.length) return NaN;
    let below = 0;
    for (const v of a) if (v < x) below++;
    return 100 * below / a.length;
  }

  // ---------- normalise raw feeds into aligned daily rows ----------
  // stable: [{date:unix, totalCirculatingUSD:{peggedUSD}}]
  // prices: [{timestamp:unix, price}]
  // vols:   { name: [[unix, usd], ...], ... }
  function alignDaily({ stable, prices, vols, start, end }) {
    const dayKey = t => Math.floor(t / DAY) * DAY;
    const map = new Map();
    const row = d => { if (!map.has(d)) map.set(d, { date: d }); return map.get(d); };

    for (const r of stable || []) {
      const v = r.totalCirculatingUSD && r.totalCirculatingUSD.peggedUSD;
      if (typeof v === 'number') row(dayKey(+r.date)).stable = v;
    }
    for (const p of prices || []) {
      if (typeof p.price === 'number') row(dayKey(p.timestamp)).price = p.price;
    }
    for (const [name, series] of Object.entries(vols || {})) {
      for (const [t, v] of series) {
        if (typeof v === 'number') {
          const r = row(dayKey(t));
          r.vol = (r.vol || 0) + v;
          r['vol_' + name] = v;
        }
      }
    }
    let rows = [...map.values()].sort((a, b) => a.date - b.date);
    if (start) rows = rows.filter(r => r.date >= start);
    if (end) rows = rows.filter(r => r.date <= end);
    // forward-fill stable & price gaps (weekend/API holes), never volume
    let lastS = null, lastP = null;
    for (const r of rows) {
      if (r.stable == null) r.stable = lastS; else lastS = r.stable;
      if (r.price == null) r.price = lastP; else lastP = r.price;
    }
    return rows.filter(r => r.stable != null && r.price != null);
  }

  // ---------- indicators ----------
  const DEFAULTS = {
    inflowWindow: 7,     // days of net stablecoin change
    inflowBaseline: 90,  // days for z-score baseline
    volWindow: 14,       // realized-vol window
    volBaseline: 365,    // percentile lookback
    volumeBaseline: 30,  // median window for volume spike
    spikeMult: 1.75,     // spike = volume > mult * median
    zThresh: 1.0,        // staging if inflow z >= this
    volPctThresh: 30,    // and vol percentile <= this
    horizon: 7,           // days ahead to look for a spike
    minDays: 2            // consecutive staging days before it counts
  };

  function computeIndicators(rows, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    const n = rows.length;
    const out = rows.map(r => Object.assign({}, r));

    // daily log returns
    for (let i = 1; i < n; i++) out[i].ret = Math.log(out[i].price / out[i - 1].price);

    const netChg = new Array(n).fill(null);
    for (let i = c.inflowWindow; i < n; i++) netChg[i] = out[i].stable - out[i - c.inflowWindow].stable;

    for (let i = 0; i < n; i++) {
      const o = out[i];
      o.inflow7 = netChg[i];
      // z-score of 7d net change vs trailing baseline of 7d net changes
      if (i >= c.inflowWindow + c.inflowBaseline) {
        const base = netChg.slice(i - c.inflowBaseline, i).filter(x => x != null);
        const sd = std(base);
        o.inflowZ = sd > 0 ? (netChg[i] - mean(base)) / sd : 0;
      } else o.inflowZ = null;

      // realized vol (annualised) over volWindow
      if (i >= c.volWindow) {
        const rets = out.slice(i - c.volWindow + 1, i + 1).map(x => x.ret).filter(x => x != null);
        o.rvol = rets.length > 2 ? std(rets) * Math.sqrt(365) : null;
      } else o.rvol = null;
    }
    for (let i = 0; i < n; i++) {
      const o = out[i];
      if (o.rvol != null && i >= c.volWindow + 60) {
        const base = out.slice(Math.max(0, i - c.volBaseline), i).map(x => x.rvol).filter(x => x != null);
        o.volPct = base.length >= 60 ? pctRank(o.rvol, base) : null;
      } else o.volPct = null;

      // volume vs trailing median
      if (o.vol != null && i >= c.volumeBaseline) {
        const base = out.slice(i - c.volumeBaseline, i).map(x => x.vol).filter(x => x != null);
        o.volMedian = base.length >= 10 ? median(base) : null;
        o.volRatio = o.volMedian ? o.vol / o.volMedian : null;
        o.spike = o.volRatio != null && o.volRatio >= c.spikeMult;
      } else { o.volMedian = null; o.volRatio = null; o.spike = false; }

      // 30d SOL return (for context)
      o.ret30 = i >= 30 ? out[i].price / out[i - 30].price - 1 : null;

      o.staging = o.inflowZ != null && o.volPct != null && o.inflowZ >= c.zThresh && o.volPct <= c.volPctThresh;
      o.streak = o.staging ? ((i > 0 && out[i - 1].streak) || 0) + 1 : 0;
    }
    return out;
  }

  // ---------- state machine ----------
  // Quiet -> Staging (powder + compression) -> Deploying (spike while/after staging) -> Extended (vol high, powder gone)
  function classify(o, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    if (o.inflowZ == null || o.volPct == null) return 'Warming up';
    if (o.spike) return 'Deploying';
    if (o.staging && (o.streak || 1) >= c.minDays) return 'Staging';
    if (o.volPct >= 70) return 'Extended';
    return 'Quiet';
  }

  function stateTransitions(ind, cfg) {
    const log = [];
    let prev = null;
    for (let i = 0; i < ind.length; i++) {
      const s = classify(ind[i], cfg);
      ind[i].state = s;
      if (s !== prev) {
        log.push({ date: ind[i].date, state: s, from: prev, i });
        prev = s;
      }
    }
    return log;
  }

  // ---------- backtest ----------
  function backtest(ind, cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    const n = ind.length;
    const valid = ind.map((o, i) => o.inflowZ != null && o.volPct != null && o.volRatio != null && i + c.horizon < n);

    // Signal episodes: consecutive staging days collapsed into one event, dated at first day
    const episodes = [];
    for (let i = 0; i < n; i++) {
      if (!valid[i]) continue;
      if (ind[i].staging && (i === 0 || !ind[i - 1].staging)) {
        let j = i; while (j + 1 < n && ind[j + 1].staging) j++;
        // first spike within horizon of episode start
        const endK = Math.min(n - 1, j + c.horizon);
        let hit = null;
        for (let k = i + 1; k <= endK; k++) if (ind[k].spike) { hit = k; break; }
        // peak volume ratio through episode + horizon, SOL move over same span
        let peakRatio = 0;
        for (let k = i + 1; k <= endK; k++) peakRatio = Math.max(peakRatio, ind[k].volRatio || 0);
        const solFwd = ind[endK].price / ind[i].price - 1;
        if (j - i + 1 >= c.minDays) episodes.push({
          start: ind[i].date, end: ind[j].date, days: j - i + 1,
          inflowZ: ind[i].inflowZ, volPct: ind[i].volPct,
          hit: hit != null, leadDays: hit != null ? hit - i : null,
          peakRatio, solFwd
        });
        i = j;
      }
    }

    // Base rate: any valid day -> spike within horizon
    let baseN = 0, baseHit = 0, sigN = 0, sigHit = 0;
    for (let i = 0; i < n; i++) {
      if (!valid[i]) continue;
      let hit = false;
      for (let k = i + 1; k <= Math.min(n - 1, i + c.horizon); k++) if (ind[k].spike) { hit = true; break; }
      baseN++; if (hit) baseHit++;
      if (ind[i].staging && ind[i].streak >= c.minDays) { sigN++; if (hit) sigHit++; }
    }
    const hits = episodes.filter(e => e.hit);
    const spikes = ind.filter((o, i) => valid[i] && o.spike).length;
    return {
      cfg: c,
      episodes,
      episodeCount: episodes.length,
      episodeHitRate: episodes.length ? hits.length / episodes.length : null,
      medianLead: hits.length ? median(hits.map(e => e.leadDays)) : null,
      dayHitRate: sigN ? sigHit / sigN : null,
      baseRate: baseN ? baseHit / baseN : null,
      lift: (sigN && baseN && baseHit) ? (sigHit / sigN) / (baseHit / baseN) : null,
      signalDays: sigN, validDays: baseN, spikeDays: spikes,
      medianSolFwd: episodes.length ? median(episodes.map(e => e.solFwd)) : null
    };
  }

  function latest(ind) { return ind[ind.length - 1]; }

  return { DAY, DEFAULTS, alignDaily, computeIndicators, classify, stateTransitions, backtest, latest, stats: { mean, std, median, pctRank } };
});
