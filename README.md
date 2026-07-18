# 🔻 PriceDrop

A free **Amazon & Flipkart price-drop tracker**. Add products (by link *or* by searching), see them
on an animated dashboard, and get **emailed the moment a price drops or a sale appears**.

## Architecture (all free)

| Piece | Runs on | Job |
|---|---|---|
| Dashboard + Add/Search/Recipients UI | **Vercel** (static) | what you see & click |
| `/api/*` backend | **Vercel** serverless functions | add / search Flipkart / manage recipients |
| Hourly price checker + emailer | **GitHub Actions** (`scripts/monitor.py`) | scrape prices, detect drops, send email |
| "Database" | JSON files in this repo | `watchlist.json`, `data/prices.json` |
| Recipient emails | **encrypted GitHub secret** `ALERT_RECIPIENTS` | never stored in the public repo |

```
Browser ──► Vercel (static site + /api) ──► GitHub repo (watchlist.json)
                                     └─────► triggers GitHub Actions monitor
GitHub Actions (hourly) ──► scrape ──► email on drop ──► commit prices.json ──► Vercel redeploys
```

Why a backend? A static page can't write to GitHub without exposing a token, and Flipkart **search**
must be scraped server-side (browser CORS blocks it). The Vercel functions hold the token secretly and
do the scraping.

---

## Setup

### 1. Deploy to Vercel (hosts the site + API)
1. Go to **[vercel.com](https://vercel.com)** → sign up with GitHub (free).
2. **Add New → Project → Import** the `shoppingalert` repo. Framework preset: **Other**. Click **Deploy**.
3. After it deploys, open **Project → Settings → Environment Variables** and add:
   | Name | Value |
   |---|---|
   | `GITHUB_TOKEN` | a token that can write this repo (see below) |
   | `GH_OWNER` | `SHIVA-SAGAR-SHETTY` |
   | `GH_REPO` | `shoppingalert` |
4. **Redeploy** (Deployments → ⋯ → Redeploy) so the env vars take effect.
5. Your site is live at `https://<project>.vercel.app`.

**The `GITHUB_TOKEN`** needs, on this repo: **Contents: Read/write**, **Actions: Read/write** (to trigger
the monitor), and **Secrets: Read/write** (to store recipient emails). A
[fine-grained token](https://github.com/settings/personal-access-tokens/new) scoped to only
`shoppingalert` with those three permissions is ideal.

### 2. Email secrets (for sending alerts) — GitHub repo → Settings → Secrets → Actions
| Secret | Value |
|---|---|
| `GMAIL_USER` | your Gmail address (sender) |
| `GMAIL_APP_PASSWORD` | 16-char [Google App Password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification) |

> You don't set `ALERT_RECIPIENTS` by hand — add recipients from the site's **✉ Alert emails** button.
> It's stored encrypted automatically.

### 3. Enable GitHub Actions
It's on by default. The monitor runs hourly; run it now anytime via **Actions → Price monitor → Run workflow**.

---

## Using it
- **Add by link:** paste an Amazon/Flipkart product URL → **Add**. Optional target price = only alert at/below it.
- **Add by search:** type e.g. `asics novablast shoes` → it adds Flipkart's **top 3** results.
- **Recipients:** **✉ Alert emails** → enter emails (one per line) → Save.
- Cards with a **price drop or sale sort to the top** automatically.

## Local development
```bash
# scraper
pip install -r scripts/requirements.txt
GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=xxxx ALERT_RECIPIENTS=you@gmail.com python scripts/monitor.py

# backend (needs Vercel CLI: npm i -g vercel)
GITHUB_TOKEN=... vercel dev
```

## Known limitations
- **Flipkart works reliably** (links *and* search). **Amazon is best-effort** — it serves bots a
  CAPTCHA and often strips the price from the HTML, so Amazon items may show **⚠ stale**.
- GitHub Actions cron is best-effort (hourly, can be delayed a few minutes).
- Site selectors change occasionally and may need updates (`scripts/monitor.py`, `api/_lib/scrape.js`).
- The site is public-write (anyone can add). Basic caps are in place (max 60 items, max 25 recipients).
