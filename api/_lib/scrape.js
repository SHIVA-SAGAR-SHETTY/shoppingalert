// Shared scraping helpers (Node / Vercel). Mirrors scripts/monitor.py logic.
import * as cheerio from "cheerio";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// NOTE: we deliberately do NOT set Accept-Encoding — undici (Node fetch) advertises
// and decodes only what it supports, avoiding the brotli-garbling bug we hit in Python.
const HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-IN,en;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Cache-Control": "no-cache",
  "Upgrade-Insecure-Requests": "1",
};

const BOT_MARKERS = [
  "api-services-support",
  "enter the characters you see below",
  "to discuss automated access",
  "/errors/validatecaptcha",
  "type the characters",
  "robot check",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function detectSite(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes("amazon.")) return "amazon";
    if (h.includes("flipkart.")) return "flipkart";
  } catch {}
  return null;
}

export function pidOf(url) {
  try {
    return new URL(url).searchParams.get("pid") || "";
  } catch {
    return "";
  }
}

// Human-readable title from the URL slug: .../asics-novablast-5-running-shoes-men/p/itm...
export function slugTitle(url) {
  try {
    const path = new URL(url).pathname;
    const seg = path.split("/p/")[0].split("/").filter(Boolean).pop() || "";
    const words = seg.replace(/-/g, " ").trim();
    if (!words) return "";
    return words.replace(/\b\w/g, (c) => c.toUpperCase());
  } catch {
    return "";
  }
}

export function toNumber(text) {
  if (text == null) return null;
  const m = String(text).replace(/₹/g, "").match(/[\d][\d,]*\.?\d*/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

export async function fetchHtml(url, retries = 3) {
  let last = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: "follow" });
      const text = await res.text();
      const low = text.toLowerCase();
      if (BOT_MARKERS.some((m) => low.includes(m))) last = "bot/CAPTCHA wall";
      else if (res.status === 200 && text.length > 1500) return text;
      else last = `status ${res.status}, len ${text.length}`;
    } catch (e) {
      last = String(e);
    }
    await sleep(1500 * (i + 1));
  }
  throw new Error(`fetch failed: ${last}`);
}

function parseJsonLd($) {
  let out = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (out) return;
    let data;
    try {
      data = JSON.parse($(el).contents().text());
    } catch {
      return;
    }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      let offers = node.offers;
      if (Array.isArray(offers)) offers = offers[0];
      if (offers && offers.price) {
        out = {
          price: toNumber(offers.price),
          currency: offers.priceCurrency || "₹",
          title: node.name || null,
          image: Array.isArray(node.image) ? node.image[0] : node.image || null,
        };
        return;
      }
    }
  });
  return out;
}

// Parse a single product page -> { price, currency, title, image, onSale }
export function parseProduct(html, site) {
  const $ = cheerio.load(html);
  let price = null,
    currency = "₹",
    title = null,
    image = null,
    onSale = false;

  if (site === "flipkart") {
    for (const sel of ["div.Nx9bqj.CxhGGd", "div._30jeq3._16Jk6d", "div._30jeq3"]) {
      const t = $(sel).first().text();
      price = toNumber(t);
      if (price) break;
    }
    title = $("span.VU-ZEz, span.B_NuCI, h1").first().text().trim() || null;
    image = $("img._396cs4, img._53J4C-, img.DByuf4").first().attr("src") || null;
    const low = $.root().text().toLowerCase();
    onSale = low.includes("% off");
  } else if (site === "amazon") {
    for (const sel of [
      "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
      "#corePrice_feature_div .a-price .a-offscreen",
      "#apex_desktop .a-price .a-offscreen",
      "span.a-price span.a-offscreen",
      "span.a-price-whole",
    ]) {
      const t = $(sel).first().text();
      price = toNumber(t);
      if (price) break;
    }
    title = $("#productTitle").first().text().trim() || null;
    image = $("#landingImage, #imgBlkFront").first().attr("src") || null;
    onSale = $("#dealBadge, .savingsPercentage, #savingsPercentage").length > 0;
  }

  if (price == null || !title || !image) {
    const ld = parseJsonLd($);
    if (ld) {
      price = price ?? ld.price;
      currency = currency || ld.currency;
      title = title || ld.title;
      image = image || ld.image;
    }
  }
  if (!image) image = $('meta[property="og:image"]').attr("content") || null;
  if (!title) title = $('meta[property="og:title"]').attr("content") || null;

  if (price == null) return null;
  return { price, currency: currency || "₹", title, image, onSale: !!onSale };
}

// Parse a Flipkart search page -> up to `count` unique products.
export function parseSearch(html, count = 3) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  $("a[href]").each((_, a) => {
    if (results.length >= count) return false;
    let href = $(a).attr("href");
    if (!href || !href.includes("/p/") || !href.includes("pid=")) return;
    const full = href.startsWith("/") ? "https://www.flipkart.com" + href : href;
    const pid = pidOf(full);
    if (!pid || seen.has(pid)) return;

    // walk up to a card container that contains a price
    let el = $(a);
    let price = null,
      image = null;
    for (let i = 0; i < 6; i++) {
      el = el.parent();
      if (!el.length) break;
      const txt = el.text();
      const m = txt.match(/₹\s?([\d,]{3,})/);
      if (m && price == null) price = toNumber(m[1]);
      if (price) {
        image = el.find("img").first().attr("src") || null;
        break;
      }
    }
    seen.add(pid);
    results.push({
      url: full,
      pid,
      price,
      image,
      title: slugTitle(full),
      site: "flipkart",
    });
  });

  return results;
}
