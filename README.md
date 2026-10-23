# Hyperliquid Miner (HYPE MINER)

Production-ready **Telegram Mini App** for HYPE mining on the TON ecosystem.  
Same features as the original HYPE MINER — ready for **GitHub** + **Cloudflare Workers** (or classic Node hosts).

## Features

- Telegram WebApp authentication (`initData` HMAC validation)
- Persistent mining (energy, cooldown, daily limits, levels)
- Tasks with claim flow
- Referral squad (invite links, bonus, commission)
- Profile + TON wallet linking (public address only)
- Live mining pool / network stats
- Admin panel (users, rates, tasks, withdrawals)
- Rate limiting and transactional balance updates
- 8-hour mining-pause Telegram reminders (DIGGO-style)

## Quick start (local Node)

```bash
npm install
cp .env.example .env
# Edit .env → BOT_TOKEN, JWT_SECRET, ADMIN_PASSWORD, WEBAPP_URL
npm start
```

Open http://localhost:3000  
Admin: http://localhost:3000/hq-control

## Deploy to GitHub

1. Create a new repo on GitHub (e.g. `hyperliquid-miner`).
2. Push this folder:

```bash
git init
git add .
git commit -m "Hyperliquid Miner — ready for Cloudflare / Node"
git branch -M main
git remote add origin https://github.com/YOUR_USER/hyperliquid-miner.git
git push -u origin main
```

Then connect the repo to Cloudflare (or Render / Railway).

## Deploy to Cloudflare Workers

This project uses the new **Node.js HTTP server support** on Cloudflare Workers (`nodejs_compat` + `httpServerHandler`), so the Express app runs almost unchanged.

### 1. Create KV namespace (for persistent data)

```bash
npx wrangler kv namespace create HYPE_DB
npx wrangler kv namespace create HYPE_DB --preview
```

Copy the IDs into `wrangler.toml` (`id` and `preview_id`).

### 2. Set secrets

```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put REFERRAL_SALT
npx wrangler secret put WEBAPP_URL          # https://hyperliquid-miner.YOUR_SUBDOMAIN.workers.dev
npx wrangler secret put COMMUNITY_CHANNEL_URL
# optional
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put BOT_USERNAME
```

### 3. Deploy

```bash
npm install
npx wrangler deploy
```

Or from Cloudflare Dashboard → Workers & Pages → Create → Connect to Git → select this repo → build command empty / start with Wrangler.

### 4. BotFather

Set the Mini App URL to your Workers URL (HTTPS).

Admin panel: `https://YOUR-WORKER.workers.dev/hq-control` (open in browser, not inside Telegram).

### Notes on Cloudflare persistence

- With **HYPE_DB** KV binding the full JSON store is saved/loaded automatically.
- Without KV the store lives only in the isolate memory (lost on cold start / recycle).
- Cron trigger (`*/5 * * * *`) runs the mining-pause notifier.
- Static assets are served from `public/` via the assets binding + Express fallback.

## Classic Node hosts (Render / Railway / Fly / VPS)

```bash
npm install
# Set env vars from .env.example
# On Render: attach Persistent Disk and set DB_PATH=/data/hype.json
npm start
```

## Environment variables

See `.env.example`. Critical ones:

| Variable | Description |
|----------|-------------|
| `BOT_TOKEN` | Telegram bot token |
| `JWT_SECRET` | Long random string (≥32 chars) |
| `ADMIN_PASSWORD` | Admin panel password |
| `WEBAPP_URL` | Public HTTPS URL of the Mini App |
| `COMMUNITY_CHANNEL_URL` | Telegram channel for “Join Community” button |
| `DB_PATH` | (Node only) Path to JSON file, e.g. `/data/hype.json` |
| `WITHDRAWALS_ENABLED` | `true` only after real TON signing is configured |

## Admin panel

- Path: `/hq-control` or `/admin` (browser only)
- Credentials: `ADMIN_USERNAME` / `ADMIN_PASSWORD`

## Security

- Never store seed phrases or private keys.
- Withdrawals stay closed until you enable them and implement secure TON signing.
- Mining rates, cooldowns and rewards are editable from the admin panel.

## License

MIT
