// ─────────────────────────────────────────────────────────────────────────────
// BROADCAST MESSAGE — shown at top of chat if set by admin
// ─────────────────────────────────────────────────────────────────────────────
const BROADCAST_KEY = 'ws_broadcast';

async function checkBroadcast() {
  try {
    let data = null;
    // Try localStorage first (fast), then KV if Supabase available
    const local = localStorage.getItem('kv:' + BROADCAST_KEY);
    if (local) data = JSON.parse(local);
    if (!data?.msg) return;
    // Show as a sticky banner above the chat
    if (document.getElementById('broadcastBanner')) return;
    const banner = document.createElement('div');
    banner.id = 'broadcastBanner';
    banner.style.cssText = 'background:#1a3a6b;color:#fff;padding:9px 16px 9px 14px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:10px;border-bottom:1px solid rgba(255,255,255,0.15);font-family:system-ui,sans-serif;flex-shrink:0';
    banner.innerHTML = `<span style="flex:1">📢 ${escapeHTML(data.msg)}</span><button onclick="this.parentElement.remove()" style="background:none;border:none;color:rgba(255,255,255,0.7);font-size:16px;cursor:pointer;padding:0;line-height:1" title="Dismiss">✕</button>`;
    const chatWindow = document.getElementById('chatWindow');
    if (chatWindow) chatWindow.parentElement.insertBefore(banner, chatWindow);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
const SETTINGS = {
  minConfidence:      0.20,
  chipLimit:          8,
  chipClickCooldownMs:900,
  smsNumber:          "07773652107",
  smsMaxChars:        500,
};

// ─────────────────────────────────────────────────────────────────────────────
// EMP GATE
// ─────────────────────────────────────────────────────────────────────────────
const EMP_SESSION_KEY = "ws_emp_session";
let empNumber = null;
let empName   = null;

function getStoredEmpSession() {
  try {
    const obj = JSON.parse(sessionStorage.getItem(EMP_SESSION_KEY) || "null");
    if (obj && /^\d{6}$/.test(obj.emp) && obj.name) return obj;
  } catch {}
  return null;
}
function storeEmpSession(emp, name, dept) {
  try { sessionStorage.setItem(EMP_SESSION_KEY, JSON.stringify({ emp, name, dept: dept || "" })); } catch {}
}
function getStoredPhone() {
  try { return sessionStorage.getItem("ws_last_phone_" + (empNumber || "")) || null; } catch { return null; }
}
function storePhone(phone) {
  try { if (empNumber && phone) sessionStorage.setItem("ws_last_phone_" + empNumber, phone); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM REFERENCES
// ─────────────────────────────────────────────────────────────────────────────
const chatWindow        = document.getElementById("chatWindow");
const input             = document.getElementById("chatInput");
const sendBtn           = document.getElementById("sendBtn");
const clearBtn          = document.getElementById("clearBtn");
const suggestionsEl     = document.getElementById("suggestions");
const topicsBtn         = document.getElementById("topicsBtn");
const drawer            = document.getElementById("topicsDrawer");
const drawerOverlay     = document.getElementById("drawerOverlay");
const drawerCloseBtn    = document.getElementById("drawerCloseBtn");
const drawerCategoriesEl= document.getElementById("drawerCategories");
const drawerQuestionsEl = document.getElementById("drawerQuestions");
const micBtn            = document.getElementById("micBtn");
const voiceBtn          = document.getElementById("voiceBtn");

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let isResponding     = false;
let lastChipClickAt  = 0;
let CHAT_LOG         = [];
let smsCtx           = null;   // active pay/deduction SMS collection flow
let distanceCtx      = null;   // active depot-distance flow
let flowCtx          = null;   // active guided flow (workAllocation, equipment, NTF…)
let lastPhoneNumber  = null;   // last phone number the bot mentioned (for context recall)
let FAQS             = [];
let faqsLoaded       = false;
let categories       = [];
let categoryIndex    = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// ANALYTICS — localStorage keys
// ─────────────────────────────────────────────────────────────────────────────
const WS_SESSIONS_KEY  = "ws_sessions_v1";
const WS_INTENTS_KEY   = "ws_intents_v1";
const WS_SMS_LOG_KEY   = "ws_sms_log_v1";
const UNRESOLVED_KEY   = "ws_unresolved_v1";
const WS_EMPLOYEES_KEY = "ws_employees_v1";

const SESSION_ID    = Date.now() + "_" + Math.random().toString(36).slice(2, 7);
const SESSION_START = Date.now();
let sessionMsgCount = 0;

function saveSession() {
  try {
    const sessions = JSON.parse(localStorage.getItem(WS_SESSIONS_KEY) || "[]");
    const idx = sessions.findIndex(s => s.id === SESSION_ID);
    const entry = {
      id: SESSION_ID, start: SESSION_START, end: Date.now(),
      messages: sessionMsgCount,
      date: new Date(SESSION_START).toISOString().slice(0, 10),
      emp: empNumber || "", name: empName || ""
    };
    if (idx >= 0) sessions[idx] = entry; else sessions.push(entry);
    if (sessions.length > 2000) sessions.splice(0, sessions.length - 2000);
    localStorage.setItem(WS_SESSIONS_KEY, JSON.stringify(sessions));
  } catch {}
}

function logEmployee(emp, name, dept) {
  try {
    const employees = JSON.parse(localStorage.getItem(WS_EMPLOYEES_KEY) || "{}");
    const prev = employees[emp] || {};
    employees[emp] = {
      emp,
      name: name || prev.name || "",
      dept: dept || prev.dept || "",
      firstSeen:    prev.firstSeen || Date.now(),
      lastSeen:     Date.now(),
      sessions:     (prev.sessions || 0) + (prev._thisSession === SESSION_ID ? 0 : 1),
      _thisSession: SESSION_ID
    };
    localStorage.setItem(WS_EMPLOYEES_KEY, JSON.stringify(employees));
  } catch {}
}

function logIntent(intent) {
  try {
    const intents = JSON.parse(localStorage.getItem(WS_INTENTS_KEY) || "[]");
    intents.push({ intent, ts: Date.now(), date: new Date().toISOString().slice(0, 10), emp: empNumber || "" });
    if (intents.length > 5000) intents.splice(0, intents.length - 5000);
    localStorage.setItem(WS_INTENTS_KEY, JSON.stringify(intents));
  } catch {}
}

function logSMS(entry) {
  try {
    const log = JSON.parse(localStorage.getItem(WS_SMS_LOG_KEY) || "[]");
    log.push({ ...entry, ts: Date.now(), date: new Date().toISOString().slice(0, 10), emp: empNumber || "" });
    if (log.length > 2000) log.splice(0, log.length - 2000);
    localStorage.setItem(WS_SMS_LOG_KEY, JSON.stringify(log));
  } catch {}
}

function logUnresolved(text) {
  try {
    const arr = JSON.parse(localStorage.getItem(UNRESOLVED_KEY) || "[]");
    arr.push({ text, ts: Date.now(), emp: empNumber || "" });
    if (arr.length > 200) arr.splice(0, arr.length - 200);
    localStorage.setItem(UNRESOLVED_KEY, JSON.stringify(arr));
  } catch {}
}

setInterval(saveSession, 30000);
window.addEventListener("beforeunload", saveSession);

// ── Offline banner ──
(function() {
  function showOfflineBanner() {
    if (document.getElementById("offlineBanner")) return;
    const b = document.createElement("div");
    b.id = "offlineBanner";
    b.style.cssText = "position:sticky;top:0;z-index:999;background:#dc2626;color:#fff;text-align:center;padding:8px 16px;font-size:13px;font-weight:600;font-family:system-ui,sans-serif";
    b.textContent = "⚠️ No internet connection — some features may not work";
    document.body.prepend(b);
  }
  function hideOfflineBanner() {
    document.getElementById("offlineBanner")?.remove();
  }
  window.addEventListener("online",  hideOfflineBanner);
  window.addEventListener("offline", showOfflineBanner);
  if (!navigator.onLine) showOfflineBanner();
})();

// ─────────────────────────────────────────────────────────────────────────────
// UK TIME HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const UK_TZ = "Europe/London";

function formatUKTime(date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
function getUKDateISO(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = t => p.find(x => x.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function getUKDayIndex(date = new Date()) {
  const wd = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, weekday: "short" }).format(date);
  return { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 }[wd] ?? 0;
}
function getUKMinutesNow(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  return parseInt(p.find(x => x.type === "hour")?.value ?? "0") * 60
       + parseInt(p.find(x => x.type === "minute")?.value ?? "0");
}

const BUSINESS = { start: 8 * 60 + 30, end: 17 * 60, openDays: new Set([1, 2, 3, 4, 5]) };
const BANK_HOLIDAYS_EW = new Set([
  "2025-01-01","2025-04-18","2025-04-21","2025-05-05","2025-05-26","2025-08-25","2025-12-25","2025-12-26",
  "2026-01-01","2026-04-03","2026-04-06","2026-05-04","2026-05-25","2026-08-31","2026-12-25","2026-12-28",
  "2027-01-01","2027-03-26","2027-03-29","2027-05-03","2027-05-31","2027-08-30","2027-12-27","2027-12-28",
  "2028-01-03","2028-04-14","2028-04-17","2028-05-01","2028-05-29","2028-08-28","2028-12-25","2028-12-26",
]);
function isBankHolidayToday() { return BANK_HOLIDAYS_EW.has(getUKDateISO()); }
function isOpenNow() {
  const day = getUKDayIndex(), mins = getUKMinutesNow();
  return BUSINESS.openDays.has(day) && mins >= BUSINESS.start && mins < BUSINESS.end && !isBankHolidayToday();
}

// ─────────────────────────────────────────────────────────────────────────────
// TIME-AWARE GREETING
// ─────────────────────────────────────────────────────────────────────────────
function getGreeting() {
  const h = getUKMinutesNow() / 60;
  const timeGreet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  if (!isOpenNow()) {
    const bh = isBankHolidayToday();
    return `${timeGreet}! I'm <b>Welfare Support</b>.<br><br>` +
      `⚠️ We're currently <b>closed</b>${bh ? " (bank holiday)" : ""}. ` +
      `Office hours are <b>Mon–Fri 8:30am–5pm</b>.<br>` +
      `For urgent out-of-hours queries:<br>` +
      `<b>Fleet (OOH):</b> <a href="tel:07940766377">07940766377</a><br>` +
      `<b>Accident / Injury:</b> <a href="tel:07940792355">07940792355</a><br><br>` +
      `I can still help answer questions — use the <b>Topics</b> button or type below.`;
  }
  return `${timeGreet}! I'm <b>Welfare Support</b> — here to help. Use the <b>Topics</b> button or type your question below.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STRING / HTML HELPERS
// ─────────────────────────────────────────────────────────────────────────────
const normalize = s =>
  (s ?? "").toLowerCase().normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[""'']/g, '"').replace(/[‐‑‒–—―]/g, "-")
    .replace(/[^a-z0-9\s&-]/g, "").replace(/\s+/g, " ").trim();

function escapeHTML(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}
function escapeAttrUrl(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function decodeHTMLEntities(str) {
  const t = document.createElement("textarea"); t.innerHTML = str ?? ""; return t.value;
}
function htmlToPlainText(html) {
  const t = document.createElement("template"); t.innerHTML = decodeHTMLEntities(html ?? "");
  return (t.content.textContent ?? "").trim();
}
function sanitizeHTML(html) {
  const tpl = document.createElement("template"); tpl.innerHTML = html;
  const allowed = new Set(["B","STRONG","I","EM","BR","A","SMALL","IMG"]);
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
  const toStrip = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!allowed.has(el.tagName)) { toStrip.push(el); continue; }
    [...el.attributes].forEach(attr => {
      const n = attr.name.toLowerCase();
      if (el.tagName === "A" && ["href","target","rel"].includes(n)) return;
      if (el.tagName === "IMG" && ["src","alt","class","loading"].includes(n)) return;
      el.removeAttribute(attr.name);
    });
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (!/^(https?:\/\/|mailto:|tel:|sms:)/i.test(href)) el.removeAttribute("href");
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }
    if (el.tagName === "IMG") {
      if (!/^https:\/\//i.test(el.getAttribute("src") ?? "")) toStrip.push(el);
      else el.setAttribute("loading", "lazy");
      if (!el.getAttribute("alt")) el.setAttribute("alt", "Map preview");
    }
  }
  toStrip.forEach(n => n.replaceWith(document.createTextNode(n.textContent ?? "")));
  return tpl.innerHTML;
}

function relativeTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10)   return "Just now";
  if (diff < 60)   return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return formatUKTime(new Date(ts));
}
setInterval(() => {
  document.querySelectorAll(".timestamp[data-ts]").forEach(el => {
    el.textContent = relativeTime(+el.dataset.ts);
  });
}, 30000);

// ─────────────────────────────────────────────────────────────────────────────
// MAP / LOCATION HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function lonLatToTileXY(lon, lat, z) {
  const r = lat * Math.PI / 180, n = 2 ** z;
  return { x: Math.floor((lon + 180) / 360 * n), y: Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n) };
}
const osmTileURL = (lat, lon, z = 13) => { const t = lonLatToTileXY(lon, lat, z); return `https://tile.openstreetmap.org/${z}/${t.x}/${t.y}.png`; };
const imgTag  = (src, alt = "Map preview") => `<img class="map-preview" src="${escapeAttrUrl(src)}" alt="${escapeHTML(alt)}" loading="lazy" />`;
const linkTag = (href, label) => `<a href="${escapeAttrUrl(href)}">${escapeHTML(label)}</a>`;

const DEPOTS = { nuneaton: { label: "Nuneaton Depot", lat: 52.515770, lon: -1.450782 } };
const PLACES = {
  coventry:   { lat: 52.4068, lon: -1.5197 }, birmingham: { lat: 52.4895, lon: -1.8980 },
  leicester:  { lat: 52.6369, lon: -1.1398 }, london:     { lat: 51.5074, lon: -0.1278 },
};

function distanceMiles(a, b) {
  const R = 3958.8, toR = d => d * Math.PI / 180;
  const dLat = toR(b.lat - a.lat), dLon = toR(b.lon - a.lon);
  const h = Math.sin(dLat/2)**2 + Math.cos(toR(a.lat)) * Math.cos(toR(b.lat)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(h));
}
function findClosestDepot(origin) {
  let bestKey = null, best = Infinity;
  for (const k in DEPOTS) { const m = distanceMiles(origin, DEPOTS[k]); if (m < best) { best = m; bestKey = k; } }
  return bestKey ? { depotKey: bestKey, miles: best } : null;
}
function googleDirectionsURL(originText, depot, mode) {
  const tm = mode === "walk" ? "walking" : (mode === "train" || mode === "bus") ? "transit" : "driving";
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(originText)}&destination=${encodeURIComponent(`${depot.lat},${depot.lon}`)}&travelmode=${tm}`;
}
function requestBrowserLocation() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lon: p.coords.longitude }), rej, { timeout: 8000, maximumAge: 120000 });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// VOICE OUTPUT
// ─────────────────────────────────────────────────────────────────────────────
const VOICE_KEY = "ws_voice_v1";
const voiceState = { on: false, armed: false };
try { Object.assign(voiceState, JSON.parse(localStorage.getItem(VOICE_KEY) || "{}")); } catch {}
function saveVoice() { try { localStorage.setItem(VOICE_KEY, JSON.stringify(voiceState)); } catch {} }
function updateVoiceUI() { voiceBtn.classList.toggle("on", voiceState.on); voiceBtn.setAttribute("aria-pressed", String(voiceState.on)); }
function speak(text) {
  if (!voiceState.on || !voiceState.armed || !("speechSynthesis" in window)) return;
  try { window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(String(text ?? "")); u.lang = "en-GB"; window.speechSynthesis.speak(u); } catch {}
}
updateVoiceUI();
window.addEventListener("pointerdown", () => { voiceState.armed = true; saveVoice(); }, { passive: true });
window.addEventListener("keydown",     () => { voiceState.armed = true; saveVoice(); }, { passive: true });
voiceBtn.addEventListener("click", () => {
  voiceState.armed = true; voiceState.on = !voiceState.on; saveVoice(); updateVoiceUI();
  addBubble(voiceState.on ? "Voice output is now <b>on</b>." : "Voice output is now <b>off</b>.", "bot", { html: true, speak: false });
});

// ─────────────────────────────────────────────────────────────────────────────
// MICROPHONE INPUT
// ─────────────────────────────────────────────────────────────────────────────
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null, micListening = false;
function initSpeech() {
  if (!SR) return null;
  const r = new SR(); r.lang = "en-GB"; r.interimResults = false; r.maxAlternatives = 1;
  r.onstart  = () => { micListening = true;  micBtn.classList.add("on");    micBtn.setAttribute("aria-pressed","true"); };
  r.onend    = () => { micListening = false; micBtn.classList.remove("on"); micBtn.setAttribute("aria-pressed","false"); };
  r.onerror  = () => { micListening = false; micBtn.classList.remove("on"); micBtn.setAttribute("aria-pressed","false"); addBubble("Voice input isn't available here — please type your question.", "bot", { speak: false }); };
  r.onresult = e => { const t = e.results?.[0]?.[0]?.transcript ?? ""; if (t.trim()) { input.value = t.trim(); sendChat(); } };
  return r;
}
recognizer = initSpeech();
micBtn.addEventListener("click", () => {
  voiceState.armed = true; saveVoice();
  if (!recognizer) { addBubble("Voice input isn't supported in this browser. Try Chrome or Edge.", "bot", { speak: false }); return; }
  try { micListening ? recognizer.stop() : recognizer.start(); }
  catch { addBubble("Couldn't start voice input — please try again.", "bot", { speak: false }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// ADD BUBBLE — renders a chat message
// ─────────────────────────────────────────────────────────────────────────────
function addBubble(text, type, opts = {}) {
  const isHTML = !!opts.html;
  const ts = opts.ts ?? new Date();
  const row    = document.createElement("div"); row.className = "msg " + type;
  const bubble = document.createElement("div"); bubble.className = "bubble " + type;
  if (isHTML) { bubble.innerHTML = sanitizeHTML(decodeHTMLEntities(text)); }
  else         { bubble.textContent = text; }

  // Remember last phone number the bot mentions (for "what was that number?" recall)
  if (type === "bot") {
    const match = (isHTML ? htmlToPlainText(text) : text).match(/0\d[\d\s]{8,12}/);
    if (match) lastPhoneNumber = match[0].replace(/\s/g, "");
  }

  // Inject copy-to-clipboard buttons next to every tel: link
  if (type === "bot" && isHTML) {
    const COPY_ICON = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    bubble.querySelectorAll("a[href^='tel:']").forEach(a => {
      const num = a.getAttribute("href").replace("tel:", "");
      const btn = document.createElement("button"); btn.className = "copy-num-btn"; btn.title = "Copy number"; btn.innerHTML = COPY_ICON;
      btn.addEventListener("click", e => {
        e.preventDefault();
        navigator.clipboard?.writeText(num).then(() => {
          btn.innerHTML = "✓"; btn.style.background = "#16a34a";
          setTimeout(() => { btn.innerHTML = COPY_ICON; btn.style.background = ""; }, 2000);
        });
      });
      a.insertAdjacentElement("afterend", btn);
    });
  }

  // Timestamp
  const meta = document.createElement("div"); meta.className = "msg-meta";
  const time = document.createElement("span"); time.className = "timestamp"; time.dataset.ts = ts.getTime(); time.textContent = relativeTime(ts.getTime());
  meta.appendChild(time);

  // 👍 / 👎 feedback buttons (bot messages only)
  if (type === "bot" && !opts.noFeedback) {
    const fbWrap = document.createElement("div"); fbWrap.className = "feedback-btns";
    ["👍","👎"].forEach((emoji, i) => {
      const fb = document.createElement("button"); fb.className = "feedback-btn"; fb.title = i === 0 ? "Helpful" : "Not helpful"; fb.textContent = emoji;
      fb.addEventListener("click", () => {
        fbWrap.querySelectorAll(".feedback-btn").forEach(b => b.disabled = true);
        fb.classList.add("selected");
        if (i === 1) { const last = CHAT_LOG.filter(l => l.role === "User").at(-1); if (last) logUnresolved(last.text + " [marked unhelpful]"); }
        const thanks = document.createElement("span"); thanks.className = "feedback-thanks"; thanks.textContent = i === 0 ? "Thanks!" : "Sorry about that!";
        fbWrap.appendChild(thanks);
      });
      fbWrap.appendChild(fb);
    });
    meta.appendChild(fbWrap);
  }

  row.appendChild(bubble); row.appendChild(meta); chatWindow.prepend(row);
  const plain = isHTML ? htmlToPlainText(text) : String(text ?? "").trim();
  if (plain) {
    CHAT_LOG.push({ role: type === "bot" ? "Bot" : "User", text: plain, ts: ts.getTime() });
    if (type === "user") { sessionMsgCount++; saveSession(); }
  }
  if (type === "bot" && opts.speak !== false) speak(plain);
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD CHIPS — quick-reply buttons
// ─────────────────────────────────────────────────────────────────────────────
function addChips(labels, onClick) {
  if (!labels?.length) return;
  const wrap = document.createElement("div"); wrap.className = "chips";
  labels.slice(0, SETTINGS.chipLimit).forEach(label => {
    const b = document.createElement("button"); b.type = "button"; b.className = "chip-btn"; b.textContent = label;
    b.addEventListener("click", async () => {
      voiceState.armed = true; saveVoice();
      const now = Date.now();
      if (isResponding || now - lastChipClickAt < SETTINGS.chipClickCooldownMs) return;
      lastChipClickAt = now;
      wrap.querySelectorAll(".chip-btn").forEach(btn => btn.disabled = true);
      if (label === "Use my location" && distanceCtx?.stage === "needOrigin") { await handleUseMyLocation(); return; }
      typeof onClick === "function" ? onClick(label) : await handleUserMessage(label);
    });
    wrap.appendChild(b);
  });
  chatWindow.prepend(wrap);
}

// ─────────────────────────────────────────────────────────────────────────────
// GPS LOCATION HELPER
// ─────────────────────────────────────────────────────────────────────────────
async function handleUseMyLocation() {
  addBubble("Use my location", "user", { speak: false }); isResponding = true;
  try {
    const loc     = await requestBrowserLocation();
    const closest = findClosestDepot(loc);
    if (!closest) { addBubble("I couldn't find a nearby depot. Please type a town or city.", "bot"); addChips(["Coventry","Birmingham","Leicester","London"]); return; }
    const depot = DEPOTS[closest.depotKey];
    distanceCtx = { stage: "haveClosest", originKey: "your location", depotKey: closest.depotKey };
    addBubble(`Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>How are you travelling?`, "bot", { html: true });
    addChips(["By car","By train","By bus","Walking"]);
  } catch {
    addBubble("I couldn't access your location. Please allow permission or type a town/city.", "bot");
    addChips(["Coventry","Birmingham","Leicester","London"]);
  } finally { isResponding = false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPING INDICATOR
// ─────────────────────────────────────────────────────────────────────────────
function showTyping() {
  const row = document.createElement("div"); row.className = "msg bot"; row.id = "typingIndicator";
  const bub = document.createElement("div"); bub.className = "bubble bot typing-bubble";
  bub.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  row.appendChild(bub); chatWindow.prepend(row);
}
function hideTyping() { document.getElementById("typingIndicator")?.remove(); }
// Typing delay: short input = snappier reply, longer input = more "thinking" time
// Pass response HTML length after it's known for best accuracy,
// or input length as a proxy before.
const typingDelay = (responseLen = 80) => {
  const len = typeof responseLen === "string" ? responseLen.length : responseLen;
  const base = Math.min(Math.max(len * 6, 350), 1300); // 6ms/char, 350–1300ms
  return base + Math.random() * 250; // +0–250ms jitter
};

// ─────────────────────────────────────────────────────────────────────────────
// FUZZY MATCHING — Levenshtein distance
// ─────────────────────────────────────────────────────────────────────────────
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function fuzzyWordMatch(q, candidate) {
  const qWords = q.split(" ").filter(w => w.length > 3);
  const cWords = candidate.split(" ").filter(w => w.length > 3);
  if (!qWords.length) return 0;
  let matched = 0;
  for (const qw of qWords) {
    for (const cw of cWords) {
      const mx = Math.max(qw.length, cw.length), d = levenshtein(qw, cw);
      if (d === 0)           { matched += 1;   break; }
      if (mx >= 5 && d <= 1) { matched += 0.8; break; }
      if (mx >= 7 && d <= 2) { matched += 0.6; break; }
    }
  }
  return matched / qWords.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// INTENT DETECTION
// ─────────────────────────────────────────────────────────────────────────────
const INTENT_PHRASES = [
  { intent:"greeting",        patterns:["hello","hi","hey","good morning","good afternoon","good evening","hiya","alright","howdy","morning","afternoon"] },
  { intent:"smalltalk_how",   patterns:["how are you","you ok","you alright","how r u","hows things","how are things"] },
  { intent:"thanks",          patterns:["thank you","thanks","cheers","that was helpful","appreciated"] },
  { intent:"bye",             patterns:["bye","goodbye","see you","see ya","cya","later","ttyl"] },
  { intent:"pay_query",       patterns:["pay / payroll","pay payroll","pay/payroll","not been paid","havent been paid","haven't been paid","missing pay","no pay","didnt get paid","didn't get paid","where is my pay","where is my wage","when do i get paid","payday","pay day","wrong pay","incorrect pay","short paid","underpaid","overpaid","pay is wrong","wages wrong","wages are wrong","not received my pay","pay query","pay question","pay issue","pay problem","payroll query","payroll issue","salary query","salary issue","wage query","wage issue","my pay","about my pay","check my pay"] },
  { intent:"deduction_query", patterns:["deduction","deductions","money taken","taken from my pay","taken from pay","taken out","stopped from pay","money missing","why has money been taken","missing money","wrong amount"] },
  { intent:"work_allocation", patterns:["no work","not got work","havent got work","haven't got work","no jobs","no job","not been allocated","not allocated","no allocation","no shifts","where is my work","need work","run out of work","work allocation","work alloc","allocated wrong","wrong job","wrong work","given wrong job"] },
  { intent:"manager_dispute", patterns:["manager disputes","manager dispute","dispute with manager","problem with manager","issue with manager","trouble with manager","argument with manager","conflict with manager","my manager","manager being","manager has","manager is","field manager issue","area manager issue","unfair manager","manager treating","manager not","manager wont","manager won't"] },
  { intent:"contract",        patterns:["contract change","contract","my contract","change contract","contract amendment","amend contract","contract query","contract issue","contract hours","contract type","permanent","part time","full time","contract update"] },
  { intent:"equipment_stock", patterns:["stock","no stock","out of stock","missing stock","stock query","stock issue","stock form","need stock","request stock"] },
  { intent:"equipment_tooling",patterns:["tools","tooling","no tools","missing tools","need tools","tool query","tool issue","bybox","by box","tool order","order tools"] },
  { intent:"equipment_van",   patterns:["no van","need a van","when do i get a van","van query","van issue","van problem","company van","work van","my van","van not arrived","havent got a van","haven't got a van"] },
  { intent:"equipment",       patterns:["equipment query","equipment","kit","gear","my kit","my equipment","kit query","kit issue"] },
  { intent:"street_works",    patterns:["street work","streetwork","street works","streetworks","street job","sw query","sw issue"] },
  { intent:"smart_awards",    patterns:["smart award","smartaward","smart awards","smartawards","award query","award issue","my award","claim award"] },
  { intent:"id_cards",        patterns:["id card","id cards","id badge","identification","lost id","id lost","id expired","expired id","id not arrived","id not received","need new id","replace id","id renewal"] },
  { intent:"contact_support", patterns:["contact support","get help","need help","speak to welfare","welfare team","welfare number","welfare contact","welfare support","call welfare"] },
  { intent:"dept_contacts",   patterns:["department contacts","contacts","department contacts","department numbers","dept contacts","who do i call","who do i contact","who should i contact","contact details","contact list","what number","which number","contact for","call for","all contacts","departments"] },
  { intent:"fleet",           patterns:["fleet","fleet query","fleet issue","fleet contact","breakdown","car broken","company car","vehicle broken","my vehicle"] },
  { intent:"accident",        patterns:["accident","injury","injured","hurt","accident report","report accident","had an accident","been in accident","crash","vehicle damage","damage report","road accident","near miss"] },
  { intent:"parking",         patterns:["parking","parking fine","parking ticket","parking query","parking issue","penalty charge","pcn","council fine"] },
  { intent:"recruitment",     patterns:["recruit","recruitment","hiring","new job","apply","application","job application","job vacancy","vacancy","start date","when do i start","joining","onboard","onboarding"] },
  { intent:"btor_ntf",        patterns:["btor","openreach","open reach","btor ntf","ntf btor","btor support","btor contact"] },
  { intent:"cityfibre_ntf",   patterns:["city fibre","cityfibre","cf ntf","city fibre ntf","cityfibre ntf","city fibre support","cf support"] },
  { intent:"opening_times",   patterns:["opening times","office hours","working hours","what are your hours","when do you open","when do you close","open hours","what time do you"] },
  { intent:"bank_holiday",    patterns:["bank holiday","bank holidays","public holiday","open on bank holiday","open bank holiday"] },
  { intent:"available_now",   patterns:["available now","anyone available","is someone available","are you open now","anyone there","is anyone there","can i speak","speak to someone","talk to someone","open now"] },
  { intent:"location",        patterns:["where are you","your address","office address","where is the office","nuneaton","depot","closest depot","nearest depot","how far","directions","how to get","get there"] },
  { intent:"sms_query",       patterns:["send a text","text you","text support","text query","text message","sms","message support"] },
];

function detectIntent(text) {
  const q = normalize(text);
  for (const { patterns, intent } of INTENT_PHRASES)
    for (const p of patterns)
      if (q.includes(normalize(p))) return intent;
  // Fuzzy fallback for typos
  for (const { patterns, intent } of INTENT_PHRASES)
    for (const p of patterns) {
      if (p.length < 5) continue;
      for (const pw of p.split(" ").filter(w => w.length >= 5))
        for (const qw of q.split(" ").filter(w => w.length >= 4))
          if (levenshtein(pw, qw) <= 1) return intent;
    }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GUIDED FLOWS — multi-step question trees
// ─────────────────────────────────────────────────────────────────────────────
const WELFARE = `<a href="tel:02087583060"><b>02087583060</b></a>`;

// NTF contact data — keyed by normalised label for safe lookup
const BTOR_AREAS = {
  "wales & midlands":           `<a href="tel:07484034863"><b>07484034863</b></a> or <a href="tel:07483932673"><b>07483932673</b></a>`,
  "london & se":                `<a href="tel:07814089467"><b>07814089467</b></a> or <a href="tel:07814470466"><b>07814470466</b></a>`,
  "wessex":                     `<a href="tel:07977670841"><b>07977670841</b></a> or <a href="tel:07483555754"><b>07483555754</b></a>`,
  "north england & scotland":   `<a href="tel:07814089601"><b>07814089601</b></a> or <a href="tel:07484082993"><b>07484082993</b></a>`,
};
const CF_AREAS = {
  "scotland":  `<a href="tel:07866950516"><b>07866950516</b></a> or <a href="tel:07773652734"><b>07773652734</b></a>`,
  "midlands":  `<a href="tel:07773651968"><b>07773651968</b></a>`,
  "south":     `<a href="tel:07773651950"><b>07773651950</b></a>`,
  "north":     `<a href="tel:07773652146"><b>07773652146</b></a>, <a href="tel:07977330563"><b>07977330563</b></a> or <a href="tel:07773652702"><b>07773652702</b></a>`,
};

function handleFlow(text) {
  const q = normalize(text);
  if (!flowCtx) return null;
  if (q === "cancel" || q === "stop" || q === "restart" || q === "back" || q === "go back" || q === "← back") {
    flowCtx = null;
    return { html: "No problem — I've gone back. Feel free to ask anything else or use the <b>Topics</b> button." };
  }

  // ── Work Allocation ──
  if (flowCtx.type === "workAllocation") {
    if (q !== "yes" && q !== "no") return { html: "Has this been raised with your <b>Field and Area Manager</b>?", chips: ["Yes","No"] };
    flowCtx = null;
    return q === "yes"
      ? { html: `Please contact Welfare directly on ${WELFARE} and hold the line.`, chips: ["I can't get through","Thanks — all sorted"] }
      : { html: `Please raise this to your <b>Field and Area Manager</b>. Should there be any further concerns after this step, please contact Welfare directly on ${WELFARE} and hold the line.`, chips: ["Thanks — all sorted"] };
  }

  // ── Manager Dispute ──
  if (flowCtx.type === "managerDispute") {
    if (flowCtx.stage === "askFieldManager") {
      if (q !== "yes" && q !== "no") return { html: "Is this regarding your <b>Field Manager</b>?", chips: ["Yes","No"] };
      if (q === "yes") {
        flowCtx = { type: "managerDispute", stage: "askAreaManager" };
        return { html: "Have you contacted your <b>Area Manager</b>?", chips: ["Yes","No"] };
      }
      // No — not regarding Field Manager → straight to Welfare
      flowCtx = null;
      return { html: `Please contact Welfare directly on ${WELFARE} and hold the line.`, chips: ["I can't get through","Thanks — all sorted"] };
    }
    if (flowCtx.stage === "askAreaManager") {
      if (q !== "yes" && q !== "no") return { html: "Have you contacted your <b>Area Manager</b>?", chips: ["Yes","No"] };
      flowCtx = null;
      return q === "yes"
        // Yes contacted Area Manager → Welfare
        ? { html: `Please contact Welfare directly on ${WELFARE} and hold the line.`, chips: ["I can't get through","Thanks — all sorted"] }
        // No — hasn't contacted Area Manager yet
        : { html: `Please contact your <b>Area Manager</b>. Should there be any further concerns after this step, please contact Welfare directly on ${WELFARE} and hold the line.`, chips: ["I can't get through","Thanks — all sorted"] };
    }
  }

  // ── Equipment ──
  if (flowCtx.type === "equipment") {
    if (flowCtx.stage === "askType") {
      if (q === "stock")   { flowCtx = { type:"equipment", stage:"stockForm" };  return { html: "Have you submitted a <b>Stock Form</b> with your Field Manager?", chips: ["Yes","No","← Back"] }; }
      if (q === "tooling") { flowCtx = { type:"equipment", stage:"bybox" };      return { html: "Has your <b>Field Manager submitted an order through ByBox</b>?", chips: ["Yes","No","← Back"] }; }
      if (q === "van")     { flowCtx = { type:"equipment", stage:"vanRaised" };  return { html: "Have you raised the query of receiving a van to your <b>Field Manager and Area Manager</b>?", chips: ["Yes","No","← Back"] }; }
      return { html: "Sorry — is this about <b>Stock</b>, <b>Tooling</b> or a <b>Van</b>?", chips: ["Stock","Tooling","Van"] };
    }
    if (flowCtx.stage === "stockForm") {
      if (q !== "yes" && q !== "no") return { html: "Have you submitted a <b>Stock Form</b> with your Field Manager?", chips: ["Yes","No"] };
      flowCtx = null;
      return q === "yes"
        ? { html: `Please contact your <b>Field Manager</b> regarding the update of your stock. Any further concerns, please contact Welfare directly on ${WELFARE} and hold the line.`, chips: ["I can't get through","Thanks — all sorted"] }
        : { html: "Please contact your <b>Field Manager</b> and complete a <b>Stock Form</b>." };
    }
    if (flowCtx.stage === "bybox") {
      if (q !== "yes" && q !== "no") return { html: "Has your <b>Field Manager submitted an order through ByBox</b>?", chips: ["Yes","No"] };
      flowCtx = null;
      return q === "yes"
        ? { html: `Please follow up with your <b>Field Manager</b> regarding your order. Any further concerns, please contact Welfare directly on ${WELFARE} and hold the line.`, chips: ["I can't get through","Thanks — all sorted"] }
        : { html: "Please contact your <b>Field Manager</b> and request them to submit an order to <b>ByBox</b>." };
    }
    if (flowCtx.stage === "vanRaised") {
      if (q !== "yes" && q !== "no") return { html: "Have you raised the query of receiving a van to your <b>Field Manager and Area Manager</b>?", chips: ["Yes","No"] };
      flowCtx = null;
      return q === "yes"
        ? { html: `If you have raised this to your <b>Field and Area Manager</b>, please contact Welfare directly on ${WELFARE} and hold the line.`, chips: ["I can't get through","Thanks — all sorted"] }
        : { html: "Please contact your <b>Field Manager</b> and query this through." };
    }
  }

  // ── BTOR NTF area picker ──
  if (flowCtx.type === "btorNtf") {
    const label = normalize(text);
    const match = BTOR_AREAS[label] ?? Object.entries(BTOR_AREAS).find(([k]) => label.includes(k))?.[1];
    flowCtx = null;
    if (match) {
      const display = text.trim() || label;
      return { html: `For NTF <b>${escapeHTML(display)}</b>, please contact: ${match}.`, _intent: "btor_ntf" };
    }
    flowCtx = { type: "btorNtf" };
    return { html: "Sorry, I didn't catch that — please select your area:", chips: ["Wales & Midlands","London & SE","Wessex","North England & Scotland"] };
  }

  // ── City Fibre NTF area picker ──
  if (flowCtx.type === "cfNtf") {
    const label = normalize(text);
    const match = CF_AREAS[label] ?? Object.entries(CF_AREAS).find(([k]) => label === k)?.[1];
    flowCtx = null;
    if (match) {
      const display = text.trim() || label;
      return { html: `For City Fibre NTF <b>${escapeHTML(display)}</b>, please contact: ${match}.`, _intent: "cityfibre_ntf" };
    }
    flowCtx = { type: "cfNtf" };
    return { html: "Sorry, I didn't catch that — please select your area:", chips: ["Scotland","Midlands","South","North"] };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPECIAL CASES — intent-driven responses
// ─────────────────────────────────────────────────────────────────────────────
function specialCases(text) {
  const q      = normalize(text);
  const intent = detectIntent(text);

  // Active flow takes priority — BUT if user clearly wants a new topic, reset
  if (flowCtx) {
    const TOPIC_INTENTS = new Set(['pay_query','deduction_query','sms_query',
      'work_allocation','manager_dispute','equipment','equipment_stock','equipment_tooling',
      'equipment_van','street_works','smart_awards','id_cards','dept_contacts',
      'btor_ntf','cityfibre_ntf','contract','fleet','accident','parking','recruitment',
      'greeting','available_now','opening_times','location','contact_support']);
    const flowAnswers = new Set(['yes','no','stock','tooling','van',
      'wales & midlands','london & se','wessex','north england & scotland',
      'scotland','midlands','south','north']);
    const isNewTopic = TOPIC_INTENTS.has(intent) && !flowAnswers.has(q) && !q.startsWith('use ');
    if (isNewTopic) {
      flowCtx = null;
      // Fall through to handle as fresh intent below
    } else {
      const r = handleFlow(text);
      if (r) return r;
    }
  }

  // ── Active SMS collection flow ──
  if (smsCtx) {
    if (q === "cancel" || q === "stop" || q === "restart") { smsCtx = null; return { html: "No problem — that's been cancelled." }; }
    if (smsCtx.stage === "awaitingConfirm") {
      if (q.includes("yes") || q.includes("sent") || q.includes("done")) {
        smsCtx = null;
        return { html: "Great — the team will be in touch. Is there anything else I can help with?", chips: ["Department Contacts","What are your opening times?","Is anyone available now?"] };
      }
      // They couldn't send — restart the flow
      smsCtx = null;
      return { html: `No problem. You can also call Welfare directly on ${WELFARE} and hold the line, or try sending the text manually to <b>${escapeHTML(SETTINGS.smsNumber)}</b>.`, chips: ["Try again","Department Contacts"] };
    }
    if (smsCtx.stage === "confirmPhone") {
      // They're confirming whether to use saved phone
      // Match "use <number>" chip — compare normalised digits only
      const _savedDigits = (smsCtx.savedPhone || "").replace(/\D/g, "");
      const _qDigits = text.replace(/\D/g, "");
      if (q.startsWith("use ") && _savedDigits && _qDigits === _savedDigits) {
        smsCtx.phone = smsCtx.savedPhone; storePhone(smsCtx.phone); smsCtx.stage = "needType";
        return { html: "Is this a <b>Pay</b> or <b>Deduction</b> query?", chips: ["Pay query","Deduction query"] };
      }
      // They want a different number
      smsCtx.stage = "needPhone"; smsCtx.savedPhone = null;
      return { html: "No problem — what phone number would you like to use?" };
    }
    if (smsCtx.stage === "needPhone") {
      // Basic phone validation
      const digits = text.replace(/[^\d]/g, "");
      if (digits.length < 8 || digits.length > 16) return { html: "That doesn't look like a valid phone number — please enter your number again (8–16 digits):" };
      smsCtx.phone = text.trim(); storePhone(smsCtx.phone); smsCtx.stage = "needType";
      return { html: "Is this a <b>Pay</b> or <b>Deduction</b> query?", chips: ["Pay query","Deduction query"] };
    }
    if (smsCtx.stage === "needType") { smsCtx.type = text.trim(); smsCtx.stage = "needDescription"; return { html: `Please briefly describe your query in 1–3 sentences: <small style="color:var(--text-muted,#8a94a8)">(max ${SETTINGS.smsMaxChars} characters)</small>` }; }
    if (smsCtx.stage === "needDescription") {
      const trimmedDesc = text.trim().slice(0, SETTINGS.smsMaxChars);
      if (text.trim().length > SETTINGS.smsMaxChars) { return { html: `That's a bit long — please keep it under <b>${SETTINGS.smsMaxChars} characters</b>. You currently have <b>${text.trim().length}</b>. Please shorten it and send again.` }; }
      smsCtx.description = trimmedDesc;
      const body = encodeURIComponent(`Welfare Support Query\nEMP: ${empNumber||"N/A"}\nName: ${smsCtx.name}\nPhone: ${smsCtx.phone}\nType: ${smsCtx.type}\nQuery: ${smsCtx.description}`);
      const href = `sms:${SETTINGS.smsNumber}?body=${body}`;
      const html = `<b>Ready to send</b><br>` +
        `EMP: <b>${escapeHTML(empNumber||"N/A")}</b><br>` +
        `Name: <b>${escapeHTML(smsCtx.name)}</b><br>` +
        `Phone: <b>${escapeHTML(smsCtx.phone)}</b><br>` +
        `Type: <b>${escapeHTML(smsCtx.type)}</b><br>` +
        `Query: <b>${escapeHTML(smsCtx.description)}</b><br><br>` +
        `<a href="${escapeAttrUrl(href)}" target="_blank" rel="noopener">📱 Tap here to send your text to ${escapeHTML(SETTINGS.smsNumber)}</a><br>` +
        `<small>Opens your messaging app with the message pre-filled and ready to send.</small>`;
      logSMS({ name: smsCtx.name, phone: smsCtx.phone, type: smsCtx.type, description: smsCtx.description });
      logIntent("sms_sent"); smsCtx = { stage: "awaitingConfirm" };
      return { html, chips: ["Yes — sent ✓","No — try again"], _intent: "sms_sent" };
    }
  }

  // ── Context memory — "what was that number?" ──
  if (lastPhoneNumber && (q.includes("that number") || q.includes("the number") || q.includes("number again") || q.includes("say again") || q.includes("repeat") || q.includes("what was that")))
    return { html: `The last number I mentioned was <a href="tel:${escapeHTML(lastPhoneNumber)}"><b>${escapeHTML(lastPhoneNumber)}</b></a>.` };
  if (q.includes("say it again") || q.includes("repeat that") || q.includes("what did you say") || q.includes("come again")) {
    const last = CHAT_LOG.filter(l => l.role === "Bot").at(-1);
    if (last) return { html: last.text };
  }

  // ── Escalation — can't get through ──
  if (q.includes("cant get through") || q.includes("not get through") || q.includes("not answering") || q.includes("no answer") || q.includes("cant reach") || q.includes("wont answer") || q.includes("not picking up")) {
    return { html: `No problem — here are some alternative options:<br><br>` +
      `📱 <b>Text instead:</b> Start a pay/deduction query above and I'll prepare a text for you.<br>` +
      `📧 <b>Email welfare:</b> Contact your Area Manager to escalate.<br>` +
      `🚨 <b>Urgent out-of-hours:</b><br>` +
      `<b>Fleet (OOH):</b> <a href="tel:07940766377">07940766377</a><br>` +
      `<b>Accident / Injury:</b> <a href="tel:07940792355">07940792355</a>`,
      chips: ["Pay / Payroll query","Department Contacts"], _intent: "contact_support" };
  }

  // ── "Thanks — all sorted" follow-up ──
  if (q === "thanks all sorted" || q === "thanks sorted" || q === "all sorted") {
    const opts = ["Glad to help! 😊 Come back any time.", "Great — hope it gets sorted quickly!", "No problem at all — take care! 👋"];
    return { html: opts[Math.floor(Math.random() * opts.length)], _intent: "thanks" };
  }

  // ── Greetings & small talk ──
  if (intent === "greeting") {
    const opts = ["Hey! 👋 How can I help you today?","Hi there! What can I help you with?","Hello! What's your query today?","Hey, good to hear from you! What can I help with?"];
    return { html: opts[Math.floor(Math.random() * opts.length)], chips: ["Pay / Payroll query","BTOR NTF Support","City Fibre NTF Support","Department Contacts","Work Allocation","Equipment Query"], _intent: "greeting" };
  }
  if (intent === "smalltalk_how") return { html: "I'm doing well thanks! I'm here to help with welfare queries — what do you need?", _intent: "smalltalk" };
  if (intent === "thanks") {
    const opts = ["Happy to help! 😊 Anything else I can do?","No problem at all! Let me know if there's anything else.","You're welcome! Is there anything else you need?"];
    return { html: opts[Math.floor(Math.random() * opts.length)], _intent: "thanks" };
  }
  if (intent === "bye") return { html: "Take care! 👋 Come back any time.", _intent: "bye" };

  // ── Pay / deductions — start SMS flow ──
  // Pre-fill name from EMP gate so they only need to confirm phone number
  // "Try again" after failed SMS send
  if ((q === "try again" || q.includes("try again")) && !smsCtx && !flowCtx) {
    const savedPhone = getStoredPhone();
    smsCtx = { stage: savedPhone ? "confirmPhone" : "needPhone", name: empName || "", savedPhone: savedPhone || null };
    const firstName = empName ? `, <b>${escapeHTML(empName.split(" ")[0])}</b>` : "";
    if (savedPhone) return { html: `Let\'s try again. Use <b>${escapeHTML(savedPhone)}</b>${firstName}?`, chips: [`Use ${savedPhone}`, "Use a different number"] };
    return { html: "Let\'s try again. What phone number would you like to use?" };
  }

  if (intent === "pay_query" || intent === "sms_query" || intent === "deduction_query") {
    const isDeduction = intent === "deduction_query";
    const savedPhone = getStoredPhone();
    smsCtx = { stage: savedPhone ? "confirmPhone" : "needPhone", name: empName || "", savedPhone: savedPhone || null };
    const firstName = empName ? `, <b>${escapeHTML(empName.split(" ")[0])}</b>` : "";
    if (savedPhone) {
      return { html: `${isDeduction ? "I can help with that." : "I'll help you send a text to the pay team."}<br><br>Shall I use your previous number <b>${escapeHTML(savedPhone)}</b>${firstName}?`, chips: [`Use ${savedPhone}`, "Use a different number"], _intent: intent };
    }
    return { html: `${isDeduction ? "I can help with that." : "I'll help you send a text to the pay team."}<br><br>What's the best <b>phone number</b> to reach you on${firstName}?`, _intent: intent };
  }

  // ── Guided flows ──
  if (intent === "work_allocation")  { flowCtx = { type: "workAllocation" }; return { html: "Has this been raised with your <b>Field and Area Manager</b>?", chips: ["Yes","No"], _intent: "work_allocation" }; }
  if (intent === "manager_dispute")  { flowCtx = { type: "managerDispute", stage: "askFieldManager" }; return { html: "Is this regarding your <b>Field Manager</b>?", chips: ["Yes","No"], _intent: "manager_dispute" }; }
  if (intent === "equipment_stock")  { flowCtx = { type: "equipment", stage: "stockForm" };    return { html: "For stock queries — have you submitted a <b>Stock Form</b> with your Field Manager?", chips: ["Yes","No"], _intent: "equipment" }; }
  if (intent === "equipment_tooling"){ flowCtx = { type: "equipment", stage: "bybox" };        return { html: "For tooling — has your <b>Field Manager submitted an order through ByBox</b>?", chips: ["Yes","No"], _intent: "equipment" }; }
  if (intent === "equipment_van")    { flowCtx = { type: "equipment", stage: "vanRaised" };    return { html: "For van queries — have you raised this with your <b>Field Manager and Area Manager</b>?", chips: ["Yes","No"], _intent: "equipment" }; }
  if (intent === "equipment")        { flowCtx = { type: "equipment", stage: "askType" };      return { html: "Is this regarding <b>Stock</b>, <b>Tooling</b> or a <b>Van</b>?", chips: ["Stock","Tooling","Van"], _intent: "equipment" }; }

  // ── NTF flows ──
  if (intent === "btor_ntf")      { flowCtx = { type: "btorNtf" }; return { html: "Please select which area you are based in:", chips: ["Wales & Midlands","London & SE","Wessex","North England & Scotland"], _intent: "btor_ntf" }; }
  if (intent === "cityfibre_ntf") { flowCtx = { type: "cfNtf" };   return { html: "Please select which area you are based in:", chips: ["Scotland","Midlands","South","North"], _intent: "cityfibre_ntf" }; }

  // ── Single-reply intents ──
  if (intent === "contract")        return { html: "For any contract change queries, please raise this to your <b>Area Manager</b>.", chips: ["Department Contacts"], _intent: "contract" };
  if (intent === "street_works")    return { html: `For any Street Work queries please contact <a href="mailto:Street.Works@kelly.co.uk">Street.Works@kelly.co.uk</a>.`, _intent: "street_works" };
  if (intent === "smart_awards")    return { html: `For any Smart Award queries please contact <a href="mailto:smartawards@kelly.co.uk">smartawards@kelly.co.uk</a>.`, _intent: "smart_awards" };
  if (intent === "id_cards")        return { html: `If you have lost, not received or your ID card has expired, please contact <a href="mailto:nuneaton.admin@kelly.co.uk">nuneaton.admin@kelly.co.uk</a>.`, _intent: "id_cards" };
  if (intent === "fleet")           return { html: `Please call <a href="tel:01582841291"><b>01582841291</b></a> or <a href="tel:07940766377"><b>07940766377</b></a> (Out of Hours) for any vehicle or fleet related queries.`, _intent: "fleet" };
  if (intent === "accident")        return { html: `Please call <a href="tel:07940792355"><b>07940792355</b></a> for any accident reports, whether this be injuries or damage reports.`, _intent: "accident" };
  if (intent === "parking")         return { html: `Please call <a href="tel:07940792355"><b>07940792355</b></a> for any parking queries.`, _intent: "parking" };
  if (intent === "recruitment")     return { html: `Please call <a href="tel:02037583058"><b>02037583058</b></a> for recruitment.`, _intent: "recruitment" };
  if (intent === "contact_support") return { html: `You can reach Welfare on ${WELFARE} — please hold the line when prompted.`, chips: ["Department Contacts","What are your opening times?"], _intent: "contact_support" };

  if (intent === "opening_times") return { html: "We're open <b>Monday–Friday, 8:30am–5:00pm</b> (UK time), closed weekends and bank holidays.", chips: ["Is anyone available now?","Are you open on bank holidays?"], _intent: "opening_times" };
  if (intent === "bank_holiday")  return { html: "❌ <b>We are not open on bank holidays.</b>", chips: ["What are your opening times?"], _intent: "opening_times" };

  if (intent === "available_now") {
    if (isOpenNow()) return { html: `✅ Yes — we're <b>open right now</b> (Mon–Fri 8:30am–5pm).<br>Call Welfare on ${WELFARE} and hold the line.`, chips: ["Department Contacts"], _intent: "available_now" };
    const bh = isBankHolidayToday();
    return { html: `❌ We're currently <b>closed</b>${bh ? " (bank holiday)" : ""}.<br>Office hours: <b>Mon–Fri 8:30am–5pm</b>.<br><br>Urgent out-of-hours contacts:<br><b>Fleet (OOH):</b> <a href="tel:07940766377">07940766377</a><br><b>Accident / Injury:</b> <a href="tel:07940792355">07940792355</a>`, chips: ["What are your opening times?","BTOR NTF Support","City Fibre NTF Support"], _intent: "available_now" };
  }

  if (intent === "dept_contacts") return {
    html: `Here are the department contacts:<br><br>` +
      `<b>Street Works:</b> <a href="mailto:Street.Works@kelly.co.uk">Street.Works@kelly.co.uk</a><br>` +
      `<b>Smart Awards:</b> <a href="mailto:smartawards@kelly.co.uk">smartawards@kelly.co.uk</a><br>` +
      `<b>Support Team / City Fibre Back Office:</b> <a href="tel:02080164966"><b>02080164966</b></a><br>` +
      `<b>BTOR Allocations Team:</b> <a href="tel:02080164962"><b>02080164962</b></a><br>` +
      `<b>Fleet:</b> <a href="tel:01582841291"><b>01582841291</b></a> / <a href="tel:07940766377"><b>07940766377</b></a> (Out of Hours)<br>` +
      `<b>Accident Line:</b> <a href="tel:07940792355"><b>07940792355</b></a><br>` +
      `<b>Parking Line:</b> <a href="tel:07940792355"><b>07940792355</b></a><br>` +
      `<b>Recruitment:</b> <a href="tel:02037583058"><b>02037583058</b></a><br>` +
      `<b>Welfare:</b> <a href="tel:02087583060"><b>02087583060</b></a><br>` +
      `<b>ID Cards:</b> <a href="mailto:nuneaton.admin@kelly.co.uk">nuneaton.admin@kelly.co.uk</a>`,
    chips: ["BTOR NTF Support","City Fibre NTF Support","Is anyone available now?"], _intent: "dept_contacts"
  };

  if (intent === "location") {
    const depot = DEPOTS.nuneaton;
    const tile  = osmTileURL(depot.lat, depot.lon, 13);
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${depot.lat},${depot.lon}`;
    return { html: `Our main office is at <b>${escapeHTML(depot.label)}</b>.<br>${linkTag(mapsUrl,"View on Google Maps")}<br>${imgTag(tile)}`, chips: ["How do I get there?","Department Contacts"], _intent: "location" };
  }

  // "How do I get there?" chip — set up the directions flow
  if (q === "how do i get there" || q === "directions") {
    distanceCtx = { stage: "needOrigin" };
    return { html: "What town or city are you travelling from?", chips: ["Coventry","Birmingham","Leicester","London","Use my location"] };
  }

  // ── Distance / directions flow ──
  if (distanceCtx?.stage === "needOrigin") {
    const cityKey = Object.keys(PLACES).find(k => q === k || q.includes(k));
    if (cityKey) {
      const depot = DEPOTS[findClosestDepot(PLACES[cityKey])?.depotKey];
      distanceCtx = { stage: "haveClosest", originKey: cityKey, depotKey: "nuneaton" };
      return { html: `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>How are you travelling?`, chips: ["By car","By train","By bus","Walking"] };
    }
  }
  if (distanceCtx?.stage === "haveClosest" && ["by car","by train","by bus","walking"].includes(q)) {
    const mode   = q === "walking" ? "walk" : q.replace("by ", "");
    const depot  = DEPOTS[distanceCtx.depotKey];
    const origin = distanceCtx.originKey === "your location" ? "your location" : distanceCtx.originKey;
    const url    = googleDirectionsURL(origin, depot, mode);
    const tile   = osmTileURL(depot.lat, depot.lon, 13);
    distanceCtx  = null;
    return { html: `${linkTag(url, "Get directions in Google Maps")}<br>${imgTag(tile)}` };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FAQ MATCHING — single unified function
// ─────────────────────────────────────────────────────────────────────────────
function scoreMatch(a, b) {
  if (!a || !b) return 0;
  if (a === b)  return 1;
  if (b.includes(a) || a.includes(b)) return 0.92;
  const aT = new Set(a.split(" ").filter(Boolean));
  const bT = new Set(b.split(" ").filter(Boolean));
  const inter = [...aT].filter(t => bT.has(t)).length;
  const union = new Set([...aT,...bT]).size;
  return union ? inter / union : 0;
}

function matchFAQ(text) {
  const q = normalize(text);
  if (!q || !FAQS.length) return null;
  let best = null;
  for (const item of FAQS) {
    const variants = [item.question, ...(item.synonyms || [])].filter(Boolean);
    let score = 0;
    for (const v of variants) { score = Math.max(score, scoreMatch(q, normalize(v))); if (score >= 0.98) break; }
    // Keyword boost
    for (const kw of (item.canonicalKeywords || []).map(k => normalize(k))) {
      if (q.includes(kw)) { score = Math.min(1, score + 0.06); break; }
      if (kw.length >= 5 && levenshtein(q, kw) <= 1) { score = Math.min(1, score + 0.04); break; }
    }
    // Fuzzy word match fallback
    if (score < SETTINGS.minConfidence) score = Math.max(score, fuzzyWordMatch(q, normalize(item.question)) * 0.9);
    if (!best || score > best.score) best = { item, score };
  }
  return best?.score >= SETTINGS.minConfidence ? best.item : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUTOCOMPLETE SUGGESTIONS
// ─────────────────────────────────────────────────────────────────────────────
function getSuggestions(query) {
  if (!query || query.length < 2) return [];
  const q = normalize(query);
  const results = [];
  for (const item of FAQS) {
    const variants = [item.question, ...(item.synonyms || [])].filter(Boolean);
    for (const v of variants) {
      if (normalize(v).includes(q)) { results.push(item.question); break; }
    }
    if (results.length >= 5) break;
  }
  return results;
}

function renderSuggestions(items) {
  if (!suggestionsEl) return;
  suggestionsEl.innerHTML = "";
  if (!items.length) { suggestionsEl.hidden = true; return; }
  items.forEach(label => {
    const div = document.createElement("div"); div.className = "suggestion-item"; div.textContent = label; div.setAttribute("role","option");
    div.addEventListener("mousedown", e => { e.preventDefault(); input.value = label; suggestionsEl.hidden = true; sendChat(); });
    suggestionsEl.appendChild(div);
  });
  suggestionsEl.hidden = false;
}

input.addEventListener("input", () => { if (faqsLoaded) renderSuggestions(getSuggestions(input.value)); });
input.addEventListener("blur",  () => setTimeout(() => { if (suggestionsEl) suggestionsEl.hidden = true; }, 150));
input.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); if (suggestionsEl) suggestionsEl.hidden = true; sendChat(); return; }
  if (!suggestionsEl || suggestionsEl.hidden) return;
  const items = [...suggestionsEl.querySelectorAll(".suggestion-item")];
  const active = suggestionsEl.querySelector(".suggestion-item.active");
  const idx = active ? items.indexOf(active) : -1;
  if (e.key === "ArrowDown") { e.preventDefault(); items[idx + 1]?.classList.add("active"); active?.classList.remove("active"); }
  if (e.key === "ArrowUp")   { e.preventDefault(); items[idx - 1]?.classList.add("active"); active?.classList.remove("active"); }
  if (e.key === "Escape")    { suggestionsEl.hidden = true; }
});

// ─────────────────────────────────────────────────────────────────────────────
// HANDLE USER MESSAGE — main dispatcher
// ─────────────────────────────────────────────────────────────────────────────
async function handleUserMessage(text) {
  if (!text?.trim()) return;
  if (suggestionsEl) suggestionsEl.hidden = true;
  addBubble(text, "user", { speak: false });
  input.value = ""; isResponding = true; sendBtn.disabled = true;
  showTyping();
  // Use input length as proxy — longer questions get slightly more "thinking" time
  await new Promise(r => setTimeout(r, typingDelay(text.length * 3))); hideTyping();

  const special = specialCases(text);
  if (special) {
    if (special._intent) logIntent(special._intent);
    addBubble(special.html, "bot", { html: true });
    if (special.chips) addChips(special.chips);
    isResponding = false; sendBtn.disabled = false; return;
  }

  const faq = matchFAQ(text);
  if (faq) {
    addBubble(faq.answer, "bot", { html: true });
    if (faq.followUps?.length) addChips(faq.followUps);
    isResponding = false; sendBtn.disabled = false; return;
  }

  logUnresolved(text);
  addBubble("I'm not sure about that one — try the <b>Topics</b> button or pick a common query:", "bot", { html: true });
  addChips(["Pay / Payroll query","Department Contacts","BTOR NTF Support","Is anyone available now?"]);
  isResponding = false; sendBtn.disabled = false;
}

function sendChat() { if (isResponding) return; const t = input.value.trim(); if (t) handleUserMessage(t); }
sendBtn.addEventListener("click", sendChat);

clearBtn.addEventListener("click", () => {
  chatWindow.innerHTML = ""; smsCtx = null; distanceCtx = null; flowCtx = null; CHAT_LOG = [];
  if (suggestionsEl) suggestionsEl.hidden = true;
  init();
});

// ─────────────────────────────────────────────────────────────────────────────
// TOPICS DRAWER
// ─────────────────────────────────────────────────────────────────────────────
function buildCategoryIndex() {
  categoryIndex = new Map();
  FAQS.forEach(item => {
    const key = (item.category ?? "general").toLowerCase();
    if (!categoryIndex.has(key)) categoryIndex.set(key, []);
    categoryIndex.get(key).push(item);
  });
  const labelMap = { general:"General",support:"Support",opening:"Opening times",actions:"Actions",pay:"Pay & Deductions",work:"Work Allocation",contract:"Contract",departments:"Departments",equipment:"Equipment" };
  categories = [...categoryIndex.keys()].sort().map(key => ({ key, label: labelMap[key] ?? (key[0].toUpperCase() + key.slice(1)), count: categoryIndex.get(key).length }));
}

function openDrawer()  { drawerOverlay.hidden = false; drawer.hidden = false; }
function closeDrawer() { drawerOverlay.hidden = true; drawer.hidden = true; const ds = document.getElementById("drawerSearch"); if (ds) { ds.value = ""; renderDrawer(null); } }

function renderDrawer(selectedKey, searchQ) {
  const sq = (searchQ || "").toLowerCase().trim();
  drawerCategoriesEl.innerHTML = ""; drawerQuestionsEl.innerHTML = "";

  // Search box — inject once at top of drawer body
  if (!document.getElementById("drawerSearch")) {
    const sw = document.createElement("div");
    sw.style.cssText = "padding:0 0 12px 0";
    sw.innerHTML = '<input id="drawerSearch" type="text" placeholder="Search topics…" autocomplete="off" style="width:100%;padding:9px 12px;border:1.5px solid var(--border-mid,rgba(26,58,107,0.18));border-radius:10px;font-size:13.5px;font-family:var(--font,system-ui);color:var(--text-primary,#0d1f3c);background:var(--surface-3,#eef2fb);outline:none"/>';
    drawerCategoriesEl.parentElement.insertBefore(sw, drawerCategoriesEl);
    document.getElementById("drawerSearch").addEventListener("input", e => renderDrawer(null, e.target.value));
    document.getElementById("drawerSearch").addEventListener("keydown", e => { if (e.key === "Escape") { e.target.value = ""; renderDrawer(selectedKey); } });
  }
  categories.forEach(c => {
    const pill = document.createElement("button"); pill.type = "button"; pill.className = "cat-pill"; pill.textContent = `${c.label} (${c.count})`; pill.setAttribute("aria-selected", String(c.key === selectedKey));
    pill.addEventListener("click", () => renderDrawer(c.key)); drawerCategoriesEl.appendChild(pill);
  });
  const list = sq
    ? FAQS.filter(item => item.question.toLowerCase().includes(sq) || (item.synonyms||[]).some(s=>s.toLowerCase().includes(sq)))
    : (selectedKey && categoryIndex.has(selectedKey) ? categoryIndex.get(selectedKey) : FAQS);
  if (sq && list.length === 0) { drawerQuestionsEl.innerHTML = '<p style="font-size:13px;color:var(--text-muted,#8a94a8);padding:16px 4px">No topics found for \"' + sq + '\". Try a different word.</p>'; return; }
  list.forEach(item => {
    const b = document.createElement("button"); b.type = "button"; b.className = "drawer-q"; b.textContent = item.question;
    b.addEventListener("click", () => { closeDrawer(); handleUserMessage(item.question); }); drawerQuestionsEl.appendChild(b);
  });
}

topicsBtn.addEventListener("click",  () => { if (faqsLoaded) openDrawer(); else addBubble("Loading topics — please try again in a moment.", "bot", { speak: false }); });
drawerOverlay.addEventListener("click", closeDrawer);
drawerCloseBtn.addEventListener("click", closeDrawer);

// Bundled FAQs — always available as fallback
const BUNDLED_FAQS = [{"question":"What are your opening times?","answer":"We're open <b>Monday\u2013Friday, 8:30am\u20135:00pm</b> (UK time). We're <b>closed on weekends and bank holidays</b>.","synonyms":["opening times","opening hours","office hours","business hours","when do you open","what time do you open","what time do you close","when are you open","what time","working hours","open hours","are you open"],"canonicalKeywords":["hours","open","times","availability"],"category":"opening","followUps":["Is anyone available now?","Are you open on bank holidays?","How can I contact support?"]},{"question":"Are you open on bank holidays?","answer":"<b>No \u2014 we are not open on bank holidays.</b> If you have an urgent query out of hours, please contact:<br><b>Fleet (OOH):</b> <a href=\"tel:07940766377\">07940766377</a><br><b>Accident / Injury:</b> <a href=\"tel:07940792355\">07940792355</a>","synonyms":["bank holiday","bank holidays","open on bank holidays","closed on bank holidays","public holiday","open on public holiday"],"canonicalKeywords":["bank holiday","public holiday","open","closed"],"category":"opening","followUps":["What are your opening times?","Is anyone available now?","Department Contacts"]},{"question":"Is anyone available now?","answer":"Ask <b>is anyone available</b> and I'll check if we're open right now based on UK time.","synonyms":["is anyone available","anyone available","available now","open now","are you open now","anyone there","is anyone there","can i speak to someone","speak to someone","talk to someone"],"canonicalKeywords":["available","open","now","speak"],"category":"opening","followUps":["What are your opening times?","How can I contact support?","Department Contacts"]},{"question":"How can I contact support?","answer":"You can reach Welfare directly on <a href=\"tel:02087583060\"><b>02087583060</b></a> \u2014 please hold the line when prompted.","synonyms":["support","customer service","help contact","contact details","phone number","welfare number","welfare contact","contact welfare","call welfare","speak to welfare","welfare team","get help","need help"],"canonicalKeywords":["contact","welfare","support","help","phone"],"category":"support","followUps":["Department Contacts","What are your opening times?","Is anyone available now?"]},{"question":"Where are you located?","answer":"We're based in <b>Nuneaton, UK</b>. Visits are by appointment only.","synonyms":["address","office location","where is your office","location","where are you","your address","office address","where is the office","nuneaton"],"canonicalKeywords":["address","location","office","nuneaton"],"category":"general","followUps":["Get directions to my closest depot","Department Contacts"]},{"question":"Get directions to my closest depot","answer":"Type <b>directions</b> or tap the <b>How do I get there?</b> chip and I'll guide you \u2014 you can use GPS or select a nearby city.","synonyms":["closest depot","how far depot","distance to depot","depot directions","directions to depot","how do i get there","how to get there","get there","nearest depot","how far is the depot"],"canonicalKeywords":["depot","closest","nearest","distance","directions","get there"],"category":"actions","followUps":["Where are you located?","Department Contacts"]},{"question":"Work Allocation query","answer":"Has this already been raised with your <b>Field and Area Manager</b>? If yes, contact Welfare on <a href=\"tel:02087583060\"><b>02087583060</b></a> and hold the line. If not, please raise it with them first.","synonyms":["work allocation","job allocation","allocated work","no work","work query","not got work","haven't got work","no jobs","no job","not been allocated","not allocated","no allocation","no shifts","where is my work","need work","run out of work","wrong job","wrong work","given wrong job","allocated wrong"],"canonicalKeywords":["work","allocation","jobs","shifts","allocated"],"category":"work","followUps":["How can I contact support?","Department Contacts"]},{"question":"Manager dispute or issue","answer":"I'm sorry to hear that. Please first raise this with your <b>Field Manager</b>, then your <b>Area Manager</b>. If concerns remain unresolved, contact Welfare on <a href=\"tel:02087583060\"><b>02087583060</b></a> and hold the line.","synonyms":["manager dispute","dispute with manager","problem with manager","issue with manager","trouble with manager","argument with manager","conflict with manager","my manager","field manager issue","area manager issue","unfair manager","manager treating me","manager not helping","manager won't","manager wont"],"canonicalKeywords":["manager","dispute","issue","problem","conflict"],"category":"work","followUps":["How can I contact support?","Department Contacts"]},{"question":"Contract change query","answer":"For any contract change queries, please raise this with your <b>Area Manager</b>.","synonyms":["contract change","change contract","contract query","contract amendment","amend contract","contract issue","contract hours","contract type","permanent","part time","full time","contract update","my contract"],"canonicalKeywords":["contract","change","hours","amendment"],"category":"contract","followUps":["How can I contact support?","Department Contacts"]},{"question":"Equipment query \u2014 Stock","answer":"For stock queries \u2014 please first ensure a <b>Stock Form has been submitted with your Field Manager</b>. If already raised, follow up with your Field Manager. If needed, contact Welfare on <a href=\"tel:02087583060\"><b>02087583060</b></a>.","synonyms":["stock","no stock","out of stock","missing stock","stock query","stock issue","stock form","need stock","request stock","equipment stock"],"canonicalKeywords":["stock","equipment","form"],"category":"equipment","followUps":["Equipment query \u2014 Tooling","Equipment query \u2014 Van","How can I contact support?"]},{"question":"Equipment query \u2014 Tooling","answer":"For tooling queries \u2014 please ensure your <b>Field Manager has submitted an order through ByBox</b>. If already raised, follow up on the ByBox order status. If needed, contact Welfare on <a href=\"tel:02087583060\"><b>02087583060</b></a>.","synonyms":["tooling","tools","no tools","missing tools","need tools","tool query","tool issue","bybox","by box","tool order","order tools","equipment tools"],"canonicalKeywords":["tools","tooling","bybox","equipment"],"category":"equipment","followUps":["Equipment query \u2014 Stock","Equipment query \u2014 Van","How can I contact support?"]},{"question":"Equipment query \u2014 Van","answer":"For van queries \u2014 please ensure this has been <b>raised with your Field Manager and Area Manager</b>. If already raised, contact Welfare on <a href=\"tel:02087583060\"><b>02087583060</b></a> and hold the line.","synonyms":["van","no van","need a van","van query","van issue","van problem","company van","work van","my van","van not arrived","haven't got a van","havent got a van","when do i get a van","equipment van"],"canonicalKeywords":["van","vehicle","equipment"],"category":"equipment","followUps":["Equipment query \u2014 Stock","Equipment query \u2014 Tooling","How can I contact support?"]},{"question":"Street Works query","answer":"For any Street Works queries please contact <a href=\"mailto:Street.Works@kelly.co.uk\">Street.Works@kelly.co.uk</a>.","synonyms":["street works","streetworks","street work query","sw query","sw issue","street job"],"canonicalKeywords":["street works","streetworks"],"category":"departments","followUps":["Department Contacts"]},{"question":"Smart Awards query","answer":"For any Smart Awards queries please contact <a href=\"mailto:smartawards@kelly.co.uk\">smartawards@kelly.co.uk</a>.","synonyms":["smart awards","smartawards","smart award query","award query","award issue","my award","claim award"],"canonicalKeywords":["smart awards","smartawards","award"],"category":"departments","followUps":["Department Contacts"]},{"question":"ID Cards","answer":"If you have lost, not received, or your ID card has expired, please contact <a href=\"mailto:nuneaton.admin@kelly.co.uk\">nuneaton.admin@kelly.co.uk</a>.","synonyms":["id card","id cards","lost id","id expired","id not received","identification card","id badge","id not arrived","need new id","replace id","id renewal"],"canonicalKeywords":["id card","id","identification","badge"],"category":"general","followUps":["How can I contact support?","Department Contacts"]},{"question":"Department Contacts","answer":"Here are the main department contacts:<br><b>Welfare:</b> <a href=\"tel:02087583060\">02087583060</a><br><b>Street Works:</b> <a href=\"mailto:Street.Works@kelly.co.uk\">Street.Works@kelly.co.uk</a><br><b>Smart Awards:</b> <a href=\"mailto:smartawards@kelly.co.uk\">smartawards@kelly.co.uk</a><br><b>Support / City Fibre Back Office:</b> <a href=\"tel:02080164966\">02080164966</a><br><b>BTOR Allocations:</b> <a href=\"tel:02080164962\">02080164962</a><br><b>Fleet:</b> <a href=\"tel:01582841291\">01582841291</a> / <a href=\"tel:07940766377\">07940766377</a> (OOH)<br><b>Accident &amp; Parking:</b> <a href=\"tel:07940792355\">07940792355</a><br><b>Recruitment:</b> <a href=\"tel:02037583058\">02037583058</a>","synonyms":["department contacts","departments","contacts","who do i contact","contact list","all contacts","all numbers","contact details","all departments","who do i call","which number","what number"],"canonicalKeywords":["department","contacts","contact","numbers"],"category":"departments","followUps":["BTOR NTF Support","City Fibre NTF Support","How can I contact support?"]},{"question":"BTOR NTF Support","answer":"Please select which area you are based in:<br><b>Wales &amp; Midlands:</b> <a href=\"tel:07484034863\">07484034863</a> or <a href=\"tel:07483932673\">07483932673</a><br><b>London &amp; SE:</b> <a href=\"tel:07814089467\">07814089467</a> or <a href=\"tel:07814470466\">07814470466</a><br><b>Wessex:</b> <a href=\"tel:07977670841\">07977670841</a> or <a href=\"tel:07483555754\">07483555754</a><br><b>North England &amp; Scotland:</b> <a href=\"tel:07814089601\">07814089601</a> or <a href=\"tel:07484082993\">07484082993</a>","synonyms":["btor ntf","btor ntf support","openreach ntf","ntf support btor","ntf","btor","openreach","open reach","btor support","btor contact"],"canonicalKeywords":["btor","ntf","openreach"],"category":"departments","followUps":["City Fibre NTF Support","Department Contacts"]},{"question":"City Fibre NTF Support","answer":"Please select which area you are based in:<br><b>Scotland:</b> <a href=\"tel:07866950516\">07866950516</a> or <a href=\"tel:07773652734\">07773652734</a><br><b>Midlands:</b> <a href=\"tel:07773651968\">07773651968</a><br><b>South:</b> <a href=\"tel:07773651950\">07773651950</a><br><b>North:</b> <a href=\"tel:07773652146\">07773652146</a>, <a href=\"tel:07977330563\">07977330563</a> or <a href=\"tel:07773652702\">07773652702</a>","synonyms":["city fibre ntf","city fibre ntf support","cityfibre ntf","ntf support city fibre","city fibre","cityfibre","cf ntf","cf support","city fibre support"],"canonicalKeywords":["city fibre","cityfibre","ntf","cf"],"category":"departments","followUps":["BTOR NTF Support","Department Contacts"]},{"question":"Fleet query","answer":"For any vehicle or fleet related queries please call <a href=\"tel:01582841291\"><b>01582841291</b></a> or <a href=\"tel:07940766377\"><b>07940766377</b></a> (out of hours).","synonyms":["fleet","vehicle","fleet query","fleet contact","fleet issue","breakdown","car broken","company car","vehicle broken","my vehicle","van broken","vehicle query"],"canonicalKeywords":["fleet","vehicle","breakdown","car"],"category":"departments","followUps":["Department Contacts","Accident or injury report"]},{"question":"Accident or injury report","answer":"For any accident reports \u2014 whether injuries or vehicle damage \u2014 please call <a href=\"tel:07940792355\"><b>07940792355</b></a> as soon as possible.","synonyms":["accident","injury","accident report","injury report","damage report","accident line","hurt","injured","had an accident","been in accident","crash","vehicle damage","road accident","near miss"],"canonicalKeywords":["accident","injury","damage","hurt","crash"],"category":"departments","followUps":["Department Contacts","Fleet query"]},{"question":"Parking query","answer":"For any parking queries please call <a href=\"tel:07940792355\"><b>07940792355</b></a>.","synonyms":["parking","parking query","parking ticket","parking fine","parking issue","penalty charge","pcn","council fine"],"canonicalKeywords":["parking","pcn","fine","ticket"],"category":"departments","followUps":["Department Contacts"]},{"question":"Recruitment","answer":"For recruitment queries please call <a href=\"tel:02037583058\"><b>02037583058</b></a>.","synonyms":["recruitment","recruiting","new job","job application","apply for job","hiring","vacancy","start date","when do i start","joining","onboarding","onboard"],"canonicalKeywords":["recruitment","hiring","job","vacancy","apply"],"category":"departments","followUps":["Department Contacts","How can I contact support?"]}];

// Load FAQs — try Supabase KV first (live, editor changes instant),
// then bundled FAQs as fallback
(async function loadFAQs() {
  try {
    const resp = await fetch(
      `${_SB_URL}/rest/v1/kv_store?key=eq.ws_faqs_edited&limit=1&select=value`,
      { headers: { apikey: _SB_ANON, Authorization: 'Bearer ' + _SB_ANON } }
    );
    if (resp.ok) {
      const rows = await resp.json();
      if (rows && rows.length && rows[0].value) {
        const data = JSON.parse(rows[0].value);
        if (Array.isArray(data) && data.length) {
          FAQS = data;
          faqsLoaded = true;
          buildCategoryIndex();
          renderDrawer(null);
          return;
        }
      }
    }
  } catch {}
  // Fallback 1: local faqs.json file
  try {
    const r = await fetch("./public/config/faqs.json");
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length) {
        FAQS = data; faqsLoaded = true; buildCategoryIndex(); renderDrawer(null); return;
      }
    }
  } catch {}
  // Fallback 2: bundled FAQs (always works)
  FAQS = BUNDLED_FAQS;
  faqsLoaded = true;
  buildCategoryIndex();
  renderDrawer(null);
})();

// ─────────────────────────────────────────────────────────────────────────────
// INIT — show greeting after login
// ─────────────────────────────────────────────────────────────────────────────
function init() {
  checkBroadcast();
  const firstName = empName ? empName.split(" ")[0] : null;
  const namePrefix = firstName ? `Hi <b>${escapeHTML(firstName)}</b>! ` : "";
  // Use document-specified greeting when open
  if (isOpenNow()) {
    addBubble(
      `${namePrefix}I'm <b>Welfare Support</b>, please let me know what your query is regarding using the <b>Topics</b> button or type below.`,
      "bot", { html: true, speak: false, noFeedback: true }
    );
  } else {
    addBubble(namePrefix + getGreeting(), "bot", { html: true, speak: false, noFeedback: true });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EMP LIST VALIDATION
// Reads the list saved by admin.html from shared/local storage.
// Returns { valid: bool, name: string|null }
// If no list is stored, validation is disabled (all 6-digit EMPs pass).
// ─────────────────────────────────────────────────────────────────────────────
const EMP_LIST_KEY = 'ws_emp_list';

// ── Supabase config — must match index.html ──────────────────────────────
// These are read by lookupEMP to fetch the EMP list directly.
// Update these if you ever change your Supabase project.
const _SB_URL  = 'https://jlhtcwsbigznojwfxmox.supabase.co';
const _SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpsaHRjd3NiaWd6bm9qd2Z4bW94Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzOTkzNjcsImV4cCI6MjA4ODk3NTM2N30.u9hOH97ASyyVaLgBKHdrdBo1F8W1BIqwGrm06vcvasU';

async function lookupEMP(emp) {
  let list = null;
  let fetchedFromSupabase = false;

  // ── Step 1: Try Supabase directly (always works cross-device) ──────────
  try {
    const resp = await fetch(
      `${_SB_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(EMP_LIST_KEY)}&limit=1&select=value`,
      { headers: { apikey: _SB_ANON, Authorization: 'Bearer ' + _SB_ANON } }
    );
    if (resp.ok) {
      const rows = await resp.json();
      if (rows && rows.length && rows[0].value) {
        list = JSON.parse(rows[0].value);
        fetchedFromSupabase = true;
        // Cache locally so it works if Supabase is temporarily down
        try { localStorage.setItem('kv:' + EMP_LIST_KEY, rows[0].value); } catch {}
      }
    }
  } catch {}

  // ── Step 2: Fall back to localStorage cache (set by admin or above) ────
  if (!list) {
    try {
      const raw = localStorage.getItem('kv:' + EMP_LIST_KEY) || localStorage.getItem(EMP_LIST_KEY);
      if (raw) list = JSON.parse(raw);
    } catch {}
  }

  // ── Step 3: Decide ──────────────────────────────────────────────────────
  // If we genuinely have no list anywhere — no list has been uploaded yet
  if (!list) return { valid: true, name: null, dept: null, listLoaded: false };

  const rec = list[emp];
  if (rec === undefined) return { valid: false, name: null, dept: null, listLoaded: true };

  const name = typeof rec === 'object' ? rec.name : rec;
  const dept = typeof rec === 'object' ? rec.dept : null;
  return { valid: true, name: name || null, dept: dept || null, listLoaded: true };
}
function showEmpGate() {
  input.disabled = sendBtn.disabled = micBtn.disabled = true;

  const gate = document.createElement("div");
  gate.id = "empGate";
  gate.style.cssText = "position:fixed;inset:0;z-index:9999;background:linear-gradient(145deg,#d6e4ff 0%,#e8f0ff 50%,#f0f5ff 100%);display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif";

  gate.innerHTML = `
    <div style="background:#fff;border-radius:18px;padding:40px 36px;max-width:380px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(13,31,60,0.18),0 0 0 1px rgba(26,58,107,0.08)">
      <div style="font-size:44px;margin-bottom:12px">🔐</div>
      <h2 id="gTitle" style="font-size:20px;font-weight:800;color:#1a3a6b;margin-bottom:6px">Employee Login</h2>
      <p id="gDesc"  style="font-size:13.5px;color:#4a5878;margin-bottom:24px;line-height:1.6">Enter your <strong>6-digit EMP number</strong> to continue.</p>
      <div id="gListStatus" style="font-size:11px;color:#8a94a8;margin-bottom:8px;margin-top:-16px;display:none"></div>
      <input id="gEmp" type="text" inputmode="numeric" maxlength="6" placeholder="e.g. 123456" autocomplete="off" spellcheck="false"
        style="width:100%;padding:14px 16px;font-size:22px;letter-spacing:6px;text-align:center;border:2px solid rgba(26,58,107,0.18);border-radius:12px;outline:none;font-family:monospace;color:#0d1f3c;background:#f7f9ff;margin-bottom:12px;transition:border-color 0.15s,box-shadow 0.15s"/>
      <div id="gErr" style="font-size:13px;color:#dc2626;font-weight:600;min-height:18px;margin-bottom:12px;display:none"></div>
      <button id="gNext" style="width:100%;padding:13px;font-size:15px;font-weight:700;background:#1a3a6b;color:#fff;border:none;border-radius:12px;cursor:pointer;transition:background 0.15s">Continue →</button>
      <div id="gStep2" style="display:none;margin-top:20px">
        <p style="font-size:13.5px;color:#4a5878;margin-bottom:12px;line-height:1.5">Now enter your <strong>full name</strong>.</p>
        <input id="gName" type="text" placeholder="e.g. John Smith" autocomplete="name"
          style="width:100%;padding:12px 16px;font-size:16px;text-align:center;border:2px solid rgba(26,58,107,0.18);border-radius:12px;outline:none;color:#0d1f3c;background:#f7f9ff;margin-bottom:12px;transition:border-color 0.15s;font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif"/>
        <button id="gStart" style="width:100%;padding:13px;font-size:15px;font-weight:700;background:#16a34a;color:#fff;border:none;border-radius:12px;cursor:pointer;transition:background 0.15s">Start chat →</button>
      </div>
    </div>`;
  document.body.appendChild(gate);

  const gEmp   = gate.querySelector("#gEmp");
  const gNext  = gate.querySelector("#gNext");
  const gErr   = gate.querySelector("#gErr");
  const gStep2 = gate.querySelector("#gStep2");
  const gName  = gate.querySelector("#gName");
  const gStart = gate.querySelector("#gStart");
  let attempts = 0;
  let validating = false; // prevents double-fire from auto-submit + button click

  function shake(el) { el.animate([{transform:"translateX(0)"},{transform:"translateX(-8px)"},{transform:"translateX(8px)"},{transform:"translateX(-6px)"},{transform:"translateX(6px)"},{transform:"translateX(0)"}],{duration:360,easing:"ease"}); }
  function setErr(msg) { gErr.textContent = msg; gErr.style.display = "block"; gEmp.style.cssText += ";border-color:#dc2626;box-shadow:0 0 0 3px rgba(220,38,38,0.15)"; shake(gEmp); }
  function clrErr() { gErr.style.display = "none"; gEmp.style.borderColor = "rgba(26,58,107,0.18)"; gEmp.style.boxShadow = ""; }

  async function validateEMP() {
    if (validating) return;
    validating = true;
    const raw = gEmp.value.trim();
    if (!/^\d{6}$/.test(raw)) {
      if (++attempts >= 3) { lockout('Too many attempts — please refresh the page to try again.'); return; }
      validating = false;
      setErr(`Please enter exactly 6 digits. ${3 - attempts} attempt${3 - attempts !== 1 ? "s" : ""} remaining.`);
      gEmp.value = ""; gEmp.focus(); return;
    }
    // Disable button while checking
    gNext.disabled = true; gNext.textContent = 'Checking…';
    const result = await lookupEMP(raw);
    gNext.disabled = false; gNext.textContent = 'Continue →';
    // Show list status for transparency
    const statusEl = gate.querySelector("#gListStatus");
    if (statusEl) {
      if (!result.listLoaded) {
        statusEl.textContent = "ℹ️ No EMP list loaded — open access mode";
        statusEl.style.display = "block";
        statusEl.style.color = "#d97706";
      } else {
        statusEl.style.display = "none";
      }
    }

    if (!result.valid) {
      if (++attempts >= 3) { lockout('EMP number not recognised. Please contact your manager or HR to verify your EMP number.'); return; }
      validating = false;
      setErr(`EMP number not found on our system. ${3 - attempts} attempt${3 - attempts !== 1 ? "s" : ""} remaining.`);
      gEmp.value = ""; gEmp.focus(); return;
    }

    // Valid EMP — if we have their name from the spreadsheet, skip the name step
    clrErr(); empNumber = raw;
    if (result.name) {
      empName = result.name;
      storeEmpSession(empNumber, empName, result.dept); logEmployee(empNumber, empName, result.dept); saveSession();
      gate.style.transition = "opacity 0.35s ease"; gate.style.opacity = "0";
      setTimeout(() => { gate.remove(); input.disabled = sendBtn.disabled = micBtn.disabled = false; init(); }, 360);
      return;
    }
    // No name in spreadsheet (or no list) — ask for name
    gEmp.disabled = true; gNext.style.display = "none";
    gate.querySelector("#gTitle").textContent = "Almost there!";
    gate.querySelector("#gDesc").style.display = "none";
    gStep2.style.display = "block"; setTimeout(() => gName.focus(), 50);
  }

  function validateName() {
    if (gName.value.trim().length < 2) { gName.style.borderColor = "#dc2626"; shake(gName); return; }
    empName = gName.value.trim(); storeEmpSession(empNumber, empName, null); logEmployee(empNumber, empName, null); saveSession();
    gate.style.transition = "opacity 0.35s ease"; gate.style.opacity = "0";
    setTimeout(() => { gate.remove(); input.disabled = sendBtn.disabled = micBtn.disabled = false; init(); }, 360);
  }

  function lockout(msg) {
    gEmp.disabled = gNext.disabled = true;
    gErr.textContent = msg; gErr.style.display = "block";
    gEmp.style.borderColor = "#dc2626";
  }

  gEmp.addEventListener("focus", clrErr);
  gEmp.addEventListener("input", () => { if (/^\d{6}$/.test(gEmp.value.trim())) validateEMP(); });
  gNext.addEventListener("click", validateEMP);
  gEmp.addEventListener("keydown",  e => { if (e.key === "Enter") validateEMP(); });
  gName.addEventListener("keydown", e => { if (e.key === "Enter") validateName(); });
  gStart.addEventListener("click",  validateName);
  gNext.addEventListener("mouseenter",  () => { gNext.style.background  = "#1e4d9b"; });
  gNext.addEventListener("mouseleave",  () => { gNext.style.background  = "#1a3a6b"; });
  gStart.addEventListener("mouseenter", () => { gStart.style.background = "#15803d"; });
  gStart.addEventListener("mouseleave", () => { gStart.style.background = "#16a34a"; });

  setTimeout(() => gEmp.focus(), 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────────────────────
function boot() {
  const stored = getStoredEmpSession();
  if (stored) { empNumber = stored.emp; empName = stored.name; logEmployee(empNumber, empName, stored.dept || null); init(); }
  else showEmpGate();
}

document.readyState === "loading" ? window.addEventListener("DOMContentLoaded", boot) : boot();
