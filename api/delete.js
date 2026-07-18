// POST /api/delete  { id }  -> stop tracking a product
import { getFile, putFile, updateFile } from "./_lib/github.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: "Missing id." });

    const wl = await getFile("watchlist.json");
    const list = wl.json || [];
    const next = list.filter((x) => x.id !== id);
    if (next.length === list.length) return res.status(404).json({ error: "Not found." });
    await putFile("watchlist.json", next, wl.sha, `Remove product ${id}`);

    // prune its price record too (best-effort)
    updateFile(
      "data/prices.json",
      (prices) => {
        if (!prices[id]) return null;
        delete prices[id];
        return prices;
      },
      `Prune prices for ${id}`,
      {}
    ).catch(() => {});

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
