/* Welfare Support Chat – full working build (Topics + SMS) */

const SETTINGS = {
  minConfidence: 0.20,
  suggestionLimit: 5,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  supportEmail: "support@Kelly.co.uk",
  supportPhone: "01234 567890",
  ticketTranscriptMessages: 12,
  greeting:
    "Hi! I’m <b>Welfare Support</b>, please let me know what your query is regarding using the <b>Topics</b> button.",
  // SMS deep link for Pay/Deduction (you can change this any time)
  textSystemNumber: "07773652107"
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
let ticketCtx = null;
let distanceCtx = null;
let flowCtx = null; // NEW: topics flow context

// helpers
const normalize = (s) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”‘’]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function escapeAttrUrl(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// decode entities so legacy <b> works too
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
      const safe = /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href) || /^sms:/i.test(href);
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

// Business hours Mon-Fri 08:30–17:00
const BUSINESS = { start: 8*60+30, end: 17*60, openDays: new Set([1,2,3,4,5]) };
// Bank holidays (England & Wales) 2025–2028
const BANK_HOLIDAYS_EW = new Set([
  "2025-01-01","2025-04-18","2025-04-21","2025-05-05","2025-05-26","2025-08-25","2025-12-25","2025-12-26",
  "2026-01-01","2026-04-03","2026-04-06","2026-05-04","2026-05-25","2026-08-31","2026-12-25","2026-12-28",
  "2027-01-01","2027-03-26","2027-03-29","2027-05-03","2027-05-31","2027-08-30","2027-12-27","2027-12-28",
  "2028-01-03","2028-04-14","2028-04-17","2028-05-01","2028-05-29","2028-08-28","2028-12-25","2028-12-26"
]);

function isBankHolidayToday() { return BANK_HOLIDAYS_EW.has(getUKDateISO(new Date())); }
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
function buildTranscript(limit = 12) {
  const slice = CHAT_LOG.slice(-Math.max(1, limit));
  return slice.map((m) => `[${formatUKTime(new Date(m.ts))}] ${m.role}: ${m.text}`).join("\n");
}

// speaker
const VOICE_KEY = "ws_voice_v1";
const voiceState = { on:false, armed:false };
try { Object.assign(voiceState, JSON.parse(localStorage.getItem(VOICE_KEY) || "{}")); } catch {}
function saveVoice(){ try{ localStorage.setItem(VOICE_KEY, JSON.stringify(voiceState)); } catch{} }
function updateVoiceUI(){
  voiceBtn.classList.toggle("on", voiceState.on);
  voiceBtn.textContent = voiceState.on ? "🔊" : "🔈";
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
    micBtn.textContent="🎙️";
    micBtn.setAttribute("aria-pressed","true");
  };
  rec.onend = ()=>{
    micListening=false;
    micBtn.classList.remove("on");
    micBtn.textContent="🎤";
    micBtn.setAttribute("aria-pressed","false");
  };
  rec.onerror = ()=>{
    micListening=false;
    micBtn.classList.remove("on");
    micBtn.textContent="🎤";
    micBtn.setAttribute("aria-pressed","false");
    addBubble("Voice input isn’t supported here — please type your question.", "bot", { speak:false });
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
    addBubble("Voice input isn’t supported in this browser. Try Chrome/Edge, or type your question.", "bot", { speak:false });
    return;
  }
  try{
    if (micListening) recognizer.stop();
    else recognizer.start();
  } catch {
    addBubble("Couldn’t start voice input — please try again.", "bot", { speak:false });
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
  chatWindow.appendChild(row);
  chatWindow.scrollTop = chatWindow.scrollHeight;

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

      // Special chip: Use my location for depots
      if (label === "Use my location" && distanceCtx?.stage === "needOrigin") {
        await handleUseMyLocation();
        return;
      }
      // Special chip: Open Topics Drawer
      if (normalize(label) === "open topics" || normalize(label) === "topics") {
        openDrawer();
        addBubble("Opening Topics…", "bot", { speak:false });
        return;
      }

      if (typeof onClick === "function") onClick(label);
      else handleUserMessage(label);
    });
    wrap.appendChild(b);
  });
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

// GPS handler
async function handleUseMyLocation(){
  addBubble("Use my location", "user", { speak:false });
  isResponding=true;
  try{
    const loc = await requestBrowserLocation();
    const closest = findClosestDepot({ lat: loc.lat, lon: loc.lon });
    if (!closest){
      addBubble("I couldn’t determine a nearby depot from your location. Please type a town/city.", "bot");
      addChips(["Coventry","Birmingham","Leicester","London"]);
    } else {
      const depot = DEPOTS[closest.depotKey];
      distanceCtx = { stage:"haveClosest", originKey:"your location", depotKey: closest.depotKey, miles: closest.miles };
      addBubble(`Thanks — your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>How are you travelling?`, "bot", { html:true });
      addChips(["By car","By train","By bus","Walking"]);
    }
  } catch {
    addBubble("I couldn’t access your location. Please allow permission, or choose a town/city.", "bot");
    addChips(["Coventry","Birmingham","Leicester","London"]);
  } finally {
    isResponding=false;
  }
}

// ---------- FAQ matching
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

// ---------- TOPICS / SPECIAL CASES ----------
function specialCases(text){
  const q = normalize(text);

  // Open Topics drawer by typing
  if (q === "topics" || q === "open topics" || q === "topic") {
    openDrawer();
    return { html: "Choose a topic from the drawer.", chips: [] };
  }

  // Helpers + standard phrases
  const SAY = {
    welfareHold: 'Please contact Welfare directly on <b>02087583060</b> and hold the line.',
    areaManagerThenWelfare:
      'Please contact your <b>Area Manager</b>, should there be any further concerns after this step please contact Welfare directly on <b>02087583060</b> and hold the line.',
  };
  const isYes = (n) => n === "yes" || n === "y";
  const isNo  = (n) => n === "no"  || n === "n";
  const choice = (labels) => ({ chips: labels });
  const endWith = (html, extraChips=[]) => {
    flowCtx = null;
    const base = extraChips.length ? extraChips : ["Open Topics"];
    return { html, chips: base };
  };

  // If a flow is in progress, handle it
  if (flowCtx) {
    // WORK ALLOCATION
    if (flowCtx.type === "workAllocation") {
      if (flowCtx.stage === "askRaised") {
        if (isYes(q)) return endWith(SAY.welfareHold);
        if (isNo(q)) {
          return endWith(
            'Please raise this to your <b>Field</b> and <b>Area Manager</b>. Should there be any further concerns after this step please contact Welfare directly on <b>02087583060</b> and hold the line.'
          );
        }
        return { html: 'Has this been raised with your <b>Field</b> and <b>Area Manager</b>?', ...choice(["Yes","No"]) };
      }
    }

    // MANAGER DISPUTE
    if (flowCtx.type === "managerDispute") {
      if (flowCtx.stage === "askFieldMgr") {
        if (isYes(q)) {
          flowCtx.stage = "askAreaMgrContacted";
          return { html: 'Have you contacted your <b>Area Manager</b>?', ...choice(["Yes","No"]) };
        }
        if (isNo(q)) return endWith(SAY.welfareHold);
        return { html: 'Is this regarding your <b>Field Manager</b>?', ...choice(["Yes","No"]) };
      }
      if (flowCtx.stage === "askAreaMgrContacted") {
        if (isYes(q)) return endWith(SAY.welfareHold);
        if (isNo(q))  return endWith(SAY.areaManagerThenWelfare);
        return { html: 'Have you contacted your <b>Area Manager</b>?', ...choice(["Yes","No"]) };
      }
    }

    // DEPARTMENT CONTACTS (with submenus)
    if (flowCtx.type === "deptContacts") {
      const rootChips = [
        "Street Works","Smart Awards","Support Team",
        "City Fibre Back Office","BTOR Allocations Team","Fleet",
        "Accident Line","Parking Line","Recruitment",
        "BTOR NTF Support","City Fibre NTF Support"
      ];
      if (flowCtx.stage === "root") {
        if (q.includes("street works"))
          return endWith(`Please contact ${linkTag("mailto:Street.Works@kelly.co.uk","Street.Works@kelly.co.uk")} regarding any Street Work queries.`);
        if (q.includes("smart awards"))
          return endWith(`Please contact ${linkTag("mailto:smartawards@kelly.co.uk","smartawards@kelly.co.uk")} regarding any Smart Awards queries.`);
        if (q.includes("support team"))
          return endWith(`Please call <b>02080164966</b> for any job support. ${linkTag("tel:02080164966","Call 02080164966")}`);
        if (q.includes("city fibre back office"))
          return endWith(`Please call <b>02080164966</b> for any City Fibre back office / job queries. ${linkTag("tel:02080164966","Call 02080164966")}`);
        if (q.includes("btor allocations") || q.includes("open reach") || q.includes("openreach"))
          return endWith(`Please call <b>02080164962</b> for any Open Reach controls queries. ${linkTag("tel:02080164962","Call 02080164962")}`);
        if (q.includes("fleet"))
          return endWith(`Please call <b>01582841291</b> or <b>07940766377 (Out of Hours)</b> for any vehicle or fleet related queries. ${linkTag("tel:01582841291","Call 01582841291")} · ${linkTag("tel:07940766377","Call 07940766377")}`);
        if (q.includes("accident"))
          return endWith(`Please call <b>07940792355</b> for any accident reports, whether this be injuries or damage reports. ${linkTag("tel:07940792355","Call 07940792355")}`);
        if (q.includes("parking"))
          return endWith(`Please call <b>07940792355</b> for any parking queries. ${linkTag("tel:07940792355","Call 07940792355")}`);
        if (q.includes("recruitment"))
          return endWith(`Please call <b>02037583058</b> for recruitment. ${linkTag("tel:02037583058","Call 02037583058")}`);

        if (q.includes("btor ntf")) {
          flowCtx.stage = "btorNtfAreas";
          return { html: "Please select which area you are based", ...choice(["Wales & Midlands","London & SE","Wessex","North England & Scotland"]) };
        }
        if (q.includes("city fibre ntf")) {
          flowCtx.stage = "cfNtfAreas";
          return { html: "Please select which area you are based", ...choice(["Scotland","Midlands","South","North"]) };
        }
        return { html: "Department Contacts — choose one:", ...choice(rootChips) };
      }
      if (flowCtx.stage === "btorNtfAreas") {
        if (q.includes("wales") || q.includes("midlands"))
          return endWith('For NTF <b>Wales & Midlands</b>, please contact <b>07484034863</b> or <b>07483932673</b>.');
        if (q.includes("london") || q.includes("se"))
          return endWith('For NTF <b>London & SE</b>, please contact <b>07814089467</b> or <b>07814470466</b>.');
        if (q.includes("wessex"))
          return endWith('For NTF Support <b>Wessex</b>, please contact <b>07977670841</b> or <b>07483555754</b>.');
        if (q.includes("north england") || q.includes("scotland"))
          return endWith('For NTF Support <b>North England & Scotland</b>, please contact <b>07814089601</b> or <b>07484082993</b>.');
        return { html: "Please select which area you are based", ...choice(["Wales & Midlands","London & SE","Wessex","North England & Scotland"]) };
      }
      if (flowCtx.stage === "cfNtfAreas") {
        if (q.includes("scotland"))
          return endWith('For NTF Support in <b>Scotland</b>, please contact <b>07866950516</b> or <b>07773652734</b>.');
        if (q.includes("midlands"))
          return endWith('For NTF Support in <b>Midlands</b>, please contact <b>07773651968</b>.');
        if (q.includes("south"))
          return endWith('For NTF Support in <b>South</b>, please contact <b>07773651950</b>.');
        if (q.includes("north"))
          return endWith('For NTF Support in <b>North</b>, please contact <b>07773652146</b>, <b>07977330563</b> or <b>07773652702</b>.');
        return { html: "Please select which area you are based", ...choice(["Scotland","Midlands","South","North"]) };
      }
    }

    // CONTRACT CHANGE QUERIES
    if (flowCtx.type === "contractChange") {
      return endWith('For any contract change queries, please raise this to your <b>Area Manager</b>.');
    }

    // EQUIPMENT QUERY
    if (flowCtx.type === "equipment") {
      if (flowCtx.stage === "root") {
        if (q.includes("stock"))   { flowCtx.stage = "stockAsk";   return { html:'Have you submitted a <b>Stock Form</b> with your Field Manager?', ...choice(["Yes","No"]) }; }
        if (q.includes("tooling")) { flowCtx.stage = "toolingAsk"; return { html:'Has your Field Manager submitted an order through <b>ByBox</b>?', ...choice(["Yes","No"]) }; }
        if (q === "van" || q.includes("van")) {
          flowCtx.stage = "vanAsk";
          return { html:'Have you raised the query of receiving a van to your <b>Field Manager</b> and <b>Area Manager</b>?', ...choice(["Yes","No"]) };
        }
        return { html:'Is this regarding <b>Stock</b>, <b>Tooling</b> or a <b>Van</b>?', ...choice(["Stock","Tooling","Van"]) };
      }
      if (flowCtx.stage === "stockAsk") {
        if (isNo(q))  return endWith('Please contact your <b>Field Manager</b> and complete a <b>Stock Form</b>.');
        if (isYes(q)) return endWith('Please contact your <b>Field Manager</b> regarding the update of your stock. Any further concerns please contact Welfare directly on <b>02087583060</b> and hold the line.');
        return { html:'Have you submitted a <b>Stock Form</b> with your Field Manager?', ...choice(["Yes","No"]) };
      }
      if (flowCtx.stage === "toolingAsk") {
        if (isNo(q))  return endWith('Please contact your <b>Field Manager</b> and request them to submit an order to <b>ByBox</b>.');
        if (isYes(q)) return endWith('Please follow up with your <b>Field Manager</b> regarding your order. Any further concerns please contact Welfare directly on <b>02087583060</b> and hold the line.');
        return { html:'Has your Field Manager submitted an order through <b>ByBox</b>?', ...choice(["Yes","No"]) };
      }
      if (flowCtx.stage === "vanAsk") {
        if (isNo(q))  return endWith('Please contact your <b>Field Manager</b> and query this through.');
        if (isYes(q)) return endWith('If you have raised this to your <b>Field</b> and <b>Area Manager</b>, please contact Welfare directly on <b>02087583060</b> and hold the line.');
        return { html:'Have you raised the query of receiving a van to your <b>Field Manager</b> and <b>Area Manager</b>?', ...choice(["Yes","No"]) };
      }
    }

    // PAY / DEDUCTION QUERIES
    if (flowCtx.type === "pay") {
      if (flowCtx.stage === "start") {
        flowCtx.stage = "menu";
        const lines = [
          'For any <b>pay or deduction</b> queries please contact <b>02037583060</b> and <b>select option 1</b> — this will take you to the wage / deduction query process.',
          '<small>As stated in the Friday meeting on <b>13/02</b>, the ticket system will not be used for pay/deduction queries.</small>',
        ];
        const chips = ["Call now"];
        if ((SETTINGS.textSystemNumber ?? "").trim()) chips.push("Send via text");
        return { html: lines.join("<br>"), chips };
      }
      if (flowCtx.stage === "menu") {
        if (q.includes("call")) {
          const telHref = "tel:02037583060";
          return endWith(`Use this link to dial now: ${linkTag(telHref, "Call 02037583060 (option 1)")}`);
        }
        if (q.includes("text")) {
          if ((SETTINGS.textSystemNumber ?? "").trim()) {
            const smsHref = `sms:${encodeURIComponent(SETTINGS.textSystemNumber)}?body=${encodeURIComponent("Pay/Deduction query: ")}`;
            return endWith(`Open your messaging app here: ${linkTag(smsHref, "Send via text message")}`);
          }
          return endWith('A text message system can be enabled — please ask an administrator to set <code>SETTINGS.textSystemNumber</code>.');
        }
        const chips = ["Call now"];
        if ((SETTINGS.textSystemNumber ?? "").trim()) chips.push("Send via text");
        return { html: 'Choose an option:', chips };
      }
    }
    // If in a flow but not matched, each stage re-prompts above.
  }

  // Start-of-flow triggers (by clicking Topics or typing)
  if (q.includes("work allocation")) {
    flowCtx = { type: "workAllocation", stage: "askRaised" };
    return { html: 'Has this been raised with your <b>Field</b> and <b>Area Manager</b>?', ...choice(["Yes","No"]) };
  }
  if (q.includes("manager dispute") || q.includes("manager disputes") || q.includes("dispute")) {
    flowCtx = { type: "managerDispute", stage: "askFieldMgr" };
    return { html: 'Is this regarding your <b>Field Manager</b>?', ...choice(["Yes","No"]) };
  }
  if (q.includes("department contacts") || q.includes("contacts department") || q === "departments") {
    flowCtx = { type: "deptContacts", stage: "root" };
    return { html: "Department Contacts — choose one:", chips: [
      "Street Works","Smart Awards","Support Team","City Fibre Back Office","BTOR Allocations Team","Fleet","Accident Line","Parking Line","Recruitment","BTOR NTF Support","City Fibre NTF Support"
    ]};
  }
  if (q.includes("contract change")) {
    flowCtx = { type: "contractChange", stage: "start" };
    return endWith('For any contract change queries, please raise this to your <b>Area Manager</b>.');
  }
  if (q.includes("equipment query") || q === "equipment" || q.includes("equipment")) {
    flowCtx = { type: "equipment", stage: "root" };
    return { html: 'Is this regarding <b>Stock</b>, <b>Tooling</b> or a <b>Van</b>?', ...choice(["Stock","Tooling","Van"]) };
  }
  if (q.includes("street works")) {
    return endWith(`For any Street Work queries please contact ${linkTag("mailto:Street.Works@kelly.co.uk","Street.Works@kelly.co.uk")}.`);
  }
  if (q.includes("smart awards")) {
    return endWith(`For any Smart Award queries please contact ${linkTag("mailto:smartawards@kelly.co.uk","smartawards@kelly.co.uk")}.`);
  }
  if (q.includes("id cards") || q.includes("id card") || q.includes("idcards")) {
    return endWith(`If you have lost, not received or your ID card has expired, please contact ${linkTag("mailto:nuneaton.admin@kelly.co.uk","nuneaton.admin@kelly.co.uk")}.`);
  }
  if (q.includes("payroll") || q.includes("pay ") || q === "pay" || q.includes("deduction")) {
    flowCtx = { type: "pay", stage: "start" };
    return { html: "Let’s route your pay/deduction query.", chips: ["Continue"] };
  }
  if (q === "continue" && flowCtx?.type === "pay" && flowCtx.stage === "start") {
    flowCtx.stage = "menu";
    const chips = ["Call now"];
    if ((SETTINGS.textSystemNumber ?? "").trim()) chips.push("Send via text");
    return {
      html: [
        'For any <b>pay or deduction</b> queries please contact <b>02037583060</b> and <b>select option 1</b> — this will take you to the wage / deduction query process.',
        '<small>As stated in the Friday meeting on <b>13/02</b>, the ticket system will not be used for pay/deduction queries.</small>',
      ].join("<br>"),
      chips
    };
  }

  // ---------- existing special cases (kept) ----------
  if (q.includes("bank holiday") || q.includes("bank holidays")){
    return { html:"❌ <b>No we are not open on bank holidays.</b>", chips:["What are your opening times?","Is anyone available now?"] };
  }
  if (q.includes("is anyone available") || q.includes("available now") || q.includes("open now")){
    const open = isOpenNow();
    const nowUK = formatUKTime(new Date());
    if (open){
      return { html:`✅ <b>Yes we’re open right now.</b><br>Current UK time: <b>${escapeHTML(nowUK)}</b>`, chips:["How can I contact support?"] };
    }
    const bh = isBankHolidayToday();
    return { html:`❌ <b>No we’re closed right now.</b><br>Current UK time: <b>${escapeHTML(nowUK)}</b>${bh ? "<br><small>❌ <b>No — we are not open on bank holidays.</b></small>" : ""}`, chips:["What are your opening times?","How can I contact support?"] };
  }

  // Ticket start
  const wantsTicket =
    q.includes("raise a request") ||
    q.includes("create a ticket") ||
    q.includes("open a ticket") ||
    q.includes("log a ticket") ||
    q.includes("submit a request") ||
    q === "ticket";
  if (!ticketCtx && wantsTicket){
    ticketCtx = { stage:"needType" };
    return { html:"Sure — what do you need help with?", chips:["Access / Login","Pay / Payroll","General query","Something else"] };
  }
  if (ticketCtx){
    if (q==="cancel" || q==="stop" || q==="restart"){
      ticketCtx=null;
      return { html:"No problem, I’ve cancelled that request. If you want to start again, type <b>raise a request</b>." };
    }
    if (ticketCtx.stage==="needType"){ ticketCtx.type=text.trim(); ticketCtx.stage="needName"; return { html:"Thanks — what’s your name?" }; }
    if (ticketCtx.stage==="needName"){ ticketCtx.name=text.trim(); ticketCtx.stage="needEmail"; return { html:"And what email should we reply to?" }; }
    if (ticketCtx.stage==="needEmail"){
      const email=text.trim();
      if(!/^\S+@\S+\.\S+$/.test(email)) return { html:"That doesn’t look like an email, can you retype it?" };
      ticketCtx.email=email; ticketCtx.stage="needPhone"; return { html:"Thank you, what’s the best contact number for you?" };
    }
    if (ticketCtx.stage==="needPhone"){
      const phone=text.trim();
      if(!isValidPhone(phone)) return { html:"That number doesn’t look right, please enter a valid contact number (digits only is fine, or include +)." };
      ticketCtx.phone=phone; ticketCtx.stage="needDescription"; return { html:"Briefly describe the issue (1–3 sentences is perfect)." };
    }
    if (ticketCtx.stage==="needDescription"){ ticketCtx.description=text.trim(); ticketCtx.stage="needUrgency"; return { html:"How urgent is this?", chips:["Low","Normal","High"] }; }
    if (ticketCtx.stage==="needUrgency"){
      ticketCtx.urgency=text.trim();
      const transcript = buildTranscript(SETTINGS.ticketTranscriptMessages ?? 40);
      const subject = encodeURIComponent(`[Welfare Support] ${ticketCtx.type} (${ticketCtx.urgency})`);
      const body = encodeURIComponent(
        `Name: ${ticketCtx.name}\nEmail: ${ticketCtx.email}\nContact number: ${ticketCtx.phone}\nUrgency: ${ticketCtx.urgency}\nType: ${ticketCtx.type}\n\nDescription:\n${ticketCtx.description}\n\nChat transcript:\n${transcript}\n\n— Sent from Welfare Support chatbot`
      );
      const mailtoHref = `mailto:${SETTINGS.supportEmail}?subject=${subject}&body=${body}`;
      const html =
        `<b>Request summary</b><br>` +
        `Type: <b>${escapeHTML(ticketCtx.type)}</b><br>` +
        `Urgency: <b>${escapeHTML(ticketCtx.urgency)}</b><br>` +
        `Name: <b>${escapeHTML(ticketCtx.name)}</b><br>` +
        `Email: <b>${escapeHTML(ticketCtx.email)}</b><br>` +
        `Contact number: <b>${escapeHTML(ticketCtx.phone)}</b><br><br>` +
        `${linkTag(mailtoHref, "Email support with this request (includes transcript)")}` +
        `<br><small>(This opens your email app with the message prefilled, you then press Send.)</small>`;
      ticketCtx=null;
      return { html, chips:["Raise a request (create a ticket)"] };
    }
  }

  // Distance/depots special case
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
    return { html:`We’re based in <b>Nuneaton, UK</b>.<br>${linkTag(gmaps,"Open in Google Maps")}<br>${imgTag(tile)}` };
  }

  return null;
}

// ---------- main message handling
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

  addBubble("Try the Topics button, or ask: <b>raise a request</b>, <b>closest depot</b>, <b>opening times</b>.", "bot", { html:true });
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
  ticketCtx=null;
  distanceCtx=null;
  flowCtx=null;
  CHAT_LOG=[];
  init();
});

// drawer
function buildCategoryIndex(){
  categoryIndex=new Map();
  FAQS.forEach((item)=>{
    const key=(item.category ?? "general").toLowerCase();
    if(!categoryIndex.has(key)) categoryIndex.set(key, []);
    categoryIndex.get(key).push(item);
  });
  const labelMap={ general:"General", support:"Support", opening:"Opening times", actions:"Actions" /* topics auto-capitalize */ };
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
