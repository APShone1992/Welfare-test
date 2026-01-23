
/* -------------------------------------------------------
   Welfare Support – Chat Engine (Final Version)
   Includes:
   - UK Time handling (safe)
   - Auto-scroll via scrollIntoView (always works)
   - "Open now" + "Opens in X minutes"
   - Bubble timestamps
   - Short-term & long-term memory
   - FAQ search + synonyms + keywords + tags
   - AI-ish reasoning
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

// Business Hours (UK Local)
const HOURS = {
  openHour: 8,
  openMinute: 30,
  closeHour: 17,
  closeMinute: 0
};

// Contact Details
const CONTACT = {
  email: "support@Kelly.co.uk",
  phone: "01234 567890"
};

/* -------------------------------------------------------
   LONG-TERM MEMORY (localStorage)
---------------------------------------------------------- */
const MEM_KEY = "welfareSupportMemory";

let longTermMemory = {
  prefs: {},
  lastTopics: [],
  contactRequests: 0
};

function loadMemory() {
  try { const saved = localStorage.getItem(MEM_KEY); if (saved) longTermMemory = JSON.parse(saved); }
  catch {}
}

function saveMemory() {
  try { localStorage.setItem(MEM_KEY, JSON.stringify(longTermMemory)); }
  catch {}
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
   LOAD FAQ DATA
---------------------------------------------------------- */
fetch("public/config/faqs.json")
  .then(res => res.json())
  .then(data => { FAQS = data || []; faqsLoaded = true; })
  .catch(() => { FAQS = []; faqsLoaded = true; });

/* -------------------------------------------------------
   TEXT NORMALISATION
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
   SUPER SAFE UK TIME HANDLING
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

  return {
    weekday: get("weekday"),
    year: parseInt(get("year")),
    month: parseInt(get("month")),
    day: parseInt(get("day")),
    hour: parseInt(get("hour")),
    minute: parseInt(get("minute"))
  };
}

function getUKTimeHHMM() {
  const { hour, minute } = getUKParts();
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

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

  const parts = dtf.formatToParts(date).reduce((o, p) => {
    o[p.type] = p.value;
    return o;
  }, {});

  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );

  return asUTC - date.getTime();
}

function ukLocalToUtcMs({ year, month, day, hour, minute }) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset = tzOffsetMs(guess, "Europe/London");
  return guess.getTime() - offset;
}

function isWeekendUK(weekday) {
  return weekday === "Saturday" || weekday === "Sunday";
}

function minutesUntil(ms) {
  return Math.max(0, Math.ceil((ms - Date.now()) / 60000));
}

/* -------------------------------------------------------
   NEXT OPEN LOGIC
---------------------------------------------------------- */
function getNextOpenInfo() {
  const nowUK = getUKParts();
  const nowMs = Date.now();

  const nowMinutes = nowUK.hour * 60 + nowUK.minute;
  const openMinutes = HOURS.openHour * 60 + HOURS.openMinute;
  const closeMinutes = HOURS.closeHour * 60 + HOURS.closeMinute;

  function nextWeekdayStart() {
    let d = new Date();
    for (let i = 0; i < 14; i++) {
      const uk = getUKParts(d);
      if (!isWeekendUK(uk.weekday)) return uk;
      d = new Date(d.getTime() + 86400000);
    }
  }

  // Before opening today
  if (!isWeekendUK(nowUK.weekday) && nowMinutes < openMinutes) {
    const utc = ukLocalToUtcMs({
      year: nowUK.year,
      month: nowUK.month,
      day: nowUK.day,
      hour: HOURS.openHour,
      minute: HOURS.openMinute
    });

    return {
      nextWeekday: nowUK.weekday,
      nextTime: `${String(HOURS.openHour).padStart(2, "0")}:${String(HOURS.openMinute).padStart(2, "0")}`,
      minutes: minutesUntil(utc)
    };
  }

  // Weekend or after closing
  if (isWeekendUK(nowUK.weekday) || nowMinutes >= closeMinutes) {
    const next = nextWeekdayStart();
    const utc = ukLocalToUtcMs({
      year: next.year,
      month: next.month,
      day: next.day,
      hour: HOURS.openHour,
      minute: HOURS.openMinute
    });

    return {
      nextWeekday: next.weekday,
      nextTime: `${String(HOURS.openHour).padStart(2, "0")}:${String(HOURS.openMinute).padStart(2, "0")}`,
      minutes: minutesUntil(utc)
    };
  }

  return null;
}

/* -------------------------------------------------------
   CONTEXT INFERENCE
---------------------------------------------------------- */
function inferContext(text) {
  const q = normalize(text);

  if (q.includes("prefer email")) setUserPreference("contactMethod", "email");
  if (q.includes("prefer phone")) setUserPreference("contactMethod", "phone");

  if (memory.lastMatchedTopic) {
    const last = normalize(memory.lastMatchedTopic);

    if (["weekend","saturday","sunday","bank holiday"].some(w => q.includes(w))
        && last.includes("open")) {
      return {
        matched: true,
        answerHTML:
          "We’re <b>closed on weekends and bank holidays</b>.<br>Hours: <b>Mon–Fri 8:30–17:00</b>."
      };
    }
  }

  return null;
}

/* -------------------------------------------------------
   AI-ish Reasoning
---------------------------------------------------------- */
function aiReasoning(text) {
  const q = normalize(text);

  /* Contact details again / lost */
  const asksContact = q.includes("number") || q.includes("phone") || q.includes("contact") || q.includes("email");
  const reAsk = q.includes("again") || q.includes("lost") || q.includes("remind") || q.includes("what is");

  if (asksContact && reAsk) {
    rememberContactAccess();
    rememberTopic("contact");

    const pref = getUserPreference("contactMethod");

    return {
      matched: true,
      answerHTML:
        "Here you go:<br><br>" +
        `<b>Email:</b> <a href="mailto:${CONTACT.email}">${CONTACT.email}</a><br>` +
        `<b>Phone:</b> ${CONTACT.phone}` +
        (pref ? `<br><br><small>(I remember you prefer <b>${pref}</b>)</small>` : "")
    };
  }

  /* Tomorrow */
  if (q.includes("tomorrow")) {
    const tomorrow = new Date(Date.now() + 86400000);
    const tUK = getUKParts(tomorrow);

    if (isWeekendUK(tUK.weekday)) {
      return {
        matched: true,
        answerHTML:
          `Tomorrow is <b>${tUK.weekday}</b>, so we’re closed.<br>Hours: <b>Mon–Fri 8:30–17:00</b>.`
      };
    }

    return {
      matched: true,
      answerHTML:
        `Yes — tomorrow is <b>${tUK.weekday}</b>, so we’ll be open <b>08:30–17:00</b>.`
    };
  }

  /* Parking */
  if (q.includes("parking") || q.includes("car park")) {
    return {
      matched: true,
      answerHTML:
        "Yes — we offer visitor parking near our Nuneaton office. Spaces may be limited."
    };
  }

  /* Coventry distance */
  if ((q.includes("coventry") || q.includes("cov")) && q.includes("far")) {
    return {
      matched: true,
      answerHTML:
        "We’re in <b>Nuneaton</b>, around <b>8 miles</b> from Coventry — roughly a <b>15–20 minute</b> drive."
    };
  }

  /* Availability Now */
  if (q.includes("available") || q.includes("open now") || q.includes("right now")) {
    const uk = getUKParts();
    const timeNow = `${String(uk.hour).padStart(2,"0")}:${String(uk.minute).padStart(2,"0")}`;

    const isWk = isWeekendUK(uk.weekday);
    const afterOpen = uk.hour > HOURS.openHour ||
      (uk.hour === HOURS.openHour && uk.minute >= HOURS.openMinute);
    const beforeClose = uk.hour < HOURS.closeHour;

    if (!isWk && afterOpen && beforeClose) {
      return {
        matched: true,
        answerHTML:
          `Yes — we’re <b>open</b> right now.<br>` +
          `UK time: <b>${uk.weekday} ${timeNow}</b><br>` +
          `Hours: <b>Mon–Fri 8:30–17:00</b>.`
      };
    }

    const next = getNextOpenInfo();

    return {
      matched: true,
      answerHTML:
        `We’re currently <b>closed</b> (UK time: <b>${uk.weekday} ${timeNow}</b>).<br>` +
        `We open <b>in ${next.minutes} minutes</b> on <b>${next.nextWeekday}</b> at <b>${next.nextTime}</b>.<br>` +
        `Hours: <b>Mon–Fri 8:30–17:00</b>.`
    };
  }

  return null;
}

/* -------------------------------------------------------
   FAQ MATCHING
---------------------------------------------------------- */
function matchFAQ(query) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(query);

  const results = FAQS.map(item => {
    const scoreQ = jaccard(qTokens, tokenSet(item.question));
    const scoreSyn = item.synonyms?.length
      ? Math.max(...item.synonyms.map(s => jaccard(qTokens, tokenSet(s))))
      : 0;
    const scoreKeys = item.canonicalKeywords?.length
      ? Math.max(...item.canonicalKeywords.map(k => jaccard(qTokens, tokenSet(k))))
      : 0;
    const scoreTags = item.tags?.length
      ? Math.max(...item.tags.map(t => jaccard(qTokens, tokenSet(t))))
      : 0;

    const fieldsJoined = [item.question, ...(item.synonyms||[]), ...(item.canonicalKeywords||[]), ...(item.tags||[])]
      .join(" ");
    const boost = normalize(fieldsJoined).includes(qNorm) ? SETTINGS.boostSubstring : 0;

    return {
      item,
      score:
        (0.55 * scoreQ) +
        (0.25 * scoreSyn) +
        (0.12 * scoreKeys) +
        (0.08 * scoreTags) +
        boost
    };
  });

  results.sort((a, b) => b.score - a.score);

  if (!results[0] || results[0].score < SETTINGS.minConfidence) {
    return {
      matched: false,
      suggestions: results.slice(0, SETTINGS.topSuggestions).map(r => r.item.question)
    };
  }

  return {
    matched: true,
    answerHTML: results[0].item.answer,
    question: results[0].item.question,
    followUps: results[0].item.followUps || []
  };
}

/* -------------------------------------------------------
   UI (Auto-scroll FIX)
---------------------------------------------------------- */

const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

function scrollToBottom() {
  requestAnimationFrame(() => {
    const last = chatWindow.lastElementChild;
    if (last) {
      last.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  });
}

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
  scrollToBottom();
}

function addTyping() {
  const div = document.createElement("div");
  div.className = "bubble bot";
  div.dataset.typing = "true";

  const content = document.createElement("div");
  content.className = "bubble-content";
  content.innerHTML = `Typing <span class="typing"><span></span><span></span><span></span></span>`;

  div.appendChild(content);
  chatWindow.appendChild(div);
  scrollToBottom();
}

function removeTyping() {
  const t = chatWindow.querySelector('[data-typing="true"]');
  if (t) t.remove();
  scrollToBottom();
}

/* -------------------------------------------------------
   MAIN MESSAGE HANDLER
---------------------------------------------------------- */
function handleUserMessage(text) {
  if (!text) return;

  rememberUserMessage(text);
  addBubble(text, "user");
  input.value = "";

  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot");
      return;
    }

    // 1. Context inference
    const ctx = inferContext(text);
    if (ctx?.matched) {
      addBubble(ctx.answerHTML, "bot", true);
      return;
    }

    // 2. AI-ish reasoning
    const logic = aiReasoning(text);
    if (logic?.matched) {
      addBubble(logic.answerHTML, "bot", true);
      return;
    }

    // 3. FAQ matching
    const res = matchFAQ(text);
    if (res.matched) {
      updateTopic(res.question);
      rememberTopic(res.question);
      addBubble(res.answerHTML, "bot", true);

      if (res.followUps.length) {
        addBubble(
          "You can also ask:<br>" +
          res.followUps.map(f => "• " + f).join("<br>"),
          "bot",
            );
      }
    } else {
      addBubble(
        "I’m not sure. Did you mean:<br>• " +
        res.suggestions.join("<br>• "),
        "bot",
        true
      );
    }
  }, 400);
}

/* -------------------------------------------------------
   EVENT LISTENERS
---------------------------------------------------------- */
function sendChat() {
  handleUserMessage(input.value.trim());
}

input.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

sendBtn.addEventListener("click", sendChat);

window.addEventListener("DOMContentLoaded", () => {
  addBubble(SETTINGS.greeting, "bot", true);
});
