
/* -------------------------------------------------------
   Welfare Support – Chat Engine (Clean Final + UI Enhancements)
   Includes:
   - Timestamps under bubbles
   - FAQ matching with synonyms/tags/keywords
   - AI-ish reasoning (tomorrow, parking, number again, Coventry, available now)
   - Short-term memory (context)
   - Long-term memory (localStorage)
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
   TIME HELPERS (UK time + HH:MM formatting)
---------------------------------------------------------- */
function getUKTimeHHMM() {
  const now = new Date();
  const uk = new Date(now.toLocaleString("en-GB", { timeZone: "Europe/London" }));
  const hh = String(uk.getHours()).padStart(2, "0");
  const mm = String(uk.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function getUKDateObj() {
  const now = new Date();
  return new Date(now.toLocaleString("en-GB", { timeZone: "Europe/London" }));
}

/* -------------------------------------------------------
   CONTEXT INFERENCE (follow-ups)
---------------------------------------------------------- */
function inferContext(query) {
  const q = normalize(query);

  // Learn preference
  if (q.includes("prefer email") || q.includes("email me") || q.includes("by email")) {
    setUserPreference("contactMethod", "email");
  }
  if (q.includes("prefer phone") || q.includes("call me") || q.includes("by phone")) {
    setUserPreference("contactMethod", "phone");
  }

  // Weekend follow-up after opening times
  if (memory.lastMatchedTopic) {
    const last = normalize(memory.lastMatchedTopic);

    const mentionsWeekend = ["weekend", "weekends", "saturday", "sunday", "bank holiday", "holiday"]
      .some(w => q.includes(w));

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
        "<b>Email:</b> <a href=\"mailto:support@Kelly.co.uk\">support@Kelly.co.uk</a><br>" +
        "<b>Phone:</b> <b>01234 567890</b>" +
        (pref ? `<br><br><small>I remember you prefer <b>${pref}</b>.</small>` : "")
    };
  }

  /* OPEN TOMORROW? */
  if (q.includes("tomorrow") || q.includes("open tomorrow")) {
    const ukNow = getUKDateObj();
    const tomorrow = new Date(ukNow);
    tomorrow.setDate(ukNow.getDate() + 1);

    const day = tomorrow.getDay(); // 0 Sun, 6 Sat
    rememberTopic("opening times");

    if (day === 0 || day === 6) {
      return {
        matched: true,
        answerHTML:
          "Tomorrow is a <b>weekend</b>, so we’re closed.<br>" +
          "Hours: <b>Mon–Fri, 8:30–17:00</b>."
      };
    }

    return {
      matched: true,
      answerHTML:
        "Yes — tomorrow is a weekday, so we’ll be open <b>8:30–17:00</b>."
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

  /* AVAILABLE NOW? (UK business hours Mon–Fri 08:30–17:00) */
  if (q.includes("available") || q.includes("open now") || q.includes("right now") || q.includes("someone there") || q.includes("anyone there")) {
    const uk = getUKDateObj();
    const day = uk.getDay();   // 0 Sun, 6 Sat
    const hr = uk.getHours();
    const min = uk.getMinutes();

    const isWeekend = (day === 0 || day === 6);
    const afterOpen = (hr > 8) || (hr === 8 && min >= 30);
    const beforeClose = (hr < 17);

    rememberTopic("availability");

    if (!isWeekend && afterOpen && beforeClose) {
      return {
        matched: true,
        answerHTML:
          "Yes — we’re currently <b>open</b> and staff should be available.<br>" +
          "Hours: <b>Mon–Fri, 8:30–17:00</b>."
      };
    }

    return {
      matched: true,
      answerHTML:
        "Right now we appear to be <b>closed</b>.<br>" +
        "Hours: <b>Mon–Fri, 8:30–17:00</b>."
    };
  }

  return null;
}

/* -------------------------------------------------------
   FAQ MATCHING (supports synonyms + canonicalKeywords + tags)
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
 * Adds a message bubble with timestamp.
 * - For bot messages with HTML: pass isHTML=true
 * - For user messages: always safe textContent
 */
function addBubble(text, type = "bot", isHTML = false) {
  const bubble = document.createElement("div");
  bubble.className = "bubble " + type;

  const content = document.createElement("div");
  content.className = "bubble-content";

  if (isHTML) {
    content.innerHTML = text;
  } else {
    content.textContent = text;
  }

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

  // no timestamp for typing bubble
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

    // 1) Context inference
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

    // 3) FAQ matching
    const res = matchFAQ(text);

    if (res.matched) {
      updateTopic(res.question);
      rememberTopic(res.question);

      addBubble(res.answerHTML, "bot", true);

      // Follow-ups
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
