// GET  /api/recipients            -> { emails: [masked...] }  (for display)
// POST /api/recipients { emails }  -> set full list (encrypted secret) + masked mirror
import { getFile, putFile, setSecret } from "./_lib/github.js";

const MASK_PATH = "data/recipients-masked.json";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function mask(email) {
  const [local, domain] = email.split("@");
  const head = local.slice(0, 1);
  return `${head}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export default async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const f = await getFile(MASK_PATH);
      return res.status(200).json({ emails: f.json || [] });
    }
    if (req.method === "POST") {
      let { emails } = req.body || {};
      if (typeof emails === "string") emails = emails.split(/[,\n]/);
      if (!Array.isArray(emails)) return res.status(400).json({ error: "Provide an array of emails." });
      emails = emails.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
      const bad = emails.find((e) => !EMAIL_RE.test(e));
      if (bad) return res.status(400).json({ error: `Invalid email: ${bad}` });
      if (emails.length > 25) return res.status(400).json({ error: "Too many recipients (max 25)." });
      // dedupe
      emails = [...new Set(emails)];

      await setSecret("ALERT_RECIPIENTS", emails.join(","));

      const masked = emails.map(mask);
      const f = await getFile(MASK_PATH);
      await putFile(MASK_PATH, masked, f.sha, "Update recipients (masked mirror)");

      return res.status(200).json({ ok: true, emails: masked });
    }
    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
