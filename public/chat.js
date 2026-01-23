
/* -------------------------------------------------------
   Welfare Support – Chat Engine (Upgraded)
   - FAQ matching
   - AI-ish reasoning
   - Context + short-term memory
   - Long-term memory via localStorage
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
  prefs: {},            // user preferences (e.g., contactMethod)
  lastTopics: [],       // recent topics discussed
  contactRequests: 0    // count of contact detail requests
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
   SHORT-TERM MEMORY + CONTEXT
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
   TEXT NORMALISATION + MATCHING HELPERS
---------------------------------------------------------- */
const normalize = (s) =>
  (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")            // accents
    .replace(/[“”‘’]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\p{L}\p{N}\s-]/gu, "") // letters/numbers/spaces/hyphens
    .replace(/\s+/g, " ")
    .trim();

const tokenSet = (s) => new Set(normalize(s).split(" ").filter(Boolean));

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  const inter = new Set([...a].filter(x => b.has(x)));
  return inter.size / new Set([...a, ...b]).size;
};

/* -------------------------------------------------------
   CONTEXT INFERENCE (follow-ups)
   Example: user asks "What about weekends?" after opening times.
---------------------------------------------------------- */
function inferContext(query) {
  const q = normalize(query);

  // Learn preference if user expresses it (very light inference)
  if (q.includes("email me") || q.includes("prefer email") || q.includes("by email")) {
    setUserPreference("contactMethod", "email");
  }
  if (q.includes("call me") || q.includes("prefer phone") || q.includes("by phone")) {
    setUserPreference("contactMethod", "phone");
  }

  // Follow-up weekend/holiday questions based on last topic
  if (memory.lastMatchedTopic) {
    const last = normalize(memory.lastMatchedTopic);

    const mentionsWeekend = ["weekend", "weekends", "saturday", "sunday", "bank holiday", "holiday"].some(w => q.includes(w));
    const mentionsTomorrow = q.includes("tomorrow") || q.includes("open tomorrow");

    if (mentionsWeekend && (last.includes("opening") || last.includes("open"))) {
      return {
        matched: true,
        answerHTML: "We’re currently <b>closed on weekends and bank holidays</b>. Our hours are <b>Mon–Fri, 8:30–17:00</b>.",
        contextual: true
      };
    }

    // If they just say "tomorrow" after a topic about hours, handle it here too
    if (mentionsTomorrow && (last.includes("opening") || last.includes("open"))) {
      // Let the AI reasoning handle the actual calendar logic:
      return { matched: false };
    }
  }

  return null;
}

/* -------------------------------------------------------
   ADVANCED AI-ISH REASONING (no API)
   - "Are you open tomorrow?"
   - "What's your number again?"
   - "Is there parking?"
   - "Are you far from Coventry?"
   - "Is anyone available now?"
---------------------------------------------------------- */
function aiReasoning(query) {
  const q = normalize(query);

  // 1) Contact details re-ask / lost number
  const asksContact =
    q.includes("number") ||
    q.includes("phone") ||
    q.includes("contact") ||
    (q.includes("lost") && (q.includes("number") || q.includes("contact"))) ||
    q.includes("email");

  const reAskWords = q.includes("again") || q.includes("remind") || q.includes("lost");

  if (asksContact && (reAskWords || q.includes("what is") || q.includes("whats") || q.includes("what’s"))) {
    rememberContactAccess();
    rememberTopic("contact support");
    updateTopic("How can I contact support?");
    return {
      matched: true,
      answerHTML:
        "Here you go:<br><br>" +
        "<b>Email:</b> <a href=\"mailto:support@Kelly.co.uk\">support@Kelly.co.uk</a><br>" +
        "<b>Phone:</b> <b>01234 567890</b>" +
        (getUserPreference("contactMethod")
          ? `<br><br><small>Tip: I remember you prefer <b>${getUserPreference("contactMethod")}</b>.</small>`
          : ""),
      reasoned: true
    };
  }

  // 2) “Are you open tomorrow?” (UK timezone)
  if (q.includes("tomorrow") || q.includes("open tomorrow")) {
    const now = new Date();
    const ukNow = new Date(now.toLocaleString("en-GB", { timeZone: "Europe/London" }));
    const tomorrow = new Date(ukNow);
    tomorrow.setDate(ukNow.getDate() + 1);

    const day = tomorrow.getDay(); // 0 Sun, 6 Sat
    const isWeekend = day === 0 || day === 6;

    rememberTopic("opening times");

    if (isWeekend) {
      return {
        matched: true,
        answerHTML:
          "Tomorrow is a <b>weekend</b>, so we’re <b>closed</b>.<br>" +
          "Our opening hours are <b>Mon–Fri, 8:30–17:00</b>.",
        reasoned: true
      };
    }

    return {
      matched: true,
      answerHTML:
        "Yes — tomorrow is a weekday, so we’ll be open <b>8:30–17:00</b>.",
      reasoned: true
    };
  }

  // 3) Parking
  if (q.includes("parking") || q.includes("car park") || q.includes("park my car") || q.includes("park")) {
    rememberTopic("parking");
    return {
      matched: true,
      answerHTML:
        "Yes — there is <b>visitor parking</b> available near our Nuneaton office. Spaces may be limited at busy times.",
      reasoned: true
    };
  }

  // 4) Distance from Coventry
  if ((q.includes("coventry") || q.includes("cov")) && (q.includes("far") || q.includes("distance") || q.includes("how long"))) {
    rememberTopic("location");
    return {
      matched: true,
      answerHTML:
        "We’re in <b>Nuneaton</b>, about <b>8 miles</b> from Coventry — typically a <b>15–20 minute drive</b> depending on traffic.",
      reasoned: true
    };
  }


// 5) Available right now? (UK timezone + business hours)
if (
  q.includes("available") ||
  q.includes("open now") ||
  q.includes("right now") ||
  q.includes("someone there") ||
  q.includes("anyone there")
) {
  const now = new Date();
  const uk = new Date(now.toLocaleString("en-GB", { timeZone: "Europe/London" }));

  const day = uk.getDay();        // 0 = Sunday, 6 = Saturday
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
        "Hours: <b>Mon–Fri, 8:30–17:00</b>.",
      reasoned: true
    };
  }

  return {
    matched: true,
    answerHTML:
      "Right now we appear to be <b>closed</b>.<br>" +
      "Hours: <b>Mon–Fri, 8:30–17:00</b>.<br>" +
      "Feel free to leave a message.",
    reasoned: true
  };
}



  return null;
}

/* -------------------------------------------------------
   FAQ MATCHING (supports synonyms, tags, canonicalKeywords)
---------------------------------------------------------- */
function matchFAQ(query) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(query);

  const results = [];

  for (const item of FAQS) {
    const question = item.question || "";
    const syns = (item.synonyms || []);
    const tags = (item.tags || []);
    const keys = (item.canonicalKeywords || []);

    const scoreQ = jaccard(qTokens, tokenSet(question));
    const scoreSyn = syns.length ? Math.max(...syns.map(s => jaccard(qTokens, tokenSet(s)))) : 0;
    const scoreTags = tags.length ? Math.max(...tags.map(t => jaccard(qTokens, tokenSet(t)))) : 0;
    const scoreKeys = keys.length ? Math.max(...keys.map(k => jaccard(qTokens, tokenSet(k)))) : 0;

    const anyField = [question, ...syns, ...tags, ...keys].map(normalize).join(" ");
    const boost = anyField.includes(qNorm) ? SETTINGS.boostSubstring : 0;

    // Weighted blend (question + synonyms strongest, then keywords/tags)
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

function addBubble(text, type = "bot", isHTML = false) {
  const div = document.createElement("div");
  div.className = "bubble " + type;
  if (isHTML) div.innerHTML = text;
  else div.textContent = text;
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

    // 1) Context inference first
    const contextual = inferContext(text);
    if (contextual && contextual.matched) {
      addBubble(contextual.answerHTML, "bot", true);
      return;
    }

    // 2) AI-ish reasoning (tomorrow, number again, parking, etc.)
    const logic = aiReasoning(text);
    if (logic && logic.matched) {
      addBubble(logic.answerHTML, "bot", true);
      return;
    }

    // 3) FAQ match fallback
    const res = matchFAQ(text);

    if (res.matched) {
      updateTopic(res.question);
      rememberTopic(res.question);

      addBubble(res.answerHTML, "bot", true);

      // Suggest follow-ups (optional)
      if (res.followUps && res.followUps.length) {
        const options = res.followUps.slice(0, 3).map(f => `• ${f}`).join("<br>");
        addBubble(`You can also ask:<br>${options}`, "bot", true);
      }
    } else {
      const suggestions = (res.suggestions && res.suggestions.length)
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
