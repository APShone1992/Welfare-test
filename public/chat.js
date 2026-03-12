const SETTINGS = {
  minConfidence: 0.20,
  suggestionLimit: 5,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  smsNumber: "07773652107",
  greeting: "Hi! I'm <b>Welfare Support</b>. Please let me know what your query is regarding — use the <b>Topics</b> button or type your question below."
};

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
let flowCtx = null; // for multi-step guided flows

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
  const time = document.createElement("div");
  time.className = "timestamp";
  time.textContent = formatUKTime(ts);
  row.appendChild(bubble);
  row.appendChild(time);
  chatWindow.prepend(row);
  const plain = html ? htmlToPlainText(text) : String(text ?? "").trim();
  if (plain) CHAT_LOG.push({ role: type === "bot" ? "Bot" : "User", text: plain, ts: ts.getTime() });
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
      else handleUserMessage(label);
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
        return { html: "Please contact Welfare directly on <b>02087583060</b> and hold the line." };
      } else {
        flowCtx = null;
        return { html: "Please raise this to your <b>Field and Area Manager</b>. Should there be any further concerns after this step, please contact Welfare directly on <b>02087583060</b> and hold the line." };
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
        return { html: "Please contact Welfare directly on <b>02087583060</b> and hold the line." };
      }
    }
    if (flowCtx.stage === "askAreaManager") {
      if (q === "yes") {
        flowCtx = null;
        return { html: "Please contact Welfare directly on <b>02087583060</b> and hold the line." };
      } else {
        flowCtx = null;
        return { html: "Please contact your <b>Area Manager</b>. Should there be any further concerns after this step, please contact Welfare directly on <b>02087583060</b> and hold the line." };
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
        return { html: "Please contact your <b>Field Manager</b> regarding the update of your stock. Any further concerns, please contact Welfare directly on <b>02087583060</b> and hold the line." };
      } else {
        flowCtx = null;
        return { html: "Please contact your <b>Field Manager</b> and complete a <b>Stock Form</b>." };
      }
    }
    if (flowCtx.stage === "byboxSubmitted") {
      if (q === "yes") {
        flowCtx = null;
        return { html: "Please follow up with your <b>Field Manager</b> regarding your order. Any further concerns, please contact Welfare directly on <b>02087583060</b> and hold the line." };
      } else {
        flowCtx = null;
        return { html: "Please contact your <b>Field Manager</b> and request them to submit an order to <b>ByBox</b>." };
      }
    }
    if (flowCtx.stage === "vanRaised") {
      if (q === "yes") {
        flowCtx = null;
        return { html: "As you have raised this to your Field and Area Manager, please contact Welfare directly on <b>02087583060</b> and hold the line." };
      } else {
        flowCtx = null;
        return { html: "Please contact your <b>Field Manager</b> and query this through." };
      }
    }
  }

  return null;
}

// --------- Special Cases ---------

function specialCases(text){
  const q = normalize(text);

  // Active flow check first
  if (flowCtx) {
    const flowResult = handleFlow(text);
    if (flowResult) return flowResult;
  }

  if (q.includes("bank holiday") || q.includes("bank holidays")){
    return { html:"❌ <b>No we are not open on bank holidays.</b>", chips:["What are your opening times?","Is anyone available now?"] };
  }

  if (q.includes("is anyone available") || q.includes("available now") || q.includes("open now")){
    const open = isOpenNow();
    const nowUK = formatUKTime(new Date());
    if (open){
      return { html:`✅ <b>Yes we're open right now.</b><br>Current UK time: <b>${escapeHTML(nowUK)}</b>`, chips:["How can I contact support?"] };
    }
    const bh = isBankHolidayToday();
    return { html:`❌ <b>No we're closed right now.</b><br>Current UK time: <b>${escapeHTML(nowUK)}</b>${bh ? "<br><small>❌ <b>No — we are not open on bank holidays.</b></small>" : ""}`, chips:["What are your opening times?","How can I contact support?"] };
  }

  // Work Allocation
  if (q.includes("work allocation") || q.includes("work query") || q.includes("no work") || q.includes("job allocation")){
    flowCtx = { type: "workAllocation", stage: "askRaised" };
    return { html: "Has this been raised with your <b>Field and Area Manager</b>?", chips: ["Yes", "No"] };
  }

  // Manager Dispute
  if (q.includes("manager dispute") || q.includes("dispute with manager") || q.includes("manager issue") || q.includes("manager complaint")){
    flowCtx = { type: "managerDispute", stage: "askFieldManager" };
    return { html: "Is this regarding your <b>Field Manager</b>?", chips: ["Yes", "No"] };
  }

  // Equipment Query
  if (q.includes("equipment") || q.includes("equipment query") || q.includes("stock query") || q.includes("tooling") || q.includes("van query")){
    flowCtx = { type: "equipment", stage: "askType" };
    return { html: "Is this regarding <b>Stock</b>, <b>Tooling</b> or a <b>Van</b>?", chips: ["Stock", "Tooling", "Van"] };
  }

  // SMS flow — triggered by pay/deduction queries or "send a text"
  const wantsSMS =
    q.includes("pay query") || q.includes("payroll query") || q.includes("deduction query") ||
    q.includes("i have a pay") || q.includes("i have a deduction") || q.includes("send a text") ||
    q.includes("text support") || q.includes("send text") || q === "pay" || q === "deductions";

  if (!smsCtx && wantsSMS) {
    smsCtx = { stage: "needName" };
    return { html: "I'll help you send a text to our pay & deductions team.<br><br>First, what's your <b>full name</b>?" };
  }

  if (smsCtx) {
    if (q === "cancel" || q === "stop" || q === "restart") {
      smsCtx = null;
      return { html: "No problem, I've cancelled that. Feel free to ask anything else." };
    }
    if (smsCtx.stage === "needName") {
      smsCtx.name = text.trim();
      smsCtx.stage = "needType";
      return { html: `Thanks <b>${escapeHTML(smsCtx.name)}</b> — is this a <b>Pay</b> or <b>Deduction</b> query?`, chips: ["Pay query", "Deduction query"] };
    }
    if (smsCtx.stage === "needType") {
      smsCtx.type = text.trim();
      smsCtx.stage = "needDescription";
      return { html: "Please briefly describe your query (1–3 sentences):" };
    }
    if (smsCtx.stage === "needDescription") {
      smsCtx.description = text.trim();
      // Build SMS body
      const smsBody = encodeURIComponent(
        `Welfare Support Query\nName: ${smsCtx.name}\nType: ${smsCtx.type}\nQuery: ${smsCtx.description}`
      );
      const smsHref = `sms:${SETTINGS.smsNumber}?body=${smsBody}`;
      const html =
        `<b>Ready to send</b><br>` +
        `Name: <b>${escapeHTML(smsCtx.name)}</b><br>` +
        `Type: <b>${escapeHTML(smsCtx.type)}</b><br>` +
        `Query: <b>${escapeHTML(smsCtx.description)}</b><br><br>` +
        `<a href="${escapeAttrUrl(smsHref)}">📱 Tap here to send your text to ${escapeHTML(SETTINGS.smsNumber)}</a>` +
        `<br><small>(Opens your messaging app with the message ready to send.)</small>`;
      smsCtx = null;
      return { html, chips: ["Pay / Payroll query", "Deductions query"] };
    }
  }

  if (q.includes("closest depot") || q.includes("how far") || q.includes("distance")){
    distanceCtx = { stage:"needOrigin" };
    return { html:"What town/city are you travelling from? (Or choose <b>Use my location</b>.)", chips:["Use my location","Coventry","Birmingham","Leicester","London"] };
  }

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
      return {
        html:
          `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
          `${linkTag(url, "Get directions in Google Maps")}<br>` +
          `${imgTag(tile, "OpenStreetMap preview")}`
      };
    }
  }

  if (q.includes("where are you") || q.includes("location") || q.includes("address")){
    const d = DEPOTS.nuneaton;
    const tile = osmTileURL(d.lat, d.lon, 13);
    const gmaps = `https://www.google.com/maps?q=${encodeURIComponent(d.lat + "," + d.lon)}`;
    return { html:`We're based in <b>Nuneaton, UK</b>.<br>${linkTag(gmaps,"Open in Google Maps")}<br>${imgTag(tile)}` };
  }

  return null;
}

// --------- Main message handling ---------

function handleUserMessage(text){
  if (!text) return;
  addBubble(text, "user", { speak:false });
  input.value="";
  isResponding=true;

  const s = specialCases(text);
  if (s){
    addBubble(s.html, "bot", { html:true });
    if (s.chips) addChips(s.chips);
    isResponding=false;
    return;
  }

  const faq = matchFAQ(text);
  if (faq){
    addBubble(faq.answer, "bot", { html:true });
    if (faq.followUps?.length) addChips(faq.followUps);
    isResponding=false;
    return;
  }

  addBubble("Try the <b>Topics</b> button, or ask about: <b>pay</b>, <b>work allocation</b>, <b>manager dispute</b>, <b>equipment</b>, <b>department contacts</b>, <b>opening times</b>, or <b>raise a request</b>.", "bot", { html:true });
  isResponding=false;
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
  addBubble(SETTINGS.greeting, "bot", { html:true, speak:false });
}

if (document.readyState === "loading"){
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
