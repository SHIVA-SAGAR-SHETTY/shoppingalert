// Shared GitHub API helpers (Node / Vercel).
import crypto from "crypto";
import { createRequire } from "module";
// libsodium-wrappers ships a broken ESM entry; load its CommonJS build instead.
const require = createRequire(import.meta.url);
const _sodium = require("libsodium-wrappers");

const OWNER = process.env.GH_OWNER || "SHIVA-SAGAR-SHETTY";
const REPO = process.env.GH_REPO || "shoppingalert";
const BRANCH = process.env.GH_BRANCH || "main";
const API = "https://api.github.com";

function token() {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error("Server missing GITHUB_TOKEN env var");
  return t;
}

function headers() {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "pricedrop-backend",
  };
}

export function stableId(url) {
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
}

export async function getFile(path) {
  const res = await fetch(
    `${API}/repos/${OWNER}/${REPO}/contents/${path}?ref=${BRANCH}&t=${Date.now()}`,
    { headers: headers() }
  );
  if (res.status === 404) return { sha: null, json: null };
  if (!res.ok) throw new Error(`getFile ${path}: ${res.status}`);
  const data = await res.json();
  const content = Buffer.from(data.content, "base64").toString("utf-8");
  return { sha: data.sha, json: JSON.parse(content) };
}

export async function putFile(path, obj, sha, message) {
  const body = {
    message,
    content: Buffer.from(JSON.stringify(obj, null, 2) + "\n", "utf-8").toString("base64"),
    branch: BRANCH,
  };
  if (sha) body.sha = sha;
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `putFile ${path}: ${res.status}`);
  }
  return res.json();
}

// Read/modify/write with one retry on 409 (concurrent update).
export async function updateFile(path, mutate, message, fallback) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { sha, json } = await getFile(path);
    const current = json ?? fallback;
    const next = mutate(current);
    if (next === null) return current; // signal: no change
    try {
      await putFile(path, next, sha, message);
      return next;
    } catch (e) {
      if (attempt === 0 && String(e).includes("does not match")) continue;
      throw e;
    }
  }
}

export async function dispatchWorkflow(workflow = "monitor.yml") {
  const res = await fetch(
    `${API}/repos/${OWNER}/${REPO}/actions/workflows/${workflow}/dispatches`,
    { method: "POST", headers: headers(), body: JSON.stringify({ ref: BRANCH }) }
  );
  return res.status === 204;
}

// Encrypt + set an Actions secret (keeps recipient emails out of the public repo).
export async function setSecret(name, value) {
  const keyRes = await fetch(
    `${API}/repos/${OWNER}/${REPO}/actions/secrets/public-key`,
    { headers: headers() }
  );
  if (!keyRes.ok) throw new Error(`public-key: ${keyRes.status}`);
  const { key, key_id } = await keyRes.json();

  await _sodium.ready;
  const sodium = _sodium;
  const bin = sodium.from_base64(key, sodium.base64_variants.ORIGINAL);
  const enc = sodium.crypto_box_seal(sodium.from_string(value), bin);
  const encrypted_value = sodium.to_base64(enc, sodium.base64_variants.ORIGINAL);

  const res = await fetch(
    `${API}/repos/${OWNER}/${REPO}/actions/secrets/${name}`,
    {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ encrypted_value, key_id }),
    }
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `setSecret: ${res.status}`);
  }
  return true;
}
