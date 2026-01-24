
/* -------------------------------------------------------
 Welfare Support – Clean Stateless Chat Engine (FAQ + Chips)
 - No saved memory (refresh resets)
 - Polished bubbles + real per-message timestamps (24-hour)
 - Safe HTML rendering for FAQ answers (allowlist)
------------------------------------------------------- */

const SETTINGS = {
  minConfidence: 0.20,
  topSuggestions: 3,
  boostSubstring: 0.12,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, or where we’re located."
};

let FAQS = [];
let faqsLoaded = false;

// ---------- DOM ----------
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");

// ---------- UI State ----------
let isResponding = false;
let lastChipClickAt = 0;
let missCount = 0; // in-session only; resets on refresh

// ---------- Load FAQs ----------
fetch("./public/config/faqs.json")
  .then((res) => res.json())
  .then((data) => {
    FAQS = Array.isArray(data) ? data : [];
    faqsLoaded = true;
  })
  .catch(() => {
    FAQS = [];
    faqsLoaded = true;
  });

// ---------- Helpers ----------
const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")          // strip diacritics
    .replace(/[“”‘’]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^a-z0-9\s-]/g, "")   // broad compatibility
    .replace(/\s+/g, " ")
    .trim();

const STOP_WORDS = new Set([
  "what","are","your","do","you","we","is","the","a","an","to","of","and",
  "in","on","for","with","please","can","i"
]);

function stem(token) {
  // very light stemming: plural trim
  return token.endsWith("s") && token.length > 3 ? token.slice(0, -1) : token;
}

const tokenSet = (s) =>
  new Set(
    normalize(s)
      .split(" ")
      .map(stem)
      .filter((t) => t && !STOP_WORDS.has(t))
  );

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = new Set([...a, ...b]).size;
  return union ? inter / union : 0;
};

// ---------- Safe HTML rendering (allowlist sanitizer) ----------
function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;

  const allowedTags = new Set(["B","STRONG","I","EM","BR","A","SMALL"]);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toReplace = [];

  while (walker.nextNode()) {
    const el = walker.currentNode;

    if (!allowedTags.has(el.tagName)) {
      toReplace.push(el);
      continue;
    }

    // Strip all attributes except safe <a> attributes
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (el.tagName === "A" && (name === "href" || name === "target" || name === "rel")) return;
      el.removeAttribute(attr.name);
    });

    if (el.tagName === "A") {
      const href = el.getAttribute("href") || "";
      const safe = /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
      if (!safe) el.removeAttribute("href");
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }
  }

  toReplace.forEach((node) => node.replaceWith(document.createTextNode(node.textContent)));
  return template.innerHTML;
}

// ---------- UK time (24-hour) for timestamps ----------
const UK_TZ = "Europe/London";

function formatUKTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

// ---------- UI ----------
function setUIEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  chatWindow.querySelectorAll(".chip-btn").forEach((b) => (b.disabled = !enabled));
}

function scrollToBottom() {
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function addBubble(text, type = "bot", isHTML = false, timestamp = new Date()) {
  const row = document.createElement("div");
  row.className = `msg ${type}`;
  row.dataset.ts = String(timestamp.getTime());

  const bubble = document.createElement("div");
  bubble.className = `bubble ${type}`;
  bubble.setAttribute("role", "article");
  bubble.setAttribute("aria-label", type === "bot" ? "Bot message" : "Your message");

  if (isHTML) bubble.innerHTML = sanitizeHTML(text);
  else bubble.textContent = text;

  const time = document.createElement("div");
  time.className = "timestamp";
  time.textContent = formatUKTime(timestamp);

  row.appendChild(bubble);
  row.appendChild(time);
  chatWindow.appendChild(row);
  scrollToBottom();
}

function addTyping() {
  const row = document.createElement("div");
  row.className = "msg bot";
  row.dataset.typing = "true";

  const bubble = document.createElement("div");
  bubble.className = "bubble bot typing-bubble";
  bubble.innerHTML = `Typing <span class="typing"><span></span><span></span><span></span></span>`;

  row.appendChild(bubble);
  chatWindow.appendChild(row);
  scrollToBottom();
}

function removeTyping() {
  chatWindow.querySelector('[data-typing="true"]')?.remove();
}

function addChips(questions = []) {
  if (!questions.length) return;

  const wrap = document.createElement("div");
  wrap.className = "chips";

  questions.slice(0, SETTINGS.chipLimit).forEach((q) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn";
    b.textContent = q;

    b.addEventListener("click", () => {
      const now = Date.now();
      if (isResponding) return;
      if (now - lastChipClickAt < SETTINGS.chipClickCooldownMs) return;
      lastChipClickAt = now;

      wrap.querySelectorAll(".chip-btn").forEach((btn) => (btn.disabled = true));
      handleUserMessage(q);
      input.focus();
    });

    wrap.appendChild(b);
  });

  if (isResponding) wrap.querySelectorAll(".chip-btn").forEach((btn) => (btn.disabled = true));
  chatWindow.appendChild(wrap);
  scrollToBottom();
}

// ---------- Opening hours logic (UK) ----------
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

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    weekday: map.weekday,
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
  return h * 60 + m;
}

function isOpenNowUK() {
  const uk = getUKParts();
  const day = ukWeekdayNumber(uk.weekday);
  const mins = minutesSinceMidnight(uk.hour, uk.minute);

  const isWeekend = day === 0 || day === 6;
  const openMins = minutesSinceMidnight(8, 30);
  const closeMins = minutesSinceMidnight(17, 0);

  return !isWeekend && mins >= openMins && mins < closeMins;
}

function willBeOpenTomorrowUK() {
  const uk = getUKParts(new Date());
  // safe UTC noon date prevents DST edge issues
  const safeUTC = new Date(Date.UTC(uk.year, uk.month - 1, uk.day, 12, 0, 0));
  safeUTC.setUTCDate(safeUTC.getUTCDate() + 1);
  const ukTomorrow = getUKParts(safeUTC);

  const day = ukWeekdayNumber(ukTomorrow.weekday);
  const isWeekend = day === 0 || day === 6;
  return !isWeekend;
}

// ---------- Special cases (stateless) ----------
function specialCases(query) {
  const q = normalize(query);

  if (q.includes("tomorrow")) {
    const open = willBeOpenTomorrowUK();
    return open
      ? { matched: true, answerHTML: "Yes — tomorrow is a weekday, so we’ll be open <b>8:30–17:00</b>." }
      : { matched: true, answerHTML: "Tomorrow is a <b>weekend</b>, so we’re closed.<br>Hours: <b>Mon–Fri, 8:30–17:00</b>." };
  }

  if (q.includes("available") || q.includes("open now") || q.includes("right now") || q.includes("anyone there")) {
    const openNow = isOpenNowUK();
    return openNow
      ? { matched: true, answerHTML: "Yes — we’re currently <b>open</b> and staff should be available.<br>Hours: <b>Mon–Fri, 8:30–17:00</b>." }
      : { matched: true, answerHTML: "Right now we appear to be <b>closed</b>.<br>Hours: <b>Mon–Fri, 8:30–17:00</b>." };
  }

  if (q.includes("parking") || q.includes("car park")) {
    return { matched: true, answerHTML: "Yes — we have <b>visitor parking</b> near our Nuneaton office. Spaces can be limited during busy times." };
  }

  if (q.includes("coventry") || (q.includes("cov") && q.includes("far"))) {
    return { matched: true, answerHTML: "We’re in <b>Nuneaton</b>, about <b>8 miles</b> from Coventry — around a <b>15–20 minute drive</b>." };
  }

  return null;
}

// ---------- FAQ matching ----------
function matchFAQ(query) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(query);

  const scored = FAQS
    .map((item) => {
      const question = item.question || "";
      const syns = item.synonyms || [];
      const keys = item.canonicalKeywords || [];
      const tags = item.tags || [];

      const scoreQ = jaccard(qTokens, tokenSet(question));
      const scoreSyn = syns.length ? Math.max(...syns.map((s) => jaccard(qTokens, tokenSet(s)))) : 0;
      const scoreKeys = keys.length ? Math.max(...keys.map((k) => jaccard(qTokens, tokenSet(k)))) : 0;
      const scoreTags = tags.length ? Math.max(...tags.map((t) => jaccard(qTokens, tokenSet(t)))) : 0;

      const anyField = [question, ...syns, ...keys, ...tags].map(normalize).join(" ");
      const boost = anyField.includes(qNorm) ? SETTINGS.boostSubstring : 0;

      const score = 0.55 * scoreQ + 0.25 * scoreSyn + 0.12 * scoreKeys + 0.08 * scoreTags + boost;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score);

  const top = scored[0];

  if (!top || top.score < SETTINGS.minConfidence) {
    return {
      matched: false,
      suggestions: scored.slice(0, SETTINGS.topSuggestions).map((r) => r.item.question)
    };
  }

  return {
    matched: true,
    answerHTML: top.item.answer,
    followUps: top.item.followUps || []
  };
}

// ---------- Main handler ----------
function handleUserMessage(text) {
  if (!text) return;

  addBubble(text, "user", false, new Date());
  input.value = "";

  isResponding = true;
  setUIEnabled(false);
  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot", false, new Date());
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    // 1) Special cases
    const special = specialCases(text);
    if (special?.matched) {
      addBubble(special.answerHTML, "bot", true, new Date());
      missCount = 0;
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    // 2) FAQ match
    const res = matchFAQ(text);

    if (res.matched) {
      addBubble(res.answerHTML, "bot", true, new Date());
      missCount = 0;

      if (res.followUps.length) {
        addBubble("You can also ask:", "bot", false, new Date());
        addChips(res.followUps);
      }
    } else {
      missCount++;
      addBubble("I’m not sure. Did you mean:", "bot", false, new Date());
      addChips(res.suggestions || []);

      // After 2 misses, offer contact info (still stateless)
      if (missCount >= 2) {
        addBubble(
          "If you’d like, you can contact support at <a href='mailto:support@Kelly.co.uk'>support@Kelly.co.uk</a> or call <b>01234 567890</b>.",
          "bot",
          true,
          new Date()
        );
        missCount = 0;
      }
    }

    isResponding = false;
    setUIEnabled(true);
  }, 300);
}

function sendChat() {
  if (isResponding) return;
  handleUserMessage(input.value.trim());
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

sendBtn.addEventListener("click", sendChat);

clearBtn?.addEventListener("click", () => {
  chatWindow.innerHTML = "";
  missCount = 0;
  init();
});

// ---------- Init ----------
function init() {
  addBubble(SETTINGS.greeting, "bot", true, new Date());
}

if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", init);
else init();
