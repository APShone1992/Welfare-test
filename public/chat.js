
/* ---------------------------------------------------------------
 Welfare Support – Static FAQ Chatbot (Upgraded)
 Adds:
 1) Human tone adaptation
 2) Context memory (session + localStorage)
 4) Bank holiday engine for any year (no APIs) + substitute days
 8) Embedded static map preview (OpenStreetMap static map)
 10) Auto-fix typos + rephrase "I understood"
 11) Improved matching (token + bigram similarity)
 12) Voice input (SpeechRecognition) + voice output (SpeechSynthesis)
---------------------------------------------------------------- */

const SETTINGS = {
  minConfidence: 0.20,
  topSuggestions: 3,
  boostSubstring: 0.12,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  suggestionLimit: 5,

  supportEmail: "support@Kelly.co.uk",
  supportPhone: "01234 567890",

  // mailto transcript limits
  ticketTranscriptMessages: 12,
  ticketTranscriptMaxLine: 140,

  // UX
  showUnderstoodLine: true,     // show “I understood: …” when we corrected/rephrased
  understoodLineThreshold: 0.18, // only show if meaning changed enough
  voiceDefaultOn: false,

  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, where we’re located, or how far you are from your closest depot."
};

let FAQS = [];
let faqsLoaded = false;
let categories = [];
let categoryIndex = new Map();

/* -----------------------------
   DOM
----------------------------- */
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
const statusBadge = document.getElementById("statusBadge");

/* -----------------------------
   UI State
----------------------------- */
let isResponding = false;
let lastChipClickAt = 0;
let missCount = 0;

let activeSuggestionIndex = -1;
let currentSuggestions = [];

let distanceCtx = null;
let clarifyCtx = null;
let ticketCtx = null;

let CHAT_LOG = []; // { role: "User"|"Bot", text, ts }

/* ===============================================================
   2) Context memory (persisted)
================================================================ */
const MEMORY_KEY = "ws_chat_memory_v1";
const memory = {
  name: null,
  lastTopic: null,
  lastCity: null,
  preferredMode: null,
  voiceOn: null // boolean
};

function loadMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") {
      Object.assign(memory, obj);
    }
  } catch (_) {}
}

function saveMemory() {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch (_) {}
}

loadMemory();

/* ===============================================================
   Helpers: normalization + tokens
================================================================ */
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

/* ===============================================================
   11) Mini "AI search": bigram similarity
================================================================ */
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
    if (c > 0) {
      matches++;
      map.set(y, c - 1);
    }
  }
  return (2 * matches) / (A.length + B.length);
}

/* ===============================================================
   HTML escaping + sanitization (safe)
================================================================ */
function escapeHTML(s) {
  const str = String(s ?? "");
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttrUrl(url) {
  // only used for attributes we control
  return String(url ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;

  // ✅ allow IMG for map previews (restricted)
  const allowedTags = new Set(["B","STRONG","I","EM","BR","A","SMALL","IMG"]);

  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toReplace = [];

  while (walker.nextNode()) {
    const el = walker.currentNode;

    if (!allowedTags.has(el.tagName)) {
      toReplace.push(el);
      continue;
    }

    // remove unsafe attributes
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();

      if (el.tagName === "A" && (name === "href" || name === "target" || name === "rel")) return;

      if (el.tagName === "IMG" && (name === "src" || name === "alt" || name === "class" || name === "loading")) return;

      el.removeAttribute(attr.name);
    });

    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      const safe = /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
      if (!safe) el.removeAttribute("href");
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }

    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") ?? "";
      // allow only https images (prevents script/data injection)
      const safeImg = /^https:\/\//i.test(src);
      if (!safeImg) {
        // replace unsafe image with its alt text
        toReplace.push(el);
      } else {
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

/* ===============================================================
   UK Time helpers
================================================================ */
const UK_TZ = "Europe/London";

function formatUKTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function formatUKDateLabel(dateObj) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric"
  }).format(dateObj);
}

const UK_DAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

function getUKParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
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

/* ===============================================================
   4) Bank holiday engine (England & Wales, no APIs)
   Standard bank holidays + substitute days per GOV.UK guidance. [2](https://www.publicholidayguide.com/bank-holiday/uk-bank-holidays-2025/)
   Also supports one-off overrides if ever needed.
================================================================ */
const BUSINESS_HOURS = {
  openDays: new Set([1,2,3,4,5]),     // Mon-Fri
  startMinutes: 8 * 60 + 30,         // 08:30
  endMinutes: 17 * 60                // 17:00
};

// optional overrides (rare one-offs) - format: "YYYY-MM-DD"
const BANK_HOLIDAY_OVERRIDES_ADD = new Set([
  // Example: "2023-05-08" (Coronation holiday) if you ever need it
]);
const BANK_HOLIDAY_OVERRIDES_REMOVE = new Set([
  // Example: remove if not observed
]);

function toISODate(y, m, d) {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

// Gregorian computus (Anonymous algorithm) - Easter Sunday
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=Mar, 4=Apr
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

function dayOfWeek(y, m, d) {
  // Zeller-like; return 0=Sunday..6=Saturday for Gregorian calendar
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCDay();
}

function firstMondayOfMay(year) {
  // May = 5
  for (let d = 1; d <= 7; d++) {
    if (dayOfWeek(year, 5, d) === 1) return d; // Monday
  }
  return 1;
}

function lastMondayOfMonth(year, month) {
  // find last day of month
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-based
  for (let d = lastDay; d >= lastDay - 6; d--) {
    if (dayOfWeek(year, month, d) === 1) return d; // Monday
  }
  return lastDay;
}

function christmasSubstituteDays(year) {
  // Returns { christmasObserved: {m,d}, boxingObserved: {m,d} } for E&W
  // If Christmas/Boxing fall on weekend, substitute days apply. [2](https://www.publicholidayguide.com/bank-holiday/uk-bank-holidays-2025/)
  const xmasDow = dayOfWeek(year, 12, 25); // 0 Sun .. 6 Sat
  const boxingDow = dayOfWeek(year, 12, 26);

  let christmasObserved = { m: 12, d: 25 };
  let boxingObserved = { m: 12, d: 26 };

  // If 25th is Saturday -> observed Monday 27th; Boxing observed Tuesday 28th
  if (xmasDow === 6) {
    christmasObserved = { m: 12, d: 27 };
    boxingObserved = { m: 12, d: 28 };
    return { christmasObserved, boxingObserved };
  }

  // If 25th is Sunday -> observed Tuesday 27th? Actually Monday 26th becomes Christmas substitute, Tuesday 27th becomes Boxing substitute.
  if (xmasDow === 0) {
    christmasObserved = { m: 12, d: 27 };
    boxingObserved = { m: 12, d: 28 };
    return { christmasObserved, boxingObserved };
  }

  // If Boxing Day is Sunday -> observed Tuesday 28th (because Monday 27th may be Christmas substitute if 25th was Sat)
  if (boxingDow === 0) {
    boxingObserved = { m: 12, d: 28 };
  }

  // If Boxing Day is Saturday -> observed Monday 28th? Actually if 26th is Sat, observed Monday 28th (since 27th Sunday).
  if (boxingDow === 6) {
    boxingObserved = { m: 12, d: 28 };
  }

  return { christmasObserved, boxingObserved };
}

function newYearObserved(year) {
  // If Jan 1 is Saturday -> observed Monday Jan 3
  // If Jan 1 is Sunday -> observed Monday Jan 2
  const dow = dayOfWeek(year, 1, 1);
  if (dow === 6) return { m: 1, d: 3 };
  if (dow === 0) return { m: 1, d: 2 };
  return { m: 1, d: 1 };
}

function bankHolidaysEnglandWales(year) {
  const set = new Set();

  // New Year
  const ny = newYearObserved(year);
  set.add(toISODate(year, ny.m, ny.d));

  // Easter-related
  const es = easterSunday(year);
  // Good Friday = Easter Sunday - 2 days, Easter Monday = +1 day
  const easterDate = new Date(Date.UTC(year, es.month - 1, es.day));
  const goodFriday = new Date(easterDate.getTime() - 2 * 86400000);
  const easterMonday = new Date(easterDate.getTime() + 1 * 86400000);
  set.add(toISODate(goodFriday.getUTCFullYear(), goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()));
  set.add(toISODate(easterMonday.getUTCFullYear(), easterMonday.getUTCMonth() + 1, easterMonday.getUTCDate()));

  // Early May (first Monday of May)
  set.add(toISODate(year, 5, firstMondayOfMay(year)));

  // Spring (last Monday of May)
  set.add(toISODate(year, 5, lastMondayOfMonth(year, 5)));

  // Summer (last Monday of August)
  set.add(toISODate(year, 8, lastMondayOfMonth(year, 8)));

  // Christmas + Boxing substitutes
  const x = christmasSubstituteDays(year);
  set.add(toISODate(year, x.christmasObserved.m, x.christmasObserved.d));
  set.add(toISODate(year, x.boxingObserved.m, x.boxingObserved.d));

  // apply overrides
  BANK_HOLIDAY_OVERRIDES_ADD.forEach((d) => {
    if (d.startsWith(String(year) + "-")) set.add(d);
  });
  BANK_HOLIDAY_OVERRIDES_REMOVE.forEach((d) => {
    if (d.startsWith(String(year) + "-")) set.delete(d);
  });

  return set;
}

function isBankHolidayEW(dateObj = new Date()) {
  const uk = getUKParts(dateObj);
  const iso = toISODate(uk.year, uk.month, uk.day);
  const set = bankHolidaysEnglandWales(uk.year);
  return set.has(iso);
}

function isOpenNowEW(dateObj = new Date()) {
  const uk = getUKParts(dateObj);
  const isWeekday = BUSINESS_HOURS.openDays.has(uk.dayIndex);
  const withinHours = uk.minutesNow >= BUSINESS_HOURS.startMinutes && uk.minutesNow < BUSINESS_HOURS.endMinutes;
  if (!isWeekday || !withinHours) return false;
  if (isBankHolidayEW(dateObj)) return false;
  return true;
}

function nextOpenDateTimeEW(from = new Date()) {
  // Find next opening time (08:30 UK) skipping weekends & bank holidays
  const start = new Date(from.getTime());
  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const probe = new Date(start.getTime() + dayOffset * 86400000);

    // Search for 08:30 UK on that date
    const base = new Date(probe.getTime());
    base.setHours(0, 0, 0, 0);

    for (let i = 0; i < 24 * 60; i++) {
      const cand = new Date(base.getTime() + i * 60000);
      const uk = getUKParts(cand);

      // match 08:30 on that date
      if (uk.minutesNow !== BUSINESS_HOURS.startMinutes) continue;

      // must be weekday, must not be bank holiday
      if (!BUSINESS_HOURS.openDays.has(uk.dayIndex)) continue;
      if (isBankHolidayEW(cand)) continue;

      // if dayOffset==0, must be in the future (or now before opening)
      if (cand.getTime() <= from.getTime()) continue;

      return cand;
    }
  }
  // fallback: tomorrow
  return new Date(from.getTime() + 86400000);
}

function minsToHrsMins(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

function buildAvailabilityAnswerHTML() {
  const now = new Date();
  const uk = getUKParts(now);
  const nowUK = formatUKTime(now);

  if (isOpenNowEW(now)) {
    const minsLeft = BUSINESS_HOURS.endMinutes - uk.minutesNow;
    return (
      `✅ <b>Yes — we’re open right now.</b><br>` +
      `Current UK time: <b>${escapeHTML(nowUK)}</b><br>` +
      `We close at <b>17:00</b> (in about <b>${escapeHTML(minsToHrsMins(minsLeft))}</b>).`
    );
  }

  const holidayNote = isBankHolidayEW(now)
    ? "<br><small>Today is a <b>bank holiday</b> (England & Wales), so we’re closed.</small>"
    : "";

  const nextOpen = nextOpenDateTimeEW(now);
  return (
    `❌ <b>No — we’re closed right now.</b><br>` +
    `Current UK time: <b>${escapeHTML(nowUK)}</b><br>` +
    `Next opening time: <b>${escapeHTML(formatUKDateLabel(nextOpen))}</b> at <b>${escapeHTML(formatUKTime(nextOpen))}</b>.<br>` +
    `<small>Hours: Monday–Friday, 08:30–17:00 (UK time). Closed weekends & bank holidays.</small>` +
    holidayNote
  );
}

/* ===============================================================
   8) Map preview (OSM static map) + Google Maps link
================================================================ */
function osmStaticMapURL(lat, lon, zoom = 14, w = 400, h = 220) {
  const center = `${lat},${lon}`;
  // Public OSM static map service, no key required
  return `https://staticmap.openstreetmap.de/staticmap.php?center=${encodeURIComponent(center)}&zoom=${zoom}&size=${w}x${h}&markers=${encodeURIComponent(center)},red-pushpin`;
}

function googleMapsPlaceURL(lat, lon) {
  return `https://www.google.com/maps?q=${encodeURIComponent(lat + "," + lon)}`;
}

/* ===============================================================
   DEPOTS + ORIGIN PLACES (EDIT THESE)
================================================================ */
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

function titleCase(s) {
  const t = (s ?? "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function toRad(deg) { return (deg * Math.PI) / 180; }

function distanceMiles(a, b) {
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.asin(Math.sqrt(h)));
}

function parseTravelMode(qNorm) {
  if (qNorm.includes("train") || qNorm.includes("rail")) return "train";
  if (qNorm.includes("bus") || qNorm.includes("coach")) return "bus";
  if (qNorm.includes("walk") || qNorm.includes("walking")) return "walk";
  if (qNorm.includes("car") || qNorm.includes("drive") || qNorm.includes("driving")) return "car";
  return null;
}

function estimateMinutes(miles, mode) {
  const mphMap = { car: 35, train: 55, bus: 20, walk: 3 };
  const mph = mphMap[mode] ?? 35;
  return Math.round((miles / mph) * 60);
}

function modeLabel(mode) {
  const map = { car: "by car", train: "by train", bus: "by bus", walk: "walking" };
  return map[mode] ?? "by car";
}

function findPlaceKey(qNorm) {
  for (const key in PLACES) {
    if (!Object.prototype.hasOwnProperty.call(PLACES, key)) continue;
    if (qNorm.includes(key)) return key;
  }
  return null;
}

function findClosestDepot(originLatLon) {
  let bestKey = null;
  let bestMiles = Infinity;
  for (const key in DEPOTS) {
    if (!Object.prototype.hasOwnProperty.call(DEPOTS, key)) continue;
    const miles = distanceMiles(originLatLon, DEPOTS[key]);
    if (miles < bestMiles) {
      bestMiles = miles;
      bestKey = key;
    }
  }
  return bestKey ? { depotKey: bestKey, miles: bestMiles } : null;
}

function googleDirectionsURL(originText, depot, mode) {
  const origin = encodeURIComponent(originText);
  const destination = encodeURIComponent(`${depot.lat},${depot.lon}`);
  let travelmode = "driving";
  if (mode === "walk") travelmode = "walking";
  if (mode === "train" || mode === "bus") travelmode = "transit";
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=${travelmode}`;
}

/* ===============================================================
   10) Quiet spelling correction + rephrase
================================================================ */
let VOCAB = new Set();
const PROTECTED_TOKENS = new Set(["walking","walk","by","car","train","bus","rail","coach","depot","depots","closest"]);

function shouldSkipToken(tok) {
  if (!tok) return true;
  if (tok.length <= 3) return true;
  if (/\d/.test(tok)) return true;
  if (tok.includes("@") || tok.includes(".")) return true;
  if (!/^[a-z-]+$/.test(tok)) return true;
  return false;
}

function levenshtein(a, b, maxDist) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > maxDist) return maxDist + 1;

  const prev = new Array(bl + 1);
  const curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let minInRow = curr[0];
    const ai = a.charCodeAt(i - 1);

    for (let j = 1; j <= bl; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < minInRow) minInRow = curr[j];
    }

    if (minInRow > maxDist) return maxDist + 1;
    for (let j = 0; j <= bl; j++) prev[j] = curr[j];
  }
  return prev[bl];
}

function bestVocabMatch(token) {
  if (PROTECTED_TOKENS.has(token)) return null;
  if (shouldSkipToken(token)) return null;
  if (VOCAB.has(token)) return null;

  const maxDist = token.length <= 7 ? 1 : 2;
  let best = null;
  let bestDist = maxDist + 1;

  for (const w of VOCAB) {
    if (Math.abs(w.length - token.length) > maxDist) continue;
    const d = levenshtein(token, w, maxDist);
    if (d < bestDist) {
      bestDist = d;
      best = w;
      if (bestDist === 1) break;
    }
  }
  return bestDist <= maxDist ? best : null;
}

function buildVocabFromFAQs() {
  const vocab = new Set();

  for (const item of FAQS) {
    const fields = [
      item.question,
      ...(item.synonyms ?? []),
      ...(item.canonicalKeywords ?? []),
      ...(item.tags ?? []),
      item.category
    ];
    for (const f of fields) {
      const toks = normalize(f).split(" ").filter(Boolean);
      for (const t of toks) if (!shouldSkipToken(t)) vocab.add(t);
    }
  }

  // also add locations/depot words
  for (const dk in DEPOTS) {
    if (!Object.prototype.hasOwnProperty.call(DEPOTS, dk)) continue;
    normalize(dk).split(" ").forEach((t) => { if (!shouldSkipToken(t)) vocab.add(t); });
    normalize(DEPOTS[dk].label).split(" ").forEach((t) => { if (!shouldSkipToken(t)) vocab.add(t); });
  }
  for (const pk in PLACES) {
    if (!Object.prototype.hasOwnProperty.call(PLACES, pk)) continue;
    normalize(pk).split(" ").forEach((t) => { if (!shouldSkipToken(t)) vocab.add(t); });
  }

  ["walking","walk","by","car","train","bus","rail","coach","depot","depots","closest"].forEach((w) => vocab.add(w));
  VOCAB = vocab;
}

function correctQueryTokens(rawText) {
  const norm = normalize(rawText);
  if (!norm) return { corrected: norm, changed: false };

  const tokens = norm.split(" ").filter(Boolean);
  let changed = false;
  const correctedTokens = tokens.map((t) => {
    const fixed = bestVocabMatch(t);
    if (fixed) {
      changed = true;
      return fixed;
    }
    return t;
  });
  return { corrected: correctedTokens.join(" "), changed };
}

function rephraseQuery(normText) {
  // lightweight rephrase to a canonical form for better matching & clarity
  let q = normalize(normText);

  // common sms/typo patterns
  q = q.replace(/\bwhn\b/g, "when")
       .replace(/\bur\b/g, "your")
       .replace(/\bu\b/g, "you")
       .replace(/\br\b/g, "are");

  // normalize “open/available”
  q = q.replace(/\bis any( )?one available\b/g, "is anyone available now")
       .replace(/\bopen right now\b/g, "open now")
       .replace(/\bopening hour\b/g, "opening hours");

  // normalize depot distance phrasing
  if (q.includes("how far") && q.includes("depot")) q = "how far is my closest depot";

  return q.trim();
}

function meaningChangeScore(a, b) {
  // 0..1 based on dice similarity (lower => bigger change)
  return 1 - diceCoefficient(a, b);
}

/* ===============================================================
   UI helpers + transcript
================================================================ */
function setUIEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  micBtn.disabled = !enabled;
  // allow voice toggle always
  chatWindow.querySelectorAll(".chip-btn").forEach((b) => (b.disabled = !enabled));
}

function pushToTranscript(type, text, opts) {
  const options = opts ?? {};
  const tsDate = options.ts ?? new Date();
  const ts = tsDate.getTime();

  let plain = "";
  if (options.html) plain = htmlToPlainText(text);
  else plain = String(text ?? "").trim();

  const role = type === "bot" ? "Bot" : "User";
  if (plain) CHAT_LOG.push({ role, text: plain, ts });

  const keep = Math.max(SETTINGS.ticketTranscriptMessages ?? 12, 12) * 4;
  if (CHAT_LOG.length > keep) CHAT_LOG = CHAT_LOG.slice(-keep);
}

function buildTranscript(limit = 12) {
  const take = Math.max(1, limit);
  const slice = CHAT_LOG.slice(-take);
  const MAX_LINE = Math.max(40, SETTINGS.ticketTranscriptMaxLine ?? 140);
  return slice.map((m) => {
    const time = formatUKTime(new Date(m.ts));
    const msg = (m.text ?? "").replace(/\s+/g, " ").trim();
    const clipped = msg.length > MAX_LINE ? msg.slice(0, MAX_LINE - 1) + "…" : msg;
    return `[${time}] ${m.role}: ${clipped}`;
  }).join("\n");
}

function addBubble(text, type, opts) {
  const options = opts ?? {};
  const html = !!options.html;
  const ts = options.ts ?? new Date();

  const row = document.createElement("div");
  row.className = "msg " + type;
  row.dataset.ts = String(ts.getTime());

  const bubble = document.createElement("div");
  bubble.className = "bubble " + type;
  bubble.setAttribute("role", "article");
  bubble.setAttribute("aria-label", type === "bot" ? "Bot message" : "Your message");

  if (html) bubble.innerHTML = sanitizeHTML(text);
  else bubble.textContent = text;

  const time = document.createElement("div");
  time.className = "timestamp";
  time.textContent = formatUKTime(ts);

  row.appendChild(bubble);
  row.appendChild(time);
  chatWindow.appendChild(row);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  pushToTranscript(type, html ? sanitizeHTML(text) : text, { ts, html });

  // 12) Voice output (if enabled and bot message)
  if (type === "bot") speakIfEnabled(html ? htmlToPlainText(text) : text);
}

function addTyping() {
  const row = document.createElement("div");
  row.className = "msg bot";
  row.dataset.typing = "true";

  const bubble = document.createElement("div");
  bubble.className = "bubble bot typing-bubble";
  bubble.innerHTML = 'Typing <span class="typing"><span></span><span></span><span></span></span>';

  row.appendChild(bubble);
  chatWindow.appendChild(row);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeTyping() {
  const t = chatWindow.querySelector('[data-typing="true"]');
  if (t) t.remove();
}

function addChips(questions, onClick) {
  const qs = questions ?? [];
  if (!qs.length) return;

  const wrap = document.createElement("div");
  wrap.className = "chips";

  qs.slice(0, SETTINGS.chipLimit).forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn";
    b.textContent = q;

    b.addEventListener("click", () => {
      const now = Date.now();
      if (isResponding) return;
      if (now - lastChipClickAt < SETTINGS.chipClickCooldownMs) return;

      lastChipClickAt = now;
      wrap.querySelectorAll(".chip-btn").forEach((btn) => (btn.disabled = true));
      if (typeof onClick === "function") onClick(q);
      else handleUserMessage(q);
      input.focus();
    });

    wrap.appendChild(b);
  });

  if (isResponding) wrap.querySelectorAll(".chip-btn").forEach((btn) => (btn.disabled = true));
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* ===============================================================
   Topics Drawer
================================================================ */
function buildCategoryIndex() {
  categoryIndex = new Map();
  FAQS.forEach((item) => {
    const key = (item.category ?? "general").toLowerCase();
    if (!categoryIndex.has(key)) categoryIndex.set(key, []);
    categoryIndex.get(key).push(item);
  });

  const labelMap = {
    general: "General",
    support: "Support",
    location: "Location",
    opening: "Opening times",
    actions: "Actions"
  };

  categories = Array.from(categoryIndex.keys())
    .sort()
    .map((key) => ({
      key,
      label: labelMap[key] ?? (key.charAt(0).toUpperCase() + key.slice(1)),
      count: categoryIndex.get(key).length
    }));
}

function openDrawer() {
  overlay.hidden = false;
  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  drawerCloseBtn?.focus();
}
function closeDrawer() {
  overlay.hidden = true;
  drawer.hidden = true;
  drawer.setAttribute("aria-hidden", "true");
  topicsBtn?.focus();
}

function renderDrawer(selectedKey) {
  const selected = selectedKey ?? null;
  drawerCategoriesEl.innerHTML = "";
  drawerQuestionsEl.innerHTML = "";

  categories.forEach((c) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "cat-pill";
    pill.textContent = `${c.label} (${c.count})`;
    pill.setAttribute("aria-selected", String(c.key === selected));
    pill.addEventListener("click", () => renderDrawer(c.key));
    drawerCategoriesEl.appendChild(pill);
  });

  const list = selected && categoryIndex.has(selected) ? categoryIndex.get(selected) : FAQS;

  list.forEach((item) => {
    const q = document.createElement("button");
    q.type = "button";
    q.className = "drawer-q";
    q.textContent = item.question;
    q.addEventListener("click", () => {
      closeDrawer();
      handleUserMessage(item.question);
    });
    drawerQuestionsEl.appendChild(q);
  });
}

function bindClose(el) {
  if (!el) return;
  el.addEventListener("click", (e) => {
    e.preventDefault();
    closeDrawer();
  });
  el.addEventListener("touchstart", (e) => {
    e.preventDefault();
    closeDrawer();
  }, { passive: false });
}

topicsBtn?.addEventListener("click", () => { if (faqsLoaded) openDrawer(); });
drawer?.addEventListener("click", (e) => e.stopPropagation());
drawer?.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
bindClose(drawerCloseBtn);
bindClose(overlay);
document.addEventListener("keydown", (e) => {
  if (!drawer.hidden && e.key === "Escape") closeDrawer();
});

/* ===============================================================
   Typeahead Suggestions
================================================================ */
function showSuggestions(items) {
  currentSuggestions = items;
  activeSuggestionIndex = -1;

  if (!items.length) {
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = "";
    return;
  }

  suggestionsEl.innerHTML = "";
  items.forEach((it, idx) => {
    const div = document.createElement("div");
    div.className = "suggestion-item";
    div.setAttribute("role", "option");
    div.setAttribute("aria-selected", "false");
    div.tabIndex = -1;
    div.innerHTML = `${escapeHTML(it.question)}<small>${escapeHTML(it.categoryLabel)}</small>`;

    div.addEventListener("mousedown", (ev) => { ev.preventDefault(); pickSuggestion(idx); });
    div.addEventListener("touchstart", (ev) => { ev.preventDefault(); pickSuggestion(idx); }, { passive: false });

    suggestionsEl.appendChild(div);
  });

  suggestionsEl.hidden = false;
}

function updateSuggestionSelection() {
  const nodes = suggestionsEl.querySelectorAll(".suggestion-item");
  nodes.forEach((n, i) => n.setAttribute("aria-selected", String(i === activeSuggestionIndex)));
}

function pickSuggestion(index) {
  const picked = currentSuggestions[index];
  if (!picked) return;

  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
  currentSuggestions = [];
  activeSuggestionIndex = -1;

  handleUserMessage(picked.question);
}

function computeSuggestions(query) {
  let q = normalize(query);
  if (!q || q.length < 2) return [];

  const corr = correctQueryTokens(query);
  if (corr.changed && corr.corrected) q = corr.corrected;

  const qTokens = tokenSet(q);

  const labelMap = new Map(categories.map((c) => [c.key, c.label]));

  const scored = FAQS.map((item) => {
    const question = item.question ?? "";
    const syns = item.synonyms ?? [];
    const keys = item.canonicalKeywords ?? [];
    const tags = item.tags ?? [];

    const scoreJ = Math.max(
      jaccard(qTokens, tokenSet(question)),
      syns.length ? Math.max(...syns.map((s) => jaccard(qTokens, tokenSet(s)))) : 0,
      keys.length ? Math.max(...keys.map((k) => jaccard(qTokens, tokenSet(k)))) : 0,
      tags.length ? Math.max(...tags.map((t) => jaccard(qTokens, tokenSet(t)))) : 0
    );

    const scoreB = Math.max(
      diceCoefficient(q, question),
      syns.length ? Math.max(...syns.map((s) => diceCoefficient(q, s))) : 0
    );

    const anyField = [question, ...syns, ...keys, ...tags].map(normalize).join(" ");
    const boost = anyField.includes(q) ? SETTINGS.boostSubstring : 0;

    const score = 0.62 * scoreJ + 0.30 * scoreB + boost;
    return { item, score };
  })
  .sort((a, b) => b.score - a.score)
  .slice(0, SETTINGS.suggestionLimit)
  .filter((x) => x.score > 0);

  return scored.map((s) => ({
    question: s.item.question,
    categoryLabel: labelMap.get((s.item.category ?? "general").toLowerCase()) ?? "General"
  }));
}

input.addEventListener("input", () => {
  if (!faqsLoaded) return;
  showSuggestions(computeSuggestions(input.value));
});

input.addEventListener("blur", () => {
  setTimeout(() => { suggestionsEl.hidden = true; }, 120);
});

input.addEventListener("keydown", (e) => {
  if (suggestionsEl.hidden) {
    if (e.key === "Enter") { e.preventDefault(); sendChat(); }
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, currentSuggestions.length - 1);
    updateSuggestionSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
    updateSuggestionSelection();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (activeSuggestionIndex >= 0) pickSuggestion(activeSuggestionIndex);
    else sendChat();
  } else if (e.key === "Escape") {
    suggestionsEl.hidden = true;
  }
});

/* ===============================================================
   1) Human tone adaptation
================================================================ */
function analyzeTone(userText) {
  const q = normalize(userText);
  const greeting = /\b(hi|hello|hey|morning|afternoon|evening)\b/.test(q);
  const thanks = /\b(thank|thanks|cheers)\b/.test(q);
  const frustrated = /\b(angry|annoyed|upset|ridiculous|useless|hate|not working|broken)\b/.test(q);
  const urgent = /\b(urgent|asap|immediately|right now|now)\b/.test(q);
  const short = q.length <= 18;
  return { greeting, thanks, frustrated, urgent, short };
}

function tonePrefix(tone) {
  if (tone.frustrated) return "I’m sorry about that — ";
  if (tone.urgent) return "Got it — ";
  if (tone.greeting) return "Hello! ";
  return "";
}

/* ===============================================================
   FAQ Matching (improved)
================================================================ */
function matchFAQ(query) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(qNorm);

  const scored = FAQS.map((item) => {
    const question = item.question ?? "";
    const syns = item.synonyms ?? [];
    const keys = item.canonicalKeywords ?? [];
    const tags = item.tags ?? [];

    const scoreQ = jaccard(qTokens, tokenSet(question));
    const scoreSyn = syns.length ? Math.max(...syns.map((s) => jaccard(qTokens, tokenSet(s)))) : 0;
    const scoreKeys = keys.length ? Math.max(...keys.map((k) => jaccard(qTokens, tokenSet(k)))) : 0;
    const scoreTags = tags.length ? Math.max(...tags.map((t) => jaccard(qTokens, tokenSet(t)))) : 0;

    const bigramQ = diceCoefficient(qNorm, question);
    const bigramSyn = syns.length ? Math.max(...syns.map((s) => diceCoefficient(qNorm, s))) : 0;

    const anyField = [question, ...syns, ...keys, ...tags].map(normalize).join(" ");
    const boost = anyField.includes(qNorm) ? SETTINGS.boostSubstring : 0;

    const score = (0.52 * scoreQ + 0.22 * scoreSyn + 0.10 * scoreKeys + 0.06 * scoreTags) + (0.10 * bigramQ + 0.08 * bigramSyn) + boost;

    return { item, score };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];

  if (!top || top.score < SETTINGS.minConfidence) {
    return {
      matched: false,
      suggestions: scored.slice(0, SETTINGS.topSuggestions).map((r) => r.item.question)
    };
  }

  return {
    matched: true,
    item: top.item,
    answerHTML: top.item.answer,
    followUps: top.item.followUps ?? [],
    score: top.score
  };
}

function categoryKeyFromLabelOrKey(textNorm) {
  for (const c of categories) {
    const keyNorm = normalize(c.key);
    const labelNorm = normalize(c.label);
    if (textNorm === keyNorm || textNorm === labelNorm || textNorm.includes(keyNorm) || textNorm.includes(labelNorm)) {
      return c.key;
    }
  }
  return null;
}

function matchFAQFromList(query, list) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(qNorm);

  const scored = (list ?? []).map((item) => {
    const question = item.question ?? "";
    const syns = item.synonyms ?? [];
    const keys = item.canonicalKeywords ?? [];
    const tags = item.tags ?? [];

    const scoreQ = jaccard(qTokens, tokenSet(question));
    const scoreSyn = syns.length ? Math.max(...syns.map((s) => jaccard(qTokens, tokenSet(s)))) : 0;

    const bigramQ = diceCoefficient(qNorm, question);
    const bigramSyn = syns.length ? Math.max(...syns.map((s) => diceCoefficient(qNorm, s))) : 0;

    const anyField = [question, ...syns, ...keys, ...tags].map(normalize).join(" ");
    const boost = anyField.includes(qNorm) ? SETTINGS.boostSubstring : 0;

    const score = 0.62 * Math.max(scoreQ, scoreSyn) + 0.30 * Math.max(bigramQ, bigramSyn) + boost;

    return { item, score };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < SETTINGS.minConfidence) {
    return {
      matched: false,
      suggestions: scored.slice(0, SETTINGS.topSuggestions).map((r) => r.item.question)
    };
  }
  return {
    matched: true,
    item: top.item,
    answerHTML: top.item.answer,
    followUps: top.item.followUps ?? [],
    score: top.score
  };
}

/* ===============================================================
   Ticket validation
================================================================ */
function normalizePhoneForValidation(raw) {
  const s = String(raw ?? "").trim();
  const digits = s.replace(/[^\d]/g, "");
  return { original: s, digits };
}
function isValidPhone(raw) {
  const { digits } = normalizePhoneForValidation(raw);
  return digits.length >= 8 && digits.length <= 16;
}

/* ===============================================================
   12) Voice input + output
================================================================ */
let voiceOn = (typeof memory.voiceOn === "boolean") ? memory.voiceOn : SETTINGS.voiceDefaultOn;
memory.voiceOn = voiceOn;
saveMemory();

function updateVoiceBtnUI() {
  if (!voiceBtn) return;
  voiceBtn.classList.toggle("on", !!voiceOn);
  voiceBtn.textContent = voiceOn ? "🔊" : "🔈";
  voiceBtn.title = voiceOn ? "Voice output on" : "Voice output off";
}

function speakIfEnabled(text) {
  if (!voiceOn) return;
  if (!("speechSynthesis" in window)) return;

  try {
    // cancel any ongoing speech so it doesn't overlap
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(String(text ?? ""));
    utter.rate = 1.0;
    utter.pitch = 1.0;
    utter.lang = "en-GB";
    window.speechSynthesis.speak(utter);
  } catch (_) {}
}

voiceBtn?.addEventListener("click", () => {
  voiceOn = !voiceOn;
  memory.voiceOn = voiceOn;
  saveMemory();
  updateVoiceBtnUI();
  addBubble(voiceOn ? "Voice output is now <b>on</b>." : "Voice output is now <b>off</b>.", "bot", { html: true, ts: new Date() });
});

updateVoiceBtnUI();

// Voice recognition (Chrome/Edge typically)
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let micListening = false;

function initSpeechRecognition() {
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.lang = "en-GB";
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    micListening = true;
    micBtn?.classList.add("on");
    micBtn.textContent = "🎙️";
  };

  rec.onend = () => {
    micListening = false;
    micBtn?.classList.remove("on");
    micBtn.textContent = "🎤";
  };

  rec.onerror = () => {
    micListening = false;
    micBtn?.classList.remove("on");
    micBtn.textContent = "🎤";
    addBubble("Voice input isn’t available right now — you can still type your question.", "bot", { ts: new Date() });
  };

  rec.onresult = (event) => {
    const text = event.results?.[0]?.[0]?.transcript ?? "";
    if (text.trim()) {
      input.value = text.trim();
      sendChat();
    }
  };

  return rec;
}

recognizer = initSpeechRecognition();

micBtn?.addEventListener("click", () => {
  if (!recognizer) {
    addBubble("Voice input isn’t supported in this browser. Try Chrome or Edge, or just type your question.", "bot", { ts: new Date() });
    return;
  }
  if (micListening) {
    try { recognizer.stop(); } catch (_) {}
  } else {
    try { recognizer.start(); } catch (_) {}
  }
});

/* ===============================================================
   Status badge (open/closed/bank holiday)
================================================================ */
function updateStatusBadge() {
  if (!statusBadge) return;
  const now = new Date();
  const open = isOpenNowEW(now);
  const holiday = isBankHolidayEW(now);
  const ukTime = formatUKTime(now);

  statusBadge.classList.remove("open","closed","holiday");

  if (open) {
    statusBadge.classList.add("open");
    statusBadge.textContent = `🟢 Open now (${ukTime})`;
  } else if (holiday) {
    statusBadge.classList.add("holiday");
    statusBadge.textContent = `🟡 Bank holiday — closed`;
  } else {
    statusBadge.classList.add("closed");
    statusBadge.textContent = `🔴 Closed (${ukTime})`;
  }
}
updateStatusBadge();
setInterval(updateStatusBadge, 60 * 1000);

/* ===============================================================
   Special cases (availability + flows + map previews)
================================================================ */
function specialCases(query, tone) {
  const corr = correctQueryTokens(query);
  const q0 = corr.changed && corr.corrected ? corr.corrected : normalize(query);
  const q = rephraseQuery(q0);

  // availability triggers
  const availabilityTriggers = [
    "is anyone available",
    "anyone available",
    "available now",
    "are you available",
    "open now",
    "are you open now",
    "can i speak to someone",
    "speak to someone now",
    "is someone there",
    "is anybody there"
  ];
  if (availabilityTriggers.some((t) => q.includes(t))) {
    memory.lastTopic = "opening";
    saveMemory();
    return {
      matched: true,
      answerHTML: tonePrefix(tone) + buildAvailabilityAnswerHTML(),
      chips: ["What are your opening times?", "How can I contact support?"],
      usedQuery: q
    };
  }

  // If user asks "bank holidays" or "holiday" explicitly, show this year's list
  if (q.includes("bank holiday") || q.includes("bank holidays")) {
    const now = new Date();
    const uk = getUKParts(now);
    const list = Array.from(bankHolidaysEnglandWales(uk.year))
      .sort()
      .map((d) => d)
      .slice(0, 12);

    memory.lastTopic = "opening";
    saveMemory();
    return {
      matched: true,
      answerHTML:
        `${tonePrefix(tone)}Here are the <b>England & Wales bank holidays</b> for <b>${uk.year}</b>:<br>` +
        list.map((d) => `• ${escapeHTML(d)}`).join("<br>") +
        `<br><small>If you need a different year, ask: “bank holidays ${uk.year + 1}”.</small>`,
      chips: [`Bank holidays ${uk.year + 1}`, "What are your opening times?"],
      usedQuery: q
    };
  }

  // Category clarification flow
  if (clarifyCtx && clarifyCtx.stage === "needCategory") {
    const pickedKey = categoryKeyFromLabelOrKey(q);
    if (pickedKey && categoryIndex.has(pickedKey)) {
      const list = categoryIndex.get(pickedKey);
      const res = matchFAQFromList(clarifyCtx.originalQuery, list);
      clarifyCtx = null;
      if (res.matched) {
        memory.lastTopic = pickedKey;
        saveMemory();
        return {
          matched: true,
          answerHTML: tonePrefix(tone) + res.answerHTML,
          chips: (res.followUps && res.followUps.length) ? res.followUps : null,
          usedQuery: q
        };
      }
      return {
        matched: true,
        answerHTML: tonePrefix(tone) + `Thanks — I still couldn’t match that under <b>${escapeHTML(pickedKey)}</b>. Try one of these:`,
        chips: res.suggestions ?? [],
        usedQuery: q
      };
    }
  }

  // Ticket flow trigger
  const wantsTicket =
    q.includes("raise a request") ||
    q.includes("create a ticket") ||
    q.includes("open a ticket") ||
    q.includes("log a ticket") ||
    q.includes("submit a request") ||
    q === "ticket";

  if (!ticketCtx && wantsTicket) {
    ticketCtx = { stage: "needType" };
    memory.lastTopic = "actions";
    saveMemory();
    return {
      matched: true,
      answerHTML: tonePrefix(tone) + "Sure — what do you need help with?",
      chips: ["Access / Login", "Pay / Payroll", "Benefits", "General query", "Something else"],
      usedQuery: q
    };
  }

  if (ticketCtx) {
    if (q === "cancel" || q === "stop" || q === "restart") {
      ticketCtx = null;
      return {
        matched: true,
        answerHTML: tonePrefix(tone) + "No problem — I’ve cancelled that request. If you want to start again, type <b>raise a request</b>.",
        usedQuery: q
      };
    }

    if (ticketCtx.stage === "needType") {
      ticketCtx.type = query.trim();
      ticketCtx.stage = "needName";
      return { matched: true, answerHTML: tonePrefix(tone) + "Thanks — what’s your name?", usedQuery: q };
    }
    if (ticketCtx.stage === "needName") {
      ticketCtx.name = query.trim();
      memory.name = ticketCtx.name;
      saveMemory();
      ticketCtx.stage = "needEmail";
      return { matched: true, answerHTML: tonePrefix(tone) + "And what email should we reply to?", usedQuery: q };
    }
    if (ticketCtx.stage === "needEmail") {
      const email = query.trim();
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!ok) return { matched: true, answerHTML: tonePrefix(tone) + "That doesn’t look like an email — can you retype it?", usedQuery: q };
      ticketCtx.email = email;
      ticketCtx.stage = "needPhone";
      return { matched: true, answerHTML: tonePrefix(tone) + "Thanks — what’s the best contact number for you?", usedQuery: q };
    }
    if (ticketCtx.stage === "needPhone") {
      const phone = query.trim();
      if (!isValidPhone(phone)) {
        return { matched: true, answerHTML: tonePrefix(tone) + "That number doesn’t look right — please enter a valid contact number (digits only is fine, or include +).", usedQuery: q };
      }
      ticketCtx.phone = phone;
      ticketCtx.stage = "needDescription";
      return { matched: true, answerHTML: tonePrefix(tone) + "Briefly describe the issue (1–3 sentences is perfect).", usedQuery: q };
    }
    if (ticketCtx.stage === "needDescription") {
      ticketCtx.description = query.trim();
      ticketCtx.stage = "needUrgency";
      return { matched: true, answerHTML: tonePrefix(tone) + "How urgent is this?", chips: ["Low", "Normal", "High", "Critical"], usedQuery: q };
    }
    if (ticketCtx.stage === "needUrgency") {
      ticketCtx.urgency = query.trim();

      const transcript = buildTranscript(SETTINGS.ticketTranscriptMessages ?? 40);
      const subject = encodeURIComponent(`[Welfare Support] ${ticketCtx.type} (${ticketCtx.urgency})`);
      const body = encodeURIComponent(
        `Name: ${ticketCtx.name}\n` +
        `Email: ${ticketCtx.email}\n` +
        `Contact number: ${ticketCtx.phone}\n` +
        `Urgency: ${ticketCtx.urgency}\n` +
        `Type: ${ticketCtx.type}\n\n` +
        `Description:\n${ticketCtx.description}\n\n` +
        `Chat transcript (latest messages):\n${transcript}\n\n` +
        `— Sent from Welfare Support chatbot`
      );

      const mailtoHref = `mailto:${SETTINGS.supportEmail}?subject=${subject}&body=${body}`;

      const summary =
        `<b>Request summary</b><br>` +
        `Type: <b>${escapeHTML(ticketCtx.type)}</b><br>` +
        `Urgency: <b>${escapeHTML(ticketCtx.urgency)}</b><br>` +
        `Name: <b>${escapeHTML(ticketCtx.name)}</b><br>` +
        `Email: <b>${escapeHTML(ticketCtx.email)}</b><br>` +
        `Contact number: <b>${escapeHTML(ticketCtx.phone)}</b><br><br>` +
        `<a href="${escapeAttrUrl(mailtoHref)}">Email support with this request (includes transcript)</a><br>` +
        `<small>(This opens your email app with the message prefilled — you then press Send.)</small><br><br>` +
        `Want to start another?`;

      ticketCtx = null;
      return { matched: true, answerHTML: summary, chips: ["Raise a request (create a ticket)"], usedQuery: q };
    }
  }

  // Depot / distance flow
  if (distanceCtx && distanceCtx.stage === "haveClosest") {
    if (q === "by car" || q === "by train" || q === "by bus" || q === "walking") {
      const mode = (q === "walking") ? "walk" : q.replace("by ", "");
      memory.preferredMode = mode;
      saveMemory();

      const depot = DEPOTS[distanceCtx.depotKey];
      const minutes = estimateMinutes(distanceCtx.miles, mode);

      const url = googleDirectionsURL(titleCase(distanceCtx.originKey), depot, mode);
      const mapImg = osmStaticMapURL(depot.lat, depot.lon, 13, 400, 220);

      const html =
        `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
        `From <b>${escapeHTML(titleCase(distanceCtx.originKey))}</b> it’s approximately <b>${Math.round(distanceCtx.miles)} miles</b>.<br>` +
        `Estimated time ${escapeHTML(modeLabel(mode))} is around <b>${minutes} minutes</b> (traffic and services can vary).<br>` +
        `<a href="${escapeAttrUrl(url)}">Get directions in Google Maps</a>` +
        `<br><img class="map-preview" src="${escapeAttrUrl(mapImg)}" alt="Map preview of depot location">`;

      return { matched: true, answerHTML: html, chips: ["By car", "By train", "By bus", "Walking"], usedQuery: q };
    }
  }

  if (q.includes("how far") || q.includes("distance") || q.includes("closest depot") || (q.includes("depot") && q.includes("closest"))) {
    const originKey = findPlaceKey(q);
    if (!originKey) {
      distanceCtx = { stage: "needOrigin" };
      return { matched: true, answerHTML: tonePrefix(tone) + "Certainly — what town or city are you travelling from?", chips: ["Coventry", "Birmingham", "Leicester", "London"], usedQuery: q };
    }

    memory.lastCity = originKey;
    saveMemory();

    const closest = findClosestDepot(PLACES[originKey]);
    if (!closest) return { matched: true, answerHTML: tonePrefix(tone) + "I can do that once I know your starting town/city. Where are you travelling from?", usedQuery: q };

    const depot = DEPOTS[closest.depotKey];

    distanceCtx = { stage: "haveClosest", originKey, depotKey: closest.depotKey, miles: closest.miles };

    const modeInText = parseTravelMode(q) || memory.preferredMode;

    if (modeInText) {
      const minutes = estimateMinutes(closest.miles, modeInText);
      const url = googleDirectionsURL(titleCase(originKey), depot, modeInText);
      const mapImg = osmStaticMapURL(depot.lat, depot.lon, 13, 400, 220);

      const html =
        `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
        `From <b>${escapeHTML(titleCase(originKey))}</b> it’s approximately <b>${Math.round(closest.miles)} miles</b>.<br>` +
        `Estimated time ${escapeHTML(modeLabel(modeInText))} is around <b>${minutes} minutes</b> (traffic and services can vary).<br>` +
        `<a href="${escapeAttrUrl(url)}">Get directions in Google Maps</a>` +
        `<br><img class="map-preview" src="${escapeAttrUrl(mapImg)}" alt="Map preview of depot location">`;

      return { matched: true, answerHTML: html, chips: ["By car", "By train", "By bus", "Walking"], usedQuery: q };
    }

    return {
      matched: true,
      answerHTML:
        `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
        `From <b>${escapeHTML(titleCase(originKey))}</b> it’s approximately <b>${Math.round(closest.miles)} miles</b>.<br>` +
        `How are you travelling?`,
      chips: ["By car", "By train", "By bus", "Walking"],
      usedQuery: q
    };
  }

  if (distanceCtx && distanceCtx.stage === "needOrigin") {
    const originKey2 = findPlaceKey(q) || (PLACES[q] ? q : null);
    if (originKey2) {
      memory.lastCity = originKey2;
      saveMemory();

      const closest2 = findClosestDepot(PLACES[originKey2]);
      const depot2 = DEPOTS[closest2.depotKey];

      distanceCtx = { stage: "haveClosest", originKey: originKey2, depotKey: closest2.depotKey, miles: closest2.miles };

      return {
        matched: true,
        answerHTML:
          `Thanks — your closest depot is <b>${escapeHTML(depot2.label)}</b>.<br>` +
          `From <b>${escapeHTML(titleCase(originKey2))}</b> it’s approximately <b>${Math.round(closest2.miles)} miles</b>.<br>` +
          `How are you travelling?`,
        chips: ["By car", "By train", "By bus", "Walking"],
        usedQuery: q
      };
    }
  }

  // Parking special case
  if (q.includes("parking") || q.includes("car park")) {
    memory.lastTopic = "location";
    saveMemory();
    return { matched: true, answerHTML: tonePrefix(tone) + "Yes — we have <b>visitor parking</b>. Spaces can be limited during busy times.", usedQuery: q };
  }

  // If user asks "where located" and you want map preview even if FAQ answers are plain:
  if (q.includes("where are you") || q.includes("location") || q.includes("address")) {
    const depot = DEPOTS.nuneaton;
    const mapImg = osmStaticMapURL(depot.lat, depot.lon, 13, 400, 220);
    const gmaps = googleMapsPlaceURL(depot.lat, depot.lon);

    memory.lastTopic = "location";
    saveMemory();

    return {
      matched: true,
      answerHTML:
        `${tonePrefix(tone)}We’re based in <b>Nuneaton, UK</b>. Visits are by appointment only.<br>` +
        `<a href="${escapeAttrUrl(gmaps)}">Open in Google Maps</a><br>` +
        `<img class="map-preview" src="${escapeAttrUrl(mapImg)}" alt="Map preview of Nuneaton Depot">`,
      chips: ["How can I contact support?", "Is there parking?"],
      usedQuery: q
    };
  }

  return null;
}

/* ===============================================================
   MAIN handler
================================================================ */
function handleUserMessage(text) {
  if (!text) return;

  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
  currentSuggestions = [];
  activeSuggestionIndex = -1;

  const tone = analyzeTone(text);

  addBubble(text, "user", { ts: new Date() });
  input.value = "";

  isResponding = true;
  setUIEnabled(false);
  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot", { ts: new Date() });
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    // apply correction + rephrase for matching
    const corr = correctQueryTokens(text);
    const norm0 = corr.changed && corr.corrected ? corr.corrected : text;
    const canon = rephraseQuery(norm0);

    // show “I understood…” only if meaningful change
    const change = meaningChangeScore(normalize(text), normalize(canon));
    if (SETTINGS.showUnderstoodLine && canon && change >= SETTINGS.understoodLineThreshold) {
      addBubble(`<small>I understood: <b>${escapeHTML(canon)}</b></small>`, "bot", { html: true, ts: new Date() });
    }

    // 1) Special cases first
    const special = specialCases(text, tone);
    if (special && special.matched) {
      addBubble(special.answerHTML, "bot", { html: true, ts: new Date() });
      if (special.chips && special.chips.length) addChips(special.chips);
      missCount = 0;
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    // 2) FAQ match (use canonical for best result)
    let res = matchFAQ(canon);

    if (!res.matched && canon !== text) {
      // try original too
      const res2 = matchFAQ(text);
      if (res2.matched || (res2.suggestions?.length ?? 0) > (res.suggestions?.length ?? 0)) res = res2;
    }

    if (res.matched) {
      // update memory for topic
      memory.lastTopic = (res.item?.category ?? memory.lastTopic);
      saveMemory();

      addBubble(tonePrefix(tone) + res.answerHTML, "bot", { html: true, ts: new Date() });

      if (res.followUps && res.followUps.length) {
        addBubble("You can also ask:", "bot", { ts: new Date() });
        addChips(res.followUps);
      }

      missCount = 0;
      clarifyCtx = null;
    } else {
      missCount++;

      // first miss -> ask category
      if (missCount === 1 && categories.length) {
        clarifyCtx = { stage: "needCategory", originalQuery: canon || text };
        addBubble(tonePrefix(tone) + "Quick check — what is this about?", "bot", { ts: new Date() });
        addChips(categories.map((c) => c.label));
      } else {
        addBubble(tonePrefix(tone) + "I’m not sure. Did you mean:", "bot", { ts: new Date() });
        addChips(res.suggestions ?? []);
      }

      // escalate after repeated misses
      if (missCount >= 2) {
        const mail = `mailto:${SETTINGS.supportEmail}`;
        addBubble(
          `If you’d like, you can contact support at <a href="${escapeAttrUrl(mail)}">${escapeHTML(SETTINGS.supportEmail)}</a> or call <b>${escapeHTML(SETTINGS.supportPhone)}</b>.`,
          "bot",
          { html: true, ts: new Date() }
        );
        missCount = 0;
        clarifyCtx = null;
      }
    }

    isResponding = false;
    setUIEnabled(true);
  }, 300);
}

function sendChat() {
  if (isResponding) return;
  const text = input.value.trim();
  if (!text) return;
  handleUserMessage(text);
}

sendBtn.addEventListener("click", sendChat);

clearBtn.addEventListener("click", () => {
  chatWindow.innerHTML = "";
  missCount = 0;
  distanceCtx = null;
  clarifyCtx = null;
  ticketCtx = null;
  CHAT_LOG = [];
  init();
});

/* ===============================================================
   Load FAQs
================================================================ */
fetch("./public/config/faqs.json")
  .then((res) => res.json())
  .then((data) => {
    FAQS = Array.isArray(data) ? data : [];
    faqsLoaded = true;
    buildCategoryIndex();
    buildVocabFromFAQs();
    renderDrawer();
  })
  .catch(() => {
    FAQS = [];
    faqsLoaded = true;
    buildCategoryIndex();
    buildVocabFromFAQs();
    renderDrawer();
  });

/* ===============================================================
   Init
================================================================ */
function init() {
  addBubble(SETTINGS.greeting, "bot", { html: true, ts: new Date() });

  // add a helpful chip row on first load using memory
  const chips = [];
  chips.push("What are your opening times?");
  chips.push("Is anyone available now?");
  chips.push("How can I contact support?");
  chips.push("Get directions to my closest depot");
  addChips(chips);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
