
// ------------------------------------------------------------
// Welfare Support – Upgraded FAQ Chat Engine
// ------------------------------------------------------------

const SETTINGS = {
  minConfidence: 0.24,
  topSuggestions: 4,
  boostSubstring: 0.10,
  boostExactPhrase: 0.16,
  typingDelayMs: 300,
  maxHistory: 80,
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, how to contact support, or where we’re located.",
  fallback:
    "I’m not sure I’ve got that yet. Try rephrasing, or choose one of these:",
  helpText:
    "You can ask about <b>opening times</b>, <b>contact</b>, or <b>location</b>.<br><br>" +
    "Commands:<br>• <b>help</b> – show this message<br>• <b>clear</b> – clear chat history<br>• <b>restart</b> – show the welcome message again"
};

let FAQS = [];
let faqsLoaded = false;

// Elements
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const chipRow = document.getElementById("chipRow");

// ---------------------------
// FAQ Load
// ---------------------------
async function loadFaqs() {
  try {
    const res = await fetch("public/config/faqs.json", { cache: "no-store" });
    if (!res.ok) throw new Error("FAQ fetch failed: " + res.status);
    const data = await res.json();
    FAQS = Array.isArray(data) ? data : [];
  } catch (e) {
    FAQS = [];
    console.warn(e);
  } finally {
    faqsLoaded = true;
    sendBtn.disabled = false;
    buildChips();
    if (!FAQS.length) {
      addBubble(
        "I couldn’t load the knowledge base right now. Please check your <b>public/config/faqs.json</b> path and try again.",
        "bot",
        true
      );
    }
  }
}
sendBtn.disabled = true;
loadFaqs();

// ---------------------------
// Normalization & similarity
// ---------------------------
const STOPWORDS = new Set([
  "a","an","the","and","or","but","to","of","in","on","at","for","from","by",
  "is","are","was","were","be","been","being","do","does","did",
  "i","me","my","you","your","we","our","us",
  "what","when","where","how","can","could","would","should",
  "please","tell"
]);

const normalize = (s) =>
  (s ?? "")
    .toString()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")            // accents
    .replace(/[“”‘’]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

function tokens(s) {
  return normalize(s)
    .split(" ")
    .filter(Boolean)
    .filter(t => !STOPWORDS.has(t));
}

function tokenSet(s) {
  return new Set(tokens(s));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// Dice coefficient with bigrams (good for phrase similarity)
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
    const n = map.get(y) || 0;
    if (n > 0) {
      matches++;
      map.set(y, n - 1);
    }
  }
  return (2 * matches) / (A.length + B.length);
}

// Light edit similarity (normalized Levenshtein) for short strings
function editSimilarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  const m = a.length, n = b.length;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,       // delete
        dp[j - 1] + 1,   // insert
        prev + cost      // substitute
      );
      prev = temp;
    }
  }
  const dist = dp[n];
  const maxLen = Math.max(m, n);
  return maxLen ? 1 - dist / maxLen : 0;
}

function fieldBoost(allFieldsNorm, qNorm) {
  if (!qNorm) return 0;
  if (allFieldsNorm === qNorm) return SETTINGS.boostExactPhrase;
  if (allFieldsNorm.includes(qNorm)) return SETTINGS.boostSubstring;
  return 0;
}

function scoreItem(query, item) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(query);

  const question = item.question ?? "";
  const syns = (item.synonyms ?? []);
  const tags = (item.tags ?? []);

  const scoreTokenQ = jaccard(qTokens, tokenSet(question));
  const scorePhraseQ = diceCoefficient(query, question);
  const scoreEditQ = editSimilarity(query, question);

  const synScore = syns.length
    ? Math.max(...syns.map(s => (
        0.55 * jaccard(qTokens, tokenSet(s)) +
        0.30 * diceCoefficient(query, s) +
        0.15 * editSimilarity(query, s)
      )))
    : 0;

  const tagScore = tags.length
    ? Math.max(...tags.map(t => jaccard(qTokens, tokenSet(t))))
    : 0;

  const allFieldsNorm = normalize([question, ...syns, ...tags].join(" "));
  const boost = fieldBoost(allFieldsNorm, qNorm);

  // Weighted blend
  const score =
    0.42 * scoreTokenQ +
    0.34 * scorePhraseQ +
    0.10 * scoreEditQ +
    0.10 * synScore +
    0.04 * tagScore +
    boost;

  return score;
}

function matchFAQ(query) {
  const results = FAQS.map(item => ({
    item,
    score: scoreItem(query, item)
  })).sort((a, b) => b.score - a.score);

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
    confidence: top.score,
    suggestions: results.slice(1, SETTINGS.topSuggestions + 1).map(r => r.item.question)
  };
}

// ---------------------------
// HTML sanitiser (allowlist)
// ---------------------------
function sanitizeHTML(html) {
  const allowedTags = new Set([
    "A","B","STRONG","I","EM","BR","P","UL","OL","LI","SMALL","CODE","SPAN"
  ]);

  const allowedAttrs = {
    "A": new Set(["href","target","rel"])
  };

  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html ?? ""), "text/html");

  // Remove dangerous nodes
  doc.querySelectorAll("script, style, iframe, object, embed").forEach(n => n.remove());

  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, null);
  const toProcess = [];
  while (walker.nextNode()) toProcess.push(walker.currentNode);

  for (const el of toProcess) {
    if (!allowedTags.has(el.tagName)) {
      // Replace disallowed element with its text content
      const text = doc.createTextNode(el.textContent || "");
      el.replaceWith(text);
      continue;
    }

    // Strip attributes (except allowlist)
    [...el.attributes].forEach(attr => {
      const tagAllowed = allowedAttrs[el.tagName];
      if (!tagAllowed || !tagAllowed.has(attr.name.toLowerCase())) {
        el.removeAttribute(attr.name);
      }
    });

    // Safe link handling
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      const safe = /^(https?:\/\/|mailto:|tel:)/i.test(href);
      if (!safe) el.removeAttribute("href");
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }

  return doc.body.innerHTML;
}

// ---------------------------
// UI helpers
// ---------------------------
function timeStamp() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addBubble(text, type = "bot", isHTML = false, persist = true) {
  const div = document.createElement("div");
  div.className = "bubble " + type;

  if (isHTML) {
    div.innerHTML = sanitizeHTML(text);
  } else {
    div.textContent = text;
  }

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = timeStamp();
  div.appendChild(meta);

  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  if (persist) saveToHistory({ type, text, isHTML });
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

function addSuggestions(suggestions) {
  if (!suggestions || !suggestions.length) return;

  const wrap = document.createElement("div");
  wrap.className = "bubble bot";
  wrap.innerHTML = sanitizeHTML(
    `${SETTINGS.fallback}<br><br>` +
    suggestions.map(s => `• <a href="#" data-suggest="${encodeURIComponent(s)}">${s}</a>`).join("<br>")
  );

  wrap.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-suggest]");
    if (!a) return;
    e.preventDefault();
    const q = decodeURIComponent(a.getAttribute("data-suggest"));
    handleUserMessage(q);
  });

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = timeStamp();
  wrap.appendChild(meta);

  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
  saveToHistory({ type: "bot", text: wrap.innerHTML, isHTML: true });
}

// ---------------------------
// Chips (quick replies)
// ---------------------------
function buildChips() {
  chipRow.innerHTML = "";
  if (!FAQS.length) return;

  const top = FAQS.slice(0, 3).map(f => f.question);
  top.forEach(q => {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = q;
    b.addEventListener("click", () => handleUserMessage(q));
    chipRow.appendChild(b);
  });
}

// ---------------------------
// History (localStorage)
// ---------------------------
const HISTORY_KEY = "welfare_support_chat_history_v2";

function saveToHistory(msg) {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    arr.push({ ...msg, ts: Date.now() });
    const trimmed = arr.slice(-SETTINGS.maxHistory);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(trimmed));
  } catch (_) {}
}

function restoreHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(arr) || !arr.length) return false;

    arr.forEach(m => addBubble(m.text, m.type, !!m.isHTML, false));
    return true;
  } catch (_) {
    return false;
  }
}

function clearHistory() {
  try { localStorage.removeItem(HISTORY_KEY); } catch (_) {}
  chatWindow.innerHTML = "";
}

// ---------------------------
// Message handler
// ---------------------------
function handleUserMessage(text) {
  const cleaned = (text ?? "").trim();
  if (!cleaned) return;

  addBubble(cleaned, "user", false);
  input.value = "";

  const cmd = normalize(cleaned);
  if (cmd === "clear") {
    addTyping();
    setTimeout(() => {
      removeTyping();
      clearHistory();
      addBubble("Cleared. What would you like to ask?", "bot", false);
    }, 250);
    return;
  }

  if (cmd === "help") {
    addTyping();
    setTimeout(() => {
      removeTyping();
      addBubble(SETTINGS.helpText, "bot", true);
    }, SETTINGS.typingDelayMs);
    return;
  }

  if (cmd === "restart") {
    addTyping();
    setTimeout(() => {
      removeTyping();
      addBubble(SETTINGS.greeting, "bot", true);
    }, SETTINGS.typingDelayMs);
    return;
  }

  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot");
      return;
    }

    if (!FAQS.length) {
      addBubble("I can’t answer yet because the FAQ list didn’t load.", "bot");
      return;
    }

    const res = matchFAQ(cleaned);

    if (res.matched) {
      addBubble(res.answerHTML, "bot", true);
      // Optional: show secondary suggestions after a match
      if (res.suggestions && res.suggestions.length) {
        addSuggestions(res.suggestions);
      }
    } else {
      addSuggestions(res.suggestions);
    }
  }, SETTINGS.typingDelayMs);
}

function sendChat() {
  handleUserMessage(input.value);
}

// Enter key to send
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

// Button click
sendBtn.addEventListener("click", sendChat);

// Initial greeting + restore history
window.addEventListener("DOMContentLoaded", () => {
  const restored = restoreHistory();
  if (!restored) addBubble(SETTINGS.greeting, "bot", true);
});
