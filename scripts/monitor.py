#!/usr/bin/env python3
"""
PriceDrop monitor — runs in GitHub Actions on a schedule.

Reads watchlist.json, scrapes the current price for each Amazon/Flipkart product
(best-effort), updates data/prices.json with a price-history point, and emails the
recipients in ALERT_RECIPIENTS whenever a price drops or a sale is detected.

Environment (set as GitHub Actions secrets):
    GMAIL_USER            sender Gmail address
    GMAIL_APP_PASSWORD    16-char Gmail app password
    ALERT_RECIPIENTS      comma-separated recipient emails
"""

import hashlib
import json
import os
import re
import smtplib
import sys
import time
from datetime import datetime, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
WATCHLIST = ROOT / "watchlist.json"
PRICES = ROOT / "data" / "prices.json"
MAX_HISTORY = 200  # cap history points per product

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-IN,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    # NOTE: do NOT advertise brotli ("br") here — `requests` can't decode it unless the
    # optional brotli package is installed, and the sites serve br, giving a garbled body.
    # Leaving this header out lets requests advertise only what it can actually decode.
    "Cache-Control": "no-cache",
    "Upgrade-Insecure-Requests": "1",
}

# Markers that mean we got a bot/CAPTCHA wall instead of the real product page.
BOT_MARKERS = (
    "api-services-support",
    "enter the characters you see below",
    "to discuss automated access",
    "/errors/validatecaptcha",
    "type the characters",
    "robot check",
)


# ----------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------
def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def load_json(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def item_id(url: str) -> str:
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]


def to_number(text):
    """Extract the first price-looking number from a string -> float or None."""
    if text is None:
        return None
    m = re.search(r"[\d][\d,]*\.?\d*", str(text).replace("₹", ""))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


def fetch(url: str, retries: int = 4):
    last = None
    for attempt in range(retries):
        try:
            r = requests.get(url, headers=HEADERS, timeout=25)
            text = r.text
            low = text.lower()
            if any(m in low for m in BOT_MARKERS):
                last = "bot/CAPTCHA wall"
            elif r.status_code == 200 and len(text) > 1500:
                return text
            else:
                last = f"status {r.status_code}, len {len(text)}"
        except requests.RequestException as e:
            last = str(e)
        time.sleep(3 * (attempt + 1))  # backoff; gives blocked IPs a chance to recover
    print(f"    fetch failed: {last}")
    return None


# ----------------------------------------------------------------------------
# parsing (best-effort, multiple fallbacks)
# ----------------------------------------------------------------------------
def parse_jsonld(soup):
    """Try schema.org JSON-LD offers -> (price, currency, name, image)."""
    for tag in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(tag.string or "")
        except (json.JSONDecodeError, TypeError):
            continue
        for node in data if isinstance(data, list) else [data]:
            if not isinstance(node, dict):
                continue
            offers = node.get("offers")
            if isinstance(offers, list):
                offers = offers[0] if offers else None
            if isinstance(offers, dict) and offers.get("price"):
                return (
                    to_number(offers.get("price")),
                    offers.get("priceCurrency") or "₹",
                    node.get("name"),
                    _first_image(node.get("image")),
                )
    return None


def _first_image(img):
    if isinstance(img, list):
        return img[0] if img else None
    return img


def parse_amazon(soup):
    price = None
    for sel in (
        "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
        "#corePrice_feature_div .a-price .a-offscreen",
        "#apex_desktop .a-price .a-offscreen",
        "span.a-price span.a-offscreen",
        "#tp_price_block_total_price_ww .a-offscreen",
        "#priceblock_ourprice",
        "#priceblock_dealprice",
        "span.a-price-whole",
    ):
        el = soup.select_one(sel)
        if el:
            price = to_number(el.get_text())
            if price:
                break
    # scoped fallback: a ₹ amount inside a known price container (avoids EMI/other numbers)
    if price is None:
        box = soup.select_one("#corePrice_feature_div, #apex_desktop, #buybox, #price")
        if box:
            m = re.search(r"₹\s?([\d,]{3,})", box.get_text(" ", strip=True))
            if m:
                price = to_number(m.group(1))
    title_el = soup.select_one("#productTitle")
    img_el = soup.select_one("#landingImage, #imgBlkFront")
    on_sale = bool(soup.select_one("#dealBadge, .dealBadge, .savingsPercentage, #savingsPercentage"))
    return (
        price,
        "₹",
        title_el.get_text(strip=True) if title_el else None,
        img_el.get("src") if img_el else None,
        on_sale,
    )


def parse_flipkart(soup):
    price = None
    # Flipkart obfuscates class names and changes them often; try a few + regex fallback.
    for sel in ("div.Nx9bqj.CxhGGd", "div._30jeq3._16Jk6d", "div._30jeq3"):
        el = soup.select_one(sel)
        if el:
            price = to_number(el.get_text())
            if price:
                break
    if price is None:
        m = re.search(r"₹\s?([\d,]+)", soup.get_text())
        if m:
            price = to_number(m.group(1))
    title_el = soup.select_one("span.VU-ZEz, span.B_NuCI, h1")
    img_el = soup.select_one("img._396cs4, img._53J4C-, img.DByuf4")
    txt = soup.get_text().lower()
    on_sale = ("% off" in txt) or bool(soup.select_one("div._3Ay6Sb, div.UkUFwK"))
    return (
        price,
        "₹",
        title_el.get_text(strip=True) if title_el else None,
        img_el.get("src") if img_el else None,
        on_sale,
    )


def scrape(url: str, site: str):
    """Return dict(price, currency, title, image, on_sale) or None."""
    html = fetch(url)
    if not html:
        return None
    soup = BeautifulSoup(html, "lxml")

    if site == "amazon":
        price, cur, title, image, on_sale = parse_amazon(soup)
    elif site == "flipkart":
        price, cur, title, image, on_sale = parse_flipkart(soup)
    else:
        price = cur = title = image = None
        on_sale = False

    # JSON-LD fallback for anything still missing
    if price is None or not title or not image:
        ld = parse_jsonld(soup)
        if ld:
            ld_price, ld_cur, ld_name, ld_img = ld
            price = price or ld_price
            cur = cur or ld_cur
            title = title or ld_name
            image = image or ld_img

    # Open Graph fallbacks (reliable for image + title on both sites)
    if not image:
        og = soup.select_one('meta[property="og:image"]')
        if og and og.get("content"):
            image = og["content"]
    if not title:
        ogt = soup.select_one('meta[property="og:title"]')
        if ogt and ogt.get("content"):
            title = ogt["content"]

    if price is None:
        return None
    return {
        "price": price,
        "currency": cur or "₹",
        "title": title,
        "image": image,
        "on_sale": bool(on_sale),
    }


# ----------------------------------------------------------------------------
# email
# ----------------------------------------------------------------------------
def send_email(subject, html_body):
    user = os.environ.get("GMAIL_USER")
    pw = os.environ.get("GMAIL_APP_PASSWORD")
    recipients = [e.strip() for e in os.environ.get("ALERT_RECIPIENTS", "").split(",") if e.strip()]
    if not (user and pw and recipients):
        print("  ! email not configured (GMAIL_USER / GMAIL_APP_PASSWORD / ALERT_RECIPIENTS) — skipping send")
        return False
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"PriceDrop <{user}>"
    msg["To"] = ", ".join(recipients)
    msg.attach(MIMEText(html_body, "html"))
    try:
        with smtplib.SMTP("smtp.gmail.com", 587, timeout=30) as s:
            s.starttls()
            s.login(user, pw)
            s.sendmail(user, recipients, msg.as_string())
        print(f"  ✉ emailed {len(recipients)} recipient(s)")
        return True
    except Exception as e:  # noqa: BLE001 — never let email crash the run
        print(f"  ! email failed: {e}")
        return False


def alert_html(title, url, old, new, currency, on_sale):
    pct = round((old - new) / old * 100) if old else 0
    reason = "On sale now!" if on_sale else f"Price dropped {pct}%"
    return f"""\
<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;background:#0a0b12;color:#eef0f7;padding:24px;border-radius:16px">
  <h2 style="margin:0 0 4px;color:#2ee6a6">\U0001f53b {reason}</h2>
  <p style="color:#9aa0b5;margin:0 0 16px">A product on your PriceDrop watchlist just got cheaper.</p>
  <p style="font-size:16px;font-weight:bold;margin:0 0 8px">{title or url}</p>
  <p style="font-size:15px;margin:0 0 4px">
    <span style="text-decoration:line-through;color:#9aa0b5">{currency}{old:,.0f}</span>
    &nbsp;&rarr;&nbsp;
    <span style="font-size:22px;font-weight:bold;color:#2ee6a6">{currency}{new:,.0f}</span>
  </p>
  <a href="{url}" style="display:inline-block;margin-top:16px;background:linear-gradient(135deg,#7c5cff,#22d3ee);color:#0a0b12;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px">
    Buy now ↗
  </a>
  <p style="color:#666;font-size:12px;margin-top:20px">Sent by your self-hosted PriceDrop tracker.</p>
</div>"""


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def main():
    watchlist = load_json(WATCHLIST, [])
    prices = load_json(PRICES, {})
    if not watchlist:
        print("Watchlist is empty — nothing to check.")
        save_json(PRICES, prices)
        return

    alerts = 0
    checked = 0
    for item in watchlist:
        url = item.get("url")
        if not url:
            continue
        pid = item.get("id") or item_id(url)
        site = item.get("site") or ("amazon" if "amazon." in url else "flipkart")
        print(f"[{site}] {url}")

        result = scrape(url, site)
        rec = prices.get(pid, {})
        prev_price = rec.get("currentPrice")

        if not result:
            print("    -> no price parsed (blocked or layout changed); keeping previous data")
            rec.setdefault("title", item.get("title") or url)
            rec["url"] = url
            rec["site"] = site
            # note the failed attempt but don't overwrite last good price
            rec["lastAttempt"] = now_iso()
            prices[pid] = rec
            continue

        checked += 1
        new_price = result["price"]
        print(f"    -> {result['currency']}{new_price:,.0f}"
              + ("  [SALE]" if result["on_sale"] else ""))

        # decide whether to alert BEFORE we overwrite currentPrice
        target = item.get("targetPrice")
        is_drop = prev_price is not None and new_price < prev_price
        meets_target = (target is None) or (new_price <= target)
        should_alert = ((is_drop and meets_target) or (result["on_sale"] and meets_target)) \
            and not rec.get("alertedAt_matches") == new_price

        # update record
        history = rec.get("history", [])
        # only append a history point if price changed or it's the first point
        if not history or history[-1].get("price") != new_price:
            history.append({"t": now_iso(), "price": new_price})
        history = history[-MAX_HISTORY:]

        prices[pid] = {
            "title": result["title"] or rec.get("title") or item.get("title") or url,
            "image": result["image"] or rec.get("image"),
            "url": url,
            "site": site,
            "currentPrice": new_price,
            "currency": result["currency"],
            "onSale": result["on_sale"],
            "lastChecked": now_iso(),
            "history": history,
            # remember what price we last alerted on, to debounce repeats
            "alertedAt_matches": rec.get("alertedAt_matches"),
        }

        if should_alert and prev_price is not None:
            title = prices[pid]["title"]
            subj = f"\U0001f53b Price drop: {title[:60]}"
            if send_email(subj, alert_html(title, url, prev_price, new_price,
                                           result["currency"], result["on_sale"])):
                prices[pid]["alertedAt_matches"] = new_price
                alerts += 1

        time.sleep(2)  # be polite between requests

    save_json(PRICES, prices)
    print(f"\nDone. Checked {checked}/{len(watchlist)} products, sent {alerts} alert email(s).")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"FATAL: {e}", file=sys.stderr)
        sys.exit(1)
