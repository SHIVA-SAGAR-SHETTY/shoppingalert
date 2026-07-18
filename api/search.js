// POST /api/search  { query, count? }  -> add the top N Flipkart search results
import { fetchHtml, parseSearch } from "./_lib/scrape.js";
import { getFile, putFile, updateFile, dispatchWorkflow, stableId } from "./_lib/github.js";

const MAX_ITEMS = 60;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { query } = req.body || {};
    const count = Math.min(Math.max(Number(req.body?.count) || 3, 1), 5);
    if (!query || !String(query).trim()) return res.status(400).json({ error: "Enter something to search for." });

    const searchUrl = "https://www.flipkart.com/search?q=" + encodeURIComponent(String(query).trim());
    const results = parseSearch(await fetchHtml(searchUrl, 3), count);
    if (!results.length) return res.status(502).json({ error: "No results found (Flipkart may have blocked this request — try again)." });

    const wl = await getFile("watchlist.json");
    const list = wl.json || [];
    const added = [];
    for (const r of results) {
      const id = stableId(r.url);
      if (list.some((x) => x.id === id)) continue;
      if (list.length >= MAX_ITEMS) break;
      list.push({ id, url: r.url, site: "flipkart", title: r.title, targetPrice: null, addedAt: new Date().toISOString() });
      added.push({ ...r, id });
    }
    if (!added.length) return res.status(409).json({ error: "Those top results are already being tracked." });

    await putFile("watchlist.json", list, wl.sha, `Add ${added.length} result(s) for "${query}"`);

    // Seed prices.json from the search cards so cards look good immediately.
    try {
      await updateFile(
        "data/prices.json",
        (prices) => {
          for (const r of added) {
            prices[r.id] = {
              title: r.title,
              image: r.image || null,
              url: r.url,
              site: "flipkart",
              currentPrice: r.price ?? null,
              currency: "₹",
              onSale: false,
              lastChecked: new Date().toISOString(),
              history: r.price != null ? [{ t: new Date().toISOString(), price: r.price }] : [],
              alertedAt_matches: null,
            };
          }
          return prices;
        },
        `Seed prices for "${query}"`,
        {}
      );
    } catch (_) {
      /* best-effort */
    }

    dispatchWorkflow().catch(() => {});
    return res.status(200).json({ ok: true, added: added.length, items: added.map((a) => ({ id: a.id, title: a.title, price: a.price })) });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
