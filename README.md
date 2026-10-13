# Liquidity Staging Monitor

Watches Solana for the setup where fresh stablecoin supply is building while SOL is unusually quiet, scores it against history, and messages you on Telegram only when the state changes.

**What's in here**

| File | Role |
|---|---|
| `engine.js` | The scoring logic. Shared by the collector and the dashboard so they can never disagree. |
| `collector.js` | Hourly job. Pulls feeds, scores, appends `data/history.json`, sends Telegram on a state change. |
| `index.html` | Dashboard. Pulls the same feeds in your browser, shows current state, the backtest with adjustable thresholds, and the state-change log. |
| `.github/workflows/monitor.yml` | Runs the collector every hour on GitHub's servers. Free. |
| `test_engine.js` | Synthetic-data test proving the engine catches planted setups and ignores noise. |

**States**

- **Quiet** – nothing unusual.
- **Staging** – 7-day net stablecoin growth ≥ 1σ above its 90-day norm *and* SOL 14-day realized vol in the bottom 30% of the last year, for 2+ consecutive days. This is the alert that matters.
- **Deploying** – combined pump.fun + PumpSwap + Raydium daily volume ≥ 1.75× its 30-day median. The staged money is moving.
- **Extended** – vol in the top 30% with no fresh inflow. Late.

Data: DefiLlama stablecoin, DEX-volume and price APIs. No keys needed.

## Setup (15 minutes)

1. **Create the repo.** New GitHub repository (private is fine), upload every file in this folder keeping the folder structure. `data/history.json` must exist (it ships empty).

2. **Telegram bot.** In Telegram, message `@BotFather`, send `/newbot`, follow the prompts, copy the token. Then message your new bot anything (so it can reply to you), and open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser; the number at `"chat":{"id":…}` is your chat id.

3. **Secrets.** Repo → Settings → Secrets and variables → Actions → New repository secret: `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

4. **Turn on the schedule.** Repo → Actions → enable workflows if prompted → "Liquidity staging monitor" → Run workflow. The first run records the baseline state and sends a message only if it's already Staging. After that you hear from it only on a change.

5. **Dashboard.** Repo → Settings → Pages → Source: Deploy from branch, branch `main`, folder `/ (root)`. Your dashboard will be at `https://<you>.github.io/<repo>/`. (Opening `index.html` straight from disk also works.)

## Tuning

The dashboard sliders re-run the backtest live. Start conservative; if the backtest at some setting shows a lift under ~1.5× or fewer than 4 episodes, don't trust it. To change what the collector alerts on, edit `DEFAULTS` in `engine.js` so the dashboard and the alerts stay in step.

## What it does not do

- It does not predict direction. It predicts that a volume regime change is likely. Which way SOL breaks after a Staging signal is a separate judgment.
- It does not see the intermediate step (stablecoin → SOL swaps, CEX SOL withdrawals) or pump.fun launch rate yet. Those need a Helius key and are the natural next additions.
