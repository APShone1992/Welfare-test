const SETTINGS = {
  minConfidence: 0.20,
  suggestionLimit: 5,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  smsNumber: "07773652107",
  smsMaxChars: 500,
};

// --------- Time-aware greeting (Fix 6 + 7) ---------
function getGreeting() {
  const h = getUKMinutesNow() / 60;
  const open = isOpenNow();
  let timeGreet = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  if (!open) {
    const bh = isBankHolidayToday();
    const ooh = `<br><br>⚠️ We're currently <b>closed</b>${bh ? " (bank holiday)" : ""}. Office hours are <b>Mon–Fri 8:30am–5pm</b>. For urgent queries outside these hours:<br>` +
      `<b>Fleet (OOH):</b> <a href="tel:07940766377">07940766377</a><br>` +
      `<b>Accident / Injury:</b> <a href="tel:07940792355">07940792355</a>`;
    return `${timeGreet}! I'm <b>Welfare Support</b>.${ooh}<br><br>I can still help answer questions — use the <b>Topics</b> button or type below.`;
  }
  return `${timeGreet}! I'm <b>Welfare Support</b> — here to help. Use the <b>Topics</b> button or type your question below.`;
}

let FAQS = [];
let faqsLoaded = false;
let categories = [];
let categoryIndex = new Map();

const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");
const suggestionsEl = document.getElementById("suggestions");
const topicsBtn = document.getElementById("topicsBtn");
const drawer = document.getElementById("topicsDrawer");
const overlay = document.getElementById("drawerOverlay");
const drawerCloseBtn = document.getElementById("drawerCloseBtn");
const drawerCategoriesEl = document.getElementById("drawerCategories");
const drawerQuestionsEl = document.getElementById("drawerQuestions");
const micBtn = document.getElementById("micBtn");
const voiceBtn = document.getElementById("voiceBtn");

// state
let isResponding = false;
let lastChipClickAt = 0;
let activeSuggestionIndex = -1;
let currentSuggestions = [];
let CHAT_LOG = [];
let smsCtx = null;
let distanceCtx = null;
let flowCtx = null;
let lastBotIntent = null;
let lastPhoneNumber = null;

// --------- Analytics & Data Logging ---------
const WS_SESSIONS_KEY   = "ws_sessions_v1";
const WS_INTENTS_KEY    = "ws_intents_v1";
const WS_SMS_LOG_KEY    = "ws_sms_log_v1";
const UNRESOLVED_KEY    = "ws_unresolved_v1";

// Session tracking — one session per page load, stored with timestamp
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
    // Keep last 2000 sessions
    if (sessions.length > 2000) sessions.splice(0, sessions.length - 2000);
    localStorage.setItem(WS_SESSIONS_KEY, JSON.stringify(sessions));
  } catch {}
}

function logIntent(intent) {
  try {
    const intents = JSON.parse(localStorage.getItem(WS_INTENTS_KEY) || "[]");
    intents.push({ intent, ts: Date.now(), date: new Date().toISOString().slice(0,10) });
    if (intents.length > 5000) intents.splice(0, intents.length - 5000);
    localStorage.setItem(WS_INTENTS_KEY, JSON.stringify(intents));
  } catch {}
}

function logSMS(entry) {
  try {
    const log = JSON.parse(localStorage.getItem(WS_SMS_LOG_KEY) || "[]");
    log.push({ ...entry, ts: Date.now(), date: new Date().toISOString().slice(0,10) });
    if (log.length > 2000) log.splice(0, log.length - 2000);
    localStorage.setItem(WS_SMS_LOG_KEY, JSON.stringify(log));
  } catch {}
}

// Save session every 30s and on unload
setInterval(saveSession, 30000);
window.addEventListener("beforeunload", saveSession);

// --------- Unresolved query log ---------
function logUnresolved(text) {
  try {
    const existing = JSON.parse(localStorage.getItem(UNRESOLVED_KEY) || "[]");
    existing.push({ text, ts: Date.now() });
    if (existing.length > 200) existing.splice(0, existing.length - 200);
    localStorage.setItem(UNRESOLVED_KEY, JSON.stringify(existing));
  } catch {}
}
function getUnresolvedLog() {
  try { return JSON.parse(localStorage.getItem(UNRESOLVED_KEY) || "[]"); } catch { return []; }
}

// --------- Relative timestamps ---------
function relativeTime(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 10) return "Just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  return formatUKTime(new Date(ts));
}
setInterval(() => {
  document.querySelectorAll(".timestamp[data-ts]").forEach(el => {
    el.textContent = relativeTime(parseInt(el.dataset.ts));
  });
}, 30000);

// helpers
const normalize = (s) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[""'']/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttrUrl(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeHTMLEntities(str) {
  const t = document.createElement("textarea");
  t.innerHTML = str ?? "";
  return t.value;
}

function htmlToPlainText(html) {
  const t = document.createElement("template");
  t.innerHTML = decodeHTMLEntities(html ?? "");
  return (t.content.textContent ?? "").trim();
}

function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;
  const allowedTags = new Set(["B","STRONG","I","EM","BR","A","SMALL","IMG"]);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toReplace = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!allowedTags.has(el.tagName)) { toReplace.push(el); continue; }
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (el.tagName === "A" && (name === "href" || name === "target" || name === "rel")) return;
      if (el.tagName === "IMG" && (name === "src" || name === "alt" || name === "class" || name === "loading")) return;
      el.removeAttribute(attr.name);
    });
    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      const safe = /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href);
      if (!safe) el.removeAttribute("href");
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }
    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") ?? "";
      if (!/^https:\/\//i.test(src)) toReplace.push(el);
      else el.setAttribute("loading", "lazy");
      if (!el.getAttribute("alt")) el.setAttribute("alt", "Map preview");
    }
  }
  toReplace.forEach((node) => node.replaceWith(document.createTextNode(node.textContent ?? "")));
  return template.innerHTML;
}

// UK time
const UK_TZ = "Europe/London";
function formatUKTime(date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function getUKDateISO(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, year:"numeric", month:"2-digit", day:"2-digit" });
  const parts = fmt.formatToParts(date);
  const y = parts.find(p=>p.type==="year")?.value ?? "0000";
  const m = parts.find(p=>p.type==="month")?.value ?? "01";
  const d = parts.find(p=>p.type==="day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function getUKDayIndex(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, weekday:"short" });
  const wd = fmt.format(date);
  const map = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };
  return map[wd] ?? 0;
}

function getUKMinutesNow(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, hour:"2-digit", minute:"2-digit", hour12:false });
  const parts = fmt.formatToParts(date);
  const h = parseInt(parts.find(p=>p.type==="hour")?.value ?? "0", 10);
  const m = parseInt(parts.find(p=>p.type==="minute")?.value ?? "0", 10);
  return h*60+m;
}

// Business hours Mon-Fri 08:30-17:00
const BUSINESS = { start: 8*60+30, end: 17*60, openDays: new Set([1,2,3,4,5]) };

// Bank holidays (England & Wales) 2025-2028
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

// Map helpers
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

function imgTag(src, alt="Map preview") {
  return `<img class="map-preview" src="${escapeAttrUrl(src)}" alt="${escapeHTML(alt)}" loading="lazy" />`;
}

function linkTag(href, label) {
  return `<a href="${escapeAttrUrl(href)}">${escapeHTML(label)}</a>`;
}

// Depots/places
const DEPOTS = { nuneaton: { label:"Nuneaton Depot", lat:52.515770, lon:-1.4507820 } };
const PLACES = {
  coventry:{ lat:52.4068, lon:-1.5197 },
  birmingham:{ lat:52.4895, lon:-1.8980 },
  leicester:{ lat:52.6369, lon:-1.1398 },
  london:{ lat:51.5074, lon:-0.1278 }
};

function toRad(deg){ return (deg*Math.PI)/180; }
function distanceMiles(a,b){
  const R=3958.8;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return R*(2*Math.asin(Math.sqrt(h)));
}

function findClosestDepot(origin){
  let bestKey=null, best=Infinity;
  for (const k in DEPOTS){
    const miles=distanceMiles(origin, DEPOTS[k]);
    if (miles<best){ best=miles; bestKey=k; }
  }
  return bestKey ? { depotKey: bestKey, miles: best } : null;
}

function googleDirectionsURL(originText, depot, mode){
  const origin=encodeURIComponent(originText);
  const dest=encodeURIComponent(`${depot.lat},${depot.lon}`);
  const travelmode = mode === "walk" ? "walking" : (mode === "train" || mode === "bus") ? "transit" : "driving";
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=${travelmode}`;
}

// GPS helper
function requestBrowserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
    );
  });
}

// Ticket helpers
function isValidPhone(raw) {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  return digits.length >= 8 && digits.length <= 16;
}

// ---- SMS helpers ----

// speaker
const VOICE_KEY = "ws_voice_v1";
const voiceState = { on:false, armed:false };
try { Object.assign(voiceState, JSON.parse(localStorage.getItem(VOICE_KEY) || "{}")); } catch {}

function saveVoice(){ try{ localStorage.setItem(VOICE_KEY, JSON.stringify(voiceState)); } catch{} }
function updateVoiceUI(){
  voiceBtn.classList.toggle("on", voiceState.on);
  // icon handled by SVG in index.html
  voiceBtn.setAttribute("aria-pressed", voiceState.on ? "true" : "false");
}

function speak(text){
  if (!voiceState.on || !voiceState.armed) return;
  if (!("speechSynthesis" in window)) return;
  try{
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(String(text ?? ""));
    u.lang = "en-GB";
    window.speechSynthesis.speak(u);
  } catch {}
}

updateVoiceUI();
window.addEventListener("pointerdown", ()=>{ voiceState.armed=true; saveVoice(); }, { passive:true });
window.addEventListener("keydown", ()=>{ voiceState.armed=true; saveVoice(); }, { passive:true });

voiceBtn.addEventListener("click", ()=>{
  voiceState.armed = true;
  voiceState.on = !voiceState.on;
  saveVoice();
  updateVoiceUI();
  addBubble(voiceState.on ? "Voice output is now <b>on</b>." : "Voice output is now <b>off</b>.", "bot", { html:true, speak:false });
});

// mic
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let micListening = false;

function initSpeech(){
  if (!SpeechRecognition) return null;
  const rec = new SpeechRecognition();
  rec.lang = "en-GB";
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  rec.onstart = ()=>{
    micListening=true;
    micBtn.classList.add("on");
    // mic active state
    micBtn.setAttribute("aria-pressed","true");
  };
  rec.onend = ()=>{
    micListening=false;
    micBtn.classList.remove("on");
    // mic idle state
    micBtn.setAttribute("aria-pressed","false");
  };
  rec.onerror = ()=>{
    micListening=false;
    micBtn.classList.remove("on");
    // mic idle state
    micBtn.setAttribute("aria-pressed","false");
    addBubble("Voice input isn't supported here — please type your question.", "bot", { speak:false });
  };
  rec.onresult = (event)=>{
    const t = event.results?.[0]?.[0]?.transcript ?? "";
    if (t.trim()){
      input.value = t.trim();
      sendChat();
    }
  };
  return rec;
}

recognizer = initSpeech();
micBtn.addEventListener("click", ()=>{
  voiceState.armed=true; saveVoice();
  if (!recognizer){
    addBubble("Voice input isn't supported in this browser. Try Chrome/Edge, or type your question.", "bot", { speak:false });
    return;
  }
  try{
    if (micListening) recognizer.stop();
    else recognizer.start();
  } catch {
    addBubble("Couldn't start voice input — please try again.", "bot", { speak:false });
  }
});

// UI helpers
function addBubble(text, type, opts = {}) {
  const html = !!opts.html;
  const ts = opts.ts ?? new Date();
  const speakThis = opts.speak !== false;
  const row = document.createElement("div");
  row.className = "msg " + type;
  const bubble = document.createElement("div");
  bubble.className = "bubble " + type;
  if (html) {
    const decoded = decodeHTMLEntities(text);
    bubble.innerHTML = sanitizeHTML(decoded);
  } else {
    bubble.textContent = text;
  }

  // Extract phone numbers for context memory
  if (type === "bot") {
    const phoneMatch = (html ? htmlToPlainText(text) : text).match(/0\d[\d\s]{8,12}/);
    if (phoneMatch) lastPhoneNumber = phoneMatch[0].replace(/\s/g, "");
  }

  // Copy-number buttons on all tel: links (Fix 2)
  if (type === "bot" && html) {
    bubble.querySelectorAll("a[href^='tel:']").forEach(a => {
      const num = a.getAttribute("href").replace("tel:","");
      const copyBtn = document.createElement("button");
      copyBtn.className = "copy-num-btn";
      copyBtn.title = "Copy number";
      copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
      copyBtn.addEventListener("click", e => {
        e.preventDefault();
        navigator.clipboard?.writeText(num).then(() => {
          copyBtn.innerHTML = `✓`;
          copyBtn.style.background = "#16a34a";
          setTimeout(() => {
            copyBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
            copyBtn.style.background = "";
          }, 2000);
        });
      });
      a.insertAdjacentElement("afterend", copyBtn);
    });
  }

  const meta = document.createElement("div");
  meta.className = "msg-meta";

  const time = document.createElement("span");
  time.className = "timestamp";
  time.dataset.ts = ts.getTime();
  time.textContent = relativeTime(ts.getTime());
  meta.appendChild(time);

  // Feedback thumbs (Fix 5) — only on bot messages, not typing indicator
  if (type === "bot" && !opts.noFeedback) {
    const fbWrap = document.createElement("div");
    fbWrap.className = "feedback-btns";
    ["👍","👎"].forEach((emoji, i) => {
      const fb = document.createElement("button");
      fb.className = "feedback-btn";
      fb.title = i === 0 ? "Helpful" : "Not helpful";
      fb.textContent = emoji;
      fb.addEventListener("click", () => {
        fbWrap.querySelectorAll(".feedback-btn").forEach(b => b.disabled = true);
        fb.classList.add("selected");
        if (i === 1) {
          // Log the previous user message as unresolved/unhelpful
          const lastUser = CHAT_LOG.filter(l => l.role === "User").slice(-1)[0];
          if (lastUser) logUnresolved(lastUser.text + " [marked unhelpful]");
        }
        const thanks = document.createElement("span");
        thanks.className = "feedback-thanks";
        thanks.textContent = i === 0 ? "Thanks!" : "Sorry about that!";
        fbWrap.appendChild(thanks);
      });
      fbWrap.appendChild(fb);
    });
    meta.appendChild(fbWrap);
  }

  row.appendChild(bubble);
  row.appendChild(meta);
  chatWindow.prepend(row);
  const plain = html ? htmlToPlainText(text) : String(text ?? "").trim();
  if (plain) {
    CHAT_LOG.push({ role: type === "bot" ? "Bot" : "User", text: plain, ts: ts.getTime() });
    if (type === "user") { sessionMsgCount++; saveSession(); }
  }
  if (type === "bot" && speakThis) speak(plain);
}

function addChips(labels, onClick) {
  const qs = labels ?? [];
  if (!qs.length) return;
  const wrap = document.createElement("div");
  wrap.className = "chips";
  qs.slice(0, SETTINGS.chipLimit).forEach((label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn";
    b.textContent = label;
    b.addEventListener("click", async () => {
      voiceState.armed = true; saveVoice();
      const now = Date.now();
      if (isResponding) return;
      if (now - lastChipClickAt < SETTINGS.chipClickCooldownMs) return;
      lastChipClickAt = now;
      wrap.querySelectorAll(".chip-btn").forEach((btn)=>btn.disabled=true);
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

// GPS handler
async function handleUseMyLocation(){
  addBubble("Use my location", "user", { speak:false });
  isResponding=true;
  try{
    const loc = await requestBrowserLocation();
    const closest = findClosestDepot({ lat: loc.lat, lon: loc.lon });
    if (!closest){
      addBubble("I couldn't determine a nearby depot from your location. Please type a town/city.", "bot");
      addChips(["Coventry","Birmingham","Leicester","London"]);
    } else {
      const depot = DEPOTS[closest.depotKey];
      distanceCtx = { stage:"haveClosest", originKey:"your location", depotKey: closest.depotKey, miles: closest.miles };
      addBubble(`Thanks — your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>How are you travelling?`, "bot", { html:true });
      addChips(["By car","By train","By bus","Walking"]);
    }
  } catch {
    addBubble("I couldn't access your location. Please allow permission, or choose a town/city.", "bot");
    addChips(["Coventry","Birmingham","Leicester","London"]);
  } finally {
    isResponding=false;
  }
}

// --------- Intent Map — natural language phrases people actually type ---------
// Each intent maps to a handler key. Phrases are checked as substrings after normalisation.

const INTENT_PHRASES = [

  // Greetings / small talk
  { patterns: ["hello","hi","hey","good morning","good afternoon","good evening","hiya","alright","sup","howdy","morning","afternoon"], intent: "greeting" },
  { patterns: ["how are you","you ok","you alright","how r u","hows things","how are things"], intent: "smalltalk_how" },
  { patterns: ["thank","thanks","cheers","ta ","appreciated","helpful"], intent: "thanks" },
  { patterns: ["bye","goodbye","see you","see ya","cya","later","ttyl"], intent: "bye" },

  // Pay / wages
  { patterns: ["not been paid","havent been paid","haven't been paid","missing pay","no pay","didnt get paid","didn't get paid","where is my pay","where is my wage","when do i get paid","payday","pay day","wrong pay","incorrect pay","short paid","underpaid","overpaid","pay is wrong","wages wrong","wages are wrong","not received my pay","not received pay"], intent: "pay_query" },
  { patterns: ["pay query","pay question","pay issue","pay problem","pay help","payroll query","payroll issue","payroll problem","salary query","salary issue","wage query","wage issue","wages query","wages issue","my pay","about my pay","about my wage","check my pay"], intent: "pay_query" },
  { patterns: ["deduction","deductions","money taken","taken from my pay","taken from pay","taken out","stopped from pay","money missing","why has money been taken","money been taken","missing money","wrong amount"], intent: "deduction_query" },

  // Work allocation
  { patterns: ["no work","not got work","havent got work","haven't got work","no jobs","no job","not been allocated","not allocated","no allocation","no shifts","not got any work","where is my work","where is my job","need work","need jobs","out of work","run out of work","work dried up","no more work","work allocation","work alloc","allocated wrong","wrong job","wrong work","given wrong job"], intent: "work_allocation" },

  // Manager disputes
  { patterns: ["manager dispute","dispute with manager","problem with manager","issue with manager","trouble with manager","argument with manager","falling out with manager","conflict with manager","my manager","against my manager","manager being","manager has","manager is","field manager issue","area manager issue","unfair manager","manager treating","manager not","manager wont","manager won't","manager is not"], intent: "manager_dispute" },

  // Contract
  { patterns: ["contract","my contract","change contract","contract change","contract amendment","amend contract","contract query","contract question","contract issue","contract hours","contract type","permanent","part time","full time","contract update"], intent: "contract" },

  // Equipment — stock
  { patterns: ["stock","no stock","out of stock","missing stock","stock query","stock issue","stock problem","stock form","need stock","request stock","stock request"], intent: "equipment_stock" },
  // Equipment — tooling
  { patterns: ["tools","tooling","no tools","missing tools","need tools","tool query","tool issue","bybox","by box","tool order","order tools"], intent: "equipment_tooling" },
  // Equipment — van
  { patterns: ["van","no van","need a van","vehicle","need vehicle","when do i get a van","van query","van issue","van problem","company van","work van"], intent: "equipment_van" },
  // General equipment
  { patterns: ["equipment","kit","gear","my kit","my equipment","kit query","kit issue"], intent: "equipment" },

  // Street works
  { patterns: ["street work","streetwork","street works","streetworks","street job","road work query","sw query","sw issue"], intent: "street_works" },

  // Smart awards
  { patterns: ["smart award","smartaward","smart awards","smartawards","award query","award issue","my award","claim award"], intent: "smart_awards" },

  // ID cards
  { patterns: ["id card","id cards","id badge","badge","identification","lost id","id lost","id expired","expired id","id not arrived","id not received","id havent received","need new id","replace id","id renewal"], intent: "id_cards" },

  // Department contacts
  { patterns: ["contact","contacts","department","departments","who do i call","who do i contact","who should i contact","contact details","contact list","phone number","numbers","what number","which number","contact for","call for"], intent: "dept_contacts" },

  // Fleet / vehicles
  { patterns: ["fleet","fleet query","fleet issue","fleet contact","vehicle query","vehicle issue","breakdown","van broken","van broken down","car broken","company car"], intent: "fleet" },

  // Accidents / injuries
  { patterns: ["accident","injury","injured","hurt","accident report","report accident","had an accident","been in accident","crash","vehicle damage","damage report","road accident","near miss"], intent: "accident" },

  // Parking
  { patterns: ["parking","parking fine","parking ticket","parking query","parking issue","penalty charge","pcn","council fine"], intent: "parking" },

  // Recruitment
  { patterns: ["recruit","recruitment","hiring","new job","apply","application","job application","job vacancy","vacancy","start date","when do i start","joining","onboard","onboarding"], intent: "recruitment" },

  // BTOR NTF
  { patterns: ["btor","openreach","open reach","ntf btor","btor ntf","btor support","btor contact"], intent: "btor_ntf" },

  // City Fibre NTF
  { patterns: ["city fibre","cityfibre","cf ntf","city fibre ntf","city fibre support","cf support"], intent: "cityfibre_ntf" },

  // Opening times
  { patterns: ["open","opening","hours","open hours","what time","when open","when are you open","office hours","working hours","opening times","what are your hours","are you open","when do you open","when do you close","closing time"], intent: "opening_times" },
  { patterns: ["bank holiday","bank holidays","public holiday","are you open on bank holiday","open bank holiday"], intent: "bank_holiday" },
  { patterns: ["available now","anyone available","is someone available","open now","are you open now","anyone there","is anyone there","can i speak","speak to someone","talk to someone"], intent: "available_now" },

  // Location / depot
  { patterns: ["where are you","your address","office address","where is the office","located","location","find you","nuneaton","depot","depots","closest depot","nearest depot","how far","distance","directions","get there","how to get"], intent: "location" },

  // Support / contact
  { patterns: ["support","help","contact support","get help","need help","speak to welfare","welfare team","welfare number","welfare contact","welfare support","call welfare"], intent: "contact_support" },

  // SMS / text query
  { patterns: ["send a text","text you","text support","text query","text message","sms","message support"], intent: "sms_query" },
];

function detectIntent(text) {
  const q = normalize(text);
  for (const { patterns, intent } of INTENT_PHRASES) {
    for (const p of patterns) {
      if (q.includes(p)) return intent;
    }
  }
  // Fuzzy fallback — try levenshtein on each pattern word
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

// --------- Guided Flows (Work Allocation, Manager Dispute, Equipment) ---------

function handleFlow(text) {
  const q = normalize(text);
  if (!flowCtx) return null;

  // Cancel at any point
  if (q === "cancel" || q === "stop" || q === "restart") {
    flowCtx = null;
    return { html: "No problem, I've cancelled that. Feel free to ask anything else or use the <b>Topics</b> button." };
  }

  // ---- Work Allocation Flow ----
  if (flowCtx.type === "workAllocation") {
    if (flowCtx.stage === "askRaised") {
      if (q === "yes") {
        flowCtx = null;
        return { html: `Please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      } else {
        flowCtx = null;
        return { html: `Please raise this to your <b>Field and Area Manager</b>. Should there be any further concerns after this step, please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      }
    }
  }

  // ---- Manager Dispute Flow ----
  if (flowCtx.type === "managerDispute") {
    if (flowCtx.stage === "askFieldManager") {
      if (q === "yes") {
        flowCtx = { type: "managerDispute", stage: "askAreaManager" };
        return { html: "Have you contacted your <b>Area Manager</b>?", chips: ["Yes", "No"] };
      } else {
        flowCtx = null;
        return { html: `Please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      }
    }
    if (flowCtx.stage === "askAreaManager") {
      if (q === "yes") {
        flowCtx = null;
        return { html: `Please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      } else {
        flowCtx = null;
        return { html: `Please contact your <b>Area Manager</b>. Should there be any further concerns after this step, please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      }
    }
  }

  // ---- Equipment Flow ----
  if (flowCtx.type === "equipment") {
    if (flowCtx.stage === "askType") {
      if (q === "stock") {
        flowCtx = { type: "equipment", stage: "stockFormSubmitted" };
        return { html: "Have you submitted a <b>Stock Form</b> with your Field Manager?", chips: ["Yes", "No"] };
      } else if (q === "tooling") {
        flowCtx = { type: "equipment", stage: "byboxSubmitted" };
        return { html: "Has your <b>Field Manager submitted an order through ByBox</b>?", chips: ["Yes", "No"] };
      } else if (q === "van") {
        flowCtx = { type: "equipment", stage: "vanRaised" };
        return { html: "Have you raised the query of receiving a van to your <b>Field Manager and Area Manager</b>?", chips: ["Yes", "No"] };
      }
    }
    if (flowCtx.stage === "stockFormSubmitted") {
      if (q === "yes") {
        flowCtx = null;
        return { html: `Please contact your <b>Field Manager</b> regarding the update of your stock. Any further concerns, please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      } else {
        flowCtx = null;
        return { html: "Please contact your <b>Field Manager</b> and complete a <b>Stock Form</b>." };
      }
    }
    if (flowCtx.stage === "byboxSubmitted") {
      if (q === "yes") {
        flowCtx = null;
        return { html: `Please follow up with your <b>Field Manager</b> regarding your order. Any further concerns, please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      } else {
        flowCtx = null;
        return { html: "Please contact your <b>Field Manager</b> and request them to submit an order to <b>ByBox</b>." };
      }
    }
    if (flowCtx.stage === "vanRaised") {
      if (q === "yes") {
        flowCtx = null;
        return { html: `As you have raised this to your Field and Area Manager, please contact Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> and hold the line.` };
      } else {
        flowCtx = null;
        return { html: "Please contact your <b>Field Manager</b> and query this through." };
      }
    }
  }

  return null;
}

// --------- Special Cases — intent driven ---------

function specialCases(text){
  const q = normalize(text);
  const intent = detectIntent(text);

  // Active flow check first
  if (flowCtx) {
    const flowResult = handleFlow(text);
    if (flowResult) return flowResult;
  }

  // Active SMS flow
  if (smsCtx) {
    if (q === "cancel" || q === "stop" || q === "restart") {
      smsCtx = null;
      return { html: "No problem, I've cancelled that. Feel free to ask anything else." };
    }
    if (smsCtx.stage === "needName") {
      smsCtx.name = text.trim();
      smsCtx.stage = "needPhone";
      return { html: `Thanks <b>${escapeHTML(smsCtx.name)}</b> — what's the best <b>phone number</b> to reach you on?` };
    }
    if (smsCtx.stage === "needPhone") {
      smsCtx.phone = text.trim();
      smsCtx.stage = "needType";
      return { html: "Is this a <b>Pay</b> or <b>Deduction</b> query?", chips: ["Pay query", "Deduction query"] };
    }
    if (smsCtx.stage === "needType") {
      smsCtx.type = text.trim();
      smsCtx.stage = "needDescription";
      return { html: "Please briefly describe your query (1–3 sentences):" };
    }
    if (smsCtx.stage === "needDescription") {
      smsCtx.description = text.trim();
      const smsBody = encodeURIComponent(`Welfare Support Query\nName: ${smsCtx.name}\nPhone: ${smsCtx.phone}\nType: ${smsCtx.type}\nQuery: ${smsCtx.description}`);
      const smsHref = `sms:${SETTINGS.smsNumber}?body=${smsBody}`;
      const html =
        `<b>Ready to send</b><br>` +
        `Name: <b>${escapeHTML(smsCtx.name)}</b><br>` +
        `Phone: <b>${escapeHTML(smsCtx.phone)}</b><br>` +
        `Type: <b>${escapeHTML(smsCtx.type)}</b><br>` +
        `Query: <b>${escapeHTML(smsCtx.description)}</b><br><br>` +
        `<a href="${escapeAttrUrl(smsHref)}">📱 Tap here to send your text to ${escapeHTML(SETTINGS.smsNumber)}</a>` +
        `<br><small>Opens your messaging app with the message ready to send.</small>`;
      // Log SMS to admin
      logSMS({ name: smsCtx.name, phone: smsCtx.phone, type: smsCtx.type, description: smsCtx.description });
      logIntent("sms_sent");
      smsCtx = null;
      return { html, chips: ["Pay / Payroll query", "Deductions query"], _intent: "sms_sent" };
    }
  }

  // Greetings / small talk
  if (intent === "greeting") {
    const greetings = [
      "Hey! 👋 How can I help you today?",
      "Hi there! What can I help you with?",
      "Hello! What's your query today?",
      "Hey, good to hear from you! What do you need help with?"
    ];
    return { html: greetings[Math.floor(Math.random() * greetings.length)], chips: ["Pay / Payroll query","Work Allocation query","Department Contacts","Equipment Query"], _intent: "greeting" };
  }

  if (intent === "smalltalk_how") {
    return { html: "I'm doing well thanks! I'm here to help with any welfare queries — what do you need?", _intent: "smalltalk" };
  }

  if (intent === "thanks") {
    const replies = ["Happy to help! 😊 Anything else I can do for you?","No problem at all! Let me know if there's anything else.","You're welcome! Is there anything else you need?"];
    return { html: replies[Math.floor(Math.random() * replies.length)], _intent: "thanks" };
  }

  if (intent === "bye") {
    return { html: "Take care! 👋 Come back any time you need help.", _intent: "bye" };
  }

  // Pay / deductions
  if (intent === "pay_query" || intent === "sms_query") {
    smsCtx = { stage: "needName" };
    return { html: "I'll help you send a text to our pay & deductions team.<br><br>First, what's your <b>full name</b>?", _intent: "pay_query" };
  }

  if (intent === "deduction_query") {
    smsCtx = { stage: "needName" };
    return { html: "I can help with that. I'll get your details and send a text to the team.<br><br>What's your <b>full name</b>?", _intent: "deduction_query" };
  }

  // Work allocation
  if (intent === "work_allocation") {
    flowCtx = { type: "workAllocation", stage: "askRaised" };
    return { html: "Sorry to hear that. Has this already been raised with your <b>Field and Area Manager</b>?", chips: ["Yes", "No"], _intent: "work_allocation" };
  }

  // Manager dispute
  if (intent === "manager_dispute") {
    flowCtx = { type: "managerDispute", stage: "askFieldManager" };
    return { html: "I understand, let's get this sorted. Is this regarding your <b>Field Manager</b>?", chips: ["Yes", "No"], _intent: "manager_dispute" };
  }

  // Contract
  if (intent === "contract") {
    return { html: "For any contract change queries, please raise this with your <b>Area Manager</b>.", chips: ["Department Contacts","How can I contact support?"], _intent: "contract" };
  }

  // Equipment
  if (intent === "equipment_stock") {
    flowCtx = { type: "equipment", stage: "stockFormSubmitted" };
    return { html: "For stock queries — have you submitted a <b>Stock Form</b> with your Field Manager?", chips: ["Yes", "No"], _intent: "equipment" };
  }
  if (intent === "equipment_tooling") {
    flowCtx = { type: "equipment", stage: "byboxSubmitted" };
    return { html: "For tooling queries — has your <b>Field Manager submitted an order through ByBox</b>?", chips: ["Yes", "No"], _intent: "equipment" };
  }
  if (intent === "equipment_van") {
    flowCtx = { type: "equipment", stage: "vanRaised" };
    return { html: "For van queries — have you raised this with your <b>Field Manager and Area Manager</b>?", chips: ["Yes", "No"], _intent: "equipment" };
  }
  if (intent === "equipment") {
    flowCtx = { type: "equipment", stage: "askType" };
    return { html: "No problem, let's get that sorted. Is this regarding <b>Stock</b>, <b>Tooling</b> or a <b>Van</b>?", chips: ["Stock", "Tooling", "Van"], _intent: "equipment" };
  }

  if (intent === "street_works") return { html: `For any Street Work queries please contact <a href="mailto:Street.Works@kelly.co.uk">Street.Works@kelly.co.uk</a>.`, _intent: "street_works" };
  if (intent === "smart_awards") return { html: `For any Smart Award queries please contact <a href="mailto:smartawards@kelly.co.uk">smartawards@kelly.co.uk</a>.`, _intent: "smart_awards" };
  if (intent === "id_cards") return { html: `For lost, unreceived or expired ID cards, please contact <a href="mailto:nuneaton.admin@kelly.co.uk">nuneaton.admin@kelly.co.uk</a>.`, _intent: "id_cards" };
  if (intent === "fleet") return { html: `For any vehicle or fleet queries please call <a href="tel:01582841291"><b>01582841291</b></a> or <a href="tel:07940766377"><b>07940766377</b></a> (out of hours).`, _intent: "fleet" };
  if (intent === "accident") return { html: `For accident or injury reports please call <a href="tel:07940792355"><b>07940792355</b></a> as soon as possible.`, _intent: "accident" };
  if (intent === "parking") return { html: `For any parking queries please call <a href="tel:07940792355"><b>07940792355</b></a>.`, _intent: "parking" };
  if (intent === "recruitment") return { html: `For recruitment queries please call <a href="tel:02037583058"><b>02037583058</b></a>.`, _intent: "recruitment" };
  if (intent === "contact_support") return { html: `You can reach Welfare directly on <a href="tel:02087583060"><b>02087583060</b></a> — please hold the line when prompted.`, chips: ["Department Contacts","What are your opening times?"], _intent: "contact_support" };
  if (intent === "opening_times") return { html: "We're open <b>Monday–Friday, 8:30am–5:00pm</b> (UK time). We're closed on weekends and bank holidays.", chips: ["Is anyone available now?","Are you open on bank holidays?"], _intent: "opening_times" };
  if (intent === "bank_holiday") return { html: "❌ <b>No, we are not open on bank holidays.</b>", chips: ["What are your opening times?"], _intent: "opening_times" };

  // Distance flow continuations
  if (distanceCtx?.stage==="needOrigin"){
    const cityKey = Object.keys(PLACES).find(k=>q===k || q.includes(k));
    if (cityKey){
      const closest = findClosestDepot(PLACES[cityKey]);
      const depot = DEPOTS[closest.depotKey];
      distanceCtx = { stage:"haveClosest", originKey: cityKey, depotKey: closest.depotKey, miles: closest.miles };
      return { html:`Thanks, your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>How are you travelling?`, chips:["By car","By train","By bus","Walking"] };
    }
  }

  if (distanceCtx?.stage==="haveClosest"){
    if (q==="by car" || q==="by train" || q==="by bus" || q==="walking"){
      const mode = q==="walking" ? "walk" : q.replace("by ","");
      const depot = DEPOTS[distanceCtx.depotKey];
      const originLabel = distanceCtx.originKey==="your location" ? "your location" : distanceCtx.originKey;
      const url = googleDirectionsURL(originLabel, depot, mode);
      const tile = osmTileURL(depot.lat, depot.lon, 13);
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

// --------- Typing indicator ---------

function showTyping() {
  const row = document.createElement("div");
  row.className = "msg bot";
  row.id = "typingIndicator";
  const bubble = document.createElement("div");
  bubble.className = "bubble bot typing-bubble";
  bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  row.appendChild(bubble);
  chatWindow.prepend(row);
}

function hideTyping() {
  const el = document.getElementById("typingIndicator");
  if (el) el.remove();
}

function typingDelay() {
  return Math.floor(Math.random() * 1000) + 1000; // 1000–2000ms
}

// --------- Fuzzy spell matching (Levenshtein) ---------

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
  // Check each word in the query against each word in the candidate
  const qWords = q.split(" ").filter(w => w.length > 3);
  const cWords = candidate.split(" ").filter(w => w.length > 3);
  let matched = 0;
  for (const qw of qWords) {
    for (const cw of cWords) {
      const maxLen = Math.max(qw.length, cw.length);
      const dist = levenshtein(qw, cw);
      // Allow 1 typo for words 5+ chars, exact for shorter
      if (dist === 0) { matched += 1; break; }
      if (maxLen >= 5 && dist === 1) { matched += 0.8; break; }
      if (maxLen >= 7 && dist === 2) { matched += 0.6; break; }
    }
  }
  return qWords.length ? matched / qWords.length : 0;
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

// --------- Context memory (Fix 4) ---------
function handleContextQuery(text) {
  const q = normalize(text);
  // "that number", "the number", "what was the number", "can I have that number"
  if ((q.includes("that number") || q.includes("the number") || q.includes("what number") || q.includes("number again") || q.includes("repeat") || q.includes("say again") || q.includes("what was that")) && lastPhoneNumber) {
    return { html: `The last number I mentioned was <a href="tel:${escapeHTML(lastPhoneNumber)}"><b>${escapeHTML(lastPhoneNumber)}</b></a>.` };
  }
  // "say it again", "repeat that", "what did you say"
  if (q.includes("say it again") || q.includes("repeat that") || q.includes("what did you say") || q.includes("come again")) {
    const lastBot = CHAT_LOG.filter(l => l.role === "Bot").slice(-1)[0];
    if (lastBot) return { html: lastBot.text };
  }
  return null;
}

// --------- SMS character counter helper ---------
function addSmsCharCounter(inputEl) {
  const counter = document.createElement("div");
  counter.className = "sms-char-counter";
  counter.textContent = `0 / ${SETTINGS.smsMaxChars}`;
  inputEl.parentNode?.insertBefore(counter, inputEl.nextSibling);
  inputEl.addEventListener("input", () => {
    const len = inputEl.value.length;
    counter.textContent = `${len} / ${SETTINGS.smsMaxChars}`;
    counter.classList.toggle("over", len > SETTINGS.smsMaxChars);
    if (len > SETTINGS.smsMaxChars) inputEl.value = inputEl.value.slice(0, SETTINGS.smsMaxChars);
  });
  return counter;
}

async function handleUserMessage(text){
  if (!text) return;
  addBubble(text, "user", { speak:false });
  input.value="";
  isResponding=true;
  sendBtn.disabled=true;

  showTyping();
  await new Promise(r => setTimeout(r, typingDelay()));
  hideTyping();

  // Context memory first
  const ctx = handleContextQuery(text);
  if (ctx) {
    addBubble(ctx.html, "bot", { html:true });
    if (ctx.chips) addChips(ctx.chips);
    isResponding=false;
    sendBtn.disabled=false;
    return;
  }

  const s = specialCases(text);
  if (s){
    if (s._intent) logIntent(s._intent);
    addBubble(s.html, "bot", { html:true });
    if (s.chips) addChips(s.chips);
    isResponding=false;
    sendBtn.disabled=false;
    return;
  }

  const faq = matchFAQ(text) || matchFAQFuzzy(text);
  if (faq){
    addBubble(faq.answer, "bot", { html:true });
    if (faq.followUps?.length) addChips(faq.followUps);
    isResponding=false;
    sendBtn.disabled=false;
    return;
  }

  // Nothing matched — log it
  logUnresolved(text);
  addBubble("I'm not sure about that one — try the <b>Topics</b> button or pick a common query below:", "bot", { html:true });
  addChips(["Pay / Payroll query","Work Allocation query","Department Contacts","Is anyone available now?"]);
  isResponding=false;
  sendBtn.disabled=false;
}

function sendChat(){
  if (isResponding) return;
  const t = input.value.trim();
  if (!t) return;
  handleUserMessage(t);
}

sendBtn.addEventListener("click", sendChat);
input.addEventListener("keydown", (e)=>{ if(e.key==="Enter"){ e.preventDefault(); sendChat(); } });

clearBtn.addEventListener("click", ()=>{
  chatWindow.innerHTML="";
  smsCtx=null;
  distanceCtx=null;
  flowCtx=null;
  CHAT_LOG=[];
  init();
});

// --------- FAQ Matching ---------

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

// --------- Drawer ---------

function buildCategoryIndex(){
  categoryIndex=new Map();
  FAQS.forEach((item)=>{
    const key=(item.category ?? "general").toLowerCase();
    if(!categoryIndex.has(key)) categoryIndex.set(key, []);
    categoryIndex.get(key).push(item);
  });
  const labelMap={
    general:"General",
    support:"Support",
    opening:"Opening times",
    actions:"Actions",
    pay:"Pay & Deductions",
    work:"Work Allocation",
    contract:"Contract",
    departments:"Departments",
    equipment:"Equipment"
  };
  categories=Array.from(categoryIndex.keys()).sort().map((key)=>({
    key, label: labelMap[key] ?? (key.charAt(0).toUpperCase()+key.slice(1)), count: categoryIndex.get(key).length
  }));
}

function openDrawer(){
  overlay.hidden=false;
  drawer.hidden=false;
}

function closeDrawer(){
  overlay.hidden=true;
  drawer.hidden=true;
}

function renderDrawer(selectedKey){
  const selected = selectedKey ?? null;
  drawerCategoriesEl.innerHTML="";
  drawerQuestionsEl.innerHTML="";
  categories.forEach((c)=>{
    const pill=document.createElement("button");
    pill.type="button";
    pill.className="cat-pill";
    pill.textContent=`${c.label} (${c.count})`;
    pill.setAttribute("aria-selected", String(c.key===selected));
    pill.addEventListener("click", ()=>renderDrawer(c.key));
    drawerCategoriesEl.appendChild(pill);
  });
  const list = selected && categoryIndex.has(selected) ? categoryIndex.get(selected) : FAQS;
  list.forEach((item)=>{
    const b=document.createElement("button");
    b.type="button";
    b.className="drawer-q";
    b.textContent=item.question;
    b.addEventListener("click", ()=>{
      closeDrawer();
      handleUserMessage(item.question);
    });
    drawerQuestionsEl.appendChild(b);
  });
}

topicsBtn.addEventListener("click", ()=>{ if(faqsLoaded) openDrawer(); });
overlay.addEventListener("click", closeDrawer);
drawerCloseBtn.addEventListener("click", closeDrawer);

// load faqs
fetch("./public/config/faqs.json")
  .then((res)=>res.json())
  .then((data)=>{
    FAQS = Array.isArray(data) ? data : [];
    faqsLoaded=true;
    buildCategoryIndex();
    renderDrawer(null);
  })
  .catch(()=>{
    FAQS=[];
    faqsLoaded=true;
    buildCategoryIndex();
    renderDrawer(null);
  });

// Greeting
function init(){
  addBubble(getGreeting(), "bot", { html:true, speak:false, noFeedback:true });
}

if (document.readyState === "loading"){
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
