# 🔻 PriceDrop

A free, self-hosted **Amazon & Flipkart price-drop tracker**. Add product links on an animated
dashboard; a scheduled robot checks their prices every hour and **emails you (and anyone you list)
the moment a price drops or a sale appears.**

Everything runs on **GitHub for $0**:

| Piece | Runs on |
|---|---|
| Dashboard UI | **GitHub Pages** (static site) |
| Hourly price checker + emailer | **GitHub Actions** (scheduled `scripts/monitor.py`) |
| "Database" | JSON files in this repo (`watchlist.json`, `data/prices.json`) |
| Emails | **Gmail SMTP** (app password) |

Live site: **https://shiva-sagar-shetty.github.io/shoppingalert/**

---

## How it works

```
Dashboard (Pages)  ──reads──►  watchlist.json + data/prices.json
      │  Add/remove (owner only, via GitHub API with a browser-stored token)
      ▼
GitHub Actions (hourly)  ──►  scrape prices  ──►  detect drop/sale  ──►  email
      │
      └──►  commit data/prices.json  ──►  Pages auto-updates
```

---

## One-time setup

### 1. Email secrets (so alerts can send)
Create a **Gmail App Password**: Google Account → Security → 2-Step Verification → **App passwords**
→ generate a 16-character password.

Then in this repo go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|---|---|
| `GMAIL_USER` | your Gmail address (the sender) |
| `GMAIL_APP_PASSWORD` | the 16-char app password (no spaces) |
| `ALERT_RECIPIENTS` | comma-separated recipient emails, e.g. `me@x.com, mom@y.com` |

> Recipient emails live in this **secret**, not in the public repo, so they aren't exposed to scrapers.

### 2. Enable GitHub Pages
**Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / root → Save.**

### 3. Get an admin token for the Add button
The Add/Remove buttons commit to `watchlist.json` via the GitHub API, so they need a token that is
stored **only in your browser** (never uploaded):

1. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new).
2. Repository access → **Only select repositories** → `shoppingalert`.
3. Permissions → Repository → **Contents → Read and write**.
4. Open the site, click **⚙︎**, paste the token, Save. Now **＋ Add product** works.

---

## Adding products
Click **＋ Add product**, paste an Amazon or Flipkart URL, optionally set a target price
(you'll only be alerted at/below it), and Add. The first price shows up after the next hourly run
(or trigger it now: **Actions → Price monitor → Run workflow**).

## Run / test locally
```bash
pip install -r scripts/requirements.txt
export GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxx ALERT_RECIPIENTS=you@gmail.com
python scripts/monitor.py
```
To test an alert email, lower a `currentPrice` in `data/prices.json` won't help (it compares to previous);
instead add a product, let it record once, then manually raise its stored price and rerun so the next real
price reads as a "drop".

---

## Known limitations (be realistic)
- **Amazon/Flipkart block bots.** Requests from GitHub's shared IPs sometimes get CAPTCHAs / 503s, so a
  check may be skipped (the card shows **⚠ stale**). The tracker fails soft and keeps the last good price.
- **Cron is best-effort** — hourly runs can be delayed 5–20 min under GitHub load.
- **Site layouts change**, so price selectors in `scripts/monitor.py` (`parse_amazon` / `parse_flipkart`)
  may need occasional updates.

## Adjust check frequency
Edit the `cron` line in [`.github/workflows/monitor.yml`](.github/workflows/monitor.yml). Hourly is the
practical floor for scheduled workflows.
