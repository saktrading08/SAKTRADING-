#!/usr/bin/env node
/* Memecoin Regime Monitor — collector
   Pulls the feeds, scores the current regime with engine.js, appends to data/history.json,
   and sends a Telegram message only when the state changes (or the caution flag flips).
   Run: node collector.js            (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID for alerts)
        node collector.js --dry-run  (no Telegram, no file writes) */
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const DAY = E.DAY;
const START = Date.UTC(2023, 0, 1) / 1000;
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY = path.join(DATA_DIR, 'history.json');
const SNAPSHOT = path.join(DATA_DIR, 'snapshot.json');
const SERIES = path.join(DATA_DIR, 'series.json');
const DRY = process.argv.includes('--dry-run');

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'memecoin-regime-monitor/2.0' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function loadPrices() {
  const out = []; const now = Math.floor(Date.now() / 1000);
  for (let s = START; s < now; s += 365 * DAY) {
    const span = Math.min(365, Math.ceil((now - s) / DAY) + 1);
    const j = await getJSON(`https://coins.llama.fi/chart/coingecko:solana?start=${s}&span=${span}&period=1d`);
    out.push(...(j.coins['coingecko:solana'].prices || []));
  }
  return out;
}
const loadVol = async slug => (await getJSON(`https://api.llama.fi/summary/dexs/${slug}?dataType=dailyVolume`)).totalDataChart || [];

async function fetchAll() {
  const [stable, prices, ...vol] = await Promise.all([
    getJSON('https://stablecoins.llama.fi/stablecoincharts/Solana'),
    loadPrices(),
    ...['pump.fun', 'pumpswap', 'raydium'].map(s => loadVol(s).catch(e => { console.warn('volume feed failed:', s, e.message); return []; }))
  ]);
  return { stable, prices, vols: { 'pump.fun': vol[0], pumpswap: vol[1], raydium: vol[2] } };
}

const fmtUSD = v => Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : (v / 1e6).toFixed(0) + 'M';
const fmtDate = t => new Date(t * 1000).toISOString().slice(0, 10);
const pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';

function message(cur, prevState, bt) {
  const head = { Live: '🟢 LIVE — memecoin window open', Warming: '🟡 WARMING — volume building', Neutral: '⚪ NEUTRAL', Dead: '🔴 DEAD — stay out' }[cur.state] || cur.state;
  const lines = [
    `${head}`,
    `${fmtDate(cur.date)} · was ${prevState || 'unknown'}`,
    `Memecoin volume: ${cur.regime.toFixed(2)}× its 30-day pace ($${fmtUSD(cur.meme7)}/day)`,
    `SOL $${cur.price.toFixed(0)} · ${cur.aboveMA ? 'above' : 'below'} 50-day avg · 30d ${pct(cur.ret30)}${cur.ret30 >= 0.3 ? ' (extended)' : ''}`,
    `Stablecoin supply 30d: ${pct(cur.stable30)}${cur.surge ? ' ⚠ surge flag' : ''}`
  ];
  if (bt && bt.live.episodes.length >= 5) lines.push(`History: after a Live signal the next week ran ${bt.live.nextMedian.toFixed(1)}× (base ${bt.base.nextMedian.toFixed(1)}×), held ${(bt.live.pStay * 100).toFixed(0)}% of the time`);
  if (cur.state === 'Dead') lines.push(`History: ${(bt.dead.pExpand * 100).toFixed(0)}% of Dead days were followed by an expansion`);
  return lines.join('\n');
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.log('[no telegram credentials] would send:\n' + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true })
  });
  if (!r.ok) throw new Error('telegram ' + r.status + ' ' + await r.text());
}

async function run(feeds) {
  feeds = feeds || await fetchAll();
  const rows = E.alignDaily({ ...feeds, start: START });
  const ind = E.computeIndicators(rows);
  E.stateTransitions(ind);
  const cur = E.latest(ind);
  const bt = E.backtest(ind.filter(o => o.date >= Date.UTC(2024, 0, 1) / 1000));

  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY, 'utf8')); } catch (e) {}
  const prev = history.length ? history[history.length - 1] : null;
  const prevState = prev ? prev.state : null;
  const prevSurge = prev ? !!prev.surge : false;

  const r3 = (v, d = 3) => v == null ? null : +v.toFixed(d);
  const entry = {
    ts: new Date().toISOString(), date: fmtDate(cur.date), state: cur.state,
    regime: r3(cur.regime), meme7: cur.meme7 == null ? null : Math.round(cur.meme7), meme30: cur.meme30 == null ? null : Math.round(cur.meme30),
    price: r3(cur.price, 2), aboveMA: cur.aboveMA, ret30: r3(cur.ret30), ret7: r3(cur.ret7),
    stable: Math.round(cur.stable), stable30: r3(cur.stable30), surge: cur.surge,
    inflow7: Math.round(cur.inflow7), inflowZ: r3(cur.inflowZ), rvol: r3(cur.rvol, 4), volPct: r3(cur.volPct, 1)
  };
  const changed = prevState !== null && prevState !== cur.state;
  const surgeFlipped = cur.surge !== prevSurge && prev !== null;
  console.log(JSON.stringify(entry));
  console.log(`state ${prevState || '(first run)'} -> ${cur.state}${changed ? '  CHANGED' : ''}${surgeFlipped ? '  SURGE FLAG ' + (cur.surge ? 'ON' : 'OFF') : ''}`);

  if (!DRY) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (prev && prev.date === entry.date) history[history.length - 1] = entry; else history.push(entry);
    fs.writeFileSync(HISTORY, JSON.stringify(history, null, 1));
    fs.writeFileSync(SERIES, JSON.stringify({
      updated: entry.ts,
      columns: ['date', 'price', 'stable', 'vol', 'vol_pump.fun', 'vol_pumpswap', 'vol_raydium'],
      rows: rows.map(r => [r.date, +r.price.toFixed(4), Math.round(r.stable), r.vol == null ? null : Math.round(r.vol),
        r['vol_pump.fun'] == null ? null : Math.round(r['vol_pump.fun']), r.vol_pumpswap == null ? null : Math.round(r.vol_pumpswap), r.vol_raydium == null ? null : Math.round(r.vol_raydium)])
    }));
    fs.writeFileSync(SNAPSHOT, JSON.stringify({ updated: entry.ts, current: entry, evidence: {
      base: bt.base, live: { days: bt.live.days, episodes: bt.live.episodes.length, nextMedian: bt.live.nextMedian, pStay: bt.live.pStay, medianPeakLag: bt.live.medianPeakLag },
      dead: { days: bt.dead.days, pExpand: bt.dead.pExpand }, trend: bt.trend
    } }, null, 1));
  }
  const firstRunAlert = prevState === null && (cur.state === 'Live' || cur.state === 'Dead');
  if (changed || surgeFlipped || firstRunAlert) {
    const text = (surgeFlipped && !changed ? (cur.surge ? '⚠ Stablecoin surge flag ON (30d growth over 15%; preceded SOL drawdowns in 2024–25)\n' : '⚠ Stablecoin surge flag OFF\n') : '') + message(cur, prevState, bt);
    if (DRY) console.log('[dry-run] would send:\n' + text); else await telegram(text);
  }
  return { entry, changed };
}

if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
module.exports = { run, message };
