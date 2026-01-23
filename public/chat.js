
/* -------------------------------------------------------
   Welfare Support – Chat Engine (UK Time + Chips + Anti-Spam)
---------------------------------------------------------- */

const SETTINGS = {
  minConfidence: 0.20,
  topSuggestions: 3,
  boostSubstring: 0.12,
  chipLimit: 6,
  chipClickCooldownMs: 900,   // anti-spam cooldown
  greeting:
    'Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, or where we’re located.'
};

let FAQS = [];
let faqsLoaded = false;

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
fetch("./public/config/faqs.json")
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
   UK TIME HELPERS (Robust)
---------------------------------------------------------- */
const UK_TZ = "Europe/London";

function getUKParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return {
    weekday: map.weekday,  // "Mon", "Tue", ...
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

function ukWeekdayNumber(weekdayShort) {
  const lookup = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return lookup[weekdayShort] ?? 0;
}

function minutesSinceMidnight(h, m) {
  return (h * 60) + m;
}

function isOpenNowUK() {
  const uk = getUKParts();
  const day = ukWeekdayNumber(uk.weekday);
  const mins = minutesSinceMidnight(uk.hour, uk.minute);

  const isWeekend = (day === 0 || day === 6);
  const openMins = minutesSinceMidnight(8, 30);
  const closeMins = minutesSinceMidnight(17, 0);

  // Open if >= 08:30 and < 17:00
  const openNow = (!isWeekend && mins >= openMins && mins < closeMins);
  return { openNow, uk };
}

function willBeOpenTomorrowUK() {
  const uk = getUKParts(new Date());

  // Create a safe UTC date at noon to avoid DST edges
  const safeUTC = new Date(Date.UTC(uk.year, uk.month - 1, uk.day, 12, 0, 0));
  safeUTC.setUTCDate(safeUTC.getUTCDate() + 1);

  const ukTomorrow = getUKParts(safeUTC);
  const day = ukWeekdayNumber(ukTomorrow.weekday);
  const isWeekend = (day === 0 || day === 6);

  return { isWeekend, ukTomorrow };
}

/* -------------------------------------------------------
   CONTEXT INFERENCE
---------------------------------------------------------- */
function inferContext(query) {
  const q = normalize(query);

  if (q.includes("prefer email") || q.includes("email me"))
    setUserPreference("contactMethod", "email");

  if (q.includes("prefer phone") || q.includes("call me"))
    setUserPreference("contactMethod", "phone");

  // Follow-up weekend/holiday Qs
  if (memory.lastMatchedTopic) {
    const last = normalize(memory.lastMatchedTopic);
    const mentionsWeekend = ["weekend", "saturday", "sunday", "bank holiday"]
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
  const asksContact =
    q.includes("number") ||
    q.includes("phone") ||
    q.includes("contact") ||
    q.includes("email");

  if (asksContact && (q.includes("again") || q.includes("lost") || q.includes("remind"))) {
    rememberContactAccess();
    rememberTopic("contact support");
    updateTopic("How can I contact support?");

    const pref = getUserPreference("contactMethod");
    return {
      matched: true,
      answerHTML:
        "Here you go:<br><br>" +
        `<b>Email:</b> <a href="mailto:support@Kelly.co.uk">support@Kelly.co.uk</a><br>` +
        "<b>Phone:</b> 01234 567890" +
        (pref ? `<br><br><small>I remember you prefer <b>${pref}</b>.</small>` : "")
    };
  }

  /* OPEN TOMORROW? */
  if (q.includes("tomorrow")) {
    const t = willBeOpenTomorrowUK();
    rememberTopic("opening times");

    if (t.isWeekend) {
      return {
        matched: true,
        answerHTML:
          "Tomorrow is a <b>weekend</b>, so we’re closed.<br>Hours: <b>Mon–Fri, 8:30–17:00</b>."
      };
    }

    return {
      matched: true,
      answerHTML: "Yes — tomorrow is a weekday, so we’ll be open <b>8:30–17:00</b>."
    };
  }

  /* PARKING */
  if (q.includes("parking") || q.includes("car park")) {
    rememberTopic("parking");
    return {
      matched: true,
      answerHTML:
        "Yes — we have <b>visitor parking</b> near our Nuneaton office. Spaces can be limited during busy times."
    };
  }

  /* DISTANCE FROM COVENTRY */
  if (q.includes("coventry") || (q.includes("cov") && q.includes("far"))) {
    rememberTopic("location");
    return {
      matched: true,
      answerHTML:
        "We’re in <b>Nuneaton</b>, about <b>8 miles</b> from Coventry — a <b>15–20 minute drive</b>."
    };
  }

  /* AVAILABILITY RIGHT NOW */
  if (
    q.includes("available") ||
    q.includes("open now") ||
    q.includes("right now") ||
    q.includes("someone there") ||
    q.includes("anyone there")
  ) {
    const status = isOpenNowUK();
    rememberTopic("availability");

    if (status.openNow) {
      return {
        matched: true,
        answerHTML:
          "Yes — we’re currently <b>open</b> and staff should be available.<br>Hours: <b>Mon–Fri, 8:30–17:00</b>."
      };
    }

    return {
      matched: true,
      answerHTML:
        "Right now we appear to be <b>closed</b>.<br>Hours: <b>Mon–Fri, 8:30–17:00</b>."
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

    const anyField = [q, ...syns, ...keys, ...tags].map(normalize).join(" ");
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
   UI FUNCTIONS + ANTI-SPAM STATE
---------------------------------------------------------- */
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

// Prevent chip spam while bot is responding
let isResponding = false;
let lastChipClickAt = 0;

function setUIEnabled(enabled) {
  // input + send
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;

  // any chips currently shown
  const chips = chatWindow.querySelectorAll(".chip-btn");
  chips.forEach(btn => (btn.disabled = !enabled));
}

function addBubble(text, type = "bot", isHTML = false) {
  const div = document.createElement("div");
  div.className = "bubble " + type;
  div[isHTML ? "innerHTML" : "textContent"] = text;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function addTyping() {
  const div = document.createElement("div");
  div.className = "bubble bot";
  div.setAttribute("data-typing", "true");
  div.innerHTML = `Typing <span class="typing"><span></span><span></span><span></span></span>`;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeTyping() {
  const t = chatWindow.querySelector('[data-typing="true"]');
  if (t) t.remove();
}

/**
 * Adds suggested question chips.
 * Anti-spam:
 * - chips are disabled while bot is responding
 * - clicking one disables the entire chip set immediately
 * - cooldown blocks rapid double clicks
 */
function addChips(questions = []) {
  if (!questions.length) return;

  const wrap = document.createElement("div");
  wrap.className = "chips";

  const list = questions.slice(0, SETTINGS.chipLimit);

  list.forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn";
    b.textContent = q;

    b.addEventListener("click", () => {
      const now = Date.now();

      // Cooldown and responding lock
      if (isResponding) return;
      if (now - lastChipClickAt < SETTINGS.chipClickCooldownMs) return;
      lastChipClickAt = now;

      // Disable ALL chips in this wrap immediately (prevents spam)
      wrap.querySelectorAll(".chip-btn").forEach(btn => (btn.disabled = true));

      // Send chip text
      handleUserMessage(q);

      // Keep focus in input after
      input.focus();
    });

    wrap.appendChild(b);
  });

  // If bot is responding right now, make chips disabled immediately
  if (isResponding) {
    wrap.querySelectorAll(".chip-btn").forEach(btn => (btn.disabled = true));
  }

  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* -------------------------------------------------------
   MAIN MESSAGE HANDLER
---------------------------------------------------------- */
function handleUserMessage(text) {
  if (!text) return;

  rememberUserMessage(text);
  addBubble(text, "user");
  input.value = "";

  // Lock UI to prevent spam while bot responds
  isResponding = true;
  setUIEnabled(false);

  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot");
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    // 1) Context inference
    const contextual = inferContext(text);
    if (contextual && contextual.matched) {
      addBubble(contextual.answerHTML, "bot", true);
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    // 2) AI reasoning
    const logic = aiReasoning(text);
    if (logic && logic.matched) {
      addBubble(logic.answerHTML, "bot", true);
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    // 3) FAQ matching
    const res = matchFAQ(text);

    if (res.matched) {
      updateTopic(res.question);
      rememberTopic(res.question);

      addBubble(res.answerHTML, "bot", true);

      // Follow-up chips (buttons)
      if (res.followUps && res.followUps.length) {
        addBubble("You can also ask:", "bot");
        addChips(res.followUps);
      }
    } else {
      addBubble("I’m not sure. Did you mean:", "bot");
      addChips(res.suggestions || []);
    }

    // Unlock UI after response has been printed
    isResponding = false;
    setUIEnabled(true);

  }, 350);
}

function sendChat() {
  if (isResponding) return; // extra guard
  handleUserMessage(input.value.trim());
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

sendBtn.addEventListener("click", sendChat);

function init() {
  addBubble(SETTINGS.greeting, "bot", true);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
