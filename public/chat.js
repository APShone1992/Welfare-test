/*
   Welfare Support Chatbot — Fully Optimised Version (2026)
   --------------------------------------------------------
   Cleaned, de-duplicated, faster, safer, corrected for GitHub Pages.
   Author: Copilot rewrite for Adam Shone
*/

//////////////////////////////
//  SETTINGS & CONSTANTS
//////////////////////////////

const SETTINGS = {
  minConfidence: 0.20,
  suggestionLimit: 5,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  smsNumber: "07773652107",
  smsMaxChars: 500
};

// Folder-safe path for GitHub Pages
const FAQ_PATH = "public/config/faqs.json";

//////////////////////////////
//  DOM ELEMENTS
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

const micBtn     = document.getElementById("micBtn");
const voiceBtn   = document.getElementById("voiceBtn");

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

let smsCtx = null;
let distanceCtx = null;
let flowCtx = null;
let lastBotIntent = null;
let lastPhoneNumber = null;

//////////////////////////////
// ANALYTICS KEYS
//////////////////////////////

const WS_SESSIONS_KEY = "ws_sessions_v1";
const WS_INTENTS_KEY  = "ws_intents_v1";
const WS_SMS_LOG_KEY  = "ws_sms_log_v1";
const UNRESOLVED_KEY  = "ws_unresolved_v1";

//////////////////////////////
// SESSION LOGGING
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

    if (sessions.length > 2000) sessions.splice(0, sessions.length - 2000);

    localStorage.setItem(WS_SESSIONS_KEY, JSON.stringify(sessions));
  } catch {}
}

setInterval(saveSession, 30_000);
window.addEventListener("beforeunload", saveSession);

function logIntent(intent) {
  try {
    const arr = JSON.parse(localStorage.getItem(WS_INTENTS_KEY) || "[]");
    arr.push({ intent, ts: Date.now(), date: new Date().toISOString().slice(0,10) });
    if (arr.length > 5000) arr.splice(0, arr.length - 5000);
    localStorage.setItem(WS_INTENTS_KEY, JSON.stringify(arr));
  } catch {}
}

function logSMS(entry) {
  try {
    const arr = JSON.parse(localStorage.getItem(WS_SMS_LOG_KEY) || "[]");
    arr.push({ ...entry, ts: Date.now(), date: new Date().toISOString().slice(0,10) });
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
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
    if (arr.length > 200) arr.splice(0, arr.length - 200);
    localStorage.setItem(UNRESOLVED_KEY, JSON.stringify(arr));
  } catch {}
}

//////////////////////////////
// UK TIME HELPERS
//////////////////////////////

const UK_TZ = "Europe/London";

function formatUKTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    hour:"2-digit",
    minute:"2-digit",
    hour12:false
  }).format(date);
}

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
  start: 8*60 + 30,
  end:   17*60,
  openDays: new Set([1,2,3,4,5])
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
// NORMALISE / SANITISE
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

//////////////////////////////
// STOP — THIS IS THE END OF PART 1
//////////////////////////////
 //////////////////////////////
// MESSAGE BUBBLES & FEEDBACK
//////////////////////////////

function relativeTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return "Just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return formatUKTime(new Date(ts));
}

// Update timestamps automatically
setInterval(() => {
  document.querySelectorAll(".timestamp[data-ts]").forEach(el => {
    el.textContent = relativeTime(parseInt(el.dataset.ts));
  });
}, 30000);

function addBubble(text, type, opts = {}) {
  const html = !!opts.html;
  const ts = opts.ts ?? new Date();
  const speakThis = opts.speak !== false;

  const row = document.createElement("div");
  row.className = "msg " + type;

  const bubble = document.createElement("div");
  bubble.className = "bubble " + type;

  if (html) {
    bubble.innerHTML = sanitizeHTML(decodeHTMLEntities(text));
  } else {
    bubble.textContent = text;
  }

  // Track last phone number mentioned
  if (type === "bot") {
    const plain = html ? htmlToPlainText(text) : text;
    const match = plain.match(/0\d[\d\s]{8,12}/);
    if (match) lastPhoneNumber = match[0].replace(/\s/g, "");
  }

  // Add copy buttons to all tel: links
  if (html && type === "bot") {
    bubble.querySelectorAll("a[href^='tel:']").forEach(a => {
      const num = a.getAttribute("href").replace("tel:", "");
      const copyBtn = document.createElement("button");
      copyBtn.className = "copy-num-btn";
      copyBtn.title = "Copy number";
      copyBtn.textContent = "📋";

      copyBtn.onclick = e => {
        e.preventDefault();
        navigator.clipboard?.writeText(num).then(() => {
          copyBtn.textContent = "✓";
          copyBtn.style.background = "#16a34a";
          setTimeout(() => {
            copyBtn.textContent = "📋";
            copyBtn.style.background = "";
          }, 1500);
        });
      };

      a.insertAdjacentElement("afterend", copyBtn);
    });
  }

  // Timestamp
  const meta = document.createElement("div");
  meta.className = "msg-meta";

  const time = document.createElement("span");
  time.className = "timestamp";
  time.dataset.ts = ts.getTime();
  time.textContent = relativeTime(ts.getTime());
  meta.appendChild(time);

  // Feedback buttons (thumbs up/down)
  if (type === "bot" && !opts.noFeedback) {
    const fbWrap = document.createElement("div");
    fbWrap.className = "feedback-btns";

    ["👍", "👎"].forEach((emoji, idx) => {
      const fb = document.createElement("button");
      fb.className = "feedback-btn";
      fb.textContent = emoji;

      fb.onclick = () => {
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
      };

      fbWrap.appendChild(fb);
    });

    meta.appendChild(fbWrap);
  }

  row.appendChild(bubble);
  row.appendChild(meta);
  chatWindow.prepend(row);

  const plain = html ? htmlToPlainText(text) : String(text ?? "").trim();
  CHAT_LOG.push({ role: type === "bot" ? "Bot" : "User", text: plain, ts: ts.getTime() });
  if (type === "user") {
    sessionMsgCount++;
    saveSession();
  }

  if (speakThis && type === "bot") speak(plain);
}

//////////////////////////////
// CHIP BUTTONS
//////////////////////////////

function addChips(labels, onClick) {
  if (!labels?.length) return;

  const wrap = document.createElement("div");
  wrap.className = "chips";

  labels.slice(0, SETTINGS.chipLimit).forEach(label => {
    const b = document.createElement("button");
    b.className = "chip-btn";
    b.textContent = label;

    b.onclick = async () => {
      const now = Date.now();
      if (isResponding) return;
      if (now - lastChipClickAt < SETTINGS.chipClickCooldownMs) return;

      lastChipClickAt = now;
      wrap.querySelectorAll(".chip-btn").forEach(btn => (btn.disabled = true));

      addBubble(label, "user", { speak: false });

      if (label === "Use my location" && distanceCtx?.stage === "needOrigin") {
        await handleUseMyLocation();
        return;
      }

      if (typeof onClick === "function") onClick(label);
      else await handleUserMessage(label);
    };

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

  const b = document.createElement("div");
  b.className = "bubble bot typing-bubble";
  b.innerHTML = `<span class="dot"></span><span class="dot"></span><span class="dot"></span>`;

  row.appendChild(b);
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
// SPEECH (TTS) / MICROPHONE
//////////////////////////////

// Voice output toggle
const VOICE_KEY = "ws_voice_v1";
const voiceState = { on: false, armed: false };

try {
  Object.assign(voiceState, JSON.parse(localStorage.getItem(VOICE_KEY) || "{}"));
} catch {}

function saveVoice() {
  try {
    localStorage.setItem(VOICE_KEY, JSON.stringify(voiceState));
  } catch {}
}

function updateVoiceUI() {
  voiceBtn.classList.toggle("on", voiceState.on);
  voiceBtn.setAttribute("aria-pressed", voiceState.on ? "true" : "false");
}

updateVoiceUI();

voiceBtn.onclick = () => {
  voiceState.armed = true;
  voiceState.on = !voiceState.on;
  saveVoice();
  updateVoiceUI();

  addBubble(
    `Voice output is now <b>${voiceState.on ? "ON" : "OFF"}</b>.`,
    "bot",
    { html: true, speak: false }
  );
};

function speak(text) {
  if (!voiceState.on || !voiceState.armed) return;
  if (!("speechSynthesis" in window)) return;

  try {
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-GB";
    window.speechSynthesis.speak(u);
  } catch {}
}

// Microphone input
const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let micListening = false;

function initSpeech() {
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.lang = "en-GB";
  rec.interimResults = false;

  rec.onstart = () => {
    micListening = true;
    micBtn.classList.add("on");
  };

  rec.onend = () => {
    micListening = false;
    micBtn.classList.remove("on");
  };

  rec.onresult = event => {
    const t = event.results?.[0]?.[0]?.transcript ?? "";
    if (t.trim()) {
      input.value = t.trim();
      sendChat();
    }
  };

  rec.onerror = () => {
    micListening = false;
    micBtn.classList.remove("on");
    addBubble("Voice input isn't supported in this browser.", "bot", { speak: false });
  };

  return rec;
}

recognizer = initSpeech();

micBtn.onclick = () => {
  voiceState.armed = true;
  saveVoice();

  if (!recognizer) {
    addBubble("Voice input isn't supported. Try Chrome/Edge.", "bot", { speak: false });
    return;
  }

  try {
    if (micListening) recognizer.stop();
    else recognizer.start();
  } catch {
    addBubble("Couldn't start voice input — please try again.", "bot", { speak: false });
  }
};

//////////////////////////////
// STOP — END OF PART 2
//////////////////////////////

//////////////////////////////
// SANITISER & PLAIN TEXT
//////////////////////////////

function htmlToPlainText(html) {
  const t = document.createElement("template");
  t.innerHTML = decodeHTMLEntities(html ?? "");
  return (t.content.textContent ?? "").trim();
}

function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html ?? "";

  const allowedTags = new Set([
    "B","STRONG","I","EM","BR","A","SMALL","IMG","UL","OL","LI"
  ]);

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toReplace = [];

  function isSafeHref(href) {
    return /^https?:\/\//i.test(href) ||
           /^mailto:/i.test(href)   ||
           /^tel:/i.test(href)      ||
           /^sms:/i.test(href);
  }

  while (walker.nextNode()) {
    const el = walker.currentNode;

    // Replace disallowed tags with their text
    if (!allowedTags.has(el.tagName)) {
      toReplace.push(el);
      continue;
    }

    // Clean attributes
    [...el.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();

      if (el.tagName === "A" && (name === "href" || name === "target" || name === "rel")) return;
      if (el.tagName === "IMG" && (name === "src" || name === "alt" || name === "class" || name === "loading")) return;

      el.removeAttribute(attr.name);
    });

    // Enforce safe anchors
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      if (!isSafeHref(href)) el.removeAttribute("href");
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }

    // Enforce safe images (https only)
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
// MAP / GEO HELPERS
//////////////////////////////

function lonLatToTileXY(lon, lat, z) {
  const latRad = lat * Math.PI / 180;
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

function osmTileURL(lat, lon, zoom = 13) {
  const t = lonLatToTileXY(lon, lat, zoom);
  return `https://tile.openstreetmap.org/${zoom}/${t.x}/${t.y}.png`;
}

function imgTag(src, alt = "Map preview") {
  return `<img class="map-preview" src="${String(src)}" alt="${escapeHTML(alt)}" loading="lazy" />`;
}

function linkTag(href, label) {
  return `<a href="${String(href)}" target="_blank" rel="noopener noreferrer">${escapeHTML(label)}</a>`;
}

const DEPOTS = {
  nuneaton: { label: "Nuneaton Depot", lat: 52.515770, lon: -1.4507820 }
};

const PLACES = {
  coventry:   { lat: 52.4068, lon: -1.5197 },
  birmingham: { lat: 52.4895, lon: -1.8980 },
  leicester:  { lat: 52.6369, lon: -1.1398 },
  london:     { lat: 51.5074, lon: -0.1278 }
};

function toRad(deg){ return (deg * Math.PI) / 180; }

function distanceMiles(a, b){
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2)**2;
  return R * (2 * Math.asin(Math.sqrt(h)));
}

function findClosestDepot(origin){
  let bestKey = null, best = Infinity;
  for (const k in DEPOTS){
    const miles = distanceMiles(origin, DEPOTS[k]);
    if (miles < best){ best = miles; bestKey = k; }
  }
  return bestKey ? { depotKey: bestKey, miles: best } : null;
}

function googleDirectionsURL(originText, depot, mode){
  const origin = encodeURIComponent(originText);
  const dest   = encodeURIComponent(`${depot.lat},${depot.lon}`);
  const travelmode = mode === "walking" ? "walking" : (mode === "transit" ? "transit" : "driving");
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=${travelmode}`;
}

function requestBrowserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => reject(err),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
    );
  });
}

//////////////////////////////
// GREETING
//////////////////////////////

function getGreeting() {
  const h = getUKMinutesNow() / 60;
  const open = isOpenNow();
  const timeGreet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";

  if (!open) {
    const ooh =
      `<br><br>⚠️ We're currently <b>closed</b>. Office hours are <b>Mon–Fri 8:30am–5pm</b> (UK). For urgent queries outside these hours:<br>` +
      `<b>Fleet (OOH):</b> <a href="tel:07940766377">07940766377</a><br>` +
      `<b>Accident / Injury:</b> <a href="tel:07940792355">07940792355</a>`;

    return `${timeGreet}! I'm <b>Welfare Support</b>.${ooh}<br><br>I can still help — use the <b>Topics</b> button or type below.`;
  }

  return `${timeGreet}! I'm <b>Welfare Support</b> — here to help. Use the <b>Topics</b> button or type your question below.`;
}

//////////////////////////////
// INTENTS & FUZZY MATCH
//////////////////////////////

const INTENT_PHRASES = [
  // Greeting / small talk
  { patterns: ["hello","hi","hey","good morning","good afternoon","good evening","hiya","alright","morning","afternoon"], intent: "greeting" },
  { patterns: ["how are you","you ok","you alright","how r u","hows things","how are things"], intent: "smalltalk_how" },
  { patterns: ["thank","thanks","cheers","ta ","appreciated","helpful"], intent: "thanks" },
  { patterns: ["bye","goodbye","see you","see ya","cya","later","ttyl"], intent: "bye" },

  // Pay / wages
  { patterns: ["not been paid","havent been paid","missing pay","no pay","didnt get paid","where is my pay","payday","pay day","wrong pay","incorrect pay","short paid","underpaid","overpaid","pay is wrong","wages wrong","not received my pay"], intent: "pay_query" },
  { patterns: ["pay query","pay question","pay issue","pay problem","pay help","payroll query","salary query","wage query","my pay","about my pay","check my pay"], intent: "pay_query" },
  { patterns: ["deduction","deductions","money taken","taken from my pay","taken from pay","taken out","stopped from pay","missing money","why has money been taken","wrong amount"], intent: "deduction_query" },

  // Work allocation
  { patterns: ["no work","not got work","no jobs","not been allocated","no allocation","no shifts","need work","work dried up","work allocation","work alloc","allocated wrong","wrong job","wrong work"], intent: "work_allocation" },

  // Manager dispute
  { patterns: ["manager dispute","dispute with manager","problem with manager","issue with manager","trouble with manager","argument with manager","conflict with manager","my manager","field manager issue","area manager issue","unfair manager","manager treating"], intent: "manager_dispute" },

  // Contract
  { patterns: ["contract","my contract","change contract","contract change","contract amendment","amend contract","contract query","contract hours","contract update"], intent: "contract" },

  // Equipment
  { patterns: ["stock","no stock","stock query","stock issue","need stock","stock request"], intent: "equipment_stock" },
  { patterns: ["tools","tooling","no tools","bybox","by box","tool order","order tools"], intent: "equipment_tooling" },
  { patterns: ["van","no van","need a van","vehicle","company van","work van"], intent: "equipment_van" },
  { patterns: ["equipment","kit","gear","my kit","my equipment","kit query","kit issue"], intent: "equipment" },

  // Street works / departments
  { patterns: ["street work","streetwork","street works","streetworks","street job"], intent: "street_works" },
  { patterns: ["smart award","smartaward","smart awards","smartawards"], intent: "smart_awards" },
  { patterns: ["id card","id cards","id badge","badge","lost id","id expired","id not arrived","id not received","need new id","id renewal"], intent: "id_cards" },
  { patterns: ["contact","contacts","department","departments","who do i call","contact details","phone number","numbers","which number","contact for"], intent: "dept_contacts" },
  { patterns: ["fleet","fleet query","fleet issue","fleet contact","vehicle query","breakdown","van broken"], intent: "fleet" },
  { patterns: ["accident","injury","accident report","vehicle damage","near miss"], intent: "accident" },
  { patterns: ["parking","parking fine","parking ticket","pcn","council fine"], intent: "parking" },
  { patterns: ["recruit","recruitment","hiring","new job","apply","job application","vacancy","start date","joining","onboard"], intent: "recruitment" },
  { patterns: ["btor","openreach","open reach","ntf btor","btor ntf"], intent: "btor_ntf" },
  { patterns: ["city fibre","cityfibre","cf ntf","city fibre ntf"], intent: "cityfibre_ntf" },

  // Opening / availability
  { patterns: ["open","opening","hours","office hours","what time","when open","when do you open","when do you close","closing time","opening times"], intent: "opening_times" },
  { patterns: ["bank holiday","bank holidays","public holiday","are you open on bank holiday"], intent: "bank_holiday" },
  { patterns: ["available now","anyone available","is someone available","open now","are you open now","anyone there","is anyone there","speak to someone","talk to someone"], intent: "available_now" },

  // Location / depot
  { patterns: ["where are you","your address","office address","where is the office","located","location","find you","nuneaton","depot","depots","closest depot","nearest depot","how far","distance","directions","get there","how to get"], intent: "location" },

  // Support / contact
  { patterns: ["support","help","contact support","get help","need help","speak to welfare","welfare team","welfare number","welfare contact","welfare support","call welfare"], intent: "contact_support" },

  // SMS / text
  { patterns: ["send a text","text you","text support","text query","text message","sms","message support"], intent: "sms_query" }
];

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function fuzzyMatch(q, candidate) {
  const qWords = q.split(" ").filter(w => w.length > 3);
  const cWords = candidate.split(" ").filter(w => w.length > 3);
  let matched = 0;

  for (const qw of qWords) {
    for (const cw of cWords) {
      const maxLen = Math.max(qw.length, cw.length);
      const dist = levenshtein(qw, cw);
      if (dist === 0) { matched += 1; break; }
      if (maxLen >= 5 && dist === 1) { matched += 0.8; break; }
      if (maxLen >= 7 && dist === 2) { matched += 0.6; break; }
    }
  }
  return qWords.length ? matched / qWords.length : 0;
}

function detectIntent(text) {
  const q = normalize(text);
  for (const { patterns, intent } of INTENT_PHRASES) {
    for (const p of patterns) {
      if (q.includes(p)) return intent;
    }
  }
  // Levenshtein fallback on words
  for (const { patterns, intent } of INTENT_PHRASES) {
    for (const p of patterns) {
      if (p.length < 5) continue;
      const pWords = p.split(" ");
      const qWords = q.split(" ");
      for (const pw of pWords) {
        if (pw.length < 5) continue;
        for (const qw of qWords) {
          if (qw.length < 4) continue;
          if (levenshtein(pw, qw) <= 1) return intent;
        }
      }
    }
  }
  return null;
}

//////////////////////////////
// FAQ MATCHING
//////////////////////////////

let faqsLoaded = false;

function scoreMatch(qNorm, candNorm) {
  if (!qNorm || !candNorm) return 0;
  if (qNorm === candNorm) return 1;
  if (candNorm.includes(qNorm) || qNorm.includes(candNorm)) return 0.92;

  const qT = new Set(qNorm.split(" ").filter(Boolean));
  const cT = new Set(candNorm.split(" ").filter(Boolean));
  const inter = [...qT].filter(t => cT.has(t)).length;
  const union = new Set([...qT, ...cT]).size;
  return union ? inter / union : 0;
}

function matchFAQ(text) {
  const q = normalize(text);
  if (!q || !FAQS.length) return null;

  let best = null;
  for (const item of FAQS) {
    const variants = [item.question, ...(item.synonyms || [])].filter(Boolean);
    let bestLocal = 0;

    for (const v of variants) {
      bestLocal = Math.max(bestLocal, scoreMatch(q, normalize(v)));
      if (bestLocal >= 0.98) break;
    }

    const kws = (item.canonicalKeywords || []).map(k => normalize(k)).filter(Boolean);
    if (kws.some(k => q.includes(k))) bestLocal = Math.min(1, bestLocal + 0.06);

    if (!best || bestLocal > best.score) best = { item, score: bestLocal };
  }
  return best && best.score >= SETTINGS.minConfidence ? best.item : null;
}

function matchFAQFuzzy(text) {
  const q = normalize(text);
  if (!q || !FAQS.length) return null;

  let best = null;
  for (const item of FAQS) {
    const variants = [item.question, ...(item.synonyms || [])].filter(Boolean);
    let bestLocal = 0;

    for (const v of variants) {
      const vn = normalize(v);
      const fuzzy = fuzzyMatch(q, vn);
      bestLocal = Math.max(bestLocal, fuzzy);
      if (bestLocal >= 0.98) break;
    }

    const kws = (item.canonicalKeywords || []).map(k => normalize(k)).filter(Boolean);
    if (kws.some(k => {
      const dist = levenshtein(q, k);
      return q.includes(k) || (k.length >= 5 && dist <= 1);
    })) bestLocal = Math.min(1, bestLocal + 0.10);

    if (!best || bestLocal > best.score) best = { item, score: bestLocal };
  }
  return best && best.score >= 0.55 ? best.item : null;
}

//////////////////////////////
// CONTEXT MEMORY
//////////////////////////////

function handleContextQuery(text) {
  const q = normalize(text);

  if ((q.includes("that number") || q.includes("the number") || q.includes("what number") ||
       q.includes("number again") || q.includes("repeat") || q.includes("say again") ||
       q.includes("what was that")) && lastPhoneNumber) {
    return { html: `The last number I mentioned was <a href="tel:${escapeHTML(lastPhoneNumber)}"><b>${escapeHTML(lastPhoneNumber)}</b></a>.` };
  }

  if (q.includes("say it again") || q.includes("repeat that") || q.includes("what did you say") || q.includes("come again")) {
    const lastBot = CHAT_LOG.filter(l => l.role === "Bot").slice(-1)[0];
    if (lastBot) return { html: lastBot.text };
  }

  return null;
}

//////////////////////////////
// GUIDED FLOWS
//////////////////////////////

function handleFlow(text) {
  const q = normalize(text);
  if (!flowCtx) return null;

  // Cancel
  if (["cancel","stop","restart"].includes(q)) {
    flowCtx = null;
    return { html: "No problem, I've cancelled that. Ask anything else or use <b>Topics</b>." };
  }

  // Work allocation
  if (flowCtx.type === "workAllocation") {
    if (flowCtx.stage === "askRaised") {
      flowCtx = null;
      if (q === "yes") {
        return { html: `Please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      }
      return { html: `Please raise this to your <b>Field and Area Manager</b>. If concerns remain, call <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
    }
  }

  // Manager dispute
  if (flowCtx.type === "managerDispute") {
    if (flowCtx.stage === "askFieldManager") {
      if (q === "yes") {
        flowCtx = { type: "managerDispute", stage: "askAreaManager" };
        return { html: "Have you contacted your <b>Area Manager</b>?", chips: ["Yes","No"] };
      }
      flowCtx = null;
      return { html: `Please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
    }
    if (flowCtx.stage === "askAreaManager") {
      flowCtx = null;
      if (q === "yes") {
        return { html: `Please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      }
      return { html: `Please contact your <b>Area Manager</b>. If concerns remain, call <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
    }
  }

  // Equipment
  if (flowCtx.type === "equipment") {
    if (flowCtx.stage === "askType") {
      if (q === "stock") {
        flowCtx = { type: "equipment", stage: "stockFormSubmitted" };
        return { html: "Have you submitted a <b>Stock Form</b> with your Field Manager?", chips:["Yes","No"] };
      } else if (q === "tooling") {
        flowCtx = { type: "equipment", stage: "byboxSubmitted" };
        return { html: "Has your <b>Field Manager submitted an order through ByBox</b>?", chips:["Yes","No"] };
      } else if (q === "van") {
        flowCtx = { type: "equipment", stage: "vanRaised" };
        return { html: "Have you raised receiving a van with your <b>Field Manager and Area Manager</b>?", chips:["Yes","No"] };
      }
    }
    if (flowCtx.stage === "stockFormSubmitted") {
      flowCtx = null;
      if (q === "yes") {
        return { html: `Please contact your <b>Field Manager</b> for an update. If needed, call Welfare <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      }
      return { html: "Please contact your <b>Field Manager</b> and complete a <b>Stock Form</b>." };
    }
    if (flowCtx.stage === "byboxSubmitted") {
      flowCtx = null;
      if (q === "yes") {
        return { html: `Please follow up with your <b>Field Manager</b>. If needed, call Welfare <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      }
      return { html: "Please ask your <b>Field Manager</b> to submit an order to <b>ByBox</b>." };
    }
    if (flowCtx.stage === "vanRaised") {
      flowCtx = null;
      if (q === "yes") {
        return { html: `As you've raised this to your Field and Area Manager, please call Welfare <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      }
      return { html: "Please contact your <b>Field Manager</b> and query this through." };
    }
  }

  return null;
}

//////////////////////////////
// SPECIAL CASES (INTENT-DRIVEN)
//////////////////////////////

function specialCases(text) {
  const q = normalize(text);
  const intent = detectIntent(text);

  // Flow continuation first
  if (flowCtx) {
    const flowRes = handleFlow(text);
    if (flowRes) return flowRes;
  }

  // SMS flow
  if (smsCtx) {
    if (["cancel","stop","restart"].includes(q)) {
      smsCtx = null;
      return { html: "No problem, I've cancelled that. Ask anything else." };
    }
    if (smsCtx.stage === "needName") {
      smsCtx.name = text.trim();
      smsCtx.stage = "needPhone";
      return { html: `Thanks <b>${escapeHTML(smsCtx.name)}</b> — what's the best <b>phone number</b> to reach you on?` };
    }
    if (smsCtx.stage === "needPhone") {
      smsCtx.phone = text.trim();
      smsCtx.stage = "needType";
      return { html: "Is this a <b>Pay</b> or <b>Deduction</b> query?", chips: ["Pay query","Deduction query"] };
    }
    if (smsCtx.stage === "needType") {
      smsCtx.type = text.trim();
      smsCtx.stage = "needDescription";
      return { html: "Please briefly describe your query (1–3 sentences):" };
    }
    if (smsCtx.stage === "needDescription") {
      smsCtx.description = text.trim();

      const smsBody = encodeURIComponent(
        `Welfare Support Query\nName: ${smsCtx.name}\nPhone: ${smsCtx.phone}\nType: ${smsCtx.type}\nQuery: ${smsCtx.description}`
      );
      const smsHref = `sms:${SETTINGS.smsNumber}?body=${smsBody}`;

      const html =
        `<b>Ready to send</b><br>` +
        `Name: <b>${escapeHTML(smsCtx.name)}</b><br>` +
        `Phone: <b>${escapeHTML(smsCtx.phone)}</b><br>` +
        `Type: <b>${escapeHTML(smsCtx.type)}</b><br>` +
        `Query: <b>${escapeHTML(smsCtx.description)}</b><br><br>` +
        `<a href="${smsHref}" target="_blank" rel="noopener">📱 Tap here to send your text to ${escapeHTML(SETTINGS.smsNumber)}</a>` +
        `<br><small>Opens your messaging app with the message ready to send.</small>`;

      logSMS({ name: smsCtx.name, phone: smsCtx.phone, type: smsCtx.type, description: smsCtx.description });
      logIntent("sms_sent");
      smsCtx = null;

      return { html, chips: ["Pay / Payroll query","Deductions query"], _intent: "sms_sent" };
    }
  }

  // Greetings / small talk
  if (intent === "greeting") {
    return {
      html: ["Hey! 👋 How can I help today?","Hi there! What can I help you with?","Hello! What’s your query today?"][Math.floor(Math.random()*3)],
      chips: ["Pay / Payroll query","Work Allocation query","Department Contacts","Equipment Query"],
      _intent: "greeting"
    };
  }
  if (intent === "smalltalk_how") return { html: "I'm doing well thanks! What do you need help with?", _intent: "smalltalk" };
  if (intent === "thanks") return { html: "Happy to help! 😊 Anything else I can do for you?", _intent: "thanks" };
  if (intent === "bye") return { html: "Take care! 👋 Come back any time you need help.", _intent: "bye" };

  // Pay / deductions => start SMS flow
  if (intent === "pay_query" || intent === "sms_query") {
    smsCtx = { stage: "needName" };
    return { html: "I'll help you send a text to our pay &amp; deductions team.<br><br>First, what's your <b>full name</b>?", _intent: "pay_query" };
  }
  if (intent === "deduction_query") {
    smsCtx = { stage: "needName" };
    return { html: "Okay — I’ll get your details and prep a message to the team.<br><br>What's your <b>full name</b>?", _intent: "deduction_query" };
  }

  // Work allocation
  if (intent === "work_allocation") {
    flowCtx = { type: "workAllocation", stage: "askRaised" };
    return { html: "Sorry to hear that. Has this already been raised with your <b>Field and Area Manager</b>?", chips: ["Yes","No"], _intent:"work_allocation" };
  }

  // Manager dispute
  if (intent === "manager_dispute") {
    flowCtx = { type: "managerDispute", stage: "askFieldManager" };
    return { html: "I understand. Is this regarding your <b>Field Manager</b>?", chips: ["Yes","No"], _intent:"manager_dispute" };
  }

  // Contract
  if (intent === "contract") {
    return { html: "For any contract change queries, please raise this with your <b>Area Manager</b>.", chips:["Department Contacts","How can I contact support?"], _intent:"contract" };
  }

  // Equipment
  if (intent === "equipment_stock") {
    flowCtx = { type:"equipment", stage:"stockFormSubmitted" };
    return { html: "For stock queries — have you submitted a <b>Stock Form</b> with your Field Manager?", chips:["Yes","No"], _intent:"equipment" };
  }
  if (intent === "equipment_tooling") {
    flowCtx = { type:"equipment", stage:"byboxSubmitted" };
    return { html: "For tooling queries — has your <b>Field Manager submitted an order through ByBox</b>?", chips:["Yes","No"], _intent:"equipment" };
  }
  if (intent === "equipment_van") {
    flowCtx = { type:"equipment", stage:"vanRaised" };
    return { html: "For van queries — have you raised this with your <b>Field Manager and Area Manager</b>?", chips:["Yes","No"], _intent:"equipment" };
  }
  if (intent === "equipment") {
    flowCtx = { type:"equipment", stage:"askType" };
    return { html: "No problem. Is this regarding <b>Stock</b>, <b>Tooling</b> or a <b>Van</b>?", chips:["Stock","Tooling","Van"], _intent:"equipment" };
  }

  // Departments
  if (intent === "street_works")  return { html: `For Street Works queries contact <a href="mailto:Street.Works@kelly.co.uk">Street.Works@kelly.co.uk</a>.`, _intent:"street_works" };
  if (intent === "smart_awards")  return { html: `For Smart Awards queries contact <a href="mailto:smartawards@kelly.co.uk">smartawards@kelly.co.uk</a>.`, _intent:"smart_awards" };
  if (intent === "id_cards")      return { html: `For lost/unreceived/expired ID cards, contact <a href="mailto:nuneaton.admin@kelly.co.uk">nuneaton.admin@kelly.co.uk</a>.`, _intent:"id_cards" };
  if (intent === "fleet")         return { html: `Fleet queries: <a href="tel:01582841291"><b>01582841291</b></a> or <a href="tel:07940766377"><b>07940766377</b></a> (OOH).`, _intent:"fleet" };
  if (intent === "accident")      return { html: `Accident or injury: call <a href="tel:07940792355"><b>07940792355</b></a> ASAP.`, _intent:"accident" };
  if (intent === "parking")       return { html: `Parking queries: call <a href="tel:07940792355"><b>07940792355</b></a>.`, _intent:"parking" };
  if (intent === "recruitment")   return { html: `Recruitment queries: call <a href="tel:02037583058"><b>02037583058</b></a>.`, _intent:"recruitment" };
  if (intent === "contact_support") return { html: `You can reach Welfare on <a href="tel:02087583060"><b>02087583060</b></a> — please hold the line.`, chips:["Department Contacts","What are your opening times?"], _intent:"contact_support" };

  // Opening & availability
  if (intent === "opening_times") return { html: "We're open <b>Mon–Fri, 8:30am–5:00pm</b> (UK). We're closed on weekends and bank holidays.", chips:["Is anyone available now?","Are you open on bank holidays?"], _intent:"opening_times" };
  if (intent === "bank_holiday")  return { html: "❌ <b>No, we're not open on bank holidays.</b>", chips:["What are your opening times?"], _intent:"opening_times" };
  if (intent === "available_now") {
    const open = isOpenNow();
    return { html: open ? "✅ Yes — we're open now." : "❌ No — we're closed right now.", chips:["What are your opening times?"] };
  }

  // Location / distance flow (start)
  if (intent === "location") {
    distanceCtx = { stage: "needOrigin" };
    return {
      html: "Tell me your starting point and I’ll help you get to the depot. You can also use GPS.",
      chips: ["Use my location","Coventry","Birmingham","Leicester","London"]
    };
  }

  // Distance flow continuation
  if (distanceCtx?.stage === "needOrigin") {
    const key = Object.keys(PLACES).find(k => q.includes(k));
    if (key) {
      const closest = findClosestDepot(PLACES[key]);
      if (!closest) {
        return { html:"I couldn't determine a nearby depot from that. Please try a different town/city or use GPS.", chips:["Use my location","Coventry","Birmingham","Leicester","London"] };
      }
      const depot = DEPOTS[closest.depotKey];
      distanceCtx = { stage:"haveClosest", originKey:key, depotKey:closest.depotKey, miles:closest.miles };
      return { html:`Thanks — your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>How are you travelling?`, chips:["By car","By train","By bus","Walking"] };
    }
  }

  if (distanceCtx?.stage === "haveClosest") {
    if (["by car","by train","by bus","walking"].includes(q)) {
      const mode   = q === "walking" ? "walking" : (q === "by train" || q === "by bus") ? "transit" : "driving";
      const depot  = DEPOTS[distanceCtx.depotKey];
      const origin = distanceCtx.originKey === "your location" ? "your location" : distanceCtx.originKey;
      const url    = googleDirectionsURL(origin, depot, mode);
      const tile   = osmTileURL(depot.lat, depot.lon, 13);

      distanceCtx = null;
      return {
        html:
          `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
          `${linkTag(url, "Get directions in Google Maps")}<br>` +
          `${imgTag(tile, "OpenStreetMap preview")}`
      };
    }
  }

  return null;
}

//////////////////////////////
// GPS HANDLER (Use my location)
//////////////////////////////

async function handleUseMyLocation(){
  isResponding = true;
  try{
    const loc = await requestBrowserLocation();
    const closest = findClosestDepot({ lat: loc.lat, lon: loc.lon });

    if (!closest) {
      addBubble("I couldn't determine a nearby depot from your location. Please type a town/city.", "bot");
      addChips(["Coventry","Birmingham","Leicester","London"]);
    } else {
      const depot = DEPOTS[closest.depotKey];
      distanceCtx = { stage:"haveClosest", originKey:"your location", depotKey:closest.depotKey, miles:closest.miles };
      addBubble(`Thanks — your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>How are you travelling?`, "bot", { html:true });
      addChips(["By car","By train","By bus","Walking"]);
    }
  } catch {
    addBubble("I couldn't access your location. Please allow permission, or choose a town/city.", "bot");
    addChips(["Coventry","Birmingham","Leicester","London"]);
  } finally {
    isResponding = false;
  }
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

  // Context memory first
  const ctx = handleContextQuery(text);
  if (ctx) {
    addBubble(ctx.html, "bot", { html: true });
    if (ctx.chips) addChips(ctx.chips);
    isResponding = false; sendBtn.disabled = false; return;
  }

  const s = specialCases(text);
  if (s) {
    if (s._intent) logIntent(s._intent);
    addBubble(s.html, "bot", { html: true });
    if (s.chips) addChips(s.chips);
    isResponding = false; sendBtn.disabled = false; return;
  }

  const faq = matchFAQ(text) || matchFAQFuzzy(text);
  if (faq) {
    addBubble(faq.answer, "bot", { html: true });
    if (faq.followUps?.length) addChips(faq.followUps);
    isResponding = false; sendBtn.disabled = false; return;
  }

  // No match
  logUnresolved(text);
  addBubble("I'm not sure about that one — try the <b>Topics</b> button or pick a common query below:", "bot", { html: true });
  addChips(["Pay / Payroll query","Work Allocation query","Department Contacts","Is anyone available now?"]);
  isResponding = false;
  sendBtn.disabled = false;
}

function sendChat() {
  if (isResponding) return;
  const t = input.value.trim();
  if (!t) return;
  handleUserMessage(t);
}

sendBtn.addEventListener("click", sendChat);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendChat(); } });

clearBtn.addEventListener("click", () => {
  chatWindow.innerHTML = "";
  smsCtx = null;
  distanceCtx = null;
  flowCtx = null;
  CHAT_LOG = [];
  init();
});

//////////////////////////////
// TOPICS DRAWER
//////////////////////////////

function buildCategoryIndex(){
  categoryIndex = new Map();

  FAQS.forEach(item => {
    const key = (item.category ?? "general").toLowerCase();
    if (!categoryIndex.has(key)) categoryIndex.set(key, []);
    categoryIndex.get(key).push(item);
  });

  const labelMap = {
    general:    "General",
    support:    "Support",
    opening:    "Opening times",
    actions:    "Actions",
    pay:        "Pay & Deductions",
    work:       "Work Allocation",
    contract:   "Contract",
    departments:"Departments",
    equipment:  "Equipment"
  };

  categories = Array.from(categoryIndex.keys())
    .sort()
    .map(key => ({ key, label: labelMap[key] ?? (key[0].toUpperCase() + key.slice(1)), count: categoryIndex.get(key).length }));
}

function openDrawer(){
  overlay.hidden = false;
  drawer.hidden = false;
}

function closeDrawer(){
  overlay.hidden = true;
  drawer.hidden = true;
}

function renderDrawer(selectedKey){
  const selected = selectedKey ?? null;
  drawerCategoriesEl.innerHTML = "";
  drawerQuestionsEl.innerHTML = "";

  categories.forEach(c => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "cat-pill";
    pill.textContent = `${c.label} (${c.count})`;
    pill.setAttribute("aria-selected", String(c.key === selected));
    pill.onclick = () => renderDrawer(c.key);
    drawerCategoriesEl.appendChild(pill);
  });

  const list = selected && categoryIndex.has(selected) ? categoryIndex.get(selected) : FAQS;

  list.forEach(item => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "drawer-q";
    b.textContent = item.question;
    b.onclick = () => { closeDrawer(); handleUserMessage(item.question); };
    drawerQuestionsEl.appendChild(b);
  });
}

topicsBtn.addEventListener("click", () => { if (faqsLoaded) openDrawer(); });
overlay.addEventListener("click", closeDrawer);
drawerCloseBtn.addEventListener("click", closeDrawer);

//////////////////////////////
// LOAD FAQS & INIT
//////////////////////////////

function init(){
  addBubble(getGreeting(), "bot", { html: true, speak: false, noFeedback: true });
}

(function bootstrap(){
  // Load FAQs
  fetch(FAQ_PATH)
    .then(res => res.json())
    .then(data => {
      FAQS = Array.isArray(data) ? data : [];
      faqsLoaded = true;
      buildCategoryIndex();
      renderDrawer(null);
    })
    .catch(() => {
      FAQS = [];
      faqsLoaded = true;
      buildCategoryIndex();
      renderDrawer(null);
    });

  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
