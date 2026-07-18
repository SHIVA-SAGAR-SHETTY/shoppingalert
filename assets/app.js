/* ============================================================
   PriceDrop — frontend (talks to the /api backend on Vercel)
   ============================================================ */

const API = ""; // same-origin on Vercel: calls go to /api/*
const CURRENCY = "₹";
const STALE_HOURS = 6;

const $ = (sel) => document.querySelector(sel);
const charts = [];

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
  return iso ? (Date.now() - new Date(iso).getTime()) / 3.6e6 : Infinity;
}
function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s.trim()) || /(amazon\.|flipkart\.)/i.test(s);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function toast(msg, kind = "") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show " + kind;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "toast hidden"), 3600);
}

async function api(path, opts) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function loadJSON(path) {
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

/* ---------- render ---------- */
async function render() {
  let watchlist = [], prices = {};
  try {
    [watchlist, prices] = await Promise.all([
      loadJSON("watchlist.json"),
      loadJSON("data/prices.json").catch(() => ({})),
    ]);
  } catch (e) { console.error(e); }

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

  // sort: dropped/on-sale first (biggest drop % first), then the rest
  const decorated = watchlist.map((item) => {
    const p = prices[item.id] || {};
    return { item, p, drop: dropInfo(p) };
  });
  decorated.sort((a, b) => {
    const ad = a.drop.isDrop || a.p.onSale, bd = b.drop.isDrop || b.p.onSale;
    if (ad !== bd) return ad ? -1 : 1;
    return (b.drop.pct || 0) - (a.drop.pct || 0);
  });

  let dropCount = 0;
  decorated.forEach(({ item, p, drop }) => {
    if (drop.isDrop || p.onSale) dropCount++;
    grid.appendChild(buildCard(item, p, drop));
  });

  updateStats(watchlist.length, dropCount, prices);
  animateIn();
}

function dropInfo(p) {
  const h = p.history || [];
  if (h.length < 2) return { isDrop: false, pct: 0, diff: 0 };
  const now = h[h.length - 1].price, prev = h[h.length - 2].price;
  const diff = now - prev;
  return { isDrop: diff < 0, pct: prev ? Math.round((-diff / prev) * 100) : 0, diff };
}

function buildCard(item, p, drop) {
  const card = document.createElement("article");
  card.className = "card";
  const highlighted = p.onSale || drop.isDrop;
  if (highlighted) card.classList.add("dropped");

  const site = item.site || "flipkart";
  const title = p.title || item.title || item.url;
  const cur = p.currency || CURRENCY;
  const pending = p.currentPrice == null;

  let deltaHtml = '<span class="delta flat">—</span>';
  if (drop.isDrop) deltaHtml = `<span class="delta down">▼ ${fmtPrice(-drop.diff, cur)} (${drop.pct}%)</span>`;
  else if (drop.diff > 0) deltaHtml = `<span class="delta up">▲ ${fmtPrice(drop.diff, cur)}</span>`;

  const imgHtml = p.image
    ? `<img class="card-img" src="${p.image}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'card-img placeholder',textContent:'📦'}))" />`
    : `<div class="card-img placeholder">📦</div>`;

  const stale = !pending && hoursSince(p.lastChecked) > STALE_HOURS;
  const targetNote = item.targetPrice ? `<p class="target-note">🎯 Alert target: ${fmtPrice(item.targetPrice, cur)}</p>` : "";
  const priceHtml = pending
    ? `<span class="price pending">Fetching price…</span>`
    : `<span class="price">${fmtPrice(p.currentPrice, cur)}</span> ${deltaHtml}`;

  card.innerHTML = `
    ${p.onSale ? '<span class="sale-tag">SALE</span>' : ""}
    <div class="card-top">
      ${imgHtml}
      <div>
        <span class="site-badge ${site}">${site}</span>
        <h3 class="card-title">${escapeHtml(title)}</h3>
      </div>
    </div>
    <div class="price-row">${priceHtml}</div>
    ${targetNote}
    <div class="chart-wrap"><canvas></canvas></div>
    <div class="card-foot">
      <a href="${item.url}" target="_blank" rel="noopener">View product ↗</a>
      <span>
        ${stale ? '<span class="stale" title="No successful check recently">⚠ stale</span> ' : ""}
        <span class="muted">${pending ? "just added" : timeAgo(p.lastChecked)}</span>
        <button class="icon-btn" title="Stop tracking" data-del="${item.id}">🗑</button>
      </span>
    </div>`;

  const canvas = card.querySelector("canvas");
  if ((p.history || []).length > 1) drawSpark(canvas, p.history, highlighted);

  card.querySelector("[data-del]").addEventListener("click", () => removeProduct(item.id, title));
  return card;
}

function drawSpark(canvas, history, dropped) {
  const data = history.slice(-30);
  charts.push(new Chart(canvas, {
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
  }));
}

function updateStats(tracked, drops, prices) {
  countTo($("#statTracked"), tracked);
  countTo($("#statDrops"), drops);
  const times = Object.values(prices).map((p) => p.lastChecked).filter(Boolean).sort();
  $("#statUpdated").textContent = times.length ? timeAgo(times[times.length - 1]) : "—";
}
function countTo(el, target) {
  const t0 = performance.now(), dur = 800;
  (function step(now) {
    const k = Math.min((now - t0) / dur, 1);
    el.textContent = Math.round(target * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  })(performance.now());
}
function animateIn() {
  if (!window.gsap) return;
  gsap.from(".card", { opacity: 0, y: 28, duration: 0.55, stagger: 0.06, ease: "power3.out", clearProps: "all" });
  gsap.from(".stat", { opacity: 0, y: 14, duration: 0.45, stagger: 0.07, ease: "power2.out", clearProps: "all" });
}

/* ============================================================
   Add / search / delete (via backend)
   ============================================================ */
async function submitAdd() {
  const val = $("#addInput").value.trim();
  const target = $("#targetInput").value.trim();
  if (!val) return;
  const btn = $("#addBtn");
  btn.disabled = true; btn.textContent = "Adding…";
  try {
    if (looksLikeUrl(val)) {
      const r = await api("/api/add", { method: "POST", body: JSON.stringify({ url: val, targetPrice: target || null }) });
      toast("Added — fetching latest price…", "ok");
    } else {
      const r = await api("/api/search", { method: "POST", body: JSON.stringify({ query: val, count: 3 }) });
      toast(`Added ${r.added} top result${r.added > 1 ? "s" : ""} for “${val}”.`, "ok");
    }
    $("#addInput").value = ""; $("#targetInput").value = "";
    setTimeout(render, 1400);
  } catch (e) {
    toast(e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = "Add";
  }
}

async function removeProduct(id, title) {
  if (!confirm(`Stop tracking "${title}"?`)) return;
  try {
    await api("/api/delete", { method: "POST", body: JSON.stringify({ id }) });
    toast("Removed from watchlist.", "ok");
    setTimeout(render, 900);
  } catch (e) { toast(e.message, "err"); }
}

/* ---------- recipients ---------- */
async function openRecipients() {
  $("#recipientsModal").classList.remove("hidden");
  const box = $("#currentRecipients");
  box.innerHTML = '<span class="muted">Loading…</span>';
  try {
    const { emails } = await api("/api/recipients", { method: "GET" });
    box.innerHTML = emails.length
      ? "Currently alerting: " + emails.map((e) => `<span class="chip">${escapeHtml(e)}</span>`).join(" ")
      : '<span class="muted">No recipients yet — add some below.</span>';
  } catch (e) {
    box.innerHTML = `<span class="muted">Couldn’t load recipients (${escapeHtml(e.message)}).</span>`;
  }
}
async function saveRecipients() {
  const raw = $("#emailsInput").value;
  const errEl = $("#recipError");
  errEl.classList.add("hidden");
  const btn = $("#saveRecipients");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const { emails } = await api("/api/recipients", { method: "POST", body: JSON.stringify({ emails: raw }) });
    toast(`Saved ${emails.length} recipient${emails.length === 1 ? "" : "s"}.`, "ok");
    $("#emailsInput").value = "";
    openRecipients();
  } catch (e) {
    errEl.textContent = e.message; errEl.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "Save recipients";
  }
}

/* ---------- wiring ---------- */
function closeModals() {
  document.querySelectorAll(".modal-backdrop").forEach((m) => m.classList.add("hidden"));
}
function wire() {
  $("#addBtn").addEventListener("click", submitAdd);
  $("#addInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAdd(); });
  $("#addInput").addEventListener("input", () => {
    const v = $("#addInput").value.trim();
    $("#addBtn").textContent = v && !looksLikeUrl(v) ? "Search & add top 3" : "Add";
  });
  $("#recipientsBtn").addEventListener("click", openRecipients);
  $("#saveRecipients").addEventListener("click", saveRecipients);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeModals));
  document.querySelectorAll(".modal-backdrop").forEach((m) =>
    m.addEventListener("click", (e) => { if (e.target === m) closeModals(); }));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });
}

wire();
render();
