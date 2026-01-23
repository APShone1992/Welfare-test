
// ------------------------------------------------------------
// Welfare Support – Chat Engine (Upgraded Features, Original Theme)
// ------------------------------------------------------------

const SETTINGS = {
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, how to contact support, or where we’re located.",
  help:
    "You can ask about <b>opening times</b>, <b>support contact</b>, or <b>location</b>.<br><br>" +
    "<b>Commands</b>:<br>• <b>help</b> – show this message<br>• <b>clear</b> – clear chat<br>• <b>restart</b> – restart chat",
  typingDelayMs: 320,
  maxHistory: 80,

  // Matching
  minConfidence: 0.24,
  topSuggestions: 4
};

// Option C: Advanced escalation after 2 fails
const ESCALATION = {
  afterFails: 2,

  // 👇 PASTE your deployed Google Apps Script Web App URL here:
  endpoint: "https://docs.google.com/spreadsheets/d/1GferLO7LCK2PsUw5OXSIPTXJ-XsnlZKgCFp-MIL2ia4/edit?gid=0#gid=0",

  // Displayed contact fallback (in case endpoint is not configured)
  fallbackEmail: "support@Kelly.co.uk",
  fallbackPhone: "01234 567890"
};

let FAQS = [];
let INDEX = []; // precomputed for speed
let faqsLoaded = false;
let failCount = 0;

// DOM
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const chipRow = document.getElementById("chipRow");
const faqToggle = document.getElementById("faqToggle");

// ---------------------------
// Load FAQs
// ---------------------------
fetch("public/config/faqs.json", { cache: "no-store" })
  .then(res => res.json())
  .then(data => {
    FAQS = Array.isArray(data) ? data : [];
    buildIndex();
    faqsLoaded = true;
    buildChips();
  })
  .catch(() => {
    FAQS = [];
    faqsLoaded = true;
    addBubble("I couldn’t load the FAQ knowledge base. Please check <b>public/config/faqs.json</b>.", "bot", true);
  });

// ---------------------------
// Normalize / tokenize
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

function tokenSet(arr) {
  return new Set(arr);
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

// Dice coefficient using bigrams (phrase similarity)
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

// Lightweight edit similarity (Levenshtein normalized)
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
// Safe HTML sanitiser (basic allowlist)
// ---------------------------
function sanitizeHTML(html) {
  const allowedTags = new Set(["A","B","STRONG","I","EM","BR","P","UL","OL","LI","SMALL","CODE","SPAN"]);
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(html ?? ""), "text/html");

  doc.querySelectorAll("script, style, iframe, object, embed").forEach(n => n.remove());

  const els = Array.from(doc.body.querySelectorAll("*"));
  els.forEach(el => {
    if (!allowedTags.has(el.tagName)) {
      el.replaceWith(doc.createTextNode(el.textContent || ""));
      return;
    }
    // Strip all attributes except safe link attrs
    Array.from(el.attributes).forEach(a => el.removeAttribute(a.name));
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
// Build search index (speed)
// Supports category + tags + synonyms
// ---------------------------
function buildIndex() {
  INDEX = FAQS.map((item, idx) => {
    const q = item.question ?? "";
    const syns = Array.isArray(item.synonyms) ? item.synonyms : [];
    const tags = Array.isArray(item.tags) ? item.tags : [];
    const cat = item.category ?? "";
    const pri = Number(item.priority ?? 0);

    const allText = [q, ...syns, ...tags, cat].join(" ");
    const tks = tokens(allText);
    return {
      idx,
      question: q,
      answer: item.answer ?? "",
      category: cat || "General",
      priority: pri,
      tset: tokenSet(tks),
      qTokens: tokenSet(tokens(q)),
      qNorm: normalize(q),
      allNorm: normalize(allText),
      syns
    };
  });
}

// Scoring with boosts
function score(query, entry) {
  const qNorm = normalize(query);
  const qTokSet = tokenSet(tokens(query));

  const tokenScore = jaccard(qTokSet, entry.tset);
  const phraseScore = dice(query, entry.question);
  const editScore = editSimilarity(query, entry.question);

  // substring boost if query is contained in any field
  const boost = entry.allNorm.includes(qNorm) ? 0.10 : 0;

  // Slight boost if category matches query tokens
  const catBoost = entry.category && normalize(entry.category).includes(qNorm) ? 0.06 : 0;

  return (0.50 * tokenScore) + (0.32 * phraseScore) + (0.08 * editScore) + boost + catBoost;
}

function matchFAQ(query) {
  const scored = INDEX
    .map(e => ({ e, s: score(query, e) }))
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
    question: best.e.question,
    suggestions: scored.slice(1, SETTINGS.topSuggestions + 1).map(x => x.e.question)
  };
}

// ---------------------------
// UI helpers
// ---------------------------
function ts() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addBubble(text, type="bot", isHTML=false, persist=true) {
  const div = document.createElement("div");
  div.className = "bubble " + type;
  if (isHTML) div.innerHTML = sanitizeHTML(text);
  else div.textContent = text;

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = ts();
  div.appendChild(meta);

  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  if (persist) saveHistory({ type, text, isHTML });
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

// Clickable suggestions bubble
function addSuggestions(list) {
  if (!list || !list.length) return;
  const html =
    `<div class="suggest">Did you mean:<br>` +
    list.map(q => `• <a href="#" data-suggest="${encodeURIComponent(q)}">${q}</a>`).join("<br>") +
    `</div>`;

  const wrap = document.createElement("div");
  wrap.className = "bubble bot";
  wrap.innerHTML = sanitizeHTML(html);

  wrap.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-suggest]");
    if (!a) return;
    e.preventDefault();
    handleUserMessage(decodeURIComponent(a.getAttribute("data-suggest")));
  });

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = ts();
  wrap.appendChild(meta);

  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  saveHistory({ type: "bot", text: wrap.innerHTML, isHTML: true });
}

// ---------------------------
// Quick chips
// ---------------------------
function buildChips() {
  chipRow.innerHTML = "";
  if (!INDEX.length) return;

  // Top 3 by priority, then by order
  const top = [...INDEX]
    .sort((a,b) => (b.priority - a.priority))
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
// FAQ browser panel (category groups)
// ---------------------------
let faqPanelOpen = false;

function showFaqBrowser() {
  if (!INDEX.length) return;

  const groups = {};
  INDEX.forEach(i => {
    const cat = i.category || "General";
    groups[cat] = groups[cat] || [];
    groups[cat].push(i);
  });

  const cats = Object.keys(groups).sort();
  const html =
    `<div class="faq-panel" id="faqPanel">` +
    `<h3>Browse FAQs</h3>` +
    cats.map(cat => {
      const qs = groups[cat]
        .sort((a,b)=> (b.priority - a.priority))
        .slice(0, 8)
        .map(q => `<a class="faq-q" href="#" data-q="${encodeURIComponent(q.question)}">${q.question}</a>`)
        .join("");
      return `<div class="faq-cat">
                <div class="faq-cat-title">${cat}</div>
                ${qs}
              </div>`;
    }).join("") +
    `</div>`;

  addBubble(html, "bot", true);

  // Attach click handler to last inserted panel
  const panels = chatWindow.querySelectorAll("#faqPanel");
  const panel = panels[panels.length - 1];
  if (panel) {
    panel.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-q]");
      if (!a) return;
      e.preventDefault();
      handleUserMessage(decodeURIComponent(a.getAttribute("data-q")));
    });
  }
}

faqToggle.addEventListener("click", () => {
  faqPanelOpen = !faqPanelOpen;
  if (faqPanelOpen) showFaqBrowser();
});

// ---------------------------
// History
// ---------------------------
const HISTORY_KEY = "welfare_support_history_v3";

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
    arr.forEach(m => addBubble(m.text, m.type, !!m.isHTML, false));
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
// Escalation form (Option C)
// ---------------------------
function showSupportForm(lastUserMessage) {
  const endpointOk = ESCALATION.endpoint && ESCALATION.endpoint.startsWith("http");

  const html =
    `<b>Still not finding the right answer?</b><br>` +
    `Fill this in and we’ll log a ticket and contact you.<br>` +
    `<form class="support-form" id="supportForm">` +
      `<label>Your name</label>` +
      `<input name="name" required placeholder="e.g. John Smith">` +
      `<label>Your email</label>` +
      `<input name="email" type="email" required placeholder="e.g. you@email.com">` +
      `<label>Message</label>` +
      `<textarea name="message" required placeholder="Describe your issue..."></textarea>` +
      `<div class="form-hint">We’ll create a ticket and email you a confirmation.</div>` +
      `<div class="support-actions">` +
        `<button class="btn-primary" type="submit">Submit</button>` +
        `<button class="btn-secondary" type="button" data-cancel="1">Cancel</button>` +
      `</div>` +
      (!endpointOk
        ? `<div class="form-hint"><br><b>Admin note:</b> Endpoint not configured. Users can contact: ` +
          `<a href="mailto:${ESCALATION.fallbackEmail}">${ESCALATION.fallbackEmail}</a> / ` +
          `<a href="tel:${ESCALATION.fallbackPhone.replace(/\s+/g,'')}">${ESCALATION.fallbackPhone}</a></div>`
        : ``) +
    `</form>`;

  addBubble(html, "bot", true);

  // Hook the latest form only
  const forms = chatWindow.querySelectorAll("#supportForm");
  const form = forms[forms.length - 1];
  if (!form) return;

  form.addEventListener("click", (e) => {
    const cancel = e.target.closest("[data-cancel]");
    if (cancel) {
      e.preventDefault();
      addBubble("No problem — ask another question any time.", "bot");
    }
  });

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

    // If endpoint not set, show fallback contact
    if (!(ESCALATION.endpoint && ESCALATION.endpoint.startsWith("http"))) {
      addBubble(
        `Thanks — please email <a href="mailto:${ESCALATION.fallbackEmail}">${ESCALATION.fallbackEmail}</a> or call <b>${ESCALATION.fallbackPhone}</b>.`,
        "bot",
        true
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
        `✅ Ticket created: <b>${json.ticketId}</b><br>` +
        `We’ve emailed you a confirmation. Our team will contact you soon.`,
        "bot",
        true
      );
    } catch (err) {
      removeTyping();
      addBubble("Sorry — ticket submission failed. Please try again later.", "bot");
    }
  });
}

// ---------------------------
// Main message handling
// ---------------------------
function handleUserMessage(text) {
  const t = String(text ?? "").trim();
  if (!t) return;

  addBubble(t, "user", false);
  input.value = "";

  const cmd = normalize(t);
  if (cmd === "help") {
    addBubble(SETTINGS.help, "bot", true);
    return;
  }
  if (cmd === "clear") {
    clearHistory();
    addBubble("Chat cleared. Ask a question whenever you're ready.", "bot");
    return;
  }
  if (cmd === "restart") {
    clearHistory();
    addBubble(SETTINGS.greeting, "bot", true);
    buildChips();
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
      addBubble("The FAQ knowledge base is empty.", "bot");
      return;
    }

    const res = matchFAQ(t);

    if (res.matched) {
      failCount = 0;
      addBubble(res.answerHTML, "bot", true);
      if (res.suggestions && res.suggestions.length) addSuggestions(res.suggestions);
      return;
    }

    failCount++;
    addBubble("I’m not sure I understood that.", "bot");
    addSuggestions(res.suggestions);

    // Option C escalation after N fails
    if (failCount >= ESCALATION.afterFails) {
      showSupportForm(t);
    }
  }, SETTINGS.typingDelayMs);
}

// Events
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
  if (!restored) addBubble(SETTINGS.greeting, "bot", true);
});

