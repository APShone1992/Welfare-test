
// ------------------------------------------------------------
// Welfare Support – Chat Engine (No History + Working Form)
// EXACT THEME PRESERVED — no styling in this file.
// ------------------------------------------------------------

// SETTINGS
const SETTINGS = {
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me anything about our services.",
  help:
    "You can ask about <b>opening times</b>, <b>contact details</b>, or <b>location</b>.<br><br>" +
    "<b>Commands:</b><br>• help<br>• clear<br>• restart<br>• report",
  typingDelayMs: 350,
  minConfidence: 0.24,
  topSuggestions: 4
};

// ESCALATION (form appears after 2 fails)
const ESCALATION = {
  afterFails: 2,
  endpoint: "https://script.google.com/macros/s/AKfycbzllEA7HTp6BMX9nZIrsrzLpt5-iHIYU6yxltqcCnwCRmKbKVto28boO0tW3dH1ZRkFOA/exec", // leave blank if not using Google Apps Script yet
  fallbackEmail: "support@Kelly.co.uk",
  fallbackPhone: "01234 567890"
};

// STATE
let FAQS = [];
let INDEX = [];
let faqsLoaded = false;
let failCount = 0;

// DOM
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
let chipRow = document.getElementById("chipRow");

// -----------------------------------------
// LOAD FAQS
// -----------------------------------------
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
    addBubble(
      "Unable to load FAQs. Please check <b>public/config/faqs.json</b>.",
      "bot",
      { html: true, trusted: true }
    );
  });

// -----------------------------------------
// NORMALISATION & TOKENS
// -----------------------------------------
const STOPWORDS = new Set([
  "a","an","the","and","or","but","to","of","in","on","at","for","from",
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
  return inter / union;
}

// Dice coefficient
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

// Light edit similarity
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
  return 1 - dp[n] / Math.max(m, n);
}

// -----------------------------------------
// SANITISE FAQ HTML
// -----------------------------------------
function sanitizeFAQHtml(html) {
  const allowed = new Set(["A","B","STRONG","I","EM","BR","P","UL","OL","LI","SMALL","CODE","SPAN"]);
  const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");

  doc.querySelectorAll("script, style, iframe, object, embed").forEach(n => n.remove());

  doc.querySelectorAll("*").forEach(el => {
    if (!allowed.has(el.tagName)) {
      el.replaceWith(doc.createTextNode(el.textContent || ""));
      return;
    }
    [...el.attributes].forEach(a => el.removeAttribute(a.name));
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener");
    }
  });

  return doc.body.innerHTML;
}

// -----------------------------------------
// BUILD INDEX
// -----------------------------------------
function buildIndex() {
  INDEX = FAQS.map(item => {
    const q = item.question ?? "";
    const syn = item.synonyms ?? [];
    const tags = item.tags ?? [];
    const cat = item.category ?? "";
    const pri = Number(item.priority ?? 0);

    const all = [q, ...syn, ...tags, cat].join(" ");
    return {
      question: q,
      answer: item.answer ?? "",
      tset: setFrom(tokens(all)),
      allNorm: normalize(all),
      priority: pri
    };
  });
}

function scoreQuery(query, entry) {
  const qNorm = normalize(query);
  const qTok = setFrom(tokens(query));
  return (
    0.5 * jaccard(qTok, entry.tset) +
    0.3 * dice(query, entry.question) +
    0.1 * editSimilarity(query, entry.question) +
    (entry.allNorm.includes(qNorm) ? 0.1 : 0)
  );
}

function matchFAQ(query) {
  const list = INDEX.map(e => ({ e, s: scoreQuery(query, e) }))
    .sort((a, b) => b.s - a.s);

  const best = list[0];
  if (!best || best.s < SETTINGS.minConfidence) {
    return {
      matched: false,
      suggestions: list.slice(0, SETTINGS.topSuggestions).map(x => x.e.question)
    };
  }

  return {
    matched: true,
    answerHTML: best.e.answer,
    suggestions: list.slice(1, SETTINGS.topSuggestions + 1).map(x => x.e.question)
  };
}

// -----------------------------------------
// UI HELPERS
// -----------------------------------------
function timestamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addBubble(content, type = "bot", opt = {}) {
  const { html = false, trusted = false } = opt;

  const div = document.createElement("div");
  div.className = "bubble " + type;

  if (html) div.innerHTML = trusted ? content : sanitizeFAQHtml(content);
  else div.textContent = content;

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = timestamp();
  div.appendChild(meta);

  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function addTyping() {
  const div = document.createElement("div");
  div.className = "bubble bot";
  div.setAttribute("data-typing", "yes");
  div.innerHTML = `Typing <span class="typing"><span></span><span></span><span></span></span>`;
  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeTyping() {
  const t = chatWindow.querySelector('[data-typing="yes"]');
  if (t) t.remove();
}

// -----------------------------------------
// SUGGESTIONS
// -----------------------------------------
function addSuggestions(list) {
  if (!list || !list.length) return;

  const html =
    `Did you mean:<br>` +
    list.map(q => `• <a data-suggest="${encodeURIComponent(q)}">${q}</a>`).join("<br>");

  addBubble(html, "bot", { html: true, trusted: true });

  const last = chatWindow.lastElementChild;
  last.addEventListener("click", e => {
    const a = e.target.closest("a[data-suggest]");
    if (!a) return;
    e.preventDefault();
    handleUserMessage(decodeURIComponent(a.getAttribute("data-suggest")));
  });
}

// -----------------------------------------
// CHIPS
// -----------------------------------------
function ensureChipRow() {
  if (chipRow) return;
  chipRow = document.createElement("div");
  chipRow.id = "chipRow";
  chipRow.className = "chips";
  chatWindow.insertAdjacentElement("afterend", chipRow);
}

function buildChips() {
  chipRow.innerHTML = "";
  if (!INDEX.length) return;

  const items = [...INDEX].sort((a, b) => b.priority - a.priority).slice(0, 3);

  items.forEach(i => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = i.question;
    b.onclick = () => handleUserMessage(i.question);
    chipRow.appendChild(b);
  });
}

// -----------------------------------------
// ESCALATION FORM
// -----------------------------------------
function showEscalationForm(lastMsg = "") {
  const connected = ESCALATION.endpoint && ESCALATION.endpoint.startsWith("http");

  const html = `
    <div class="support-form">
      <b>Still not finding the right answer?</b><br>
      Fill this in and we’ll get back to you.<br><br>

      <label>Name</label>
      <input id="sf_name" placeholder="John Smith">

      <label>Email</label>
      <input id="sf_email" type="email" placeholder="you@example.com">

      <label>Message</label>
      <textarea id="sf_msg" placeholder="Describe your issue..."></textarea>

      <div class="support-actions">
        <button class="btn-primary" id="sf_submit">Submit</button>
        <button class="btn-secondary" id="sf_cancel">Cancel</button>
      </div>

      ${
        connected
          ? `<div class="form-hint">You’ll receive a ticket ID by email.</div>`
          : `<div class="form-hint">
               Ticket system not connected.  
               Email us at <b>${ESCALATION.fallbackEmail}</b> or call <b>${ESCALATION.fallbackPhone}</b>.
             </div>`
      }
    </div>
  `;

  addBubble(html, "bot", { html: true, trusted: true });

  setTimeout(() => {
    document.getElementById("sf_cancel").onclick = () =>
      addBubble("No problem — ask me another question anytime.", "bot");

    document.getElementById("sf_submit").onclick = async () => {
      const name = document.getElementById("sf_name").value.trim();
      const email = document.getElementById("sf_email").value.trim();
      const msg = document.getElementById("sf_msg").value.trim();

      if (!name || !email || !msg) {
        addBubble("Please complete all fields.", "bot");
        return;
      }

      if (!connected) {
        addBubble("Form ready, but ticket backend not connected.", "bot");
        return;
      }

      addTyping();
      try {
        const r = await fetch(ESCALATION.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            email,
            message: msg,
            lastUserMessage: lastMsg,
            pageUrl: location.href,
            userAgent: navigator.userAgent,
            createdAt: new Date().toISOString()
          })
        });

        const json = await r.json().catch(() => null);
        removeTyping();

        if (!r.ok || !json || !json.ticketId) {
          addBubble("Ticket submission failed. Try again later.", "bot");
          return;
        }

        failCount = 0;
        addBubble(
          `✅ Ticket created: <b>${json.ticketId}</b><br>We’ve emailed you a confirmation.`,
          "bot",
          { html: true, trusted: true }
        );
      } catch {
        removeTyping();
        addBubble("Ticket submission error. Try again later.", "bot");
      }
    };
  }, 50);
}

// -----------------------------------------
// HANDLE USER MESSAGE
// -----------------------------------------
function handleUserMessage(text) {
  const t = String(text ?? "").trim();
  if (!t) return;

  addBubble(t, "user");
  input.value = "";

  const cmd = normalize(t);

  if (cmd === "help") {
    addBubble(SETTINGS.help, "bot", { html: true, trusted: true });
    return;
  }

  if (cmd === "clear") {
    chatWindow.innerHTML = "";
    failCount = 0;
    addBubble("Chat cleared.", "bot");
    return;
  }

  if (cmd === "restart") {
    chatWindow.innerHTML = "";
    failCount = 0;
    addBubble(SETTINGS.greeting, "bot", { html: true, trusted: true });
    buildChips();
    return;
  }

  if (cmd === "report") {
    showEscalationForm(t);
    return;
  }

  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading FAQs… please try again.", "bot");
      return;
    }

    const res = matchFAQ(t);

    if (res.matched) {
      failCount = 0;
      addBubble(res.answerHTML, "bot", { html: true, trusted: false });
      if (res.suggestions?.length) addSuggestions(res.suggestions);
      return;
    }

    failCount++;
    addBubble("I’m not sure — try one of these:", "bot");
    addSuggestions(res.suggestions);

    if (failCount >= ESCALATION.afterFails) {
      showEscalationForm(t);
    }
  }, SETTINGS.typingDelayMs);
}

// SEND BUTTON + ENTER KEY
sendBtn.onclick = () => handleUserMessage(input.value);
input.onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    handleUserMessage(input.value);
  }
};

// INITIAL GREETING (always fresh)
addBubble(SETTINGS.greeting, "bot", { html: true, trusted: true });
