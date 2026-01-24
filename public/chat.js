
/* -------------------------------------------------------
 Welfare Support – Static FAQ Chatbot (Polished + Human-like)
 Features:
 - No saved memory (refresh resets)
 - Topics drawer (browse by category)
 - Search-as-you-type suggestions
 - Helpful feedback buttons (👍/👎)
 - Guided fallback (category clarification)
 - Quiet spelling correction (auto-corrects typos without asking)
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
let categories = [];              // [{key, label, count}]
let categoryIndex = new Map();    // key -> [faqItems]

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
let missCount = 0; // in-session only; resets on refresh

// suggestion keyboard state
let activeSuggestionIndex = -1;
let currentSuggestions = [];

// ---------- Helpers ----------
const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”‘’]/g, '"')
    .replace(/[–—]/g, "-")
    // Broad compatibility: keep letters/numbers/spaces/hyphens (ASCII)
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

// -----------------------------
// Spelling correction (quiet mode)
// -----------------------------
let VOCAB = new Set();

function shouldSkipToken(tok) {
  if (!tok) return true;
  if (tok.length <= 3) return true;
  if (/\d/.test(tok)) return true;
  if (tok.includes("@") || tok.includes(".")) return true;
  if (!/^[a-z-]+$/.test(tok)) return true;
  return false;
}

function levenshtein(a, b, maxDist) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > maxDist) return maxDist + 1;

  const prev = new Array(bl + 1);
  const curr = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let minInRow = curr[0];
    const ai = a.charCodeAt(i - 1);

    for (let j = 1; j <= bl; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < minInRow) minInRow = curr[j];
    }

    if (minInRow > maxDist) return maxDist + 1;
    for (let j = 0; j <= bl; j++) prev[j] = curr[j];
  }

  return prev[bl];
}

function bestVocabMatch(token) {
  if (shouldSkipToken(token)) return null;
  if (VOCAB.has(token)) return null;

  const maxDist = token.length <= 5 ? 1 : 2;
  let best = null;
  let bestDist = maxDist + 1;

  for (const w of VOCAB) {
    if (Math.abs(w.length - token.length) > maxDist) continue;
    const d = levenshtein(token, w, maxDist);
    if (d < bestDist) {
      bestDist = d;
      best = w;
      if (bestDist === 1) break;
    }
  }

  return bestDist <= maxDist ? best : null;
}

function buildVocabFromFAQs() {
  const vocab = new Set();

  for (const item of FAQS) {
    const fields = [
      item.question,
      ...(item.synonyms || []),
      ...(item.canonicalKeywords || []),
      ...(item.tags || []),
      item.category
    ];

    for (const f of fields) {
      const toks = normalize(f).split(" ").filter(Boolean);
      for (const t of toks) {
        if (!shouldSkipToken(t)) vocab.add(t);
      }
    }
  }

  VOCAB = vocab;
}

function correctQueryTokens(rawText) {
  const norm = normalize(rawText);
  if (!norm) return { corrected: norm, changed: false };

  const tokens = norm.split(" ").filter(Boolean);
  let changed = false;

  const correctedTokens = tokens.map((t) => {
    const fixed = bestVocabMatch(t);
    if (fixed) {
      changed = true;
      return fixed;
    }
    return t;
  });

  return { corrected: correctedTokens.join(" "), changed: changed };
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

function addBubble(text, type, opts) {
  const options = opts || {};
  const html = !!options.html;
  const ts = options.ts || new Date();
  const feedback = !!options.feedback;
  const feedbackMeta = options.feedbackMeta || null;

  const row = document.createElement("div");
  row.className = "msg " + type;
  row.dataset.ts = String(ts.getTime());

  const bubble = document.createElement("div");
  bubble.className = "bubble " + type;
  bubble.setAttribute("role", "article");
  bubble.setAttribute("aria-label", type === "bot" ? "Bot message" : "Your message");

  if (html) bubble.innerHTML = sanitizeHTML(text);
  else bubble.textContent = text;

  if (feedback && type === "bot") {
    bubble.appendChild(buildFeedbackUI(feedbackMeta));
  }

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
  bubble.innerHTML = 'Typing <span class="typing"><span></span><span></span><span></span></span>';

  row.appendChild(bubble);
  chatWindow.appendChild(row);
  scrollToBottom();
}

function removeTyping() {
  const t = chatWindow.querySelector('[data-typing="true"]');
  if (t) t.remove();
}

function addChips(questions, onClick) {
  const qs = questions || [];
  if (!qs.length) return;

  const wrap = document.createElement("div");
  wrap.className = "chips";

  qs.slice(0, SETTINGS.chipLimit).forEach(function (q) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip-btn";
    b.textContent = q;

    b.addEventListener("click", function () {
      const now = Date.now();
      if (isResponding) return;
      if (now - lastChipClickAt < SETTINGS.chipClickCooldownMs) return;
      lastChipClickAt = now;

      wrap.querySelectorAll(".chip-btn").forEach(function (btn) { btn.disabled = true; });
      if (typeof onClick === "function") onClick(q);
      else handleUserMessage(q);
      input.focus();
    });

    wrap.appendChild(b);
  });

  if (isResponding) wrap.querySelectorAll(".chip-btn").forEach(function (btn) { btn.disabled = true; });
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
    console.log("feedback", { value: value, at: new Date().toISOString(), meta: meta });
  }

  up.addEventListener("click", function () { submit("up"); });
  down.addEventListener("click", function () { submit("down"); });

  wrap.appendChild(label);
  wrap.appendChild(up);
  wrap.appendChild(down);
  wrap.appendChild(thanks);
  return wrap;
}

// ---------- Topics Drawer ----------
function buildCategoryIndex() {
  categoryIndex = new Map();

  FAQS.forEach(function (item) {
    const key = (item.category || "general").toLowerCase();
    if (!categoryIndex.has(key)) categoryIndex.set(key, []);
    categoryIndex.get(key).push(item);
  });

  const labelMap = {
    general: "General",
    support: "Support",
    location: "Location",
    opening: "Opening times"
  };

  categories = Array.from(categoryIndex.keys())
    .sort()
    .map(function (key) {
      return {
        key: key,
        label: labelMap[key] || (key.charAt(0).toUpperCase() + key.slice(1)),
        count: categoryIndex.get(key).length
      };
    });
}

function openDrawer() {
  overlay.hidden = false;
  drawer.hidden = false;
  drawer.setAttribute("aria-hidden", "false");
  if (drawerCloseBtn) drawerCloseBtn.focus();
}

function closeDrawer() {
  overlay.hidden = true;
  drawer.hidden = true;
  drawer.setAttribute("aria-hidden", "true");
  if (topicsBtn) topicsBtn.focus();
}

function renderDrawer(selectedKey) {
  const selected = selectedKey || null;
  drawerCategoriesEl.innerHTML = "";
  drawerQuestionsEl.innerHTML = "";

  categories.forEach(function (c) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "cat-pill";
    pill.textContent = c.label + " (" + c.count + ")";
    pill.setAttribute("aria-selected", String(c.key === selected));

    pill.addEventListener("click", function () { renderDrawer(c.key); });
    drawerCategoriesEl.appendChild(pill);
  });

  const list = selected && categoryIndex.has(selected) ? categoryIndex.get(selected) : FAQS;

  list.forEach(function (item) {
    const q = document.createElement("button");
    q.type = "button";
    q.className = "drawer-q";
    q.textContent = item.question;
    q.addEventListener("click", function () {
      closeDrawer();
      handleUserMessage(item.question);
    });
    drawerQuestionsEl.appendChild(q);
  });
}

function bindClose(el) {
  if (!el) return;

  el.addEventListener("click", function (e) {
    e.preventDefault();
    closeDrawer();
  });

  el.addEventListener(
    "touchstart",
    function (e) {
      e.preventDefault();
      closeDrawer();
    },
    { passive: false }
  );
}

if (topicsBtn) {
  topicsBtn.addEventListener("click", function () {
    if (!faqsLoaded) return;
    openDrawer();
  });
}

if (drawer) {
  drawer.addEventListener("click", function (e) { e.stopPropagation(); });
  drawer.addEventListener("touchstart", function (e) { e.stopPropagation(); }, { passive: true });
}

bindClose(drawerCloseBtn);
bindClose(overlay);

document.addEventListener("keydown", function (e) {
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
  items.forEach(function (it, idx) {
    const div = document.createElement("div");
    div.className = "suggestion-item";
    div.setAttribute("role", "option");
    div.setAttribute("aria-selected", "false");
    div.tabIndex = -1;

    div.innerHTML = escapeHTML(it.question) + "<small>" + escapeHTML(it.categoryLabel) + "</small>";

    div.addEventListener("mousedown", function (ev) {
      ev.preventDefault();
      pickSuggestion(idx);
    });

    div.addEventListener(
      "touchstart",
      function (ev) {
        ev.preventDefault();
        pickSuggestion(idx);
      },
      { passive: false }
    );

    suggestionsEl.appendChild(div);
  });

  suggestionsEl.hidden = false;
}

function updateSuggestionSelection() {
  const nodes = suggestionsEl.querySelectorAll(".suggestion-item");
  nodes.forEach(function (n, i) {
    n.setAttribute("aria-selected", String(i === activeSuggestionIndex));
  });
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
  let q = normalize(query);
  if (!q || q.length < 2) return [];

  const correction = correctQueryTokens(query);
  if (correction.changed && correction.corrected) q = correction.corrected;

  const qTokens = tokenSet(q);

  const scored = FAQS.map(function (item) {
    const question = item.question || "";
    const syns = item.synonyms || [];
    const keys = item.canonicalKeywords || [];
    const tags = item.tags || [];

    const scoreQ = jaccard(qTokens, tokenSet(question));
    const scoreSyn = syns.length ? Math.max.apply(null, syns.map(function (s) { return jaccard(qTokens, tokenSet(s)); })) : 0;
    const scoreKeys = keys.length ? Math.max.apply(null, keys.map(function (k) { return jaccard(qTokens, tokenSet(k)); })) : 0;
    const scoreTags = tags.length ? Math.max.apply(null, tags.map(function (t) { return jaccard(qTokens, tokenSet(t)); })) : 0;

    const anyField = [question].concat(syns, keys, tags).map(normalize).join(" ");
    const boost = anyField.includes(q) ? SETTINGS.boostSubstring : 0;

    const score = 0.60 * scoreQ + 0.22 * scoreSyn + 0.12 * scoreKeys + 0.06 * scoreTags + boost;
    return { item: item, score: score };
  })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, SETTINGS.suggestionLimit)
    .filter(function (x) { return x.score > 0; });

  const labelMap = new Map(categories.map(function (c) { return [c.key, c.label]; }));

  return scored.map(function (s) {
    return {
      question: s.item.question,
      categoryLabel: labelMap.get((s.item.category || "general").toLowerCase()) || "General"
    };
  });
}

input.addEventListener("input", function () {
  if (!faqsLoaded) return;
  showSuggestions(computeSuggestions(input.value));
});

input.addEventListener("blur", function () {
  setTimeout(function () { suggestionsEl.hidden = true; }, 120);
});

input.addEventListener("keydown", function (e) {
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
function getUKParts(date) {
  const d = date || new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(d);

  const map = Object.fromEntries(parts.map(function (p) { return [p.type, p.value]; }));
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
  const uk = getUKParts(new Date());
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

  const scored = FAQS.map(function (item) {
    const question = item.question || "";
    const syns = item.synonyms || [];
    const keys = item.canonicalKeywords || [];
    const tags = item.tags || [];

    const scoreQ = jaccard(qTokens, tokenSet(question));
    const scoreSyn = syns.length ? Math.max.apply(null, syns.map(function (s) { return jaccard(qTokens, tokenSet(s)); })) : 0;
    const scoreKeys = keys.length ? Math.max.apply(null, keys.map(function (k) { return jaccard(qTokens, tokenSet(k)); })) : 0;
    const scoreTags = tags.length ? Math.max.apply(null, tags.map(function (t) { return jaccard(qTokens, tokenSet(t)); })) : 0;

    const anyField = [question].concat(syns, keys, tags).map(normalize).join(" ");
    const boost = anyField.includes(qNorm) ? SETTINGS.boostSubstring : 0;

    const score = 0.55 * scoreQ + 0.25 * scoreSyn + 0.12 * scoreKeys + 0.08 * scoreTags + boost;
    return { item: item, score: score };
  }).sort(function (a, b) { return b.score - a.score; });

  const top = scored[0];
  if (!top || top.score < SETTINGS.minConfidence) {
    return {
      matched: false,
      suggestions: scored.slice(0, SETTINGS.topSuggestions).map(function (r) { return r.item.question; })
    };
  }

  return {
    matched: true,
    item: top.item,
    answerHTML: top.item.answer,
    followUps: top.item.followUps || []
  };
}

// ---------- Guided fallback ----------
function getTopCategoriesFor(query) {
  const qTokens = tokenSet(query);

  const scoredCats = categories
    .map(function (c) {
      const items = categoryIndex.get(c.key) || [];
      const field = items
        .map(function (it) {
          return [it.question].concat(it.synonyms || [], it.canonicalKeywords || []).join(" ");
        })
        .join(" ");
      const score = jaccard(qTokens, tokenSet(field));
      return { key: c.key, label: c.label, count: c.count, score: score };
    })
    .sort(function (a, b) { return b.score - a.score; });

  const top = scoredCats.filter(function (x) { return x.score > 0; }).slice(0, 3);
  if (top.length) return top;
  return categories.slice().sort(function (a, b) { return b.count - a.count; }).slice(0, 3);
}

function showCategoryClarifier(query) {
  const topCats = getTopCategoriesFor(query);
  addBubble("Which topic is this closest to?", "bot", { ts: new Date() });

  const options = topCats.map(function (c) { return c.label; });
  addChips(options, function (label) {
    const picked = topCats.find(function (c) { return c.label === label; });
    if (!picked) return;
    showQuestionsForCategory(picked.key, true);
  });
}

function showQuestionsForCategory(key, includeIntro) {
  const items = categoryIndex.get(key) || [];
  const labelObj = categories.find(function (c) { return c.key === key; });
  const label = labelObj ? labelObj.label : "Topic";

  if (includeIntro) {
    addBubble("Here are common questions in <b>" + label + "</b>:", "bot", { html: true, ts: new Date() });
  }

  const qs = items.map(function (it) { return it.question; });
  addChips(qs, function (q) { handleUserMessage(q); });
}

// ---------- Main handler ----------
function handleUserMessage(text) {
  if (!text) return;

  // Hide suggestions once user sends
  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
  currentSuggestions = [];
  activeSuggestionIndex = -1;

  addBubble(text, "user", { ts: new Date() });
  input.value = "";

  isResponding = true;
  setUIEnabled(false);
  addTyping();

  setTimeout(function () {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot", { ts: new Date() });
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    const special = specialCases(text);
    if (special && special.matched) {
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

    // FAQ match with quiet spelling correction
    let res = matchFAQ(text);
    if (!res.matched) {
      const corr = correctQueryTokens(text);
      if (corr.changed && corr.corrected) {
        const res2 = matchFAQ(corr.corrected);
        if (res2.matched) res = res2;
        else if ((res2.suggestions || []).length > (res.suggestions || []).length) res = res2;
      }
    }

    if (res.matched) {
      addBubble(res.answerHTML, "bot", {
        html: true,
        ts: new Date(),
        feedback: true,
        feedbackMeta: { type: "faq", question: res.item.question, category: res.item.category || "general" }
      });
      missCount = 0;

      if (res.followUps && res.followUps.length) {
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
          "If you’d like, you can contact support at <a href=\"mailto:support@Kelly.co.uk\">support@Kelly.co.uk</a> or call <b>01234 567890</b>.",
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

// Enter submits when suggestion list isn't open
input.addEventListener("keydown", function (e) {
  if (!suggestionsEl.hidden) return;
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

clearBtn.addEventListener("click", function () {
  chatWindow.innerHTML = "";
  missCount = 0;
  init();
});

// ---------- Load FAQs (single fetch) ----------
fetch("./public/config/faqs.json")
  .then(function (res) { return res.json(); })
  .then(function (data) {
    FAQS = Array.isArray(data) ? data : [];
    faqsLoaded = true;
    buildCategoryIndex();
    buildVocabFromFAQs();
    renderDrawer();
  })
  .catch(function () {
    FAQS = [];
    faqsLoaded = true;
    buildCategoryIndex();
    buildVocabFromFAQs();
    renderDrawer();
  });

// ---------- Init ----------
function init() {
  addBubble(SETTINGS.greeting, "bot", { html: true, ts: new Date() });
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
