#!/usr/bin/env node
/* Liquidity Staging Monitor — collector
   Pulls the feeds, scores the current state with engine.js, appends to data/history.json,
   and sends a Telegram message only when the state changes.
   Run: node collector.js            (needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID for alerts)
        node collector.js --dry-run  (no Telegram, no file writes) */
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const DAY = E.DAY;
const START = Date.UTC(2023, 0, 1) / 1000;
const DATA_DIR = path.join(__dirname, 'data');
const HISTORY = path.join(DATA_DIR, 'history.json');
const SNAPSHOT = path.join(DATA_DIR, 'snapshot.json');
const SERIES = path.join(DATA_DIR, 'series.json');   // full aligned daily history, for offline analysis
const DRY = process.argv.includes('--dry-run');

async function getJSON(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'liquidity-staging-monitor/1.0' } });
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

function fmtUSD(v) { return Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : (v / 1e6).toFixed(0) + 'M'; }
const fmtDate = t => new Date(t * 1000).toISOString().slice(0, 10);

function message(cur, prev, bt) {
  const head = { Staging: '🟠 STAGING', Deploying: '🟢 DEPLOYING', Extended: '🔴 EXTENDED', Quiet: '⚪ QUIET' }[cur.state] || cur.state;
  const lines = [
    `${head}  (was ${prev || 'unknown'})  ${fmtDate(cur.date)}`,
    `Stablecoin 7d net: ${cur.inflow7 >= 0 ? '+' : '−'}$${fmtUSD(Math.abs(cur.inflow7))}  z=${cur.inflowZ.toFixed(2)}`,
    `SOL 14d vol: ${(cur.rvol * 100).toFixed(0)}%  p${cur.volPct.toFixed(0)} of last year`,
    `DEX volume: ${cur.volRatio == null ? 'n/a' : cur.volRatio.toFixed(2) + '× 30d median'}`,
  ];
  if (bt && bt.episodeCount >= 4 && bt.lift != null) lines.push(`Backtest: ${bt.episodeCount} episodes, ${(bt.episodeHitRate * 100).toFixed(0)}% hit, ${bt.lift.toFixed(1)}× base`);
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

  const entry = {
    ts: new Date().toISOString(), date: fmtDate(cur.date), state: cur.state,
    price: +cur.price.toFixed(2), stable: Math.round(cur.stable), inflow7: Math.round(cur.inflow7),
    inflowZ: +cur.inflowZ.toFixed(3), rvol: +cur.rvol.toFixed(4), volPct: +cur.volPct.toFixed(1),
    vol: cur.vol == null ? null : Math.round(cur.vol), volRatio: cur.volRatio == null ? null : +cur.volRatio.toFixed(3),
    streak: cur.streak
  };
  const changed = prevState !== null && prevState !== cur.state;
  console.log(JSON.stringify(entry));
  console.log(`state ${prevState || '(first run)'} -> ${cur.state}${changed ? '  CHANGED' : ''}`);

  if (!DRY) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // one row per calendar day: replace today's row if the collector runs more than once a day
    if (prev && prev.date === entry.date) history[history.length - 1] = entry; else history.push(entry);
    fs.writeFileSync(HISTORY, JSON.stringify(history, null, 1));
    fs.writeFileSync(SERIES, JSON.stringify({
      updated: entry.ts,
      columns: ['date', 'price', 'stable', 'vol', 'vol_pump.fun', 'vol_pumpswap', 'vol_raydium'],
      rows: rows.map(r => [r.date, +r.price.toFixed(4), Math.round(r.stable), r.vol == null ? null : Math.round(r.vol),
        r['vol_pump.fun'] == null ? null : Math.round(r['vol_pump.fun']), r.vol_pumpswap == null ? null : Math.round(r.vol_pumpswap), r.vol_raydium == null ? null : Math.round(r.vol_raydium)])
    }));
    fs.writeFileSync(SNAPSHOT, JSON.stringify({ updated: entry.ts, current: entry, backtest: {
      episodeCount: bt.episodeCount, episodeHitRate: bt.episodeHitRate, baseRate: bt.baseRate, lift: bt.lift, medianLead: bt.medianLead
    } }, null, 1));
  }
  if (changed || (prevState === null && cur.state === 'Staging')) {
    const text = message(cur, prevState, bt);
    if (DRY) console.log('[dry-run] would send:\n' + text); else await telegram(text);
  }
  return { entry, changed };
}

if (require.main === module) run().catch(e => { console.error(e); process.exit(1); });
module.exports = { run, message };
