/* ============================================================
   PriceDrop — frontend dashboard + owner admin mode
   ============================================================ */

const CONFIG = {
  owner: "SHIVA-SAGAR-SHETTY",
  repo: "shoppingalert",
  branch: "main",
  watchlistPath: "watchlist.json",
  pricesPath: "data/prices.json",
};

const TOKEN_KEY = "pricedrop_gh_token";
const CURRENCY = "₹";
const STALE_HOURS = 6;

const $ = (sel) => document.querySelector(sel);
const charts = [];

/* ---------- token helpers (browser-only) ---------- */
const getToken = () => localStorage.getItem(TOKEN_KEY) || "";
const setToken = (t) => localStorage.setItem(TOKEN_KEY, t.trim());
const clearToken = () => localStorage.removeItem(TOKEN_KEY);

/* ---------- utils ---------- */
function fmtPrice(v, cur) {
  if (v == null || isNaN(v)) return "—";
  return (cur || CURRENCY) + Number(v).toLocaleString("en-IN");
}

function timeAgo(iso) {
  if (!iso) return "never";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function hoursSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 3.6e6;
}

function detectSite(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes("amazon.")) return "amazon";
    if (h.includes("flipkart.")) return "flipkart";
  } catch (_) {}
  return null;
}

// Stable id from URL (matches the intent of the Python hash: first 12 hex of sha1-ish).
async function makeId(url) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(url));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

function toast(msg, kind = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show " + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "toast hidden"), 3200);
}

/* ---------- data loading ---------- */
async function loadJSON(path) {
  // cache-bust so freshly committed JSON shows up without a hard refresh
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function render() {
  let watchlist = [];
  let prices = {};
  try {
    [watchlist, prices] = await Promise.all([
      loadJSON(CONFIG.watchlistPath),
      loadJSON(CONFIG.pricesPath).catch(() => ({})),
    ]);
  } catch (e) {
    console.error(e);
  }

  $("#loading").classList.add("hidden");
  const grid = $("#grid");
  charts.forEach((c) => c.destroy());
  charts.length = 0;
  grid.innerHTML = "";

  if (!watchlist.length) {
    $("#empty").classList.remove("hidden");
    grid.classList.add("hidden");
    updateStats(0, 0, prices);
    return;
  }
  $("#empty").classList.add("hidden");
  grid.classList.remove("hidden");

  let dropCount = 0;
  watchlist.forEach((item) => {
    const p = prices[item.id] || {};
    if (p.onSale || (p.history && p.history.length > 1 && isDrop(p))) dropCount++;
    grid.appendChild(buildCard(item, p));
  });

  updateStats(watchlist.length, dropCount, prices);
  animateIn();
}

function isDrop(p) {
  const h = p.history || [];
  if (h.length < 2) return false;
  return h[h.length - 1].price < h[h.length - 2].price;
}

function buildCard(item, p) {
  const card = document.createElement("article");
  card.className = "card";
  const dropped = p.onSale || isDrop(p);
  if (dropped) card.classList.add("dropped");

  const site = item.site || detectSite(item.url) || "amazon";
  const title = p.title || item.title || item.url;
  const cur = p.currency || CURRENCY;

  // delta vs previous recorded price
  let deltaHtml = '<span class="delta flat">—</span>';
  const h = p.history || [];
  if (h.length >= 2) {
    const now = h[h.length - 1].price, prev = h[h.length - 2].price;
    const diff = now - prev;
    const pct = prev ? Math.round((diff / prev) * 100) : 0;
    if (diff < 0) deltaHtml = `<span class="delta down">▼ ${fmtPrice(-diff, cur)} (${pct}%)</span>`;
    else if (diff > 0) deltaHtml = `<span class="delta up">▲ ${fmtPrice(diff, cur)} (+${pct}%)</span>`;
  }

  const imgHtml = p.image
    ? `<img class="card-img" src="${p.image}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'card-img placeholder',textContent:'📦'}))" />`
    : `<div class="card-img placeholder">📦</div>`;

  const stale = hoursSince(p.lastChecked) > STALE_HOURS;
  const targetNote = item.targetPrice
    ? `<p class="target-note">🎯 Alert target: ${fmtPrice(item.targetPrice, cur)}</p>`
    : "";

  card.innerHTML = `
    ${p.onSale ? '<span class="sale-tag">SALE</span>' : ""}
    <div class="card-top">
      ${imgHtml}
      <div>
        <span class="site-badge ${site}">${site}</span>
        <h3 class="card-title">${escapeHtml(title)}</h3>
      </div>
    </div>
    <div class="price-row">
      <span class="price">${fmtPrice(p.currentPrice, cur)}</span>
      ${deltaHtml}
    </div>
    ${targetNote}
    <div class="chart-wrap"><canvas></canvas></div>
    <div class="card-foot">
      <a href="${item.url}" target="_blank" rel="noopener">View product ↗</a>
      <span>
        ${stale ? '<span class="stale" title="No successful check recently">⚠ stale</span> ' : ""}
        <span class="muted">${timeAgo(p.lastChecked)}</span>
        <button class="icon-btn" title="Stop tracking" data-del="${item.id}">🗑</button>
      </span>
    </div>`;

  const canvas = card.querySelector("canvas");
  if (h.length > 1) drawSpark(canvas, h, dropped);

  card.querySelector("[data-del]").addEventListener("click", () => removeProduct(item.id, title));
  return card;
}

function drawSpark(canvas, history, dropped) {
  const data = history.slice(-30);
  const chart = new Chart(canvas, {
    type: "line",
    data: {
      labels: data.map((d) => d.t),
      datasets: [{
        data: data.map((d) => d.price),
        borderColor: dropped ? "#2ee6a6" : "#7c5cff",
        backgroundColor: (ctx) => {
          const g = ctx.chart.ctx.createLinearGradient(0, 0, 0, 60);
          g.addColorStop(0, dropped ? "rgba(46,230,166,0.35)" : "rgba(124,92,255,0.35)");
          g.addColorStop(1, "rgba(0,0,0,0)");
          return g;
        },
        fill: true, borderWidth: 2, pointRadius: 0, tension: 0.35,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: {
        displayColors: false,
        callbacks: {
          title: (i) => new Date(i[0].label).toLocaleString("en-IN"),
          label: (i) => CURRENCY + Number(i.raw).toLocaleString("en-IN"),
        },
      } },
      scales: { x: { display: false }, y: { display: false } },
      animation: { duration: 600 },
    },
  });
  charts.push(chart);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function updateStats(tracked, drops, prices) {
  countTo($("#statTracked"), tracked);
  countTo($("#statDrops"), drops);
  const times = Object.values(prices).map((p) => p.lastChecked).filter(Boolean).sort();
  $("#statUpdated").textContent = times.length ? timeAgo(times[times.length - 1]) : "—";
}

function countTo(el, target) {
  const start = 0, dur = 900, t0 = performance.now();
  function step(now) {
    const k = Math.min((now - t0) / dur, 1);
    el.textContent = Math.round(start + (target - start) * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/* ---------- GSAP entrance ---------- */
function animateIn() {
  if (!window.gsap) return;
  gsap.from(".card", {
    opacity: 0, y: 30, duration: 0.6, stagger: 0.07, ease: "power3.out", clearProps: "all",
  });
  gsap.from(".stat", { opacity: 0, y: 16, duration: 0.5, stagger: 0.08, ease: "power2.out", clearProps: "all" });
}

/* ============================================================
   Admin: add / remove via GitHub Contents API
   ============================================================ */
const GH_API = "https://api.github.com";

async function ghGetFile(path) {
  const res = await fetch(`${GH_API}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}?ref=${CONFIG.branch}`, {
    headers: ghHeaders(),
  });
  if (!res.ok) throw new Error(`GitHub read failed (${res.status})`);
  const data = await res.json();
  return { sha: data.sha, content: JSON.parse(decodeURIComponent(escape(atob(data.content)))) };
}

async function ghPutFile(path, obj, sha, message) {
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(obj, null, 2) + "\n"))),
    sha,
    branch: CONFIG.branch,
  };
  const res = await fetch(`${GH_API}/repos/${CONFIG.owner}/${CONFIG.repo}/contents/${path}`, {
    method: "PUT", headers: ghHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub write failed (${res.status})`);
  }
  return res.json();
}

function ghHeaders() {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

async function addProduct() {
  const url = $("#urlInput").value.trim();
  const target = $("#targetInput").value.trim();
  const errEl = $("#addError");
  errEl.classList.add("hidden");

  const site = detectSite(url);
  if (!site) {
    errEl.textContent = "Please paste a valid Amazon or Flipkart product URL.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!getToken()) { closeModals(); openSettings(); return; }

  const btn = $("#addSubmit");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    const id = await makeId(url);
    const { sha, content } = await ghGetFile(CONFIG.watchlistPath);
    if (content.some((x) => x.id === id)) throw new Error("That product is already being tracked.");
    content.push({
      id, url, site,
      title: "",
      targetPrice: target ? Number(target) : null,
      addedAt: new Date().toISOString(),
    });
    await ghPutFile(CONFIG.watchlistPath, content, sha, `Add product: ${url}`);
    toast("Product added — first price check runs within the hour.", "ok");
    closeModals();
    $("#urlInput").value = ""; $("#targetInput").value = "";
    setTimeout(render, 1200);
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "Add & track";
  }
}

async function removeProduct(id, title) {
  if (!getToken()) { openSettings(); return; }
  if (!confirm(`Stop tracking "${title}"?`)) return;
  try {
    const wl = await ghGetFile(CONFIG.watchlistPath);
    const next = wl.content.filter((x) => x.id !== id);
    await ghPutFile(CONFIG.watchlistPath, next, wl.sha, `Remove product ${id}`);
    // also prune its price record (best-effort)
    try {
      const pr = await ghGetFile(CONFIG.pricesPath);
      if (pr.content[id]) {
        delete pr.content[id];
        await ghPutFile(CONFIG.pricesPath, pr.content, pr.sha, `Prune prices for ${id}`);
      }
    } catch (_) {}
    toast("Removed from watchlist.", "ok");
    setTimeout(render, 1000);
  } catch (e) {
    toast(e.message, "err");
  }
}

/* ---------- modal wiring ---------- */
function openAdd() { $("#addModal").classList.remove("hidden"); $("#urlInput").focus(); }
function openSettings() {
  $("#tokenInput").value = getToken();
  $("#settingsModal").classList.remove("hidden");
}
function closeModals() {
  document.querySelectorAll(".modal-backdrop").forEach((m) => m.classList.add("hidden"));
}

function wire() {
  $("#addBtn").addEventListener("click", openAdd);
  $("#settingsBtn").addEventListener("click", openSettings);
  $("#addSubmit").addEventListener("click", addProduct);
  $("#urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") addProduct(); });

  $("#saveToken").addEventListener("click", () => {
    const t = $("#tokenInput").value.trim();
    if (!t) return toast("Paste a token first.", "err");
    setToken(t);
    toast("Token saved to this browser.", "ok");
    closeModals();
  });
  $("#clearToken").addEventListener("click", () => {
    clearToken(); $("#tokenInput").value = "";
    toast("Token removed from this browser.", "ok");
  });

  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModals));
  document.querySelectorAll(".modal-backdrop").forEach((m) =>
    m.addEventListener("click", (e) => { if (e.target === m) closeModals(); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });
}

wire();
render();
