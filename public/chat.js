
/* -------------------------------------------------------
 Welfare Support – Impressive Static Chatbot (FAQ + Topics + Suggestions)
 - No saved memory (refresh resets)
 - Topics drawer (browse by category)
 - Search-as-you-type suggestions
 - Helpful feedback buttons (👍/👎)
 - Guided fallback (category clarification)
------------------------------------------------------- */

const SETTINGS = {
  minConfidence: 0.20,
  topSuggestions: 3,
  boostSubstring: 0.12,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  suggestionLimit: 4,
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, or where we’re located."
};

let FAQS = [];
let faqsLoaded = false;
let categories = [];
let categoryIndex = new Map();

// ---------- DOM ----------
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");

const suggestionsEl = document.getElementById("suggestions");

const topicsBtn = document.getElementById("topicsBtn");
const drawer = document.getElementById("topicsDrawer");
const overlay = document.getElementById("drawerOverlay");
const drawerCloseBtn = document.getElementById("drawerCloseBtn");
const drawerCategoriesEl = document.getElementById("drawerCategories");
const drawerQuestionsEl = document.getElementById("drawerQuestions");

// ---------- UI State ----------
let isResponding = false;
let lastChipClickAt = 0;
let missCount = 0;

// suggestion keyboard state
let activeSuggestionIndex = -1;
let currentSuggestions = [];

// ---------- Load FAQs ----------
fetch("./public/config/faqs.json")
  .then((res) => res.json())
  .then((data) => {
    FAQS = Array.isArray(data) ? data : [];
    faqsLoaded = true;
    buildCategoryIndex();
    renderDrawer();
  })
  .catch(() => {
    FAQS = [];
    faqsLoaded = true;
    buildCategoryIndex();
    renderDrawer();
  });

// ---------- Helpers ----------
const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”‘’]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const STOP_WORDS = new Set([
  "what","are","your","do","you","we","is","the","a","an","to","of","and",
  "in","on","for","with","please","can","i","me","my"
]);

function stem(token) {
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

// ---------- UK time (24-hour) ----------
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

function addBubble(text, type = "bot", opts = {}) {
  const { html = false, ts = new Date(), feedback = false, feedbackMeta = null } = opts;

  const row = document.createElement("div");
  row.className = `msg ${type}`;
  row.dataset.ts = String(ts.getTime());

  const bubble = document.createElement("div");
  bubble.className = `bubble ${type}`;
  bubble.setAttribute("role", "article");
  bubble.setAttribute("aria-label", type === "bot" ? "Bot message" : "Your message");

  if (html) bubble.innerHTML = sanitizeHTML(text);
  else bubble.textContent = text;

  if (feedback && type === "bot") bubble.appendChild(buildFeedbackUI(feedbackMeta));

  const time = document.createElement("div");
  time.className = "timestamp";
  time.textContent = formatUKTime(ts);

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

function addChips(questions = [], onClick) {
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

      if (typeof onClick === "function") onClick(q);
      else handleUserMessage(q);

      input.focus();
    });

    wrap.appendChild(b);
  });

  if (isResponding) wrap.querySelectorAll(".chip-btn").forEach((btn) => (btn.disabled = true));
  chatWindow.appendChild(wrap);
  scrollToBottom();
}

// ---------- Feedback UI ----------
function buildFeedbackUI(meta) {
  const wrap = document.createElement("div");
  wrap.className = "feedback";

  const label = document.createElement("span");
  label.className = "label";
  label.textContent = "Helpful?";

  const up = document.createElement("button");
  up.type = "button";
  up.textContent = "👍";
  up.setAttribute("aria-label", "Helpful");

  const down = document.createElement("button");
  down.type = "button";
  down.textContent = "👎";
  down.setAttribute("aria-label", "Not helpful");

  const thanks = document.createElement("span");
  thanks.className = "thanks";
  thanks.hidden = true;

  function submit(value) {
    up.disabled = true;
    down.disabled = true;
    thanks.hidden = false;
    thanks.textContent = "Thanks!";

    console.log("feedback", { value, at: new Date().toISOString(), meta });
  }

  up.addEventListener("click", () => submit("up"));
  down.addEventListener("click", () => submit("down"));

  wrap.appendChild(label);
  wrap.appendChild(up);
  wrap.appendChild(down);
  wrap.appendChild(thanks);
  return wrap;
}

// ---------- Topics Drawer ----------
function buildCategoryIndex() {
  categoryIndex = new Map();

  for (const item of FAQS) {
    const key = (item.category || "general").toLowerCase();
    if (!categoryIndex.has(key)) categoryIndex.set(key, []);
    categoryIndex.get(key).push(item);
  }

  const labelMap = {
    general: "General",
    support: "Support",
    location: "Location",
    opening: "Opening times"
  };

  categories = [...categoryIndex.keys()]
    .sort()
    .map((key) => ({
      key,
      label: labelMap[key] || (key.charAt(0).toUpperCase() + key.slice(1)),
      count: categoryIndex.get(key).length
    }));
}

function openDrawer() {
  overlay.hidden = false;
  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  drawerCloseBtn?.focus();
}

function closeDrawer() {
  overlay.hidden = true;
  drawer.hidden = true;
  drawer.setAttribute("aria-hidden", "true");
  topicsBtn?.focus();
}

function renderDrawer(selectedKey = null) {
  drawerCategoriesEl.innerHTML = "";
  drawerQuestionsEl.innerHTML = "";

  categories.forEach((c) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "cat-pill";
    pill.textContent = `${c.label} (${c.count})`;
    pill.setAttribute("aria-selected", String(c.key === selectedKey));

    pill.addEventListener("click", () => renderDrawer(c.key));
    drawerCategoriesEl.appendChild(pill);
  });

  const list = selectedKey && categoryIndex.has(selectedKey)
    ? categoryIndex.get(selectedKey)
    : FAQS;

  list.forEach((item) => {
    const q = document.createElement("button");
    q.type = "button";
    q.className = "drawer-q";
    q.textContent = item.question;
    q.addEventListener("click", () => {
      closeDrawer();
      handleUserMessage(item.question);
    });
    drawerQuestionsEl.appendChild(q);
  });
}

/* ✅ MOBILE FIX: bind close on both click + touchstart */
function bindClose(el) {
  if (!el) return;

  el.addEventListener("click", (e) => {
    e.preventDefault();
    closeDrawer();
  });

  el.addEventListener(
    "touchstart",
    (e) => {
      e.preventDefault();
      closeDrawer();
    },
    { passive: false }
  );
}

topicsBtn?.addEventListener("click", () => {
  if (!faqsLoaded) return;
  openDrawer();
});

// stop taps inside drawer from acting like outside taps
drawer?.addEventListener("click", (e) => e.stopPropagation());
drawer?.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

bindClose(drawerCloseBtn);
bindClose(overlay);

document.addEventListener("keydown", (e) => {
  if (!drawer.hidden && e.key === "Escape") closeDrawer();
});

// ---------- Suggestions (typeahead) ----------
function escapeHTML(s) {
  return (s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showSuggestions(items) {
  currentSuggestions = items;
  activeSuggestionIndex = -1;

  if (!items.length) {
    suggestionsEl.hidden = true;
    suggestionsEl.innerHTML = "";
    return;
  }

  suggestionsEl.innerHTML = "";
  items.forEach((it, idx) => {
    const div = document.createElement("div");
    div.className = "suggestion-item";
    div.setAttribute("role", "option");
    div.setAttribute("aria-selected", "false");
    div.tabIndex = -1;

    div.innerHTML = `${escapeHTML(it.question)}<small>${escapeHTML(it.categoryLabel)}</small>`;

    div.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      pickSuggestion(idx);
    });

    div.addEventListener("touchstart", (ev) => {
      ev.preventDefault();
      pickSuggestion(idx);
    }, { passive: false });

    suggestionsEl.appendChild(div);
  });

  suggestionsEl.hidden = false;
}

function updateSuggestionSelection() {
  const nodes = suggestionsEl.querySelectorAll(".suggestion-item");
  nodes.forEach((n, i) => n.setAttribute("aria-selected", String(i === activeSuggestionIndex)));
}

function pickSuggestion(index) {
  const picked = currentSuggestions[index];
  if (!picked) return;

  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
  currentSuggestions = [];
  activeSuggestionIndex = -1;

  handleUserMessage(picked.question);
}

function computeSuggestions(query) {
  const q = normalize(query);
  if (!q || q.length < 2) return [];

  const qTokens = tokenSet(q);

  const scored = FAQS.map((item) => {
    const question = item.question || "";
    const syns = item.synonyms || [];
    const keys = item.canonicalKeywords || [];
    const tags = item.tags || [];

    const scoreQ = jaccard(qTokens, tokenSet(question));
    const scoreSyn = syns.length ? Math.max(...syns.map((s) => jaccard(qTokens, tokenSet(s)))) : 0;
    const scoreKeys = keys.length ? Math.max(...keys.map((k) => jaccard(qTokens, tokenSet(k)))) : 0;
    const scoreTags = tags.length ? Math.max(...tags.map((t) => jaccard(qTokens, tokenSet(t)))) : 0;

    const anyField = [question, ...syns, ...keys, ...tags].map(normalize).join(" ");
    const boost = anyField.includes(q) ? SETTINGS.boostSubstring : 0;

    const score = 0.60 * scoreQ + 0.22 * scoreSyn + 0.12 * scoreKeys + 0.06 * scoreTags + boost;
    return { item, score };
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, SETTINGS.suggestionLimit)
    .filter((x) => x.score > 0);

  const labelMap = new Map(categories.map((c) => [c.key, c.label]));

  return scored.map((s) => ({
    question: s.item.question,
    categoryLabel: labelMap.get((s.item.category || "general").toLowerCase()) || "General"
  }));
}

input.addEventListener("input", () => {
  if (!faqsLoaded) return;
  showSuggestions(computeSuggestions(input.value));
});

input.addEventListener("blur", () => {
  setTimeout(() => { suggestionsEl.hidden = true; }, 120);
});

input.addEventListener("keydown", (e) => {
  if (suggestionsEl.hidden) {
    if (e.key === "Enter") {
      e.preventDefault();
      sendChat();
    }
    return;
  }

  if (e.key === "ArrowDown") {
    e.preventDefault();
    activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, currentSuggestions.length - 1);
    updateSuggestionSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
    updateSuggestionSelection();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (activeSuggestionIndex >= 0) pickSuggestion(activeSuggestionIndex);
    else sendChat();
  } else if (e.key === "Escape") {
    suggestionsEl.hidden = true;
  }
});

// ---------- Opening hours + special cases ----------
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
  const safeUTC = new Date(Date.UTC(uk.year, uk.month - 1, uk.day, 12, 0, 0));
  safeUTC.setUTCDate(safeUTC.getUTCDate() + 1);
  const ukTomorrow = getUKParts(safeUTC);

  const day = ukWeekdayNumber(ukTomorrow.weekday);
  const isWeekend = day === 0 || day === 6;
  return !isWeekend;
}

function specialCases(query) {
  const q = normalize(query);

  if (q.includes("tomorrow")) {
    return willBeOpenTomorrowUK()
      ? { matched: true, answerHTML: "Yes — tomorrow is a weekday, so we’ll be open <b>8:30–17:00</b>." }
      : { matched: true, answerHTML: "Tomorrow is a <b>weekend</b>, so we’re closed.<br>Hours: <b>Mon–Fri, 8:30–17:00</b>." };
  }

  if (q.includes("available") || q.includes("open now") || q.includes("right now") || q.includes("anyone there")) {
    return isOpenNowUK()
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

  const scored = FAQS.map((item) => {
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
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < SETTINGS.minConfidence) {
    return { matched: false, suggestions: scored.slice(0, SETTINGS.topSuggestions).map((r) => r.item.question) };
  }

  return { matched: true, item: top.item, answerHTML: top.item.answer, followUps: top.item.followUps || [] };
}

// ---------- Guided fallback ----------
function getTopCategoriesFor(query) {
  const qTokens = tokenSet(query);

  const scoredCats = categories.map((c) => {
    const items = categoryIndex.get(c.key) || [];
    const field = items.map((it) => [it.question, ...(it.synonyms || []), ...(it.canonicalKeywords || [])].join(" ")).join(" ");
    const score = jaccard(qTokens, tokenSet(field));
    return { ...c, score };
  }).sort((a, b) => b.score - a.score);

  const top = scoredCats.filter((x) => x.score > 0).slice(0, 3);
  if (top.length) return top;
  return [...categories].sort((a, b) => b.count - a.count).slice(0, 3);
}

function showCategoryClarifier(query) {
  const topCats = getTopCategoriesFor(query);
  addBubble("Which topic is this closest to?", "bot", { ts: new Date() });

  addChips(topCats.map((c) => c.label), (label) => {
    const picked = topCats.find((c) => c.label === label);
    if (picked) showQuestionsForCategory(picked.key, true);
  });
}

function showQuestionsForCategory(key, includeIntro = false) {
  const items = categoryIndex.get(key) || [];
  const label = categories.find((c) => c.key === key)?.label || "Topic";

  if (includeIntro) addBubble(`Here are common questions in <b>${label}</b>:`, "bot", { html: true, ts: new Date() });

  addChips(items.map((it) => it.question), (q) => handleUserMessage(q));
}

// ---------- Main handler ----------
function handleUserMessage(text) {
  if (!text) return;

  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
  currentSuggestions = [];
  activeSuggestionIndex = -1;

  addBubble(text, "user", { ts: new Date() });
  input.value = "";

  isResponding = true;
  setUIEnabled(false);
  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot", { ts: new Date() });
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    const special = specialCases(text);
    if (special?.matched) {
      addBubble(special.answerHTML, "bot", {
        html: true,
        ts: new Date(),
        feedback: true,
        feedbackMeta: { type: "special", query: text }
      });
      missCount = 0;
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    const res = matchFAQ(text);

    if (res.matched) {
      addBubble(res.answerHTML, "bot", {
        html: true,
        ts: new Date(),
        feedback: true,
        feedbackMeta: { type: "faq", question: res.item.question, category: res.item.category || "general" }
      });
      missCount = 0;

      if (res.followUps?.length) {
        addBubble("You can also ask:", "bot", { ts: new Date() });
        addChips(res.followUps);
      }
    } else {
      missCount++;

      if (missCount === 1) {
        showCategoryClarifier(text);
      } else {
        addBubble("I’m still not sure. Did you mean:", "bot", { ts: new Date() });
        addChips(res.suggestions || []);

        addBubble(
          'If you’d like, you can contact support at <a href="mailto:support@Kelly.co.uk">support@Kelly.co.uk</a> or call <b>01234 567890</b>.',
          "bot",
          { html: true, ts: new Date(), feedback: true, feedbackMeta: { type: "escalation" } }
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
  const text = input.value.trim();
  if (!text) return;
  handleUserMessage(text);
}

sendBtn.addEventListener("click", sendChat);

clearBtn?.addEventListener("click", () => {
  chatWindow.innerHTML = "";
  missCount = 0;
  init();
});

// ---------- Init ----------
function init() {
  addBubble(SETTINGS.greeting, "bot", { html: true, ts: new Date() });
}

if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", init);
else init();
