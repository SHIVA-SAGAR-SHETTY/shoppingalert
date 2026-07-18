// POST /api/add  { url, targetPrice? }  -> add a single product to the watchlist
import { detectSite, fetchHtml, parseProduct, slugTitle } from "./_lib/scrape.js";
import { getFile, putFile, updateFile, dispatchWorkflow, stableId } from "./_lib/github.js";

const MAX_ITEMS = 60;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { url, targetPrice } = req.body || {};
    const site = detectSite(url);
    if (!site) return res.status(400).json({ error: "Please provide a valid Amazon or Flipkart product URL." });

    const id = stableId(url);
    const wl = await getFile("watchlist.json");
    const list = wl.json || [];
    if (list.length >= MAX_ITEMS) return res.status(429).json({ error: "Watchlist is full." });
    if (list.some((x) => x.id === id)) return res.status(409).json({ error: "That product is already being tracked." });

    list.push({
      id,
      url,
      site,
      title: slugTitle(url),
      targetPrice: targetPrice ? Number(targetPrice) : null,
      addedAt: new Date().toISOString(),
    });
    await putFile("watchlist.json", list, wl.sha, `Add product: ${url}`);

    // Best-effort: seed prices.json so the card shows a price/image immediately.
    try {
      const meta = parseProduct(await fetchHtml(url, 2), site);
      if (meta) {
        await updateFile(
          "data/prices.json",
          (prices) => {
            prices[id] = {
              title: meta.title || slugTitle(url),
              image: meta.image || null,
              url,
              site,
              currentPrice: meta.price,
              currency: meta.currency,
              onSale: meta.onSale,
              lastChecked: new Date().toISOString(),
              history: [{ t: new Date().toISOString(), price: meta.price }],
              alertedAt_matches: null,
            };
            return prices;
          },
          `Seed price for ${id}`,
          {}
        );
      }
    } catch (_) {
      /* seeding is best-effort; the hourly monitor will fill it in */
    }

    dispatchWorkflow().catch(() => {});
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
