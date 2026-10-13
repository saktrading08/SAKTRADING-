# Memecoin Regime Monitor

Tells you whether the Solana memecoin market is live or dead, scores each state against history, and messages you on Telegram only when the state changes.

**Why this and not stablecoin inflows:** the original "stablecoins arriving + SOL quiet" thesis was backtested on Jan 2024–Oct 2026 data and showed no edge at any threshold (and heavy 30-day stablecoin surges actually preceded SOL drawdowns in 2024–25). What did hold: memecoin volume regimes persist once they start, and die hard once they stop. See `index.html` for the live evidence panel.

**What's in here**

| File | Role |
|---|---|
| `engine.js` | The scoring logic. Shared by the collector and the dashboard so they can never disagree. |
| `collector.js` | Hourly job. Pulls feeds, scores, appends `data/history.json`, sends Telegram on a state change. |
| `index.html` | Dashboard. Pulls the same feeds in your browser, shows current state, the backtest with adjustable thresholds, and the state-change log. |
| `.github/workflows/monitor.yml` | Runs the collector every hour on GitHub's servers. Free. |
| `test_engine.js` | Re-runs the evidence against `data/series.json` (real history) or synthetic data. |

**States** (regime = 7-day avg pump.fun + PumpSwap volume ÷ prior 30-day avg)

- **Live** – regime ≥ 1.5×. Historically the next week ran a median 2.1× and held above 1.5× 85% of the time; peak volume came ~19 days later.
- **Warming** – 1.3× to 1.5×. Early warning.
- **Neutral** – in between.
- **Dead** – regime ≤ 0.7×. Zero historical Dead days were followed by an expansion the next week. The stay-out signal.

Filters shown alongside: SOL above/below its 50-day average (regimes ran far more often above), SOL 30-day return (≥ 30% = extended), and a stablecoin-surge caution flag (30-day supply growth ≥ 15%).

Data: DefiLlama stablecoin, DEX-volume and price APIs. No keys needed.

## Setup (15 minutes)

1. **Create the repo.** New GitHub repository (private is fine), upload every file in this folder keeping the folder structure. `data/history.json` must exist (it ships empty).

2. **Telegram bot.** In Telegram, message `@BotFather`, send `/newbot`, follow the prompts, copy the token. Then message your new bot anything (so it can reply to you), and open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser; the number at `"chat":{"id":…}` is your chat id.

3. **Secrets.** Repo → Settings → Secrets and variables → Actions → New repository secret: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

4. **Turn on the schedule.** Repo → Actions → enable workflows if prompted → "Liquidity staging monitor" → Run workflow. The first run records the baseline state and sends a message only if it is already Live or Dead. After that you hear from it only on a change.

5. **Dashboard.** Repo → Settings → Pages → Source: Deploy from branch, branch `main`, folder `/ (root)`. Your dashboard will be at `https://<you>.github.io/<repo>/`. (Opening `index.html` straight from disk also works.)

## Tuning

Thresholds live in `DEFAULTS` in `engine.js` (hot 1.5, warm 1.3, dead 0.7). Edit there so the dashboard and the alerts stay in step. `node test_engine.js` re-runs the evidence against `data/series.json`.

## What it does not do

- It does not predict direction. It predicts that a volume regime change is likely. Which way SOL moves during a Live regime is a separate judgment.
- It confirms a regime rather than leading it. The leading layer (graduation rate, new-wallet share, stable→SOL rotation) needs the Helius key stored as the `HELIUS_API_KEY` secret and is the next addition.
