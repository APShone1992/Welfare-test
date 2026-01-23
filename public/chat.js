
// ------------------------------------------------------------
// Welfare Support – Chat Engine (Upgraded + Escalation Form Works)
// Keeps your original theme (CSS controls all visuals)
// ------------------------------------------------------------

/**
 * Works with your original index.html IDs:
 *  - #chatWindow
 *  - #chatInput
 *  - #sendBtn
 * and your existing bubble CSS classes. [1](https://kellycomms-my.sharepoint.com/personal/adam_shone_kelly_co_uk/_layouts/15/Doc.aspx?sourcedoc=%7B5B2B63EF-EF9F-4543-AA05-380ECBD123FE%7D&file=Welfare-Support-Files.docx&action=default&mobileredirect=true)
 */

const SETTINGS = {
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, how to contact support, or where we’re located.",
  help:
    "You can ask about <b>opening times</b>, <b>contact</b>, or <b>location</b>.<br><br>" +
    "<b>Commands</b>:<br>• <b>help</b><br>• <b>clear</b><br>• <b>restart</b><br>• <b>report</b> (show the contact form)",
  typingDelayMs: 350,

  // Matching
  minConfidence: 0.24,
  topSuggestions: 4,
  maxHistory: 80
};

// Escalation behaviour (form pops up after N failed matches)
const ESCALATION = {
  afterFails: 2,

  // Optional backend endpoint (Google Apps Script Web App URL)
  // Leave empty if you only want the form to show (no submission).
  endpoint: "https://script.google.com/macros/s/AKfycbzllEA7HTp6BMX9nZIrsrzLpt5-iHIYU6yxltqcCnwCRmKbKVto28boO0tW3dH1ZRkFOA/exec",

  fallbackEmail: "support@Kelly.co.uk",
  fallbackPhone: "01234 567890"
};

// ---------------------------
// State
// ---------------------------
let FAQS = [];
let INDEX = [];
let faqsLoaded = false;
let failCount = 0;

// ---------------------------
// DOM
// ---------------------------
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

// Optional UI (injected if missing)
let chipRow = document.getElementById("chipRow");

// Guard: required elements must exist
if (!chatWindow || !input || !sendBtn) {
  console.error("Missing required chat elements. Ensure chatWindow/chatInput/sendBtn exist.");
}

// ---------------------------
// FAQ Load (same path as your original) [1](https://kellycomms-my.sharepoint.com/personal/adam_shone_kelly_co_uk/_layouts/15/Doc.aspx?sourcedoc=%7B5B2B63EF-EF9F-4543-AA05-380ECBD123FE%7D&file=Welfare-Support-Files.docx&action=default&mobileredirect=true)
// ---------------------------
fetch("public/config/faqs.json", { cache: "no-store" })
  .then(res => res.json())
  .then(data => {
    FAQS = Array.isArray(data) ? data : [];
    buildIndex();
    faqsLoaded = true;
    ensureChipRow();
    buildChips();
  })
  .catch(() => {
    FAQS = [];
    INDEX = [];
    faqsLoaded = true;
    addBubble(
      "I couldn’t load the knowledge base. Please check <b>public/config/faqs.json</b>.",
      "bot",
      { html: true, trusted: true }
    );
  });

// ---------------------------
// Text helpers
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
    .replace(/[̀-ͯ]/g, "")
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

function setFrom(arr) {
  return new Set(arr);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

// Dice coefficient (phrase similarity)
function bigrams(str) {
  const s = normalize(str);
  const out = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}
function dice(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const map = new Map();
  for (const x of A) map.set(x, (map.get(x) || 0) + 1);
  let matches = 0;
  for (const y of B) {
    const n = map.get(y) || 0;
    if (n > 0) { matches++; map.set(y, n - 1); }
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
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
      prev = temp;
    }
  }
  const dist = dp[n];
  return 1 - dist / Math.max(m, n);
}

// ---------------------------
// HTML sanitiser
// IMPORTANT: Only used for FAQ answers (untrusted).
// Internal UI (chips/form/suggestions) uses trusted HTML mode.
// ---------------------------
function sanitizeFAQHtml(html) {
  const allowedTags = new Set(["A","B","STRONG","I","EM","BR","P","UL","OL","LI","SMALL","CODE","SPAN"]);
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html ?? ""), "text/html");

  // Remove dangerous nodes
  doc.querySelectorAll("script, style, iframe, object, embed").forEach(n => n.remove());

  const nodes = Array.from(doc.body.querySelectorAll("*"));
  nodes.forEach(el => {
    if (!allowedTags.has(el.tagName)) {
      el.replaceWith(doc.createTextNode(el.textContent || ""));
      return;
    }

    // strip attributes
    Array.from(el.attributes).forEach(a => el.removeAttribute(a.name));

    // safe links
    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      const safe = /^(https?:\/\/|mailto:|tel:)/i.test(href);
      if (!safe) el.removeAttribute("href");
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });

  return doc.body.innerHTML;
}

// ---------------------------
// Index build (faster matching)
// ---------------------------
function buildIndex() {
  INDEX = FAQS.map(item => {
    const q = item.question ?? "";
    const syns = Array.isArray(item.synonyms) ? item.synonyms : [];
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const cat = item.category ?? "";
    const pri = Number(item.priority ?? 0);

    const allText = [q, ...syns, ...tags, cat].join(" ");
    return {
      question: q,
      answer: item.answer ?? "",
      category: cat || "General",
      priority: pri,
      allNorm: normalize(allText),
      tset: setFrom(tokens(allText))
    };
  });
}

function scoreQuery(query, entry) {
  const qNorm = normalize(query);
  const qTok = setFrom(tokens(query));

  const tokenScore = jaccard(qTok, entry.tset);
  const phraseScore = dice(query, entry.question);
  const editScore = editSimilarity(query, entry.question);

  const boost = entry.allNorm.includes(qNorm) ? 0.10 : 0;
  return (0.52 * tokenScore) + (0.34 * phraseScore) + (0.08 * editScore) + boost;
}

function matchFAQ(query) {
  const scored = INDEX
    .map(e => ({ e, s: scoreQuery(query, e) }))
    .sort((a, b) => b.s - a.s);

  const best = scored[0];
  if (!best || best.s < SETTINGS.minConfidence) {
    return {
      matched: false,
      suggestions: scored.slice(0, SETTINGS.topSuggestions).map(x => x.e.question)
    };
  }
  return {
    matched: true,
    answerHTML: best.e.answer,
    suggestions: scored.slice(1, SETTINGS.topSuggestions + 1).map(x => x.e.question)
  };
}

// ---------------------------
// UI functions
// ---------------------------
function timeStamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * addBubble supports:
 *  - text
 *  - html: true (if trusted: true => no sanitizing; else sanitize as FAQ answer)
 */
function addBubble(content, type = "bot", options = {}) {
  const { html = false, trusted = false, persist = true } = options;

  const div = document.createElement("div");
  div.className = "bubble " + type;

  if (html) {
    div.innerHTML = trusted ? String(content ?? "") : sanitizeFAQHtml(content);
  } else {
    div.textContent = String(content ?? "");
  }

  // timestamp (works with your theme; CSS handles .meta)
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = timeStamp();
  div.appendChild(meta);

  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  if (persist) saveHistory({ type, content, html, trusted });
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

// ---------------------------
// Suggestions (clickable)
// Uses trusted HTML (internal UI), NOT sanitized away.
// ---------------------------
function addSuggestions(list) {
  if (!list || !list.length) return;

  const html =
    `<div class="suggest">Did you mean:<br>` +
    list.map(q => `• <a href="#" data-suggest="${encodeURIComponent(q)}">${q}</a>`).join("<br>") +
    `</div>`;

  // trusted so links remain clickable
  addBubble(html, "bot", { html: true, trusted: true });

  // Attach click handler to the last suggestion bubble
  const last = chatWindow.lastElementChild;
  if (!last) return;

  last.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-suggest]");
    if (!a) return;
    e.preventDefault();
    const q = decodeURIComponent(a.getAttribute("data-suggest"));
    handleUserMessage(q);
  });
}

// ---------------------------
// Chips row (optional)
// If your index.html doesn't have it, we inject it under chatWindow.
// ---------------------------
function ensureChipRow() {
  if (chipRow) return;
  chipRow = document.createElement("div");
  chipRow.id = "chipRow";
  chipRow.className = "chips";
  // insert after chatWindow
  chatWindow.insertAdjacentElement("afterend", chipRow);
}

function buildChips() {
  if (!chipRow || !INDEX.length) return;
  chipRow.innerHTML = "";

  const top = [...INDEX]
    .sort((a, b) => (b.priority - a.priority))
    .slice(0, 3);

  top.forEach(item => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = item.question;
    btn.addEventListener("click", () => handleUserMessage(item.question));
    chipRow.appendChild(btn);
  });
}

// ---------------------------
// History (localStorage)
// ---------------------------
const HISTORY_KEY = "welfare_support_history_v4";

function saveHistory(msg) {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    arr.push({ ...msg, at: Date.now() });
    localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(-SETTINGS.maxHistory)));
  } catch {}
}

function restoreHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    if (!Array.isArray(arr) || !arr.length) return false;

    arr.forEach(m => {
      addBubble(m.content, m.type, {
        html: !!m.html,
        trusted: !!m.trusted,
        persist: false
      });
    });
    return true;
  } catch {
    return false;
  }
}

function clearHistory() {
  try { localStorage.removeItem(HISTORY_KEY); } catch {}
  chatWindow.innerHTML = "";
  failCount = 0;
}

// ---------------------------
// Escalation Form (THIS is what you want to pop up)
// This uses trusted HTML so it WILL render inside the chat.
// ---------------------------
function showEscalationForm(lastUserMessage = "") {
  const endpointConfigured = !!(ESCALATION.endpoint && ESCALATION.endpoint.startsWith("http"));

  const html = `
    <div class="support-form" id="supportFormWrap">
      <b>Still not finding the right answer?</b><br>
      Fill this in and we’ll create a support ticket.<br>

      <form class="support-form" id="supportForm">
        <label>Your name</label>
        <input name="name" required placeholder="e.g. John Smith" />

        <label>Your email</label>
        <input name="email" type="email" required placeholder="e.g. you@email.com" />

        <label>Message</label>
        <textarea name="message" required placeholder="Describe your issue..."></textarea>

        <div class="support-actions">
          <button class="btn-primary" type="submit">Submit</button>
          <button class="btn-secondary" type="button" data-cancel="1">Cancel</button>
        </div>

        ${
          endpointConfigured
            ? `<div class="form-hint">You’ll receive an email confirmation with your ticket ID.</div>`
            : `<div class="form-hint">
                 <b>Note:</b> Ticket sending isn’t connected yet. You can still contact us at
                 <a href="mailto:${ESCALATION.fallbackEmail}">${ESCALATION.fallbackEmail}</a> or call <b>${ESCALATION.fallbackPhone}</b>.
               </div>`
        }
      </form>
    </div>
  `;

  addBubble(html, "bot", { html: true, trusted: true });

  // Hook the latest form only (in case multiple forms exist)
  const forms = chatWindow.querySelectorAll("#supportForm");
  const form = forms[forms.length - 1];
  if (!form) return;

  // Cancel
  form.addEventListener("click", (e) => {
    const cancel = e.target.closest("[data-cancel]");
    if (!cancel) return;
    e.preventDefault();
    addBubble("No problem — ask another question whenever you like.", "bot");
  });

  // Submit
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    const fd = new FormData(form);
    const payload = {
      name: String(fd.get("name") || "").trim(),
      email: String(fd.get("email") || "").trim(),
      message: String(fd.get("message") || "").trim(),
      lastUserMessage: String(lastUserMessage || "").trim(),
      pageUrl: location.href,
      userAgent: navigator.userAgent,
      createdAt: new Date().toISOString()
    };

    if (!payload.name || !payload.email || !payload.message) {
      addBubble("Please complete all fields.", "bot");
      return;
    }

    // If no endpoint, just confirm locally
    if (!(ESCALATION.endpoint && ESCALATION.endpoint.startsWith("http"))) {
      failCount = 0;
      addBubble(
        "✅ Thanks! Your details are ready to send, but ticket submission isn’t connected yet.",
        "bot"
      );
      return;
    }

    addTyping();
    try {
      const r = await fetch(ESCALATION.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const json = await r.json().catch(() => null);
      removeTyping();

      if (!r.ok || !json || !json.ticketId) {
        addBubble("Sorry — I couldn’t submit the ticket right now. Please try again later.", "bot");
        return;
      }

      failCount = 0; // reset after successful escalation
      addBubble(
        `✅ Ticket created: <b>${json.ticketId}</b><br>We’ve emailed you a confirmation.`,
        "bot",
        { html: true, trusted: true }
      );
    } catch {
      removeTyping();
      addBubble("Sorry — ticket submission failed. Please try again later.", "bot");
    }
  });
}

// ---------------------------
// Main message handler
// ---------------------------
function handleUserMessage(text) {
  const t = String(text ?? "").trim();
  if (!t) return;

  addBubble(t, "user");
  input.value = "";

  const cmd = normalize(t);

  // Commands
  if (cmd === "help") {
    addBubble(SETTINGS.help, "bot", { html: true, trusted: true });
    return;
  }
  if (cmd === "clear") {
    clearHistory();
    addBubble("Chat cleared. Ask a question whenever you're ready.", "bot");
    return;
  }
  if (cmd === "restart") {
    clearHistory();
    addBubble(SETTINGS.greeting, "bot", { html: true, trusted: true });
    ensureChipRow();
    buildChips();
    return;
  }
  // Force show the form (great for testing)
  if (cmd === "report") {
    showEscalationForm(t);
    return;
  }

  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot");
      return;
    }

    if (!INDEX.length) {
      addBubble("The knowledge base is empty.", "bot");
      failCount++;
      if (failCount >= ESCALATION.afterFails) showEscalationForm(t);
      return;
    }

    const res = matchFAQ(t);

    if (res.matched) {
      failCount = 0;
      // FAQ answer is untrusted -> sanitize it
      addBubble(res.answerHTML, "bot", { html: true, trusted: false });

      if (res.suggestions && res.suggestions.length) {
        addSuggestions(res.suggestions);
      }
      return;
    }

    // Not matched -> increment fail count and show suggestions
    failCount++;
    addBubble("I’m not sure. Try one of these:", "bot");
    addSuggestions(res.suggestions);

    // Escalation after N fails -> show form
    if (failCount >= ESCALATION.afterFails) {
      showEscalationForm(t);
    }
  }, SETTINGS.typingDelayMs);
}

// ---------------------------
// Events (same approach as your original) [1](https://kellycomms-my.sharepoint.com/personal/adam_shone_kelly_co_uk/_layouts/15/Doc.aspx?sourcedoc=%7B5B2B63EF-EF9F-4543-AA05-380ECBD123FE%7D&file=Welfare-Support-Files.docx&action=default&mobileredirect=true)
// ---------------------------
sendBtn.addEventListener("click", () => handleUserMessage(input.value));
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    handleUserMessage(input.value);
  }
});

// Start: restore history or greet
window.addEventListener("DOMContentLoaded", () => {
  const restored = restoreHistory();
  if (!restored) addBubble(SETTINGS.greeting, "bot", { html: true, trusted: true });
});
