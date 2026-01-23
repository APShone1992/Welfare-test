
/* -------------------------------------------------------
   Welfare Support – Chat Engine (Final Version)
   Includes:
   - Safe UK time handling
   - "Open now" + "Opens in X minutes"
   - Bubble timestamps
   - Auto-scroll FIX
   - FAQ matching + synonyms + keywords + tags
   - AI-ish reasoning
   - Short-term + long-term memory
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

// Business Hours
const HOURS = {
  openHour: 8,
  openMinute: 30,
  closeHour: 17,
  closeMinute: 0
};

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
   LOAD FAQS
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
   SAFEST UK TIME HANDLING
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

// Get time as HH:MM UK-local
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

  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
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

function isWeekend(dayName) {
  return dayName === "Saturday" || dayName === "Sunday";
}

function minutesUntil(msFuture) {
  return Math.max(0, Math.ceil((msFuture - Date.now()) / 60000));
}

/* -------------------------------------------------------
   NEXT OPEN LOGIC
---------------------------------------------------------- */
function getNextOpenInfo() {
  const now = new Date();
  const nowUK = getUKParts(now);

  const currentMins = nowUK.hour * 60 + nowUK.minute;
  const openMins = HOURS.openHour * 60 + HOURS.openMinute;
  const closeMins = HOURS.closeHour * 60 + HOURS.closeMinute;

  function findNextWeekday() {
    let test = new Date(now);
    for (let i = 0; i < 14; i++) {
      const uk = getUKParts(test);
      if (!isWeekend(uk.weekday)) return uk;
      test = new Date(test.getTime() + 86400000);
    }
    return getUKParts(test);
  }

  // Before opening today
  if (!isWeekend(nowUK.weekday) && currentMins < openMins) {
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

  // After closing or weekend → next weekday
  if (isWeekend(nowUK.weekday) || currentMins >= closeMins) {
    const next = findNextWeekday();

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

  return null;
}

/* -------------------------------------------------------
   CONTEXT INFERENCE
---------------------------------------------------------- */
function inferContext(query) {
  const q = normalize(query);

  if (q.includes("prefer email")) setUserPreference("contactMethod", "email");
  if (q.includes("prefer phone")) setUserPreference("contactMethod", "phone");

  if (memory.lastMatchedTopic) {
    const last = normalize(memory.lastMatchedTopic);

    const mentionsWeekend = ["weekend","saturday","sunday","bank holiday"]
      .some(w => q.includes(w));

    if (mentionsWeekend && last.includes("open")) {
      return {
        matched: true,
        answerHTML:
          "We’re <b>closed on weekends and bank holidays</b>.<br>Hours: <b>Mon–Fri, 8:30–17:00</b>."
      };
    }
  }

  return null;
}

/* -------------------------------------------------------
   AI-ISH REASONING
---------------------------------------------------------- */
function aiReasoning(query) {
  const q = normalize(query);

  /* CONTACT DETAILS AGAIN */
  const asksContact = q.includes("number") || q.includes("phone") || q.includes("contact") || q.includes("email");
  const reAsk = q.includes("again") || q.includes("lost") || q.includes("remind") || q.includes("what is");

  if (asksContact && reAsk) {
    rememberContactAccess();
    rememberTopic("contact");
    updateTopic("contact");

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

  /* OPEN TOMORROW? */
  if (q.includes("tomorrow")) {
    const tomorrow = new Date(Date.now() + 86400000);
    const tUK = getUKParts(tomorrow);

    if (isWeekend(tUK.weekday)) {
      return {
        matched: true,
        answerHTML:
          `Tomorrow is <b>${tUK.weekday}</b>, so we’re closed.<br>Hours: <b>Mon–Fri, 8:30–17:00</b>.`
      };
    }

    return {
      matched: true,
      answerHTML:
        `Yes — tomorrow is <b>${tUK.weekday}</b>, so we’ll be open <b>08:30–17:00</b>.`
    };
  }

  /* PARKING */
  if (q.includes("parking") || q.includes("car park")) {
    return {
      matched: true,
      answerHTML:
        "Yes — visitor parking is available near our Nuneaton office. Spaces may be limited at busy times."
    };
  }

  /* DISTANCE FROM COVENTRY */
  if ((q.includes("coventry") || q.includes("cov")) && q.includes("far")) {
    return {
      matched: true,
      answerHTML:
        "We’re in <b>Nuneaton</b>, about <b>8 miles</b> from Coventry — typically a <b>15–20 minute drive</b>."
    };
  }

  /* AVAILABLE NOW? */
  if (q.includes("available") || q.includes("open now") || q.includes("right now")) {
    const nowUK = getUKParts();
    const timeNow = `${String(nowUK.hour).padStart(2, "0")}:${String(nowUK.minute).padStart(2, "0")}`;

    const isWk = isWeekend(nowUK.weekday);
    const afterOpen = nowUK.hour > HOURS.openHour || (nowUK.hour === HOURS.openHour && nowUK.minute >= HOURS.openMinute);
    const beforeClose = nowUK.hour < HOURS.closeHour;

    if (!isWk && afterOpen && beforeClose) {
      return {
        matched: true,
        answerHTML:
          `Yes — we're <b>open</b> right now.<br>` +
          `UK time: <b>${nowUK.weekday} ${timeNow}</b><br>` +
          `Hours: <b>Mon–Fri, 8:30–17:00</b>.`
      };
    }

    // CLOSED → show "opens in X minutes"
    const next = getNextOpenInfo();
    return {
      matched: true,
      answerHTML:
        `We're currently <b>closed</b> (UK time: <b>${nowUK.weekday} ${timeNow}</b>).<br>` +
        `We open <b>in ${next.minutes} minutes</b> on <b>${next.nextWeekday}</b> at <b>${next.nextTime}</b>.<br>` +
        `Hours: <b>Mon–Fri, 8:30–17:00</b>.`
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

  const results = [];

  for (const item of FAQS) {
    const q = item.question || "";
    const syns = item.synonyms || [];
    const keys = item.canonicalKeywords || [];
    const tags = item.tags || [];

    const scoreQ = jaccard(qTokens, tokenSet(q));
    const scoreSyn = syns.length ? Math.max(...syns.map(s => jaccard(qTokens, tokenSet(s)))) : 0;
    const scoreKeys = keys.length ? Math.max(...keys.map(k => jaccard(qTokens, tokenSet(k)))) : 0;
    const scoreTags = tags.length ? Math.max(...tags.map(t => jaccard(qTokens, tokenSet(t)))) : 0;

    const anyField = [q, ...syns, ...keys, ...tags].join(" ");
    const boost = anyField.includes(qNorm) ? SETTINGS.boostSubstring : 0;

    const score =
      0.55 * scoreQ +
      0.25 * scoreSyn +
      0.12 * scoreKeys +
      0.08 * scoreTags +
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
   UI (bubbles, timestamps, auto-scroll fix)
---------------------------------------------------------- */
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

function scrollToBottom() {
  setTimeout(() => {
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }, 30); // ensures browser paints first
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
  div.setAttribute("data-typing", "true");

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
}

/* -------------------------------------------------------
   MAIN HANDLER
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

    // 1) Context inference
    const contextual = inferContext(text);
    if (contextual?.matched) {
      addBubble(contextual.answerHTML, "bot", true);
      return;
    }

    // 2) AI-ish reasoning
    const logic = aiReasoning(text);
    if (logic?.matched) {
      addBubble(logic.answerHTML, "bot", true);
      return;
    }

    // 3) FAQ fallback
    const res = matchFAQ(text);
    if (res.matched) {
      updateTopic(res.question);
      rememberTopic(res.question);

      addBubble(res.answerHTML, "bot", true);

      if (res.followUps.length) {
        const opts = res.followUps.map(f => "• " + f).join("<br>");
        addBubble("You can also ask:<br>" + opts, "bot", true);
      }
    } else {
      const s = res.suggestions.length
        ? "<br><br>• " + res.suggestions.join("<br>• ")
        : "";
      addBubble("I’m not sure. Did you mean:" + s, "bot", true);
    }
  }, 350);
}

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
