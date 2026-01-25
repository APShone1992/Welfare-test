
/* Welfare Support Chatbot (Restored + Enhanced)
- Startup greeting only (no starter chips) [1](https://www.publicholidayguide.com/bank-holiday/england-wales-bank-holidays-2025/)
- Depot flow accepts city chips again when not using GPS [1](https://www.publicholidayguide.com/bank-holiday/england-wales-bank-holidays-2025/)
- Map preview FIXED: uses OpenStreetMap tile images instead of staticmap.openstreetmap.de
- No bank holiday year listing; policy only; bank holidays affect availability (substitute-day principle) [2](https://www.publicholidayguide.com/bank-holiday/uk-bank-holidays-2025/)
*/

const SETTINGS = {
  minConfidence: 0.20,
  topSuggestions: 3,
  boostSubstring: 0.12,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  suggestionLimit: 5,
  supportEmail: "support@Kelly.co.uk",
  supportPhone: "01234 567890",
  ticketTranscriptMessages: 12,
  ticketTranscriptMaxLine: 140,
  showUnderstoodLine: true,
  understoodLineThreshold: 0.18,
  voiceDefaultOn: false,
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, where we’re located, or how far you are from your closest depot."
};

let FAQS = [];
let faqsLoaded = false;
let categories = [];
let categoryIndex = new Map();

/* DOM */
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

/* UI State */
let isResponding = false;
let lastChipClickAt = 0;
let missCount = 0;
let activeSuggestionIndex = -1;
let currentSuggestions = [];

let distanceCtx = null;
let clarifyCtx = null;
let ticketCtx = null;
let journeyCtx = null;
let lastMissQueryNorm = null;
let CHAT_LOG = [];

/* Memory */
const MEMORY_KEY = "ws_chat_memory_v5";
const memory = { name: null, lastTopic: null, lastCity: null, preferredMode: null, voiceOn: null };
function loadMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") Object.assign(memory, obj);
  } catch (_) {}
}
function saveMemory() {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); } catch (_) {}
}
loadMemory();

/* Local learning */
const LEARN_KEY = "ws_choice_map_v1";
let LEARN_MAP = {};
function loadLearnMap() {
  try {
    const raw = localStorage.getItem(LEARN_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") LEARN_MAP = obj;
  } catch (_) {}
}
function saveLearnMap() {
  try { localStorage.setItem(LEARN_KEY, JSON.stringify(LEARN_MAP)); } catch (_) {}
}
loadLearnMap();
function rememberChoice(queryNorm, chosenQuestion) {
  if (!queryNorm || !chosenQuestion) return;
  const entry = LEARN_MAP[queryNorm] || { chosen: chosenQuestion, count: 0 };
  entry.chosen = chosenQuestion;
  entry.count = (entry.count || 0) + 1;
  LEARN_MAP[queryNorm] = entry;
  saveLearnMap();
}
function learnedChoiceFor(queryNorm) {
  const e = LEARN_MAP[queryNorm];
  if (!e || !e.chosen) return null;
  return e;
}

/* Normalisation */
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

const STOP_WORDS = new Set([
  "what","are","your","do","you","we","is","the","a","an","to","of","and",
  "in","on","for","with","please","can","i","me","my"
]);

function stem(token) {
  return token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
}
const tokenSet = (s) =>
  new Set(
    normalize(s)
      .split(" ")
      .map(stem)
      .filter((t) => t && !STOP_WORDS.has(t))
  );

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
};

/* bigram similarity */
function bigrams(str) {
  const s = normalize(str).replace(/\s+/g, " ");
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}
function diceCoefficient(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const map = new Map();
  for (const x of A) map.set(x, (map.get(x) || 0) + 1);
  let matches = 0;
  for (const y of B) {
    const c = map.get(y) || 0;
    if (c > 0) { matches++; map.set(y, c - 1); }
  }
  return (2 * matches) / (A.length + B.length);
}

/* Safe HTML */
function escapeHTML(s) {
  const str = String(s ?? "");
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function escapeAttrUrl(url) {
  return String(url ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function linkHTML(url, label) {
  return `<a href="${escapeAttrUrl(url)}">${escapeHTML(label)}</a>`;
}
function imgHTML(url, alt = "Map preview") {
  return `<img class="map-preview" src="${escapeAttrUrl(url)}" alt="${escapeHTML(alt)}" loading="lazy" />`;
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
      const safeImg = /^https:\/\//i.test(src);
      if (!safeImg) toReplace.push(el);
      else {
        if (!el.getAttribute("alt")) el.setAttribute("alt", "Map preview");
        el.setAttribute("loading", "lazy");
      }
    }
  }

  toReplace.forEach((node) => node.replaceWith(document.createTextNode(node.textContent ?? "")));
  return template.innerHTML;
}
function htmlToPlainText(html) {
  const template = document.createElement("template");
  template.innerHTML = html ?? "";
  return (template.content.textContent ?? "").replace(/\s+\n/g, "\n").trim();
}

/* UK time */
const UK_TZ = "Europe/London";
function formatUKTime(date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}
function formatUKDateLabel(dateObj) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, weekday: "long", day: "numeric", month: "short", year: "numeric" }).format(dateObj);
}
const UK_DAY_INDEX = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };
function getUKParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  });
  const parts = fmt.formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const weekdayShort = get("weekday");
  const dayIndex = UK_DAY_INDEX[weekdayShort] ?? 0;
  const year = parseInt(get("year") ?? "0", 10);
  const month = parseInt(get("month") ?? "1", 10);
  const day = parseInt(get("day") ?? "1", 10);
  const hour = parseInt(get("hour") ?? "0", 10);
  const minute = parseInt(get("minute") ?? "0", 10);
  const minutesNow = hour * 60 + minute;
  return { weekdayShort, dayIndex, year, month, day, hour, minute, minutesNow };
}

/* Business hours + bank holidays E&W */
const BUSINESS_HOURS = {
  openDays: new Set([1,2,3,4,5]),
  startMinutes: 8 * 60 + 30,
  endMinutes: 17 * 60
};
function toISODate(y, m, d) {
  return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
}
function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}
function dayOfWeekUTC(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }
function firstMondayOfMay(year) { for (let d=1; d<=7; d++) if (dayOfWeekUTC(year,5,d)===1) return d; return 1; }
function lastMondayOfMonth(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d=lastDay; d>=lastDay-6; d--) if (dayOfWeekUTC(year, month, d)===1) return d;
  return lastDay;
}
function newYearObserved(year) {
  const dow = dayOfWeekUTC(year,1,1);
  if (dow===6) return { m:1, d:3 };
  if (dow===0) return { m:1, d:2 };
  return { m:1, d:1 };
}
function christmasAndBoxingObserved(year) {
  const xmasDow = dayOfWeekUTC(year,12,25);
  const boxingDow = dayOfWeekUTC(year,12,26);
  if (xmasDow===6 || xmasDow===0) return { xmas:{m:12,d:27}, boxing:{m:12,d:28} };
  if (boxingDow===6 || boxingDow===0) return { xmas:{m:12,d:25}, boxing:{m:12,d:28} };
  return { xmas:{m:12,d:25}, boxing:{m:12,d:26} };
}
function bankHolidaysEWSet(year) {
  const set = new Set();
  const ny = newYearObserved(year);
  set.add(toISODate(year, ny.m, ny.d));

  const es = easterSunday(year);
  const easter = new Date(Date.UTC(year, es.month - 1, es.day));
  const goodFriday = new Date(easter.getTime() - 2 * 86400000);
  const easterMonday = new Date(easter.getTime() + 1 * 86400000);
  set.add(toISODate(goodFriday.getUTCFullYear(), goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()));
  set.add(toISODate(easterMonday.getUTCFullYear(), easterMonday.getUTCMonth() + 1, easterMonday.getUTCDate()));

  set.add(toISODate(year, 5, firstMondayOfMay(year)));
  set.add(toISODate(year, 5, lastMondayOfMonth(year, 5)));
  set.add(toISODate(year, 8, lastMondayOfMonth(year, 8)));

  const xb = christmasAndBoxingObserved(year);
  set.add(toISODate(year, xb.xmas.m, xb.xmas.d));
  set.add(toISODate(year, xb.boxing.m, xb.boxing.d));
  return set;
}
function isBankHolidayEW(dateObj = new Date()) {
  const uk = getUKParts(dateObj);
  const iso = toISODate(uk.year, uk.month, uk.day);
  return bankHolidaysEWSet(uk.year).has(iso);
}
function isOpenNowEW(dateObj = new Date()) {
  const uk = getUKParts(dateObj);
  const isWeekday = BUSINESS_HOURS.openDays.has(uk.dayIndex);
  const within = uk.minutesNow >= BUSINESS_HOURS.startMinutes && uk.minutesNow < BUSINESS_HOURS.endMinutes;
  if (!isWeekday || !within) return false;
  if (isBankHolidayEW(dateObj)) return false;
  return true;
}
function nextOpenDateTimeEW(from = new Date()) {
  const start = new Date(from.getTime());
  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const base = new Date(start.getTime() + dayOffset * 86400000);
    base.setHours(0,0,0,0);
    for (let i=0; i<24*60; i++) {
      const cand = new Date(base.getTime() + i*60000);
      const uk = getUKParts(cand);
      if (uk.minutesNow !== BUSINESS_HOURS.startMinutes) continue;
      if (!BUSINESS_HOURS.openDays.has(uk.dayIndex)) continue;
      if (isBankHolidayEW(cand)) continue;
      if (cand.getTime() <= from.getTime()) continue;
      return cand;
    }
  }
  return new Date(from.getTime() + 86400000);
}
function minsToHrsMins(mins) {
  const h = Math.floor(mins/60), m = mins%60;
  if (h<=0) return `${m} min`;
  if (m===0) return `${h} hr`;
  return `${h} hr ${m} min`;
}
function buildAvailabilityAnswerHTML() {
  const now = new Date();
  const uk = getUKParts(now);
  const nowUK = formatUKTime(now);

  if (isOpenNowEW(now)) {
    const minsLeft = BUSINESS_HOURS.endMinutes - uk.minutesNow;
    return `✅ <b>Yes — we’re open right now.</b><br>Current UK time: <b>${escapeHTML(nowUK)}</b><br>We close at <b>17:00</b> (in about <b>${escapeHTML(minsToHrsMins(minsLeft))}</b>).`;
  }

  const holidayNote = isBankHolidayEW(now)
    ? "<br><small>❌ <b>No — we are not open on bank holidays.</b></small>"
    : "";

  const nextOpen = nextOpenDateTimeEW(now);
  return `❌ <b>No — we’re closed right now.</b><br>Current UK time: <b>${escapeHTML(nowUK)}</b><br>Next opening time: <b>${escapeHTML(formatUKDateLabel(nextOpen))}</b> at <b>${escapeHTML(formatUKTime(nextOpen))}</b>.<br><small>Hours: Monday–Friday, 08:30–17:00 (UK time). Closed weekends & bank holidays.</small>${holidayNote}`;
}

/* Depots & places */
const DEPOTS = {
  nuneaton: { label: "Nuneaton Depot", lat: 52.5230, lon: -1.4652 }
};
const PLACES = {
  coventry: { lat: 52.4068, lon: -1.5197 },
  birmingham: { lat: 52.4895, lon: -1.8980 },
  leicester: { lat: 52.6369, lon: -1.1398 },
  london: { lat: 51.5074, lon: -0.1278 },
  wolverhampton: { lat: 52.5862, lon: -2.1286 }
};
function titleCase(s) { const t=(s??"").trim(); return t ? t.charAt(0).toUpperCase()+t.slice(1) : t; }
function toRad(deg){ return (deg*Math.PI)/180; }
function distanceMiles(a,b){
  const R=3958.8;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return R*(2*Math.asin(Math.sqrt(h)));
}
function estimateMinutes(miles, mode){
  const mphMap={ car:35, train:55, bus:20, walk:3 };
  const mph=mphMap[mode] ?? 35;
  return Math.round((miles/mph)*60);
}
function modeLabel(mode){
  const map={ car:"by car", train:"by train", bus:"by bus", walk:"walking" };
  return map[mode] ?? "by car";
}
function parseTravelMode(qNorm){
  if (qNorm.includes("train") || qNorm.includes("rail")) return "train";
  if (qNorm.includes("bus") || qNorm.includes("coach")) return "bus";
  if (qNorm.includes("walk") || qNorm.includes("walking")) return "walk";
  if (qNorm.includes("car") || qNorm.includes("drive") || qNorm.includes("driving")) return "car";
  return null;
}
function findPlaceKey(qNorm){
  for (const key in PLACES) if (Object.prototype.hasOwnProperty.call(PLACES, key) && qNorm.includes(key)) return key;
  return null;
}
function findClosestDepot(originLatLon){
  let bestKey=null, bestMiles=Infinity;
  for (const key in DEPOTS) {
    if (!Object.prototype.hasOwnProperty.call(DEPOTS,key)) continue;
    const miles=distanceMiles(originLatLon, DEPOTS[key]);
    if (miles<bestMiles){ bestMiles=miles; bestKey=key; }
  }
  return bestKey ? { depotKey: bestKey, miles: bestMiles } : null;
}
function googleDirectionsURL(originText, depot, mode){
  const origin=encodeURIComponent(originText);
  const dest=encodeURIComponent(`${depot.lat},${depot.lon}`);
  let travelmode="driving";
  if (mode==="walk") travelmode="walking";
  if (mode==="train" || mode==="bus") travelmode="transit";
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=${travelmode}`;
}
function googleMapsPlaceURL(lat, lon){ return `https://www.google.com/maps?q=${encodeURIComponent(lat+","+lon)}`; }

/* ✅ MAP PREVIEW FIX: use standard OSM tile */
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

/* Spelling correction (quiet) */
let VOCAB = new Set();
const PROTECTED_TOKENS = new Set(["walking","walk","by","car","train","bus","rail","coach","depot","depots","closest","payroll"]);
function shouldSkipToken(tok){
  if (!tok) return true;
  if (tok.length<=3) return true;
  if (/\d/.test(tok)) return true;
  if (tok.includes("@") || tok.includes(".")) return true;
  if (!/^[a-z-]+$/.test(tok)) return true;
  return false;
}
function levenshtein(a,b,maxDist){
  if (a===b) return 0;
  const al=a.length, bl=b.length;
  if (Math.abs(al-bl)>maxDist) return maxDist+1;
  const prev=new Array(bl+1), curr=new Array(bl+1);
  for (let j=0;j<=bl;j++) prev[j]=j;
  for (let i=1;i<=al;i++){
    curr[0]=i;
    let minInRow=curr[0];
    const ai=a.charCodeAt(i-1);
    for (let j=1;j<=bl;j++){
      const cost = ai===b.charCodeAt(j-1) ? 0 : 1;
      curr[j]=Math.min(prev[j]+1, curr[j-1]+1, prev[j-1]+cost);
      if (curr[j]<minInRow) minInRow=curr[j];
    }
    if (minInRow>maxDist) return maxDist+1;
    for (let j=0;j<=bl;j++) prev[j]=curr[j];
  }
  return prev[bl];
}
function bestVocabMatch(token){
  if (PROTECTED_TOKENS.has(token)) return null;
  if (shouldSkipToken(token)) return null;
  if (VOCAB.has(token)) return null;
  const maxDist = token.length<=7 ? 1 : 2;
  let best=null, bestDist=maxDist+1;
  for (const w of VOCAB){
    if (Math.abs(w.length-token.length)>maxDist) continue;
    const d=levenshtein(token,w,maxDist);
    if (d<bestDist){ bestDist=d; best=w; if (bestDist===1) break; }
  }
  return bestDist<=maxDist ? best : null;
}
function buildVocabFromFAQs(){
  const vocab=new Set();
  for (const item of FAQS){
    const fields=[ item.question, ...(item.synonyms??[]), ...(item.canonicalKeywords??[]), ...(item.tags??[]), item.category ];
    for (const f of fields){
      const toks=normalize(f).split(" ").filter(Boolean);
      for (const t of toks) if (!shouldSkipToken(t)) vocab.add(t);
    }
  }
  Object.keys(DEPOTS).forEach((k)=>normalize(k).split(" ").forEach((t)=>{ if(!shouldSkipToken(t)) vocab.add(t); }));
  Object.keys(PLACES).forEach((k)=>normalize(k).split(" ").forEach((t)=>{ if(!shouldSkipToken(t)) vocab.add(t); }));
  ["walking","walk","by","car","train","bus","rail","coach","depot","depots","closest","payroll"].forEach((w)=>vocab.add(w));
  VOCAB=vocab;
}
function correctQueryTokens(rawText){
  const norm=normalize(rawText);
  if (!norm) return { corrected: norm, changed: false };
  const tokens=norm.split(" ").filter(Boolean);
  let changed=false;
  const correctedTokens=tokens.map((t)=>{
    const fixed=bestVocabMatch(t);
    if (fixed){ changed=true; return fixed; }
    return t;
  });
  return { corrected: correctedTokens.join(" "), changed };
}
function rephraseQuery(text){
  let q=normalize(text);
  q=q.replace(/\bwhn\b/g,"when").replace(/\bur\b/g,"your").replace(/\bu\b/g,"you").replace(/\br\b/g,"are");
  q=q.replace(/\bis any( )?one available\b/g,"is anyone available now").replace(/\bopen right now\b/g,"open now");
  if (q.includes("how far") && q.includes("depot")) q="how far is my closest depot";
  return q.trim();
}
function meaningChangeScore(a,b){ return 1 - diceCoefficient(a,b); }

/* UI helpers */
function setUIEnabled(enabled){
  input.disabled=!enabled;
  sendBtn.disabled=!enabled;
  micBtn.disabled=!enabled;
  chatWindow.querySelectorAll(".chip-btn").forEach((b)=>b.disabled=!enabled);
}
function pushToTranscript(type, text, opts){
  const options=opts ?? {};
  const tsDate=options.ts ?? new Date();
  const ts=tsDate.getTime();
  const plain = options.html ? htmlToPlainText(text) : String(text ?? "").trim();
  const role = type==="bot" ? "Bot" : "User";
  if (plain) CHAT_LOG.push({ role, text: plain, ts });
  const keep = Math.max(SETTINGS.ticketTranscriptMessages ?? 12, 12) * 4;
  if (CHAT_LOG.length>keep) CHAT_LOG=CHAT_LOG.slice(-keep);
}
function buildTranscript(limit=12){
  const take=Math.max(1,limit);
  const slice=CHAT_LOG.slice(-take);
  const MAX_LINE=Math.max(40, SETTINGS.ticketTranscriptMaxLine ?? 140);
  return slice.map((m)=>{
    const time=formatUKTime(new Date(m.ts));
    const msg=(m.text ?? "").replace(/\s+/g," ").trim();
    const clipped = msg.length>MAX_LINE ? msg.slice(0,MAX_LINE-1)+"…" : msg;
    return `[${time}] ${m.role}: ${clipped}`;
  }).join("\n");
}

/* Voice output */
let voiceOn = (typeof memory.voiceOn === "boolean") ? memory.voiceOn : SETTINGS.voiceDefaultOn;
memory.voiceOn = voiceOn;
saveMemory();

function updateVoiceBtnUI(){
  voiceBtn.classList.toggle("on", !!voiceOn);
  voiceBtn.textContent = voiceOn ? "🔊" : "🔈";
  voiceBtn.setAttribute("aria-pressed", voiceOn ? "true" : "false");
}
function speakIfEnabled(text){
  if (!voiceOn) return;
  if (!("speechSynthesis" in window)) return;
  try{
    window.speechSynthesis.cancel();
    const u=new SpeechSynthesisUtterance(String(text ?? ""));
    u.lang="en-GB";
    window.speechSynthesis.speak(u);
  } catch(_){}
}
voiceBtn.addEventListener("click", ()=>{
  voiceOn=!voiceOn;
  memory.voiceOn=voiceOn;
  saveMemory();
  updateVoiceBtnUI();
  addBubble(voiceOn ? "Voice output is now <b>on</b>." : "Voice output is now <b>off</b>.", "bot", { html:true, speak:false });
});
updateVoiceBtnUI();

/* Voice input */
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let micListening = false;

function initSpeechRecognition(){
  if (!SpeechRecognition) return null;
  const rec=new SpeechRecognition();
  rec.lang="en-GB";
  rec.interimResults=false;
  rec.maxAlternatives=1;

  rec.onstart=()=>{
    micListening=true;
    micBtn.classList.add("on");
    micBtn.textContent="🎙️";
    micBtn.setAttribute("aria-pressed","true");
  };
  rec.onend=()=>{
    micListening=false;
    micBtn.classList.remove("on");
    micBtn.textContent="🎤";
    micBtn.setAttribute("aria-pressed","false");
  };
  rec.onerror=()=>{
    micListening=false;
    micBtn.classList.remove("on");
    micBtn.textContent="🎤";
    micBtn.setAttribute("aria-pressed","false");
    addBubble("Voice input isn’t available right now — you can still type your question.", "bot", { speak:false });
  };
  rec.onresult=(event)=>{
    const text=event.results?.[0]?.[0]?.transcript ?? "";
    if (text.trim()){
      input.value=text.trim();
      sendChat();
    }
  };
  return rec;
}
recognizer = initSpeechRecognition();
micBtn.addEventListener("click", ()=>{
  if (!recognizer){
    addBubble("Voice input isn’t supported in this browser. Try Chrome or Edge, or just type your question.", "bot", { speak:false });
    return;
  }
  if (micListening) { try{ recognizer.stop(); } catch(_){} }
  else { try{ recognizer.start(); } catch(_){} }
});

/* Bubbles */
function addBubble(text, type, opts){
  const options=opts ?? {};
  const html=!!options.html;
  const speak = options.speak !== false;
  const ts=options.ts ?? new Date();

  const row=document.createElement("div");
  row.className="msg " + type;

  const bubble=document.createElement("div");
  bubble.className="bubble " + type;
  bubble.setAttribute("role","article");
  bubble.setAttribute("aria-label", type==="bot" ? "Bot message" : "Your message");

  if (html) bubble.innerHTML = sanitizeHTML(text);
  else bubble.textContent = text;

  const time=document.createElement("div");
  time.className="timestamp";
  time.textContent=formatUKTime(ts);

  row.appendChild(bubble);
  row.appendChild(time);
  chatWindow.appendChild(row);
  chatWindow.scrollTop=chatWindow.scrollHeight;

  pushToTranscript(type, html ? sanitizeHTML(text) : text, { ts, html });

  if (type==="bot" && speak) speakIfEnabled(html ? htmlToPlainText(text) : text);
}
function addTyping(){
  const row=document.createElement("div");
  row.className="msg bot";
  row.dataset.typing="true";
  const bubble=document.createElement("div");
  bubble.className="bubble bot typing-bubble";
  bubble.innerHTML='Typing <span class="typing"><span></span><span></span><span></span></span>';
  row.appendChild(bubble);
  chatWindow.appendChild(row);
  chatWindow.scrollTop=chatWindow.scrollHeight;
}
function removeTyping(){
  const t=chatWindow.querySelector('[data-typing="true"]');
  if (t) t.remove();
}

/* Chips */
function addChips(questions, onClick){
  const qs=questions ?? [];
  if (!qs.length) return;
  const wrap=document.createElement("div");
  wrap.className="chips";
  qs.slice(0, SETTINGS.chipLimit).forEach((q)=>{
    const b=document.createElement("button");
    b.type="button";
    b.className="chip-btn";
    b.textContent=q;
    b.addEventListener("click", ()=>{
      const now=Date.now();
      if (isResponding) return;
      if (now-lastChipClickAt < SETTINGS.chipClickCooldownMs) return;
      lastChipClickAt=now;
      wrap.querySelectorAll(".chip-btn").forEach((btn)=>btn.disabled=true);
      if (typeof onClick==="function") onClick(q);
      else handleUserMessage(q);
      input.focus();
    });
    wrap.appendChild(b);
  });
  if (isResponding) wrap.querySelectorAll(".chip-btn").forEach((btn)=>btn.disabled=true);
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop=chatWindow.scrollHeight;
}

/* Drawer */
function buildCategoryIndex(){
  categoryIndex=new Map();
  FAQS.forEach((item)=>{
    const key=(item.category ?? "general").toLowerCase();
    if (!categoryIndex.has(key)) categoryIndex.set(key, []);
    categoryIndex.get(key).push(item);
  });
  const labelMap={ general:"General", support:"Support", location:"Location", opening:"Opening times", actions:"Actions" };
  categories=Array.from(categoryIndex.keys()).sort().map((key)=>({
    key, label: labelMap[key] ?? (key.charAt(0).toUpperCase()+key.slice(1)), count: categoryIndex.get(key).length
  }));
}
function openDrawer(){ overlay.hidden=false; drawer.hidden=false; drawer.setAttribute("aria-hidden","false"); drawerCloseBtn?.focus(); }
function closeDrawer(){ overlay.hidden=true; drawer.hidden=true; drawer.setAttribute("aria-hidden","true"); topicsBtn?.focus(); }
function renderDrawer(selectedKey){
  const selected=selectedKey ?? null;
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
    const q=document.createElement("button");
    q.type="button";
    q.className="drawer-q";
    q.textContent=item.question;
    q.addEventListener("click", ()=>{
      closeDrawer();
      handleUserMessage(item.question);
    });
    drawerQuestionsEl.appendChild(q);
  });
}
function bindClose(el){
  if (!el) return;
  el.addEventListener("click",(e)=>{ e.preventDefault(); closeDrawer(); });
  el.addEventListener("touchstart",(e)=>{ e.preventDefault(); closeDrawer(); }, { passive:false });
}
topicsBtn?.addEventListener("click", ()=>{ if (faqsLoaded) openDrawer(); });
drawer?.addEventListener("click",(e)=>e.stopPropagation());
drawer?.addEventListener("touchstart",(e)=>e.stopPropagation(), { passive:true });
bindClose(drawerCloseBtn);
bindClose(overlay);
document.addEventListener("keydown",(e)=>{ if (!drawer.hidden && e.key==="Escape") closeDrawer(); });

/* Suggestions */
function showSuggestions(items){
  currentSuggestions=items;
  activeSuggestionIndex=-1;
  if (!items.length){
    suggestionsEl.hidden=true;
    suggestionsEl.innerHTML="";
    return;
  }
  suggestionsEl.innerHTML="";
  items.forEach((it, idx)=>{
    const div=document.createElement("div");
    div.className="suggestion-item";
    div.setAttribute("role","option");
    div.setAttribute("aria-selected","false");
    div.tabIndex=-1;
    div.innerHTML=`${escapeHTML(it.question)}<small>${escapeHTML(it.categoryLabel)}</small>`;
    div.addEventListener("mousedown",(ev)=>{ ev.preventDefault(); pickSuggestion(idx); });
    div.addEventListener("touchstart",(ev)=>{ ev.preventDefault(); pickSuggestion(idx); }, { passive:false });
    suggestionsEl.appendChild(div);
  });
  suggestionsEl.hidden=false;
}
function updateSuggestionSelection(){
  const nodes=suggestionsEl.querySelectorAll(".suggestion-item");
  nodes.forEach((n,i)=>n.setAttribute("aria-selected", String(i===activeSuggestionIndex)));
}
function pickSuggestion(index){
  const picked=currentSuggestions[index];
  if (!picked) return;
  suggestionsEl.hidden=true;
  suggestionsEl.innerHTML="";
  currentSuggestions=[];
  activeSuggestionIndex=-1;
  handleUserMessage(picked.question);
}
function computeSuggestions(query){
  let q=normalize(query);
  if (!q || q.length<2) return [];
  const corr=correctQueryTokens(query);
  if (corr.changed && corr.corrected) q=corr.corrected;

  const qTokens=tokenSet(q);
  const labelMap=new Map(categories.map((c)=>[c.key, c.label]));

  const scored=FAQS.map((item)=>{
    const question=item.question ?? "";
    const syns=item.synonyms ?? [];
    const keys=item.canonicalKeywords ?? [];
    const tags=item.tags ?? [];

    const scoreJ=Math.max(
      jaccard(qTokens, tokenSet(question)),
      syns.length ? Math.max(...syns.map((s)=>jaccard(qTokens, tokenSet(s)))) : 0,
      keys.length ? Math.max(...keys.map((k)=>jaccard(qTokens, tokenSet(k)))) : 0,
      tags.length ? Math.max(...tags.map((t)=>jaccard(qTokens, tokenSet(t)))) : 0
    );
    const scoreB=Math.max(
      diceCoefficient(q, question),
      syns.length ? Math.max(...syns.map((s)=>diceCoefficient(q, s))) : 0
    );

    const anyField=[question, ...syns, ...keys, ...tags].map(normalize).join(" ");
    const boost = anyField.includes(q) ? SETTINGS.boostSubstring : 0;

    const learned=learnedChoiceFor(q);
    const learnedBoost = learned && learned.chosen === question ? Math.min(0.18, 0.06 + 0.02 * Math.min(6, learned.count || 1)) : 0;

    const score = 0.62*scoreJ + 0.30*scoreB + boost + learnedBoost;
    return { item, score };
  })
  .sort((a,b)=>b.score-a.score)
  .slice(0, SETTINGS.suggestionLimit)
  .filter((x)=>x.score>0);

  return scored.map((s)=>({
    question: s.item.question,
    categoryLabel: labelMap.get((s.item.category ?? "general").toLowerCase()) ?? "General"
  }));
}
input.addEventListener("input", ()=>{ if (!faqsLoaded) return; showSuggestions(computeSuggestions(input.value)); });
input.addEventListener("blur", ()=>{ setTimeout(()=>{ suggestionsEl.hidden=true; }, 120); });
input.addEventListener("keydown",(e)=>{
  if (suggestionsEl.hidden){
    if (e.key==="Enter"){ e.preventDefault(); sendChat(); }
    return;
  }
  if (e.key==="ArrowDown"){
    e.preventDefault();
    activeSuggestionIndex=Math.min(activeSuggestionIndex+1, currentSuggestions.length-1);
    updateSuggestionSelection();
  } else if (e.key==="ArrowUp"){
    e.preventDefault();
    activeSuggestionIndex=Math.max(activeSuggestionIndex-1, 0);
    updateSuggestionSelection();
  } else if (e.key==="Enter"){
    e.preventDefault();
    if (activeSuggestionIndex>=0) pickSuggestion(activeSuggestionIndex);
    else sendChat();
  } else if (e.key==="Escape"){
    suggestionsEl.hidden=true;
  }
});

/* Tone */
function analyzeTone(userText){
  const q=normalize(userText);
  return {
    greeting: /\b(hi|hello|hey|morning|afternoon|evening)\b/.test(q),
    thanks: /\b(thank|thanks|cheers)\b/.test(q),
    frustrated: /\b(angry|annoyed|upset|ridiculous|useless|hate|not working|broken)\b/.test(q),
    urgent: /\b(urgent|asap|immediately|right now|now)\b/.test(q)
  };
}
function tonePrefix(t){
  if (t.frustrated) return "I’m sorry about that — ";
  if (t.urgent) return "Got it — ";
  if (t.greeting) return "Hello! ";
  if (t.thanks) return "You’re welcome — ";
  return "";
}

/* FAQ match */
function matchFAQ(query){
  const qNorm=normalize(query);
  const qTokens=tokenSet(qNorm);

  const scored=FAQS.map((item)=>{
    const question=item.question ?? "";
    const syns=item.synonyms ?? [];
    const keys=item.canonicalKeywords ?? [];
    const tags=item.tags ?? [];

    const scoreQ=jaccard(qTokens, tokenSet(question));
    const scoreSyn=syns.length ? Math.max(...syns.map((s)=>jaccard(qTokens, tokenSet(s)))) : 0;
    const scoreKeys=keys.length ? Math.max(...keys.map((k)=>jaccard(qTokens, tokenSet(k)))) : 0;
    const scoreTags=tags.length ? Math.max(...tags.map((t)=>jaccard(qTokens, tokenSet(t)))) : 0;

    const bigramQ=diceCoefficient(qNorm, question);
    const bigramSyn=syns.length ? Math.max(...syns.map((s)=>diceCoefficient(qNorm, s))) : 0;

    const anyField=[question, ...syns, ...keys, ...tags].map(normalize).join(" ");
    const boost=anyField.includes(qNorm) ? SETTINGS.boostSubstring : 0;

    const learned=learnedChoiceFor(qNorm);
    const learnedBoost = learned && learned.chosen===question ? Math.min(0.22, 0.08 + 0.02*Math.min(7, learned.count || 1)) : 0;

    const score=(0.52*scoreQ + 0.22*scoreSyn + 0.10*scoreKeys + 0.06*scoreTags) + (0.10*bigramQ + 0.08*bigramSyn) + boost + learnedBoost;
    return { item, score };
  }).sort((a,b)=>b.score-a.score);

  const top=scored[0];
  if (!top || top.score<SETTINGS.minConfidence){
    return { matched:false, suggestions: scored.slice(0, SETTINGS.topSuggestions).map((r)=>r.item.question) };
  }
  return { matched:true, item: top.item, answerHTML: top.item.answer, followUps: top.item.followUps ?? [] };
}

/* Geolocation */
function requestBrowserLocation(){
  return new Promise((resolve, reject)=>{
    if (!navigator.geolocation){ reject(new Error("Geolocation not supported")); return; }
    navigator.geolocation.getCurrentPosition(
      (pos)=>resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err)=>reject(err),
      { enableHighAccuracy:false, timeout:8000, maximumAge:120000 }
    );
  });
}

/* Validation */
function isValidPhone(raw){
  const digits=String(raw ?? "").replace(/[^\d]/g,"");
  return digits.length>=8 && digits.length<=16;
}

/* Special cases */
function specialCases(query, tone){
  const corr=correctQueryTokens(query);
  const canon=rephraseQuery(corr.changed && corr.corrected ? corr.corrected : query);
  const q = normalize(canon);

  // bank holiday policy (no lists)
  if (q.includes("bank holiday") || q.includes("bank holidays")) {
    return {
      matched:true,
      answerHTML: `${tonePrefix(tone)}❌ <b>No — we are not open on bank holidays.</b><br><small>We’re open Monday–Friday, 08:30–17:00 (UK time), and closed on weekends & bank holidays.</small>`,
      chips: ["What are your opening times?", "Is anyone available now?", "How can I contact support?"]
    };
  }

  // availability now
  const availabilityTriggers = ["is anyone available","anyone available","available now","are you available","open now","are you open now","can i speak to someone","speak to someone now"];
  if (availabilityTriggers.some((t)=>q.includes(t))) {
    return { matched:true, answerHTML: tonePrefix(tone) + buildAvailabilityAnswerHTML(), chips:["What are your opening times?","How can I contact support?"] };
  }

  // location map
  if (q.includes("where are you") || q.includes("location") || q.includes("address")) {
    const depot = DEPOTS.nuneaton;
    const gmaps = googleMapsPlaceURL(depot.lat, depot.lon);
    const tile = osmTileURL(depot.lat, depot.lon, 13);
    return {
      matched:true,
      answerHTML:
        `We’re based in <b>Nuneaton, UK</b>. Visits are by appointment only.<br>` +
        `${linkHTML(gmaps, "Open in Google Maps")}<br>` +
        `${imgHTML(tile, "Map tile preview (OpenStreetMap)")}`,
      chips:["Is there parking?","How can I contact support?"]
    };
  }

  // parking
  if (q.includes("parking") || q.includes("car park")) {
    return { matched:true, answerHTML: "Yes — we have <b>visitor parking</b>. Spaces can be limited during busy times." };
  }

  // depot: if waiting for origin, accept GPS or city (RESTORED)
  if (distanceCtx && distanceCtx.stage === "needOrigin") {
    if (q === "use my location" || q === "my location") {
      return { matched:true, answerHTML: "Okay — please allow location access in your browser. One moment…", doGeo:true };
    }
    const cityKey = findPlaceKey(q) || (PLACES[q] ? q : null);
    if (cityKey && PLACES[cityKey]) {
      const closest = findClosestDepot(PLACES[cityKey]);
      if (!closest) return { matched:true, answerHTML: "I couldn’t find a depot for that location yet. Try another town/city." };
      const depot = DEPOTS[closest.depotKey];
      distanceCtx = { stage:"haveClosest", originKey: cityKey, depotKey: closest.depotKey, miles: closest.miles };
      return {
        matched:true,
        answerHTML:
          `Thanks — your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
          `From <b>${escapeHTML(titleCase(cityKey))}</b> it’s approximately <b>${Math.round(closest.miles)} miles</b>.<br>` +
          `How are you travelling?`,
        chips:["By car","By train","By bus","Walking"]
      };
    }
  }

  // depot trigger
  if (q.includes("how far") || q.includes("distance") || q.includes("closest depot") || (q.includes("depot") && q.includes("closest"))) {
    const originKey = findPlaceKey(q);
    if (!originKey) {
      distanceCtx = { stage:"needOrigin" };
      return {
        matched:true,
        answerHTML: "Certainly — what town/city are you travelling from? (Or choose <b>Use my location</b>.)",
        chips:["Use my location","Coventry","Birmingham","Leicester","London"]
      };
    }
    const closest = findClosestDepot(PLACES[originKey]);
    if (!closest) return { matched:true, answerHTML: "I can do that once I know your starting town/city. Where are you travelling from?" };
    const depot = DEPOTS[closest.depotKey];
    distanceCtx = { stage:"haveClosest", originKey, depotKey: closest.depotKey, miles: closest.miles };

    const mode = parseTravelMode(q) || memory.preferredMode;
    if (mode) {
      const minutes = estimateMinutes(closest.miles, mode);
      const url = googleDirectionsURL(titleCase(originKey), depot, mode);
      const tile = osmTileURL(depot.lat, depot.lon, 13);
      return {
        matched:true,
        answerHTML:
          `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
          `From <b>${escapeHTML(titleCase(originKey))}</b> it’s approximately <b>${Math.round(closest.miles)} miles</b>.<br>` +
          `Estimated time ${escapeHTML(modeLabel(mode))} is around <b>${minutes} minutes</b>.<br>` +
          `${linkHTML(url, "Get directions in Google Maps")}<br>` +
          `${imgHTML(tile, "Map tile preview (OpenStreetMap)")}`,
        chips:["By car","By train","By bus","Walking"]
      };
    }

    return {
      matched:true,
      answerHTML:
        `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
        `From <b>${escapeHTML(titleCase(originKey))}</b> it’s approximately <b>${Math.round(closest.miles)} miles</b>.<br>` +
        `How are you travelling?`,
      chips:["By car","By train","By bus","Walking"]
    };
  }

  // depot: mode selection after closest
  if (distanceCtx && distanceCtx.stage === "haveClosest") {
    if (q === "by car" || q === "by train" || q === "by bus" || q === "walking") {
      const mode = (q==="walking") ? "walk" : q.replace("by ","");
      memory.preferredMode = mode;
      saveMemory();

      const depot = DEPOTS[distanceCtx.depotKey];
      const minutes = estimateMinutes(distanceCtx.miles, mode);
      const originLabel = distanceCtx.originKey ? titleCase(distanceCtx.originKey) : "your location";
      const url = googleDirectionsURL(originLabel, depot, mode);
      const tile = osmTileURL(depot.lat, depot.lon, 13);

      return {
        matched:true,
        answerHTML:
          `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
          `From <b>${escapeHTML(originLabel)}</b> it’s approximately <b>${Math.round(distanceCtx.miles)} miles</b>.<br>` +
          `Estimated time ${escapeHTML(modeLabel(mode))} is around <b>${minutes} minutes</b>.<br>` +
          `${linkHTML(url, "Get directions in Google Maps")}<br>` +
          `${imgHTML(tile, "Map tile preview (OpenStreetMap)")}`,
        chips:["By car","By train","By bus","Walking"]
      };
    }
  }

  return null;
}

/* Main handler */
function handleUserMessage(text){
  if (!text) return;

  suggestionsEl.hidden=true;
  suggestionsEl.innerHTML="";
  currentSuggestions=[];
  activeSuggestionIndex=-1;

  const tone = analyzeTone(text);

  addBubble(text, "user", { ts:new Date(), speak:false });
  input.value="";

  isResponding=true;
  setUIEnabled(false);
  addTyping();

  setTimeout(async ()=>{
    removeTyping();

    if (!faqsLoaded){
      addBubble("Loading knowledge base… please try again in a second.", "bot", { speak:false });
      isResponding=false;
      setUIEnabled(true);
      input.focus();
      return;
    }

    const corr=correctQueryTokens(text);
    const canon=rephraseQuery(corr.changed && corr.corrected ? corr.corrected : text);
    const change = meaningChangeScore(normalize(text), normalize(canon));
    const showUnderstood = SETTINGS.showUnderstoodLine && canon && change >= SETTINGS.understoodLineThreshold;

    const special = specialCases(text, tone);
    if (special && special.matched){
      if (showUnderstood) addBubble(`<small>I understood: <b>${escapeHTML(canon)}</b></small>`, "bot", { html:true, speak:false });

      addBubble(special.answerHTML, "bot", { html:true });

      if (special.chips && special.chips.length) addChips(special.chips);

      if (special.doGeo){
        try{
          const loc = await requestBrowserLocation();
          const closest = findClosestDepot({ lat: loc.lat, lon: loc.lon });
          if (!closest){
            addBubble("I couldn’t find a nearby depot from your location yet. Try a town/city instead.", "bot");
          } else {
            const depot = DEPOTS[closest.depotKey];
            distanceCtx = { stage:"haveClosest", originKey:"your location", depotKey: closest.depotKey, miles: closest.miles };

            const mode = memory.preferredMode || "car";
            const minutes = estimateMinutes(closest.miles, mode);
            const url = googleDirectionsURL("your location", depot, mode);
            const tile = osmTileURL(depot.lat, depot.lon, 13);

            addBubble(
              `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
              `Distance is approximately <b>${Math.round(closest.miles)} miles</b>.<br>` +
              `Estimated time ${escapeHTML(modeLabel(mode))} is around <b>${minutes} minutes</b>.<br>` +
              `${linkHTML(url, "Get directions in Google Maps")}<br>` +
              `${imgHTML(tile, "Map tile preview (OpenStreetMap)")}`,
              "bot",
              { html:true }
            );

            addChips(["By car","By train","By bus","Walking"]);
          }
        } catch(_){
          addBubble("I couldn’t access your location. You can type a town/city instead (e.g., Coventry).", "bot");
          addChips(["Coventry","Birmingham","Leicester","London"]);
        }
      }

      missCount=0;
      isResponding=false;
      setUIEnabled(true);
      input.focus();
      return;
    }

    // normal FAQ match
    let res = matchFAQ(canon);
    if (!res.matched && canon !== text){
      const res2 = matchFAQ(text);
      if (res2.matched || (res2.suggestions?.length ?? 0) > (res.suggestions?.length ?? 0)) res = res2;
    }

    if (res.matched){
      if (showUnderstood) addBubble(`<small>I understood: <b>${escapeHTML(canon)}</b></small>`, "bot", { html:true, speak:false });

      addBubble(tonePrefix(tone) + res.answerHTML, "bot", { html:true });

      if (res.followUps && res.followUps.length){
        addBubble("You can also ask:", "bot", { speak:false });
        addChips(res.followUps);
      }

      missCount=0;
      clarifyCtx=null;
      lastMissQueryNorm=null;
    } else {
      missCount++;
      lastMissQueryNorm = normalize(canon || text);

      addBubble(tonePrefix(tone) + "I’m not sure. Did you mean:", "bot", { speak:false });

      addChips(res.suggestions ?? [], (pickedQuestion)=>{
        if (lastMissQueryNorm) rememberChoice(lastMissQueryNorm, pickedQuestion);
        handleUserMessage(pickedQuestion);
      });

      if (missCount >= 2){
        const mail = `mailto:${SETTINGS.supportEmail}`;
        const tel = `tel:${SETTINGS.supportPhone.replace(/\s+/g,"")}`;
        addBubble(
          `If you’d like, you can email ${linkHTML(mail, SETTINGS.supportEmail)} or call <b>${linkHTML(tel, SETTINGS.supportPhone)}</b>.`,
          "bot",
          { html:true, speak:false }
        );
        missCount=0;
        lastMissQueryNorm=null;
      }
    }

    isResponding=false;
    setUIEnabled(true);
    input.focus();
  }, 280);
}

function sendChat(){
  if (isResponding) return;
  const text=input.value.trim();
  if (!text) return;
  handleUserMessage(text);
}
sendBtn.addEventListener("click", sendChat);

clearBtn.addEventListener("click", ()=>{
  chatWindow.innerHTML="";
  missCount=0;
  distanceCtx=null;
  clarifyCtx=null;
  ticketCtx=null;
  journeyCtx=null;
  lastMissQueryNorm=null;
  CHAT_LOG=[];
  init();
  input.focus();
});

/* Load FAQs */
fetch("./public/config/faqs.json")
  .then((res)=>res.json())
  .then((data)=>{
    FAQS=Array.isArray(data) ? data : [];
    faqsLoaded=true;
    buildCategoryIndex();
    buildVocabFromFAQs();
    renderDrawer();
  })
  .catch(()=>{
    FAQS=[];
    faqsLoaded=true;
    buildCategoryIndex();
    buildVocabFromFAQs();
    renderDrawer();
  });

/* INIT (greeting only) [1](https://www.publicholidayguide.com/bank-holiday/england-wales-bank-holidays-2025/) */
function init(){
  addBubble(SETTINGS.greeting, "bot", { html:true, speak:false, ts:new Date() });
}

if (document.readyState === "loading"){
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
