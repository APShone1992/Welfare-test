/*
   Welfare Support Chatbot — Optimised Full Version (2026)
   --------------------------------------------------------
   Includes:
   - Updated greeting
   - BTOR + CityFibre NTF flows
   - Updated Pay/Deductions SMS flow
   - Updated Work Allocation, Manager Dispute, Equipment flows
   - Grouped Topics support
   - NLP improvements
   - Context memory
*/

//////////////////////////////
// SETTINGS
//////////////////////////////

const SETTINGS = {
  minConfidence: 0.20,
  suggestionLimit: 5,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  smsNumber: "07773652107",
  smsMaxChars: 500
};

// GitHub Pages-safe path
const FAQ_PATH = "public/config/faqs.json";

//////////////////////////////
// DOM ELEMENTS
//////////////////////////////

const chatWindow = document.getElementById("chatWindow");
const input      = document.getElementById("chatInput");
const sendBtn    = document.getElementById("sendBtn");
const clearBtn   = document.getElementById("clearBtn");
const suggestionsEl = document.getElementById("suggestions");

const topicsBtn  = document.getElementById("topicsBtn");
const drawer     = document.getElementById("topicsDrawer");
const overlay    = document.getElementById("drawerOverlay");
const drawerCloseBtn = document.getElementById("drawerCloseBtn");
const drawerCategoriesEl = document.getElementById("drawerCategories");
const drawerQuestionsEl = document.getElementById("drawerQuestions");

const micBtn   = document.getElementById("micBtn");
const voiceBtn = document.getElementById("voiceBtn");

//////////////////////////////
// STATE
//////////////////////////////

let isResponding = false;
let lastChipClickAt = 0;
let activeSuggestionIndex = -1;
let currentSuggestions = [];

let FAQS = [];
let categories = [];
let categoryIndex = new Map();

let CHAT_LOG = [];

let smsCtx = null;       // Pay/Deductions SMS flow
let distanceCtx = null;  // Depot finder flow
let flowCtx = null;      // Work allocation / manager / equipment flows
let lastPhoneNumber = null;

//////////////////////////////
// ANALYTICS STORAGE
//////////////////////////////

const WS_SESSIONS_KEY = "ws_sessions_v1";
const WS_INTENTS_KEY  = "ws_intents_v1";
const WS_SMS_LOG_KEY  = "ws_sms_log_v1";
const UNRESOLVED_KEY  = "ws_unresolved_v1";

//////////////////////////////
// SESSION TRACKING
//////////////////////////////

const SESSION_ID = Date.now() + "_" + Math.random().toString(36).slice(2,7);
const SESSION_START = Date.now();
let sessionMsgCount = 0;

function saveSession() {
  try {
    const sessions = JSON.parse(localStorage.getItem(WS_SESSIONS_KEY) || "[]");
    const existing = sessions.findIndex(s => s.id === SESSION_ID);

    const entry = {
      id: SESSION_ID,
      start: SESSION_START,
      end: Date.now(),
      messages: sessionMsgCount,
      date: new Date(SESSION_START).toISOString().slice(0,10)
    };

    if (existing >= 0) sessions[existing] = entry;
    else sessions.push(entry);

    if (sessions.length > 2000)
      sessions.splice(0, sessions.length - 2000);

    localStorage.setItem(WS_SESSIONS_KEY, JSON.stringify(sessions));
  } catch {}
}

setInterval(saveSession, 30000);
window.addEventListener("beforeunload", saveSession);

function logIntent(intent) {
  try {
    const arr = JSON.parse(localStorage.getItem(WS_INTENTS_KEY) || "[]");
    arr.push({ intent, ts: Date.now(), date: new Date().toISOString().slice(0,10) });

    if (arr.length > 5000)
      arr.splice(0, arr.length - 5000);

    localStorage.setItem(WS_INTENTS_KEY, JSON.stringify(arr));
  } catch {}
}

function logSMS(entry) {
  try {
    const arr = JSON.parse(localStorage.getItem(WS_SMS_LOG_KEY) || "[]");
    arr.push({ ...entry, ts: Date.now(), date: new Date().toISOString().slice(0,10) });

    if (arr.length > 2000)
      arr.splice(0, arr.length - 2000);

    localStorage.setItem(WS_SMS_LOG_KEY, JSON.stringify(arr));
  } catch {}
}

//////////////////////////////
// UNRESOLVED LOG
//////////////////////////////

function logUnresolved(text) {
  try {
    const arr = JSON.parse(localStorage.getItem(UNRESOLVED_KEY) || "[]");
    arr.push({ text, ts: Date.now() });

    if (arr.length > 200)
      arr.splice(0, arr.length - 200);

    localStorage.setItem(UNRESOLVED_KEY, JSON.stringify(arr));
  } catch {}
}

//////////////////////////////
// TIMESTAMP HANDLING
//////////////////////////////

function formatUKTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour:"2-digit",
    minute:"2-digit",
    hour12:false
  }).format(date);
}

function relativeTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return "Just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  return formatUKTime(new Date(ts));
}

setInterval(() => {
  document.querySelectorAll(".timestamp[data-ts]").forEach(el => {
    const t = parseInt(el.dataset.ts);
    if (!Number.isNaN(t))
      el.textContent = relativeTime(t);
  });
}, 30000);

//////////////////////////////
// UK TIME HELPERS
//////////////////////////////

const UK_TZ = "Europe/London";

function getUKDateISO(date = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    year:"numeric",
    month:"2-digit",
    day:"2-digit"
  });

  const p = f.formatToParts(date);
  const y = p.find(i=>i.type==="year")?.value ?? "0000";
  const m = p.find(i=>i.type==="month")?.value ?? "01";
  const d = p.find(i=>i.type==="day")?.value ?? "01";

  return `${y}-${m}-${d}`;
}

function getUKDayIndex(date = new Date()) {
  const wd = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    weekday:"short"
  }).format(date);

  const map = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };
  return map[wd] ?? 0;
}

function getUKMinutesNow(date = new Date()) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    hour:"2-digit",
    minute:"2-digit",
    hour12:false
  });

  const parts = f.formatToParts(date);
  const h = parseInt(parts.find(i=>i.type==="hour")?.value ?? "0", 10);
  const m = parseInt(parts.find(i=>i.type==="minute")?.value ?? "0", 10);

  return h*60 + m;
}

//////////////////////////////
// BUSINESS HOURS
//////////////////////////////

const BUSINESS = {
  start: 8*60 + 30, // 08:30
  end:   17*60,     // 17:00
  openDays: new Set([1,2,3,4,5]) // Mon–Fri
};

const BANK_HOLIDAYS_EW = new Set([
  "2025-01-01","2025-04-18","2025-04-21","2025-05-05","2025-05-26","2025-08-25","2025-12-25","2025-12-26",
  "2026-01-01","2026-04-03","2026-04-06","2026-05-04","2026-05-25","2026-08-31","2026-12-25","2026-12-28",
  "2027-01-01","2027-03-26","2027-03-29","2027-05-03","2027-05-31","2027-08-30","2027-12-27","2027-12-28",
  "2028-01-03","2028-04-14","2028-04-17","2028-05-01","2028-05-29","2028-08-28","2028-12-25","2028-12-26"
]);

function isBankHolidayToday() {
  return BANK_HOLIDAYS_EW.has(getUKDateISO(new Date()));
}

function isOpenNow() {
  const day = getUKDayIndex(new Date());
  const mins = getUKMinutesNow(new Date());

  if (!BUSINESS.openDays.has(day)) return false;
  if (mins < BUSINESS.start || mins >= BUSINESS.end) return false;
  if (isBankHolidayToday()) return false;

  return true;
}

//////////////////////////////
// SANITISATION
//////////////////////////////

function normalize(s) {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[""'']/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeHTMLEntities(txt) {
  const t = document.createElement("textarea");
  t.innerHTML = txt ?? "";
  return t.value;
}

function htmlToPlainText(html) {
  const t = document.createElement("template");
  t.innerHTML = decodeHTMLEntities(html ?? "");
  return (t.content.textContent ?? "").trim();
}
//////////////////////////////
// SANITISE HTML
//////////////////////////////

function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html ?? "";

  const allowedTags = new Set([
    "B","STRONG","I","EM","BR","A","SMALL","IMG","UL","OL","LI"
  ]);

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toReplace = [];

  const isSafeHref = (href) => /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href) || /^sms:/i.test(href);

  while (walker.nextNode()) {
    const el = walker.currentNode;

    if (!allowedTags.has(el.tagName)) { // Replace disallowed element with its text content
      toReplace.push(el);
      continue;
    }

    // Allowlist attributes
    [...el.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();
      if (el.tagName === "A"   && (name === "href" || name === "target" || name === "rel")) return;
      if (el.tagName === "IMG" && (name === "src"  || name === "alt"    || name === "class" || name === "loading")) return;
      el.removeAttribute(attr.name);
    });

    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (!isSafeHref(href)) el.removeAttribute("href");
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }

    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") ?? "";
      if (!/^https:\/\//i.test(src)) {
        toReplace.push(el);
      } else {
        el.setAttribute("loading", "lazy");
        if (!el.getAttribute("alt")) el.setAttribute("alt", "Image");
      }
    }
  }

  toReplace.forEach(node => node.replaceWith(document.createTextNode(node.textContent ?? "")));
  return template.innerHTML;
}

//////////////////////////////
// MESSAGE BUBBLES & FEEDBACK
//////////////////////////////

function addBubble(text, type, opts = {}) {
  const html = !!opts.html;
  const ts = opts.ts ?? new Date();
  const speakThis = opts.speak !== false;

  const row = document.createElement("div");
  row.className = "msg " + type;

  const bubble = document.createElement("div");
  bubble.className = "bubble " + type;

  if (html) bubble.innerHTML = sanitizeHTML(decodeHTMLEntities(text));
  else bubble.textContent = text;

  // Extract last phone number for context recall (from bot messages)
  if (type === "bot") {
    const plain = html ? htmlToPlainText(text) : (text ?? "");
    const match = String(plain).match(/0\d[\d\s]{8,12}/);
    if (match) lastPhoneNumber = match[0].replace(/\s/g, "");
  }

  // Add copy-number button after tel: links
  if (html && type === "bot") {
    bubble.querySelectorAll("a[href^='tel:']").forEach(a => {
      const num = a.getAttribute("href").replace("tel:", "");
      const copyBtn = document.createElement("button");
      copyBtn.className = "copy-num-btn";
      copyBtn.title = "Copy number";
      copyBtn.textContent = "📋";
      copyBtn.addEventListener("click", e => {
        e.preventDefault();
        navigator.clipboard?.writeText(num).then(() => {
          copyBtn.textContent = "✓";
          copyBtn.style.background = "#16a34a";
          setTimeout(() => {
            copyBtn.textContent = "📋";
            copyBtn.style.background = "";
          }, 1500);
        });
      });
      a.insertAdjacentElement("afterend", copyBtn);
    });
  }

  // Meta row (timestamp + feedback)
  const meta = document.createElement("div");
  meta.className = "msg-meta";

  const time = document.createElement("span");
  time.className = "timestamp";
  time.dataset.ts = ts.getTime();
  time.textContent = relativeTime(ts.getTime());
  meta.appendChild(time);

  // Feedback thumbs (only for bot, unless suppressed)
  if (type === "bot" && !opts.noFeedback) {
    const fbWrap = document.createElement("div");
    fbWrap.className = "feedback-btns";

    ["👍","👎"].forEach((emoji, idx) => {
      const fb = document.createElement("button");
      fb.className = "feedback-btn";
      fb.title = idx === 0 ? "Helpful" : "Not helpful";
      fb.textContent = emoji;

      fb.addEventListener("click", () => {
        fbWrap.querySelectorAll(".feedback-btn").forEach(b => (b.disabled = true));
        fb.classList.add("selected");

        if (idx === 1) {
          // Log last user message as unhelpful
          const lastUser = CHAT_LOG.filter(l => l.role === "User").slice(-1)[0];
          if (lastUser) logUnresolved(`${lastUser.text} [marked unhelpful]`);
        }

        const thanks = document.createElement("span");
        thanks.className = "feedback-thanks";
        thanks.textContent = idx === 0 ? "Thanks!" : "Sorry!";
        fbWrap.appendChild(thanks);
      });

      fbWrap.appendChild(fb);
    });

    meta.appendChild(fbWrap);
  }

  row.appendChild(bubble);
  row.appendChild(meta);

  // Prepend to chat (reverse order list)
  chatWindow.prepend(row);

  // Analytics & log
  const plain = html ? htmlToPlainText(text) : String(text ?? "").trim();
  CHAT_LOG.push({ role: type === "bot" ? "Bot" : "User", text: plain, ts: ts.getTime() });
  if (type === "user") { sessionMsgCount++; saveSession(); }

  // Optional TTS
  if (type === "bot" && speakThis) speak(plain);
}

//////////////////////////////
// CHIP BUTTONS (Quick Replies)
//////////////////////////////

function addChips(labels, onClick) {
  if (!labels?.length) return;

  const wrap = document.createElement("div");
  wrap.className = "chips";

  labels.slice(0, SETTINGS.chipLimit).forEach(label => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn";
    b.textContent = label;

    b.addEventListener("click", async () => {
      const now = Date.now();
      if (isResponding) return;
      if (now - lastChipClickAt < SETTINGS.chipClickCooldownMs) return;

      lastChipClickAt = now;
      wrap.querySelectorAll(".chip-btn").forEach(btn => (btn.disabled = true));

      addBubble(label, "user", { speak: false });

      // Special case: Use my location (handled in distance flow)
      if (label === "Use my location" && distanceCtx?.stage === "needOrigin") {
        await handleUseMyLocation();
        return;
      }

      if (typeof onClick === "function") onClick(label);
      else await handleUserMessage(label);
    });

    wrap.appendChild(b);
  });

  chatWindow.prepend(wrap);
}

//////////////////////////////
// TYPING INDICATOR
//////////////////////////////

function showTyping() {
  const row = document.createElement("div");
  row.id = "typingIndicator";
  row.className = "msg bot";

  const bubble = document.createElement("div");
  bubble.className = "bubble bot typing-bubble";
  bubble.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span>`;

  row.appendChild(bubble);
  chatWindow.prepend(row);
}

function hideTyping() {
  const el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

function typingDelay() {
  return 900 + Math.random() * 800; // 900–1700ms
}

//////////////////////////////
// VOICE OUTPUT (TTS) TOGGLE
//////////////////////////////

const VOICE_KEY = "ws_voice_v1";
const voiceState = { on: false, armed: false };

try {
  Object.assign(voiceState, JSON.parse(localStorage.getItem(VOICE_KEY) || "{}"));
} catch {}

function saveVoice() {
  try { localStorage.setItem(VOICE_KEY, JSON.stringify(voiceState)); } catch {}
}

function updateVoiceUI() {
  voiceBtn.classList.toggle("on", voiceState.on);
  voiceBtn.setAttribute("aria-pressed", voiceState.on ? "true" : "false");
}

updateVoiceUI();

// Arm voice on first interaction (required by some browsers)
window.addEventListener("pointerdown", () => { voiceState.armed = true; saveVoice(); }, { passive: true });
window.addEventListener("keydown",      () => { voiceState.armed = true; saveVoice(); }, { passive: true });

voiceBtn.addEventListener("click", () => {
  voiceState.armed = true;
  voiceState.on = !voiceState.on;
  saveVoice();
  updateVoiceUI();
  addBubble(
    `Voice output is now <b>${voiceState.on ? "ON" : "OFF"}</b>.`,
    "bot",
    { html: true, speak: false }
  );
});

function speak(text) {
  if (!voiceState.on || !voiceState.armed) return;
  if (!("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text ?? ""));
    u.lang = "en-GB";
    window.speechSynthesis.speak(u);
  } catch {}
}

//////////////////////////////
// MICROPHONE INPUT (SpeechRecognition)
//////////////////////////////

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let micListening = false;

function initSpeech() {
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.lang = "en-GB";
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    micListening = true;
    micBtn.classList.add("on");
    micBtn.setAttribute("aria-pressed", "true");
  };

  rec.onend = () => {
    micListening = false;
    micBtn.classList.remove("on");
    micBtn.setAttribute("aria-pressed", "false");
  };

  rec.onerror = () => {
    micListening = false;
    micBtn.classList.remove("on");
    micBtn.setAttribute("aria-pressed", "false");
    addBubble("Voice input isn't supported here — please type your question.", "bot", { speak: false });
  };

  rec.onresult = (event) => {
    const t = event.results?.[0]?.[0]?.transcript ?? "";
    if (t.trim()) {
      input.value = t.trim();
      sendChat();
    }
  };

  return rec;
}

recognizer = initSpeech();

micBtn.addEventListener("click", () => {
  voiceState.armed = true; saveVoice();

  if (!recognizer) {
    addBubble("Voice input isn't supported. Try Chrome/Edge, or type your question.", "bot", { speak: false });
    return;
  }

  try {
    if (micListening) recognizer.stop();
    else recognizer.start();
  } catch {
    addBubble("Couldn't start voice input — please try again.", "bot", { speak: false });
  }
});
//////////////////////////////
// NTF AREA MENUS
//////////////////////////////

const BTOR_AREAS = ["Wales & Midlands", "London & SE", "Wessex", "North England & Scotland"];
const BTOR_NUMBERS = {
  "Wales & Midlands": ["07484034863", "07483932673"],
  "London & SE": ["07814089467", "07814470466"],
  "Wessex": ["07977670841", "07483555754"],
  "North England & Scotland": ["07814089601", "07484082993"]
};

const CF_AREAS = ["Scotland", "Midlands", "South", "North"];
const CF_NUMBERS = {
  "Scotland": ["07866950516", "07773652734"],
  "Midlands": ["07773651968"],
  "South": ["07773651950"],
  "North": ["07773652146", "07977330563", "07773652702"]
};

//////////////////////////////
// INTENT DETECTION
//////////////////////////////

function detectIntent(text) {
  const q = normalize(text);

  if (q.includes("pay") && q.includes("payroll")) return "pay_query";
  if (q.includes("deduct")) return "deduction_query";
  if (q.includes("work alloc") || q.includes("no work")) return "work_allocation";
  if (q.includes("manager")) return "manager_dispute";
  if (q.includes("equipment") || q.includes("stock") || q.includes("tool") || q.includes("van")) return "equipment";
  if (q.includes("btor") || q.includes("openreach") || q.includes("ntf")) return "btor_ntf";
  if (q.includes("city fibre") || q.includes("cityfibre") || q.includes("cf ntf")) return "cityfibre_ntf";
  if (q.includes("available") || q.includes("open now")) return "available_now";
  if (q.includes("opening") || q.includes("hours")) return "opening_times";

  return null;
}

//////////////////////////////
// SPECIAL CASE HANDLERS
//////////////////////////////

function specialCases(text) {
  const q = normalize(text);
  const intent = detectIntent(text);

  // --- BTOR NTF SUPPORT ---
  if (intent === "btor_ntf") {
    flowCtx = { type: "ntf_btor", stage: "chooseArea" };
    return { html: "Please select which area you are based in:", chips: BTOR_AREAS };
  }

  // --- CITYFIBRE NTF ---
  if (intent === "cityfibre_ntf") {
    flowCtx = { type: "ntf_cf", stage: "chooseArea" };
    return { html: "Please select which area you are based in:", chips: CF_AREAS };
  }

  // --- AVAILABLE NOW ---
  if (intent === "available_now") {
    const open = isOpenNow();
    return {
      html: open
        ? "✅ Yes — we’re available now."
        : "❌ No — we’re currently closed. We’re open Monday–Friday, 8:30am–5:00pm (UK time).",
      chips: ["What are your opening times?"]
    };
  }

  return null;
}

//////////////////////////////
// FLOW HANDLER
//////////////////////////////

function handleFlow(text) {
  const q = normalize(text);
  if (!flowCtx) return null;

  // BTOR
  if (flowCtx.type === "ntf_btor" && flowCtx.stage === "chooseArea") {
    const picked = BTOR_AREAS.find(a => normalize(a) === q);
    if (!picked) return { html: "Please select an area:", chips: BTOR_AREAS };
    const nums = BTOR_NUMBERS[picked];
    flowCtx = null;
    return { html: `For NTF ${picked}, please contact ${nums.join(" or ")}.` };
  }

  // CITYFIBRE
  if (flowCtx.type === "ntf_cf" && flowCtx.stage === "chooseArea") {
    const picked = CF_AREAS.find(a => normalize(a) === q);
    if (!picked) return { html: "Please select an area:", chips: CF_AREAS };
    const nums = CF_NUMBERS[picked];
    flowCtx = null;
    return { html: `For NTF Support in ${picked}, please contact ${nums.join(" or ")}.` };
  }

  return null;
}

//////////////////////////////
// MAIN MESSAGE HANDLER
//////////////////////////////

async function handleUserMessage(text) {
  if (!text) return;

  addBubble(text, "user", { speak: false });
  input.value = "";

  isResponding = true;
  sendBtn.disabled = true;

  showTyping();
  await new Promise(r => setTimeout(r, typingDelay()));
  hideTyping();

  // FLOW HANDLING
  const flow = handleFlow(text);
  if (flow) {
    addBubble(flow.html, "bot", { html: true });
    if (flow.chips) addChips(flow.chips);
    isResponding = false;
    sendBtn.disabled = false;
    return;
  }

  // SPECIAL CASES
  const special = specialCases(text);
  if (special) {
    addBubble(special.html, "bot", { html: true });
    if (special.chips) addChips(special.chips);
    isResponding = false;
    sendBtn.disabled = false;
    return;
  }

  // NO MATCH
  logUnresolved(text);
  addBubble("I'm not sure about that — try using the Topics button.", "bot", { html: true });
  addChips(["Pay / Payroll", "Deductions", "Work Allocation", "Department Contacts"]);

  isResponding = false;
  sendBtn.disabled = false;
}

//////////////////////////////
// SEND HANDLER
//////////////////////////////

function sendChat() {
  if (!isResponding) handleUserMessage(input.value.trim());
}

sendBtn.addEventListener("click", sendChat);
input.addEventListener("keydown", e => { if (e.key === "Enter") sendChat(); });

//////////////////////////////
// GREETING & INIT
//////////////////////////////

function getGreeting() {
  const open = isOpenNow();
  const base = `Hi! I’m Welfare Support. Please use the <b>Topics</b> button to tell me what your query is about.`;
  if (!open) return base + `<br><br>⚠️ We’re currently <b>closed</b>. Office hours are <b>Mon–Fri 8:30am–5pm</b>.`;
  return base;
}

function init() {
  addBubble(getGreeting(), "bot", { html: true, speak: false, noFeedback: true });
}

if (document.readyState === "loading")
  window.addEventListener("DOMContentLoaded", init);
else
  init();
