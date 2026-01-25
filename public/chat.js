
/* ---------------------------------------------------------------
 Welfare Support – Static FAQ Chatbot (Upgraded + Polished)
 Implements:
 3) Guided journeys (Access/Login, Pay/Payroll, Benefits) -> structured -> creates ticket email
 4) Learns from user choices locally (miss -> suggestion chosen -> stored boost)
 5) Natural language open/close queries (today/tomorrow/day-of-week/after 4pm/before 9/close at 5)
 6) Use my location (geolocation) for closest depot
 7) Accessibility & polish (focus, ARIA, reduced motion support already in CSS)

 Also keeps:
 - No bank holiday year lookups/listing (policy only)
 - Bank holidays affect open/closed logic (E&W) per substitute-day principle. [2](https://www.publicholidayguide.com/bank-holiday/uk-bank-holidays-2025/)
 - Small mic/speaker (CSS)
 - No status bar at top
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
let journeyCtx = null; // ✅ guided journeys context
let lastMissQueryNorm = null; // ✅ for local learning

let CHAT_LOG = []; // { role: "User"|"Bot", text, ts }

/* ===============================================================
   2) Context memory (persisted)
================================================================ */
const MEMORY_KEY = "ws_chat_memory_v3";
const memory = {
  name: null,
  lastTopic: null,
  lastCity: null,
  preferredMode: null,
  voiceOn: null
};

function loadMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") Object.assign(memory, obj);
  } catch (_) {}
}
function saveMemory() {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch (_) {}
}
loadMemory();

/* ===============================================================
   4) Local Learning (suggestion choice memory)
   Stores: queryNorm -> chosenQuestion, count
================================================================ */
const LEARN_KEY = "ws_choice_map_v1";
let LEARN_MAP = {}; // { [queryNorm]: { chosen: string, count: number } }

function loadLearnMap() {
  try {
    const raw = localStorage.getItem(LEARN_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") LEARN_MAP = obj;
  } catch (_) {}
}
function saveLearnMap() {
  try {
    localStorage.setItem(LEARN_KEY, JSON.stringify(LEARN_MAP));
  } catch (_) {}
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
   11) Better matching: bigram similarity
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
   HTML escaping + sanitization
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
  return String(url ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
}

function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;

  const allowedTags = new Set(["B","STRONG","I","EM","BR","A","SMALL","IMG"]);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toReplace = [];

  while (walker.nextNode()) {
    const el = walker.currentNode;

    if (!allowedTags.has(el.tagName)) {
      toReplace.push(el);
      continue;
    }

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
      if (!safeImg) {
        toReplace.push(el);
      } else {
        if (!el.getAttribute("alt")) el.setAttribute("alt", "Map preview");
        el.setAttribute("loading", "lazy");
      }
    }
  }

  toReplace.forEach((node) =>
    node.replaceWith(document.createTextNode(node.textContent ?? ""))
  );

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
const DAY_NAME_TO_INDEX = { monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6, sunday:7 };
const INDEX_TO_DAY_NAME = { 1:"Monday",2:"Tuesday",3:"Wednesday",4:"Thursday",5:"Friday",6:"Saturday",7:"Sunday" };

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
   4) Bank holiday engine (England & Wales) — for OPEN/CLOSED only
   Uses substitute-day logic principle per GOV.UK guidance. [2](https://www.publicholidayguide.com/bank-holiday/uk-bank-holidays-2025/)
   (No year listing and no “bank holidays 2027” feature.)
================================================================ */
const BUSINESS_HOURS = {
  openDays: new Set([1,2,3,4,5]),
  startMinutes: 8 * 60 + 30,
  endMinutes: 17 * 60
};

function toISODate(y, m, d) {
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

// Easter Sunday (Gregorian computus)
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
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { year, month, day };
}

function dayOfWeekUTC(y, m, d) { return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); } // 0=Sun..6=Sat

function firstMondayOfMay(year) {
  for (let d = 1; d <= 7; d++) if (dayOfWeekUTC(year, 5, d) === 1) return d;
  return 1;
}
function lastMondayOfMonth(year, month) {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let d = lastDay; d >= lastDay - 6; d--) if (dayOfWeekUTC(year, month, d) === 1) return d;
  return lastDay;
}
function newYearObserved(year) {
  const dow = dayOfWeekUTC(year, 1, 1);
  if (dow === 6) return { m: 1, d: 3 }; // Sat -> Mon 3
  if (dow === 0) return { m: 1, d: 2 }; // Sun -> Mon 2
  return { m: 1, d: 1 };
}
function christmasAndBoxingObserved(year) {
  const xmasDow = dayOfWeekUTC(year, 12, 25);
  const boxingDow = dayOfWeekUTC(year, 12, 26);

  if (xmasDow === 6 || xmasDow === 0) {
    return { xmas: { m: 12, d: 27 }, boxing: { m: 12, d: 28 } };
  }
  if (boxingDow === 6 || boxingDow === 0) {
    return { xmas: { m: 12, d: 25 }, boxing: { m: 12, d: 28 } };
  }
  return { xmas: { m: 12, d: 25 }, boxing: { m: 12, d: 26 } };
}

function bankHolidaysEWSet(year) {
  const set = new Set();

  // New Year
  const ny = newYearObserved(year);
  set.add(toISODate(year, ny.m, ny.d));

  // Easter: Good Friday and Easter Monday
  const es = easterSunday(year);
  const easter = new Date(Date.UTC(year, es.month - 1, es.day));
  const goodFriday = new Date(easter.getTime() - 2 * 86400000);
  const easterMonday = new Date(easter.getTime() + 1 * 86400000);
  set.add(toISODate(goodFriday.getUTCFullYear(), goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()));
  set.add(toISODate(easterMonday.getUTCFullYear(), easterMonday.getUTCMonth() + 1, easterMonday.getUTCDate()));

  // Early May: first Monday of May
  set.add(toISODate(year, 5, firstMondayOfMay(year)));

  // Spring: last Monday of May
  set.add(toISODate(year, 5, lastMondayOfMonth(year, 5)));

  // Summer: last Monday of August
  set.add(toISODate(year, 8, lastMondayOfMonth(year, 8)));

  // Christmas & Boxing
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
  // next opening time (08:30 UK), skipping weekends & bank holidays
  const start = new Date(from.getTime());
  for (let dayOffset = 0; dayOffset <= 14; dayOffset++) {
    const base = new Date(start.getTime() + dayOffset * 86400000);
    base.setHours(0, 0, 0, 0);

    for (let i = 0; i < 24 * 60; i++) {
      const cand = new Date(base.getTime() + i * 60000);
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

  const isBH = isBankHolidayEW(now);
  const holidayNote = isBH ? "<br><small>❌ <b>No — we are not open on bank holidays.</b></small>" : "";
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
   5) Natural language open/close queries
   Handles:
   - "open today/tomorrow"
   - "open on monday / next monday"
   - "open after 4pm / before 9"
   - "do you close at 5"
================================================================ */
function addDays(dateObj, days) {
  return new Date(dateObj.getTime() + days * 86400000);
}

function parseTimeToMinutes(textNorm) {
  // supports: "4pm", "4 pm", "16:00", "16", "8:30", "830"
  let t = textNorm;

  // 16:00, 8:30
  const hm = t.match(/\b(\d{1,2})\s*:\s*(\d{2})\b/);
  if (hm) {
    const h = Math.min(23, parseInt(hm[1], 10));
    const m = Math.min(59, parseInt(hm[2], 10));
    return h * 60 + m;
  }

  // 4pm / 11am
  const ampm = t.match(/\b(\d{1,2})\s*(am|pm)\b/);
  if (ampm) {
    let h = parseInt(ampm[1], 10);
    const ap = ampm[2];
    if (h === 12) h = (ap === "am") ? 0 : 12;
    else if (ap === "pm") h += 12;
    return Math.min(23, h) * 60;
  }

  // 830 (as 8:30) or 930 etc
  const compact = t.match(/\b(\d{3,4})\b/);
  if (compact) {
    const s = compact[1];
    const h = parseInt(s.slice(0, s.length - 2), 10);
    const m = parseInt(s.slice(-2), 10);
    if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return h * 60 + m;
    }
  }

  // "at 5" -> assume 5:00
  const atH = t.match(/\b(at|after|before)\s+(\d{1,2})\b/);
  if (atH) {
    const h = Math.min(23, parseInt(atH[2], 10));
    return h * 60;
  }

  return null;
}

function resolveDayReference(qNorm) {
  // Returns { dayOffset, label } or null
  if (qNorm.includes("today")) return { dayOffset: 0, label: "today" };
  if (qNorm.includes("tomorrow")) return { dayOffset: 1, label: "tomorrow" };

  // day of week
  const dayMatch = qNorm.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (dayMatch) {
    const wantIdx = DAY_NAME_TO_INDEX[dayMatch[1]];
    const nowUK = getUKParts(new Date());
    let delta = (wantIdx - nowUK.dayIndex + 7) % 7;
    if (qNorm.includes("next ") && delta === 0) delta = 7;
    if (qNorm.includes("next ") && delta > 0) delta += 7; // "next monday" typically means the following week
    if (!qNorm.includes("next ") && delta === 0) delta = 7; // "on monday" when today is monday -> assume next week
    return { dayOffset: delta, label: `on ${INDEX_TO_DAY_NAME[wantIdx]}` };
  }

  return null;
}

function buildOpenAtTimeAnswer(targetDate, minutes) {
  // targetDate is a Date in local time but we check open logic against UK parts
  const ukNow = getUKParts(targetDate);
  const isBH = isBankHolidayEW(targetDate);
  const isWeekday = BUSINESS_HOURS.openDays.has(ukNow.dayIndex);

  const timeLabel = `${String(Math.floor(minutes/60)).padStart(2,"0")}:${String(minutes%60).padStart(2,"0")}`;

  if (isBH) {
    return `❌ <b>No — we are not open on bank holidays.</b><br><small>Hours: Monday–Friday, 08:30–17:00 (UK time).</small>`;
  }
  if (!isWeekday) {
    return `❌ <b>No — we’re closed ${escapeHTML(formatUKDateLabel(targetDate))}.</b><br><small>We’re open Monday–Friday, 08:30–17:00 (UK time).</small>`;
  }

  const open = minutes >= BUSINESS_HOURS.startMinutes && minutes < BUSINESS_HOURS.endMinutes;
  if (open) {
    return `✅ <b>Yes — we’re open at ${escapeHTML(timeLabel)} (UK time) ${escapeHTML(formatUKDateLabel(targetDate))}.</b><br><small>Hours: 08:30–17:00.</small>`;
  }
  return `❌ <b>No — we’re closed at ${escapeHTML(timeLabel)} (UK time) ${escapeHTML(formatUKDateLabel(targetDate))}.</b><br><small>Hours: 08:30–17:00.</small>`;
}

function naturalLanguageHoursAnswer(qNorm) {
  // Detect open/close questions with a day/time reference
  const asksOpen =
    qNorm.includes("are you open") ||
    qNorm.includes("open ") ||
    qNorm.includes("opening") ||
    qNorm.includes("available");

  const asksCloseTime =
    qNorm.includes("close at") ||
    qNorm.includes("closing time") ||
    qNorm.includes("what time do you close") ||
    qNorm.includes("what time do you shut");

  // bank holiday policy
  if (qNorm.includes("bank holiday") || qNorm.includes("bank holidays")) {
    return `❌ <b>No — we are not open on bank holidays.</b><br><small>We’re open Monday–Friday, 08:30–17:00 (UK time).</small>`;
  }

  const dayRef = resolveDayReference(qNorm);
  const timeMin = parseTimeToMinutes(qNorm);

  // "close at 5" style
  if (asksCloseTime && !dayRef && !timeMin) {
    return `We close at <b>17:00</b> (UK time), Monday–Friday. <small>Closed weekends & bank holidays.</small>`;
  }

  // if they asked something like "open tomorrow" or "open on monday"
  if (asksOpen && dayRef && timeMin == null) {
    const target = addDays(new Date(), dayRef.dayOffset);
    const uk = getUKParts(target);
    if (isBankHolidayEW(target)) {
      return `❌ <b>No — we are not open on bank holidays.</b><br><small>${escapeHTML(formatUKDateLabel(target))} is a bank holiday.</small>`;
    }
    if (!BUSINESS_HOURS.openDays.has(uk.dayIndex)) {
      return `❌ <b>No — we’re closed ${escapeHTML(dayRef.label)}.</b><br><small>We’re open Monday–Friday, 08:30–17:00 (UK time).</small>`;
    }
    return `✅ <b>Yes — we’re open ${escapeHTML(dayRef.label)}.</b><br><small>Hours: 08:30–17:00 (UK time). Closed bank holidays.</small>`;
  }

  // if they asked with time, like "open after 4pm tomorrow"
  if (asksOpen && dayRef && timeMin != null) {
    const target = addDays(new Date(), dayRef.dayOffset);
    return buildOpenAtTimeAnswer(target, timeMin);
  }

  // "open after 4pm" without day -> assume today
  if (asksOpen && !dayRef && timeMin != null) {
    const target = new Date();
    return buildOpenAtTimeAnswer(target, timeMin);
  }

  // "open today" without time -> handled above via dayRef
  if (asksOpen && !dayRef && qNorm.includes("today")) {
    const target = new Date();
    const uk = getUKParts(target);
    if (isBankHolidayEW(target)) return `❌ <b>No — we are not open on bank holidays.</b>`;
    if (!BUSINESS_HOURS.openDays.has(uk.dayIndex)) return `❌ <b>No — we’re closed today.</b><br><small>Weekends are closed.</small>`;
    return `✅ <b>Yes — we’re open today.</b><br><small>Hours: 08:30–17:00.</small>`;
  }

  return null;
}

/* ===============================================================
   8) Map preview + Google Maps link
================================================================ */
function osmStaticMapURL(lat, lon, zoom = 13, w = 400, h = 220) {
  const center = `${lat},${lon}`;
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
const PROTECTED_TOKENS = new Set(["walking","walk","by","car","train","bus","rail","coach","depot","depots","closest","payroll"]);

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

  for (const dk in DEPOTS) {
    if (!Object.prototype.hasOwnProperty.call(DEPOTS, dk)) continue;
    normalize(dk).split(" ").forEach((t) => { if (!shouldSkipToken(t)) vocab.add(t); });
    normalize(DEPOTS[dk].label).split(" ").forEach((t) => { if (!shouldSkipToken(t)) vocab.add(t); });
  }
  for (const pk in PLACES) {
    if (!Object.prototype.hasOwnProperty.call(PLACES, pk)) continue;
    normalize(pk).split(" ").forEach((t) => { if (!shouldSkipToken(t)) vocab.add(t); });
  }

  ["walking","walk","by","car","train","bus","rail","coach","depot","depots","closest","payroll"].forEach((w) => vocab.add(w));
  VOCAB = vocab;
}

function correctQueryTokens(rawText) {
  const norm = normalize(rawText);
  if (!norm) return { corrected: norm, changed: false };

  const tokens = norm.split(" ").filter(Boolean);
  let changed = false;
  const correctedTokens = tokens.map((t) => {
    const fixed = bestVocabMatch(t);
    if (fixed) { changed = true; return fixed; }
    return t;
  });
  return { corrected: correctedTokens.join(" "), changed };
}

function rephraseQuery(text) {
  let q = normalize(text);

  q = q.replace(/\bwhn\b/g, "when")
       .replace(/\bur\b/g, "your")
       .replace(/\bu\b/g, "you")
       .replace(/\br\b/g, "are");

  q = q.replace(/\bis any( )?one available\b/g, "is anyone available now")
       .replace(/\bopen right now\b/g, "open now");

  if (q.includes("how far") && q.includes("depot")) q = "how far is my closest depot";

  return q.trim();
}

function meaningChangeScore(a, b) {
  return 1 - diceCoefficient(a, b);
}

/* ===============================================================
   UI helpers + transcript
================================================================ */
function setUIEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  micBtn.disabled = !enabled;
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

/* ===============================================================
   12) Voice output
================================================================ */
let voiceOn = (typeof memory.voiceOn === "boolean") ? memory.voiceOn : SETTINGS.voiceDefaultOn;
memory.voiceOn = voiceOn;
saveMemory();

function updateVoiceBtnUI() {
  if (!voiceBtn) return;
  voiceBtn.classList.toggle("on", !!voiceOn);
  voiceBtn.textContent = voiceOn ? "🔊" : "🔈";
  voiceBtn.title = voiceOn ? "Voice output on" : "Voice output off";
  voiceBtn.setAttribute("aria-pressed", voiceOn ? "true" : "false");
}

function speakIfEnabled(text) {
  if (!voiceOn) return;
  if (!("speechSynthesis" in window)) return;

  try {
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

/* ===============================================================
   12) Voice input
================================================================ */
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
    micBtn.setAttribute("aria-pressed", "true");
  };

  rec.onend = () => {
    micListening = false;
    micBtn?.classList.remove("on");
    micBtn.textContent = "🎤";
    micBtn.setAttribute("aria-pressed", "false");
  };

  rec.onerror = () => {
    micListening = false;
    micBtn?.classList.remove("on");
    micBtn.textContent = "🎤";
    micBtn.setAttribute("aria-pressed", "false");
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
   Bubble rendering
================================================================ */
function addBubble(text, type, opts) {
  const options = opts ?? {};
  const html = !!options.html;
  const ts = options.ts ?? new Date();
  const speak = options.speak !== false;

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

  if (type === "bot" && speak) speakIfEnabled(html ? htmlToPlainText(text) : text);
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

/* ===============================================================
   Chips (supports custom onClick)
================================================================ */
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
   Topics drawer
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
  el.addEventListener("click", (e) => { e.preventDefault(); closeDrawer(); });
  el.addEventListener("touchstart", (e) => { e.preventDefault(); closeDrawer(); }, { passive: false });
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
   Suggestions
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

    // learned boost if applicable
    const learned = learnedChoiceFor(q);
    const learnedBoost = learned && learned.chosen === question ? Math.min(0.18, 0.06 + 0.02 * Math.min(6, learned.count || 1)) : 0;

    const score = 0.62 * scoreJ + 0.30 * scoreB + boost + learnedBoost;
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
   1) Tone
================================================================ */
function analyzeTone(userText) {
  const q = normalize(userText);
  const greeting = /\b(hi|hello|hey|morning|afternoon|evening)\b/.test(q);
  const thanks = /\b(thank|thanks|cheers)\b/.test(q);
  const frustrated = /\b(angry|annoyed|upset|ridiculous|useless|hate|not working|broken)\b/.test(q);
  const urgent = /\b(urgent|asap|immediately|right now|now)\b/.test(q);
  return { greeting, thanks, frustrated, urgent };
}
function tonePrefix(t) {
  if (t.frustrated) return "I’m sorry about that — ";
  if (t.urgent) return "Got it — ";
  if (t.greeting) return "Hello! ";
  if (t.thanks) return "You’re welcome — ";
  return "";
}

/* ===============================================================
   FAQ Matching (improved + learned boost)
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

    const learned = learnedChoiceFor(qNorm);
    const learnedBoost = learned && learned.chosen === question ? Math.min(0.22, 0.08 + 0.02 * Math.min(7, learned.count || 1)) : 0;

    const score =
      (0.52 * scoreQ + 0.22 * scoreSyn + 0.10 * scoreKeys + 0.06 * scoreTags) +
      (0.10 * bigramQ + 0.08 * bigramSyn) +
      boost + learnedBoost;

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
    followUps: top.item.followUps ?? []
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

    const scoreJ = Math.max(
      jaccard(qTokens, tokenSet(question)),
      syns.length ? Math.max(...syns.map((s) => jaccard(qTokens, tokenSet(s)))) : 0
    );

    const scoreB = Math.max(
      diceCoefficient(qNorm, question),
      syns.length ? Math.max(...syns.map((s) => diceCoefficient(qNorm, s))) : 0
    );

    const anyField = [question, ...syns].map(normalize).join(" ");
    const boost = anyField.includes(qNorm) ? SETTINGS.boostSubstring : 0;

    const score = 0.62 * scoreJ + 0.30 * scoreB + boost;
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
    followUps: top.item.followUps ?? []
  };
}

/* ===============================================================
   Ticket validation
================================================================ */
function isValidPhone(raw) {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  return digits.length >= 8 && digits.length <= 16;
}

/* ===============================================================
   6) Geolocation helper (Use my location)
================================================================ */
function requestBrowserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocation not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
    );
  });
}

/* ===============================================================
   3) Guided journeys
================================================================ */
function startJourney(typeLabel) {
  journeyCtx = {
    type: typeLabel,
    stage: "start",
    answers: {}
  };
}

function journeyPromptForStage(ctx) {
  const t = ctx.type;

  if (ctx.stage === "start") {
    ctx.stage = "needName";
    return { html: "Sure — I’ll guide you through a few quick questions. What’s your <b>name</b>?" };
  }
  if (ctx.stage === "needName") {
    ctx.stage = "needEmail";
    return { html: "Thanks. What <b>email</b> should we reply to?" };
  }
  if (ctx.stage === "needEmail") {
    ctx.stage = "needPhone";
    return { html: "Great — what’s the best <b>contact number</b> for you?" };
  }

  if (t === "Access / Login") {
    if (ctx.stage === "needPhone") { ctx.stage = "system"; return { html: "Which system is this for? (e.g., portal, payroll app, email)" }; }
    if (ctx.stage === "system") { ctx.stage = "issueType"; return { html: "What’s happening? (e.g., password reset, locked out, error message)" }; }
    if (ctx.stage === "issueType") { ctx.stage = "errorText"; return { html: "If there’s an error message, paste it (or type <b>none</b>)." }; }
    if (ctx.stage === "errorText") { ctx.stage = "urgency"; return { html: "How urgent is this?", chips: ["Low","Normal","High","Critical"] }; }
  }

  if (t === "Pay / Payroll") {
    if (ctx.stage === "needPhone") { ctx.stage = "payPeriod"; return { html: "Which pay period/week is affected?" }; }
    if (ctx.stage === "payPeriod") { ctx.stage = "problem"; return { html: "What’s the issue? (missing pay, wrong hours, tax code, etc.)" }; }
    if (ctx.stage === "problem") { ctx.stage = "amount"; return { html: "If you know it, what amount is missing/incorrect? (or type <b>unknown</b>)" }; }
    if (ctx.stage === "amount") { ctx.stage = "urgency"; return { html: "How urgent is this?", chips: ["Low","Normal","High","Critical"] }; }
  }

  if (t === "Benefits") {
    if (ctx.stage === "needPhone") { ctx.stage = "benefitType"; return { html: "Which benefit is this about? (e.g., holiday, sick pay, pension, other)" }; }
    if (ctx.stage === "benefitType") { ctx.stage = "change"; return { html: "What changed or what do you need help with?" }; }
    if (ctx.stage === "change") { ctx.stage = "urgency"; return { html: "How urgent is this?", chips: ["Low","Normal","High","Critical"] }; }
  }

  if (ctx.stage === "urgency") {
    ctx.stage = "done";
    return { html: "Thanks — I’ve got everything I need." };
  }

  return null;
}

function buildJourneyMailto(ctx) {
  const subject = encodeURIComponent(`[Welfare Support] ${ctx.type} (${ctx.answers.urgency || "Normal"})`);
  const transcript = buildTranscript(SETTINGS.ticketTranscriptMessages ?? 40);

  const lines = [
    `Type: ${ctx.type}`,
    `Urgency: ${ctx.answers.urgency || ""}`,
    `Name: ${ctx.answers.name || ""}`,
    `Email: ${ctx.answers.email || ""}`,
    `Contact number: ${ctx.answers.phone || ""}`,
    "",
    "Details:",
    ...(ctx.type === "Access / Login" ? [
      `System: ${ctx.answers.system || ""}`,
      `Issue: ${ctx.answers.issueType || ""}`,
      `Error message: ${ctx.answers.errorText || ""}`
    ] : []),
    ...(ctx.type === "Pay / Payroll" ? [
      `Pay period: ${ctx.answers.payPeriod || ""}`,
      `Problem: ${ctx.answers.problem || ""}`,
      `Amount: ${ctx.answers.amount || ""}`
    ] : []),
    ...(ctx.type === "Benefits" ? [
      `Benefit type: ${ctx.answers.benefitType || ""}`,
      `Query: ${ctx.answers.change || ""}`
    ] : []),
    "",
    "Chat transcript (latest messages):",
    transcript,
    "",
    "— Sent from Welfare Support chatbot"
  ].join("\n");

  const body = encodeURIComponent(lines);
  return `mailto:${SETTINGS.supportEmail}?subject=${subject}&body=${body}`;
}

/* ===============================================================
   3/4/5/6: Special cases router
================================================================ */
function specialCases(query, tone) {
  const corr = correctQueryTokens(query);
  const q0 = corr.changed && corr.corrected ? corr.corrected : normalize(query);
  const q = rephraseQuery(q0);

  // Guided journey triggers
  if (!journeyCtx) {
    if (q.includes("guided") || q.includes("help me with login") || q === "access login") {
      startJourney("Access / Login");
      return { matched: true, answerHTML: tonePrefix(tone) + journeyPromptForStage(journeyCtx).html, chips: null, suppressUnderstood: true };
    }
    if (q.includes("payroll") || q.includes("pay issue") || q.includes("missing pay") || q.includes("wrong pay")) {
      startJourney("Pay / Payroll");
      return { matched: true, answerHTML: tonePrefix(tone) + journeyPromptForStage(journeyCtx).html, chips: null, suppressUnderstood: true };
    }
    if (q.includes("benefit") || q.includes("holiday pay") || q.includes("sick pay") || q.includes("pension")) {
      startJourney("Benefits");
      return { matched: true, answerHTML: tonePrefix(tone) + journeyPromptForStage(journeyCtx).html, chips: null, suppressUnderstood: true };
    }
  }

  // If already in a guided journey, consume input
  if (journeyCtx && journeyCtx.stage !== "done") {
    // allow cancel
    if (q === "cancel" || q === "stop") {
      journeyCtx = null;
      return { matched: true, answerHTML: tonePrefix(tone) + "No problem — I’ve cancelled the guided help. You can start again anytime.", chips: ["Access / Login", "Pay / Payroll", "Benefits"] };
    }

    // validate and store answers by stage
    const stage = journeyCtx.stage;
    const raw = String(query ?? "").trim();

    if (stage === "needName") journeyCtx.answers.name = raw;
    if (stage === "needEmail") {
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
      if (!ok) return { matched: true, answerHTML: tonePrefix(tone) + "That doesn’t look like an email — can you retype it?", chips: null };
      journeyCtx.answers.email = raw;
    }
    if (stage === "needPhone") {
      if (!isValidPhone(raw)) {
        return { matched: true, answerHTML: tonePrefix(tone) + "That number doesn’t look right — please enter a valid contact number (digits only is fine, or include +).", chips: null };
      }
      journeyCtx.answers.phone = raw;
    }
    if (stage === "system") journeyCtx.answers.system = raw;
    if (stage === "issueType") journeyCtx.answers.issueType = raw;
    if (stage === "errorText") journeyCtx.answers.errorText = (normalize(raw) === "none") ? "None" : raw;

    if (stage === "payPeriod") journeyCtx.answers.payPeriod = raw;
    if (stage === "problem") journeyCtx.answers.problem = raw;
    if (stage === "amount") journeyCtx.answers.amount = (normalize(raw) === "unknown") ? "Unknown" : raw;

    if (stage === "benefitType") journeyCtx.answers.benefitType = raw;
    if (stage === "change") journeyCtx.answers.change = raw;

    if (stage === "urgency") {
      journeyCtx.answers.urgency = raw;
    }

    // advance
    const next = journeyPromptForStage(journeyCtx);
    if (next) {
      if (next.chips) return { matched: true, answerHTML: tonePrefix(tone) + next.html, chips: next.chips };
      return { matched: true, answerHTML: tonePrefix(tone) + next.html, chips: null };
    }

    // done -> show mailto summary
    if (journeyCtx.stage === "done") {
      const mailto = buildJourneyMailto(journeyCtx);
      const summary =
        `<b>Guided request summary</b><br>` +
        `Type: <b>${escapeHTML(journeyCtx.type)}</b><br>` +
        `Urgency: <b>${escapeHTML(journeyCtx.answers.urgency || "Normal")}</b><br>` +
        `Name: <b>${escapeHTML(journeyCtx.answers.name || "")}</b><br>` +
        `Email: <b>${escapeHTML(journeyCtx.answers.email || "")}</b><br>` +
        `Contact number: <b>${escapeHTML(journeyCtx.answers.phone || "")}</b><br><br>` +
        `<a href="${escapeAttrUrl(mailto)}">Email support with this request (includes transcript)</a><br>` +
        `<small>(This opens your email app with the message prefilled — you then press Send.)</small><br><br>` +
        `Want to do another guided request?`;

      journeyCtx = null;
      return { matched: true, answerHTML: summary, chips: ["Access / Login", "Pay / Payroll", "Benefits"] };
    }
  }

  // Natural language hours handling
  const nlHours = naturalLanguageHoursAnswer(q);
  if (nlHours) {
    memory.lastTopic = "opening";
    saveMemory();
    return { matched: true, answerHTML: tonePrefix(tone) + nlHours, chips: ["Is anyone available now?", "What are your opening times?", "How can I contact support?"] };
  }

  // Bank holiday policy (never lists dates)
  if (q.includes("bank holiday") || q.includes("bank holidays")) {
    memory.lastTopic = "opening";
    saveMemory();
    return {
      matched: true,
      answerHTML:
        `${tonePrefix(tone)}❌ <b>No — we are not open on bank holidays.</b><br>` +
        `<small>We’re open Monday–Friday, 08:30–17:00 (UK time), and closed on weekends & bank holidays.</small>`,
      chips: ["What are your opening times?", "Is anyone available now?", "How can I contact support?"]
    };
  }

  // Availability / open-now
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
      chips: ["What are your opening times?", "How can I contact support?"]
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
          chips: (res.followUps && res.followUps.length) ? res.followUps : null
        };
      }
      return {
        matched: true,
        answerHTML: tonePrefix(tone) + `Thanks — I still couldn’t match that under <b>${escapeHTML(pickedKey)}</b>. Try one of these:`,
        chips: res.suggestions ?? []
      };
    }
  }

  // Ticket trigger (existing flow preserved)
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
      chips: ["Access / Login", "Pay / Payroll", "Benefits", "General query", "Something else"]
    };
  }

  if (ticketCtx) {
    if (q === "cancel" || q === "stop" || q === "restart") {
      ticketCtx = null;
      return {
        matched: true,
        answerHTML: tonePrefix(tone) + "No problem — I’ve cancelled that request. If you want to start again, type <b>raise a request</b>."
      };
    }

    if (ticketCtx.stage === "needType") {
      ticketCtx.type = query.trim();
      ticketCtx.stage = "needName";
      return { matched: true, answerHTML: tonePrefix(tone) + "Thanks — what’s your name?" };
    }
    if (ticketCtx.stage === "needName") {
      ticketCtx.name = query.trim();
      memory.name = ticketCtx.name;
      saveMemory();
      ticketCtx.stage = "needEmail";
      return { matched: true, answerHTML: tonePrefix(tone) + "And what email should we reply to?" };
    }
    if (ticketCtx.stage === "needEmail") {
      const email = query.trim();
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!ok) return { matched: true, answerHTML: tonePrefix(tone) + "That doesn’t look like an email — can you retype it?" };
      ticketCtx.email = email;
      ticketCtx.stage = "needPhone";
      return { matched: true, answerHTML: tonePrefix(tone) + "Thanks — what’s the best contact number for you?" };
    }
    if (ticketCtx.stage === "needPhone") {
      const phone = query.trim();
      if (!isValidPhone(phone)) {
        return { matched: true, answerHTML: tonePrefix(tone) + "That number doesn’t look right — please enter a valid contact number (digits only is fine, or include +)." };
      }
      ticketCtx.phone = phone;
      ticketCtx.stage = "needDescription";
      return { matched: true, answerHTML: tonePrefix(tone) + "Briefly describe the issue (1–3 sentences is perfect)." };
    }
    if (ticketCtx.stage === "needDescription") {
      ticketCtx.description = query.trim();
      ticketCtx.stage = "needUrgency";
      return { matched: true, answerHTML: tonePrefix(tone) + "How urgent is this?", chips: ["Low", "Normal", "High", "Critical"] };
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
      return { matched: true, answerHTML: summary, chips: ["Raise a request (create a ticket)"] };
    }
  }

  // Depot flow: stage needOrigin -> offer "Use my location"
  if (distanceCtx && distanceCtx.stage === "needOrigin") {
    if (q === "use my location" || q === "my location") {
      return { matched: true, answerHTML: tonePrefix(tone) + "Okay — please allow location access in your browser. One moment…", chips: null, doGeo: true };
    }
  }

  // Depot trigger
  if (q.includes("how far") || q.includes("distance") || q.includes("closest depot") || (q.includes("depot") && q.includes("closest"))) {
    const originKey = findPlaceKey(q);
    if (!originKey) {
      distanceCtx = { stage: "needOrigin" };
      return {
        matched: true,
        answerHTML: tonePrefix(tone) + "Certainly — what town/city are you travelling from? (Or choose <b>Use my location</b>.)",
        chips: ["Use my location", "Coventry", "Birmingham", "Leicester", "London"]
      };
    }

    memory.lastCity = originKey;
    saveMemory();

    const closest = findClosestDepot(PLACES[originKey]);
    if (!closest) {
      return { matched: true, answerHTML: tonePrefix(tone) + "I can do that once I know your starting town/city. Where are you travelling from?" };
    }

    const depot = DEPOTS[closest.depotKey];
    distanceCtx = { stage: "haveClosest", originKey, depotKey: closest.depotKey, miles: closest.miles };

    const modeInText = parseTravelMode(q) || memory.preferredMode;
    if (modeInText) {
      const minutes = estimateMinutes(closest.miles, modeInText);
      const url = googleDirectionsURL(titleCase(originKey), depot, modeInText);
      const mapImg = osmStaticMapURL(depot.lat, depot.lon, 13, 400, 220);

      return {
        matched: true,
        answerHTML:
          `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
          `From <b>${escapeHTML(titleCase(originKey))}</b> it’s approximately <b>${Math.round(closest.miles)} miles</b>.<br>` +
          `Estimated time ${escapeHTML(modeLabel(modeInText))} is around <b>${minutes} minutes</b>.<br>` +
          `<a href="${escapeAttrUrl(url)}">Get directions in Google Maps</a>` +
          `<br><img class="map-preview" src="${escapeAttrUrl(mapImg)}" alt="Map preview">`,
        chips: ["By car", "By train", "By bus", "Walking"]
      };
    }

    return {
      matched: true,
      answerHTML:
        `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
        `From <b>${escapeHTML(titleCase(originKey))}</b> it’s approximately <b>${Math.round(closest.miles)} miles</b>.<br>` +
        `How are you travelling?`,
      chips: ["By car", "By train", "By bus", "Walking"]
    };
  }

  // Depot: choose travel mode after closest
  if (distanceCtx && distanceCtx.stage === "haveClosest") {
    if (q === "by car" || q === "by train" || q === "by bus" || q === "walking") {
      const mode = (q === "walking") ? "walk" : q.replace("by ", "");
      memory.preferredMode = mode;
      saveMemory();

      const depot = DEPOTS[distanceCtx.depotKey];
      const minutes = estimateMinutes(distanceCtx.miles, mode);
      const originLabel = distanceCtx.originKey ? titleCase(distanceCtx.originKey) : "your location";

      const url = googleDirectionsURL(originLabel, depot, mode);
      const mapImg = osmStaticMapURL(depot.lat, depot.lon, 13, 400, 220);

      return {
        matched: true,
        answerHTML:
          `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
          `From <b>${escapeHTML(originLabel)}</b> it’s approximately <b>${Math.round(distanceCtx.miles)} miles</b>.<br>` +
          `Estimated time ${escapeHTML(modeLabel(mode))} is around <b>${minutes} minutes</b>.<br>` +
          `<a href="${escapeAttrUrl(url)}">Get directions in Google Maps</a>` +
          `<br><img class="map-preview" src="${escapeAttrUrl(mapImg)}" alt="Map preview">`,
        chips: ["By car", "By train", "By bus", "Walking"]
      };
    }
  }

  // Location question -> add map preview
  if (q.includes("where are you") || q.includes("location") || q.includes("address")) {
    const depot = DEPOTS.nuneaton;
    const mapImg = osmStaticMapURL(depot.lat, depot.lon, 13, 400, 220);
    const gmaps = googleMapsPlaceURL(depot.lat, depot.lon);
    return {
      matched: true,
      answerHTML:
        `We’re based in <b>Nuneaton, UK</b>. Visits are by appointment only.<br>` +
        `<a href="${escapeAttrUrl(gmaps)}">Open in Google Maps</a>` +
        `<br><img class="map-preview" src="${escapeAttrUrl(mapImg)}" alt="Map preview">`,
      chips: ["Is there parking?", "How can I contact support?"]
    };
  }

  // Parking
  if (q.includes("parking") || q.includes("car park")) {
    return { matched: true, answerHTML: "Yes — we have <b>visitor parking</b>. Spaces can be limited during busy times." };
  }

  return null;
}

/* ===============================================================
   MAIN handler
================================================================ */
function handleUserMessage(text) {
  if (!text) return;

  // hide suggestions once user sends
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

  setTimeout(async () => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot", { ts: new Date() });
      isResponding = false;
      setUIEnabled(true);
      input.focus();
      return;
    }

    const corr = correctQueryTokens(text);
    const norm0 = corr.changed && corr.corrected ? corr.corrected : text;
    const canon = rephraseQuery(norm0);

    // show “I understood…” line (but don’t speak it)
    const change = meaningChangeScore(normalize(text), normalize(canon));
    const canShowUnderstood = SETTINGS.showUnderstoodLine && canon && change >= SETTINGS.understoodLineThreshold;

    // Special cases
    const special = specialCases(text, tone);
    if (special && special.matched) {
      if (canShowUnderstood && !special.suppressUnderstood) {
        addBubble(`<small>I understood: <b>${escapeHTML(canon)}</b></small>`, "bot", { html: true, ts: new Date(), speak: false });
      }
      addBubble(tonePrefix(tone) + special.answerHTML, "bot", { html: true, ts: new Date() });
      if (special.chips && special.chips.length) addChips(special.chips);

      // Geolocation request path
      if (special.doGeo) {
        try {
          const loc = await requestBrowserLocation();
          const closest = findClosestDepot({ lat: loc.lat, lon: loc.lon });
          if (!closest) {
            addBubble("I couldn’t find a nearby depot from your location yet. Try a town/city instead.", "bot", { ts: new Date() });
          } else {
            const depot = DEPOTS[closest.depotKey];
            distanceCtx = { stage: "haveClosest", originKey: "your location", depotKey: closest.depotKey, miles: closest.miles };

            const mode = memory.preferredMode || "car";
            const minutes = estimateMinutes(closest.miles, mode);
            const url = googleDirectionsURL("your location", depot, mode);
            const mapImg = osmStaticMapURL(depot.lat, depot.lon, 13, 400, 220);

            addBubble(
              `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
              `Distance is approximately <b>${Math.round(closest.miles)} miles</b>.<br>` +
              `Estimated time ${escapeHTML(modeLabel(mode))} is around <b>${minutes} minutes</b>.<br>` +
              `<a href="${escapeAttrUrl(url)}">Get directions in Google Maps</a>` +
              `<br><img class="map-preview" src="${escapeAttrUrl(mapImg)}" alt="Map preview">`,
              "bot",
              { html: true, ts: new Date() }
            );

            addChips(["By car", "By train", "By bus", "Walking"]);
          }
        } catch (e) {
          addBubble("I couldn’t access your location. You can type a town/city instead (e.g., Coventry).", "bot", { ts: new Date() });
          addChips(["Coventry", "Birmingham", "Leicester", "London"]);
        }
      }

      missCount = 0;
      isResponding = false;
      setUIEnabled(true);
      input.focus();
      return;
    }

    // FAQ match
    let res = matchFAQ(canon);
    if (!res.matched && canon !== text) {
      const res2 = matchFAQ(text);
      if (res2.matched || (res2.suggestions?.length ?? 0) > (res.suggestions?.length ?? 0)) res = res2;
    }

    if (res.matched) {
      if (canShowUnderstood) addBubble(`<small>I understood: <b>${escapeHTML(canon)}</b></small>`, "bot", { html: true, ts: new Date(), speak: false });

      memory.lastTopic = (res.item?.category ?? memory.lastTopic);
      saveMemory();

      addBubble(tonePrefix(tone) + res.answerHTML, "bot", { html: true, ts: new Date() });

      if (res.followUps && res.followUps.length) {
        addBubble("You can also ask:", "bot", { ts: new Date() });
        addChips(res.followUps);
      }

      missCount = 0;
      clarifyCtx = null;
      lastMissQueryNorm = null;
    } else {
      missCount++;

      // store last miss for learning
      lastMissQueryNorm = normalize(canon || text);

      if (missCount === 1 && categories.length) {
        clarifyCtx = { stage: "needCategory", originalQuery: canon || text };
        addBubble(tonePrefix(tone) + "Quick check — what is this about?", "bot", { ts: new Date() });
        addChips(categories.map((c) => c.label));
      } else {
        addBubble(tonePrefix(tone) + "I’m not sure. Did you mean:", "bot", { ts: new Date() });

        // ✅ Learning: if they click a suggestion after a miss, remember mapping
        addChips(res.suggestions ?? [], (pickedQuestion) => {
          if (lastMissQueryNorm) rememberChoice(lastMissQueryNorm, pickedQuestion);
          handleUserMessage(pickedQuestion);
        });
      }

      if (missCount >= 2) {
        const mail = `mailto:${SETTINGS.supportEmail}`;
        const tel = `tel:${SETTINGS.supportPhone.replace(/\s+/g, "")}`;
        addBubble(
          `If you’d like, you can email <a href="${escapeAttrUrl(mail)}">${escapeHTML(SETTINGS.supportEmail)}</a> or call <b><a href="${escapeAttrUrl(tel)}">${escapeHTML(SETTINGS.supportPhone)}</a></b>.`,
          "bot",
          { html: true, ts: new Date() }
        );
        missCount = 0;
        clarifyCtx = null;
        lastMissQueryNorm = null;
      }
    }

    isResponding = false;
    setUIEnabled(true);
    input.focus();
  }, 280);
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
  journeyCtx = null;
  lastMissQueryNorm = null;
  CHAT_LOG = [];
  init();
  input.focus();
});

/* ===============================================================
   LOAD FAQS
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
   INIT
================================================================ */
function init() {
  addBubble(SETTINGS.greeting, "bot", { html: true, ts: new Date() });

  // starter chips include guided journeys + location
  addChips([
    "Access / Login",
    "Pay / Payroll",
    "Benefits",
    "Is anyone available now?",
    "Are you open on bank holidays?",
    "Get directions to my closest depot"
  ]);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

