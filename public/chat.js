
// --------------------------------------
// Welfare Support – Improved Chat Engine
// --------------------------------------

const SETTINGS = {
  minConfidence: 0.24,          // slightly higher after better scoring
  topSuggestions: 4,
  boostSubstring: 0.14,
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask about opening times, contacting support, or where we’re located.<br><span class='meta'>Try: <b>topics</b>, <b>help</b>, or <b>clear</b>.</span>",
  storageKey: "ws_chat_history_v1",
  maxHistory: 60,
};

let FAQS = [];
let faqsLoaded = false;

// DOM
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

// Disable input until loaded
setInputEnabled(false);
addSystemNotice("Loading knowledge base…");

// Ensure the FAQ path matches repo structure (/public/config/faqs.json)
fetch("public/config/faqs.json", { cache: "no-store" })
  .then((res) => res.json())
  .then((data) => {
    FAQS = Array.isArray(data) ? data : [];
    faqsLoaded = true;
    removeSystemNotices();
    setInputEnabled(true);
    restoreHistory();
    if (!hasAnyMessages()) addBubble(SETTINGS.greeting, "bot", true);
  })
  .catch(() => {
    FAQS = [];
    faqsLoaded = true;
    removeSystemNotices();
    setInputEnabled(true);
    addBubble(
      "I couldn’t load the FAQ file. Make sure <b>public/config/faqs.json</b> exists and is valid JSON.",
      "bot",
      true
    );
  });

// ------------------------
// Matching / NLP helpers
// ------------------------

const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","can","could","do","for","from",
  "have","how","i","in","is","it","me","my","of","on","or","our","please","the",
  "their","there","to","us","we","what","when","where","who","why","will","with","you","your"
]);

const normalize = (s) =>
  (s ?? "")
    .toString()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // accents
    .replace(/[“”‘’]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokenize = (s) =>
  normalize(s)
    .split(" ")
    .filter(Boolean)
    .filter((t) => !STOPWORDS.has(t));

const tokenSet = (s) => new Set(tokenize(s));

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
};

function charNgrams(str, n = 3) {
  const s = normalize(str).replace(/\s+/g, " ");
  if (s.length < n) return new Set([s]);
  const out = new Set();
  for (let i = 0; i <= s.length - n; i++) out.add(s.slice(i, i + n));
  return out;
}

function ngramSimilarity(a, b) {
  const A = charNgrams(a, 3);
  const B = charNgrams(b, 3);
  return jaccard(A, B);
}

function scoreItem(query, item) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(query);

  const question = item.question ?? "";
  const answer = item.answer ?? "";
  const synonyms = Array.isArray(item.synonyms) ? item.synonyms : [];
  const tags = Array.isArray(item.tags) ? item.tags : [];

  const qScore = jaccard(qTokens, tokenSet(question));
  const synScore = synonyms.length
    ? Math.max(...synonyms.map((s) => jaccard(qTokens, tokenSet(s))))
    : 0;
  const tagScore = tags.length
    ? Math.max(...tags.map((t) => jaccard(qTokens, tokenSet(t))))
    : 0;

  const ngramQ = ngramSimilarity(query, question);
  const ngramSyn = synonyms.length
    ? Math.max(...synonyms.map((s) => ngramSimilarity(query, s)))
    : 0;

  const allFields = [question, ...synonyms, ...tags].map(normalize).join(" ");
  const substringBoost = allFields.includes(qNorm) && qNorm.length > 2 ? SETTINGS.boostSubstring : 0;

  // Weighted score (tuned for short FAQ bots)
  const score =
    0.45 * qScore +
    0.18 * synScore +
    0.07 * tagScore +
    0.23 * ngramQ +
    0.07 * ngramSyn +
    substringBoost;

  return { question, answer, score };
}

function matchFAQ(query) {
  const results = FAQS.map((item) => ({ item, ...scoreItem(query, item) }))
    .sort((a, b) => b.score - a.score);

  const top = results[0];
  const suggestions = results
    .slice(0, SETTINGS.topSuggestions)
    .map((r) => r.question)
    .filter(Boolean);

  if (!top || top.score < SETTINGS.minConfidence) {
    return { matched: false, suggestions };
  }

  return { matched: true, answerHTML: top.answer, question: top.question, suggestions };
}

// ------------------------
// Safety: sanitize FAQ HTML
// ------------------------
function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html ?? "";

  const ALLOWED = new Set(["B", "STRONG", "EM", "I", "A", "BR", "UL", "OL", "LI", "P", "CODE", "SPAN"]);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT, null);

  const toClean = [];
  while (walker.nextNode()) toClean.push(walker.currentNode);

  for (const el of toClean) {
    if (!ALLOWED.has(el.tagName)) {
      // Replace disallowed elements with their text content
      const text = document.createTextNode(el.textContent || "");
      el.replaceWith(text);
      continue;
    }

    // Strip attributes except safe ones on <a>
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      if (el.tagName === "A") {
        if (name === "href") {
          // block javascript: / data: etc
          const safe = value.trim().toLowerCase();
          if (safe.startsWith("javascript:") || safe.startsWith("data:")) {
            el.removeAttribute(attr.name);
          } else {
            el.setAttribute("target", "_blank");
            el.setAttribute("rel", "noopener noreferrer");
          }
        } else if (name !== "target" && name !== "rel" && name !== "title") {
          el.removeAttribute(attr.name);
        }
      } else {
        // Allow only class on span for meta styling
        if (!(el.tagName === "SPAN" && name === "class")) {
          el.removeAttribute(attr.name);
        }
      }
    });
  }

  return template.innerHTML;
}

// ------------------------
// UI helpers
// ------------------------

function nowTime() {
  const d = new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addBubble(text, type = "bot", isHTML = false, options = {}) {
  const div = document.createElement("div");
  div.className = "bubble " + type;

  if (isHTML) div.innerHTML = sanitizeHTML(text);
  else div.textContent = text;

  if (options.timestamp !== false) {
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = nowTime();
    div.appendChild(meta);
  }

  chatWindow.appendChild(div);

  // Suggestion chips (optional)
  if (options.suggestions && options.suggestions.length) {
    const wrap = document.createElement("div");
    wrap.className = "suggestions";
    for (const label of options.suggestions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = label;
      b.addEventListener("click", () => {
        handleUserMessage(label);
      });
      wrap.appendChild(b);
    }
    div.appendChild(wrap);
  }

  chatWindow.scrollTop = chatWindow.scrollHeight;
  persistHistory();
}

function addTyping() {
  const div = document.createElement("div");
  div.className = "bubble bot";
  div.setAttribute("data-typing", "true");
  div.innerHTML =
    `Typing <span class="typing"><span></span><span></span><span></span></span>`;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeTyping() {
  const t = chatWindow.querySelector('[data-typing="true"]');
  if (t) t.remove();
}

function addSystemNotice(text) {
  const div = document.createElement("div");
  div.className = "bubble bot";
  div.setAttribute("data-system", "true");
  div.textContent = text;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeSystemNotices() {
  chatWindow.querySelectorAll('[data-system="true"]').forEach((n) => n.remove());
}

function setInputEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  if (enabled) input.focus();
}

function hasAnyMessages() {
  return chatWindow.querySelectorAll(".bubble").length > 0;
}

// ------------------------
// Commands (makes it feel “real”)
// ------------------------
function handleCommand(text) {
  const t = normalize(text);

  if (t === "help") {
    addBubble(
      "You can ask natural questions like:<br>• <b>opening times</b><br>• <b>contact support</b><br>• <b>where are you located</b><br><br>Commands:<br>• <b>topics</b> – list all FAQs<br>• <b>clear</b> – reset chat",
      "bot",
      true
    );
    return true;
  }

  if (t === "topics" || t === "topic" || t === "menu") {
    const list = (FAQS || []).map((f) => f.question).filter(Boolean);
    if (!list.length) {
      addBubble("No topics found. Check your FAQ JSON.", "bot");
      return true;
    }
    addBubble(
      "Here are topics I can help with:",
      "bot",
      false,
      { suggestions: list.slice(0, 12), timestamp: true }
    );
    return true;
  }

  if (t === "clear" || t === "reset" || t === "restart") {
    chatWindow.innerHTML = "";
    localStorage.removeItem(SETTINGS.storageKey);
    addBubble(SETTINGS.greeting, "bot", true);
    return true;
  }

  return false;
}

// ------------------------
// Core chat behavior
// ------------------------
function handleUserMessage(text) {
  const clean = (text ?? "").trim();
  if (!clean) return;

  addBubble(clean, "user", false);

  // Commands
  if (handleCommand(clean)) return;

  // Typing
  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot");
      return;
    }

    // Simple small talk makes it feel more human
    const n = normalize(clean);
    if (["hi", "hello", "hey"].includes(n)) {
      addBubble("Hello! 😊 What can I help you with today?", "bot");
      return;
    }
    if (["thanks", "thank you", "thx"].includes(n)) {
      addBubble("You’re welcome! If you need anything else, just ask.", "bot");
      return;
    }

    const res = matchFAQ(clean);

    if (res.matched) {
      addBubble(res.answerHTML, "bot", true, {
        suggestions: res.suggestions.filter((q) => q && q !== res.question).slice(0, 3),
      });
    } else {
      const sug = res.suggestions?.length ? res.suggestions : [];
      addBubble(
        "I’m not sure I understood. Try one of these:",
        "bot",
        false,
        { suggestions: sug }
      );
    }
  }, 350);
}

function sendChat() {
  handleUserMessage(input.value);
  input.value = "";
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

// ------------------------
// Persistence
// ------------------------
function persistHistory() {
  // store minimal history: role + html/text
  const bubbles = [...chatWindow.querySelectorAll(".bubble")].slice(-SETTINGS.maxHistory);
  const serialized = bubbles.map((b) => {
    const type = b.classList.contains("user") ? "user" : "bot";
    // remove chips from stored html to avoid event handlers
    const clone = b.cloneNode(true);
    clone.querySelectorAll(".suggestions").forEach((n) => n.remove());
    const html = clone.innerHTML;
    return { type, html };
  });

  try {
    localStorage.setItem(SETTINGS.storageKey, JSON.stringify(serialized));
  } catch (_) {
    // Ignore quota errors
  }
}

function restoreHistory() {
  try {
    const raw = localStorage.getItem(SETTINGS.storageKey);
    if (!raw) return;
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || !items.length) return;

    chatWindow.innerHTML = "";
    for (const msg of items) {
      const div = document.createElement("div");
      div.className = "bubble " + (msg.type === "user" ? "user" : "bot");
      div.innerHTML = sanitizeHTML(msg.html);
      chatWindow.appendChild(div);
    }
    chatWindow.scrollTop = chatWindow.scrollHeight;
  } catch (_) {
    // If parsing fails, ignore
  }
}
