
/* -------------------------------------------------------
   Welfare Support – Chat Engine (Clean Final + Time Fix + "Open in X")
   Features:
   - Safe UK time handling (no locale-string parsing bugs)
   - Availability: shows UK weekday/time + "opens in X minutes" when closed
   - FAQ matching with synonyms/keywords/tags + suggestions + follow-ups
   - AI-ish reasoning: tomorrow, parking, number again, Coventry, available now
   - Short-term context + Long-term memory (localStorage)
   - Timestamps under bubbles (UK time)
---------------------------------------------------------- */

const SETTINGS = {
  minConfidence: 0.20,
  topSuggestions: 3,
  boostSubstring: 0.12,
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, or where we’re located."
};

let FAQS = [];
let faqsLoaded = false;

// Business hours (UK local time)
const HOURS = {
  openHour: 8,
  openMinute: 30,
  closeHour: 17,
  closeMinute: 0
};

// Contact details (matches your FAQ content)
const CONTACT = {
  email: "support@Kelly.co.uk",
  phone: "01234 567890"
};

/* -------------------------------------------------------
   LONG-TERM MEMORY (localStorage)
---------------------------------------------------------- */
const MEM_KEY = "welfareSupportMemory";

let longTermMemory = {
  prefs: {},          // e.g., contactMethod: "email" | "phone"
  lastTopics: [],     // recent topics
  contactRequests: 0  // how often user asked for contact details
};

function loadMemory() {
  try {
    const saved = localStorage.getItem(MEM_KEY);
    if (saved) longTermMemory = JSON.parse(saved);
  } catch {}
}

function saveMemory() {
  try {
    localStorage.setItem(MEM_KEY, JSON.stringify(longTermMemory));
  } catch {}
}

function rememberTopic(topic) {
  if (!topic) return;
  longTermMemory.lastTopics.push(topic);
  if (longTermMemory.lastTopics.length > 10) longTermMemory.lastTopics.shift();
  saveMemory();
}

function rememberContactAccess() {
  longTermMemory.contactRequests++;
  saveMemory();
}

function setUserPreference(key, value) {
  longTermMemory.prefs[key] = value;
  saveMemory();
}

function getUserPreference(key) {
  return longTermMemory.prefs[key];
}

loadMemory();

/* -------------------------------------------------------
   SHORT-TERM MEMORY
---------------------------------------------------------- */
let memory = {
  lastUserMessages: [],
  lastMatchedTopic: null
};

function rememberUserMessage(text) {
  memory.lastUserMessages.push(text);
  if (memory.lastUserMessages.length > 5) memory.lastUserMessages.shift();
}

function updateTopic(topic) {
  memory.lastMatchedTopic = topic;
}

/* -------------------------------------------------------
   LOAD FAQS (GitHub Pages safe)
---------------------------------------------------------- */
fetch("public/config/faqs.json")
  .then(res => res.json())
  .then(data => {
    FAQS = data || [];
    faqsLoaded = true;
  })
  .catch(() => {
    FAQS = [];
    faqsLoaded = true;
  });

/* -------------------------------------------------------
   NORMALISATION HELPERS
---------------------------------------------------------- */
const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”‘’]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const tokenSet = (s) => new Set(normalize(s).split(" ").filter(Boolean));

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  const inter = new Set([...a].filter(x => b.has(x)));
  return inter.size / new Set([...a, ...b]).size;
};

/* -------------------------------------------------------
   SAFE UK TIME HELPERS (NO parsing of locale strings)
   - Uses Intl.DateTimeFormat(...).formatToParts(...)
---------------------------------------------------------- */

function getUKParts(date = new Date()) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = dtf.formatToParts(date);
  const get = (type) => parts.find(p => p.type === type)?.value;

  const weekday = get("weekday") || "";
  const year = parseInt(get("year") || "0", 10);
  const month = parseInt(get("month") || "1", 10);
  const day = parseInt(get("day") || "1", 10);
  const hour = parseInt(get("hour") || "0", 10);
  const minute = parseInt(get("minute") || "0", 10);

  return { weekday, year, month, day, hour, minute };
}

function getUKTimeHHMM() {
  const { hour, minute } = getUKParts();
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// Calculates timeZone offset in ms at a given instant (for Europe/London)
function tzOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});

  // Interpreting formatted parts as if they were UTC gives a comparable timestamp
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  // Offset is difference between that "asUTC" and the real UTC time
  return asUTC - date.getTime();
}

// Convert a UK-local date/time (year,month,day,hour,minute) to a UTC timestamp
function ukLocalToUtcMs({ year, month, day, hour, minute }) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offset = tzOffsetMs(utcGuess, "Europe/London");
  return utcGuess.getTime() - offset;
}

function isWeekendUK(weekdayName) {
  return weekdayName === "Saturday" || weekdayName === "Sunday";
}

function minutesUntil(msFuture) {
  return Math.max(0, Math.ceil((msFuture - Date.now()) / 60000));
}

/* -------------------------------------------------------
   NEXT OPEN TIME CALC (UK schedule)
   - If closed, returns next open datetime + minutes until open
---------------------------------------------------------- */
function getNextOpenInfo() {
  const now = new Date();
  const nowUK = getUKParts(now);

  const openMinutes = HOURS.openHour * 60 + HOURS.openMinute;
  const closeMinutes = HOURS.closeHour * 60 + HOURS.closeMinute;
  const nowMinutes = nowUK.hour * 60 + nowUK.minute;

  // helper: find next weekday date (UK) by stepping days
  function nextUKDateMatching(predicate) {
    // step in 24h increments; read UK parts each time
    let d = new Date(now.getTime());
    for (let i = 0; i < 14; i++) {
      const uk = getUKParts(d);
      if (predicate(uk)) return uk;
      d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    }
    return getUKParts(d);
  }

  // If it's a weekday and BEFORE open: next open is today 08:30
  if (!isWeekendUK(nowUK.weekday) && nowMinutes < openMinutes) {
    const nextOpenUtc = ukLocalToUtcMs({
      year: nowUK.year,
      month: nowUK.month,
      day: nowUK.day,
      hour: HOURS.openHour,
      minute: HOURS.openMinute
    });
    return {
      nextWeekday: nowUK.weekday,
      nextTime: `${String(HOURS.openHour).padStart(2, "0")}:${String(HOURS.openMinute).padStart(2, "0")}`,
      minutes: minutesUntil(nextOpenUtc)
    };
  }

  // If it's a weekday and AFTER close: next open is next weekday 08:30
  // If weekend: next open is Monday 08:30
  if (isWeekendUK(nowUK.weekday) || nowMinutes >= closeMinutes) {
    const next = nextUKDateMatching(uk => !isWeekendUK(uk.weekday) && (
      // if today is weekend, we want Monday; if after close on weekday, we want next day
      !(uk.year === nowUK.year && uk.month === nowUK.month && uk.day === nowUK.day)
    ));

    const nextOpenUtc = ukLocalToUtcMs({
      year: next.year,
      month: next.month,
      day: next.day,
      hour: HOURS.openHour,
      minute: HOURS.openMinute
    });

    return {
      nextWeekday: next.weekday,
      nextTime: `${String(HOURS.openHour).padStart(2, "0")}:${String(HOURS.openMinute).padStart(2, "0")}`,
      minutes: minutesUntil(nextOpenUtc)
    };
  }

  // Otherwise we are within business hours (open) -> no next-open countdown needed
  return null;
}

/* -------------------------------------------------------
   CONTEXT INFERENCE (follow-ups)
---------------------------------------------------------- */
function inferContext(query) {
  const q = normalize(query);

  // Learn preferences (lightweight)
  if (q.includes("prefer email") || q.includes("email me") || q.includes("by email")) {
    setUserPreference("contactMethod", "email");
  }
  if (q.includes("prefer phone") || q.includes("call me") || q.includes("by phone")) {
    setUserPreference("contactMethod", "phone");
  }

  // Weekend/bank holiday follow-up after opening times
  if (memory.lastMatchedTopic) {
    const last = normalize(memory.lastMatchedTopic);
    const mentionsWeekend = ["weekend", "weekends", "saturday", "sunday", "bank holiday", "holiday"].some(w => q.includes(w));
    if (mentionsWeekend && (last.includes("open") || last.includes("opening"))) {
      return {
        matched: true,
        answerHTML:
          "We’re <b>closed on weekends and bank holidays</b>.<br>" +
          "Hours: <b>Mon–Fri, 8:30–17:00</b>."
      };
    }
  }

  return null;
}

/* -------------------------------------------------------
   AI-ISH REASONING (no API)
---------------------------------------------------------- */
function aiReasoning(query) {
  const q = normalize(query);

  /* CONTACT DETAILS AGAIN / LOST */
  const asksContact = q.includes("number") || q.includes("phone") || q.includes("contact") || q.includes("email");
  const reAsk = q.includes("again") || q.includes("lost") || q.includes("remind") || q.includes("what is") || q.includes("whats") || q.includes("what’s");

  if (asksContact && reAsk) {
    rememberContactAccess();
    rememberTopic("contact support");
    updateTopic("How can I contact support?");
    const pref = getUserPreference("contactMethod");

    return {
      matched: true,
      answerHTML:
        "Here you go:<br><br>" +
        `<b>Email:</b> mailto:${CONTACT.email}${CONTACT.email}</a><br>` +
        `<b>Phone:</b> <b>${CONTACT.phone}</b>` +
        (pref ? `<br><br><small>I remember you prefer <b>${pref}</b>.</small>` : "")
    };
  }

  /* OPEN TOMORROW? (safe UK weekday display) */
  if (q.includes("tomorrow") || q.includes("open tomorrow")) {
    // Use a +24h instant and read its UK weekday
    const tomorrowInstant = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const tomorrowUK = getUKParts(tomorrowInstant);

    rememberTopic("opening times");

    if (isWeekendUK(tomorrowUK.weekday)) {
      return {
        matched: true,
        answerHTML:
          `Tomorrow is <b>${tomorrowUK.weekday}</b>, so we’re <b>closed</b>.<br>` +
          `Hours: <b>Mon–Fri, 8:30–17:00</b>.`
      };
    }

    return {
      matched: true,
      answerHTML:
        `Yes — tomorrow is <b>${tomorrowUK.weekday}</b>, so we’ll be open <b>8:30–17:00</b>.`
    };
  }

  /* PARKING */
  if (q.includes("parking") || q.includes("car park") || q.includes("park my car")) {
    rememberTopic("parking");
    return {
      matched: true,
      answerHTML:
        "Yes — we have <b>visitor parking</b> near our Nuneaton office. Spaces can be limited during busy times."
    };
  }

  /* DISTANCE FROM COVENTRY */
  if ((q.includes("coventry") || q.includes("cov")) && (q.includes("far") || q.includes("distance") || q.includes("how long"))) {
    rememberTopic("location");
    return {
      matched: true,
      answerHTML:
        "We’re in <b>Nuneaton</b>, about <b>8 miles</b> from Coventry — typically a <b>15–20 minute drive</b> depending on traffic."
    };
  }

  /* AVAILABLE NOW? + SHOW UK DAY/TIME + "OPEN IN X MINUTES" WHEN CLOSED */
  if (
    q.includes("available") ||
    q.includes("open now") ||
    q.includes("right now") ||
    q.includes("someone there") ||
    q.includes("anyone there")
  ) {
    const nowUK = getUKParts();
    const timeNow = `${String(nowUK.hour).padStart(2, "0")}:${String(nowUK.minute).padStart(2, "0")}`;

    const isWeekend = isWeekendUK(nowUK.weekday);
    const afterOpen = (nowUK.hour > HOURS.openHour) || (nowUK.hour === HOURS.openHour && nowUK.minute >= HOURS.openMinute);
    const beforeClose = (nowUK.hour < HOURS.closeHour) || (nowUK.hour === HOURS.closeHour && nowUK.minute < HOURS.closeMinute);

    rememberTopic("availability");

    // OPEN
    if (!isWeekend && afterOpen && beforeClose) {
      return {
        matched: true,
        answerHTML:
          `Yes — we’re currently <b>open</b> (UK time: <b>${nowUK.weekday} ${timeNow}</b>).<br>` +
          `Hours: <b>Mon–Fri, 8:30–17:00</b>.`
      };
    }

    // CLOSED -> show next open + minutes
    const next = getNextOpenInfo();
    if (next) {
      const mins = next.minutes;
      const pretty =
        mins <= 1 ? "in <b>1 minute</b>" : `in <b>${mins} minutes</b>`;

      return {
        matched: true,
        answerHTML:
          `Right now we appear to be <b>closed</b> (UK time: <b>${nowUK.weekday} ${timeNow}</b>).<br>` +
          `We open ${pretty} on <b>${next.nextWeekday}</b> at <b>${next.nextTime}</b>.<br>` +
          `Hours: <b>Mon–Fri, 8:30–17:00</b>.`
      };
    }

    // Fallback (should rarely happen)
    return {
      matched: true,
      answerHTML:
        `Right now we appear to be <b>closed</b> (UK time: <b>${nowUK.weekday} ${timeNow}</b>).<br>` +
        `Hours: <b>Mon–Fri, 8:30–17:00</b>.`
    };
  }

  return null;
}

/* -------------------------------------------------------
   FAQ MATCHING (synonyms + canonicalKeywords + tags)
---------------------------------------------------------- */
function matchFAQ(query) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(query);

  const results = [];

  for (const item of FAQS) {
    const question = item.question || "";
    const syns = item.synonyms || [];
    const keys = item.canonicalKeywords || [];
    const tags = item.tags || [];

    const scoreQ = jaccard(qTokens, tokenSet(question));
    const scoreSyn = syns.length ? Math.max(...syns.map(s => jaccard(qTokens, tokenSet(s)))) : 0;
    const scoreKeys = keys.length ? Math.max(...keys.map(k => jaccard(qTokens, tokenSet(k)))) : 0;
    const scoreTags = tags.length ? Math.max(...tags.map(t => jaccard(qTokens, tokenSet(t)))) : 0;

    const anyField = [question, ...syns, ...keys, ...tags].map(normalize).join(" ");
    const boost = anyField.includes(qNorm) ? SETTINGS.boostSubstring : 0;

    const score =
      (0.55 * scoreQ) +
      (0.25 * scoreSyn) +
      (0.12 * scoreKeys) +
      (0.08 * scoreTags) +
      boost;

    results.push({ item, score });
  }

  results.sort((a, b) => b.score - a.score);
  const top = results[0];

  if (!top || top.score < SETTINGS.minConfidence) {
    return {
      matched: false,
      suggestions: results.slice(0, SETTINGS.topSuggestions).map(r => r.item.question)
    };
  }

  return {
    matched: true,
    answerHTML: top.item.answer,
    question: top.item.question,
    followUps: top.item.followUps || []
  };
}

/* -------------------------------------------------------
   UI
---------------------------------------------------------- */
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

/**
 * Adds a message bubble with timestamp (UK time)
 * - User messages: safe text only
 * - Bot messages: allow HTML when isHTML=true
 */
function addBubble(text, type = "bot", isHTML = false) {
  const bubble = document.createElement("div");
  bubble.className = "bubble " + type;

  const content = document.createElement("div");
  content.className = "bubble-content";

  if (isHTML) content.innerHTML = text;
  else content.textContent = text;

  const timestamp = document.createElement("div");
  timestamp.className = "timestamp";
  timestamp.textContent = getUKTimeHHMM();

  bubble.appendChild(content);
  bubble.appendChild(timestamp);

  chatWindow.appendChild(bubble);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function addTyping() {
  const div = document.createElement("div");
  div.className = "bubble bot";
  div.setAttribute("data-typing", "true");

  const content = document.createElement("div");
  content.className = "bubble-content";
  content.innerHTML = `Typing <span class="typing"><span></span><span></span><span></span></span>`;

  // No timestamp on typing bubble
  div.appendChild(content);
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeTyping() {
  const t = chatWindow.querySelector('[data-typing="true"]');
  if (t) t.remove();
}

/* -------------------------------------------------------
   MAIN MESSAGE HANDLER
---------------------------------------------------------- */
function handleUserMessage(text) {
  if (!text) return;

  rememberUserMessage(text);
  addBubble(text, "user", false);
  input.value = "";

  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot", false);
      return;
    }

    // 1) Context inference first
    const contextual = inferContext(text);
    if (contextual && contextual.matched) {
      addBubble(contextual.answerHTML, "bot", true);
      return;
    }

    // 2) AI-ish reasoning
    const logic = aiReasoning(text);
    if (logic && logic.matched) {
      addBubble(logic.answerHTML, "bot", true);
      return;
    }

    // 3) FAQ matching fallback
    const res = matchFAQ(text);

    if (res.matched) {
      updateTopic(res.question);
      rememberTopic(res.question);

      addBubble(res.answerHTML, "bot", true);

      if (res.followUps && res.followUps.length) {
        const options = res.followUps.slice(0, 3).map(f => "• " + f).join("<br>");
        addBubble("You can also ask:<br>" + options, "bot", true);
      }
    } else {
      const suggestions =
        res.suggestions && res.suggestions.length
          ? "<br><br>• " + res.suggestions.join("<br>• ")
          : "";
      addBubble("I’m not sure. Did you mean:" + suggestions, "bot", true);
    }
  }, 350);
}

function sendChat() {
  handleUserMessage(input.value.trim());
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

sendBtn.addEventListener("click", sendChat);

window.addEventListener("DOMContentLoaded", () => {
  addBubble(SETTINGS.greeting, "bot", true);
});
