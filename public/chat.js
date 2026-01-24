

/* ---------------------------------------------------------
 Welfare Support – Static FAQ Chatbot (Polished + Human-like)

 Includes:
 - Topics drawer (browse by category)
 - Search-as-you-type suggestions (with safe escaping)
 - Guided fallback (category clarification)
 - Quiet spelling correction (auto-corrects typos)
 - Closest depot flow (origin -> choose travel mode)
 - Ticket/request flow (prefilled email + transcript)
 - Google Maps directions link for depot answers

 NOTE: Static hosting (GitHub Pages) cannot send emails directly.
 Ticket flow uses mailto: (opens user's email app with prefilled content).

 NOTE: Feedback thumbs (👍/👎) REMOVED.
--------------------------------------------------------- */

const SETTINGS = {
  minConfidence: 0.20,
  topSuggestions: 3,
  boostSubstring: 0.12,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  suggestionLimit: 4,

  supportEmail: "support@Kelly.co.uk",
  supportPhone: "01234 567890",

  // Transcript settings (avoid huge mailto bodies)
  ticketTranscriptMessages: 20, // last N messages (user + bot)

  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, where we’re located, or how far you are from your closest depot."
};

let FAQS = [];
let faqsLoaded = false;
let categories = [];
let categoryIndex = new Map();

// ---------------------------------------------------------
// DOM
// ---------------------------------------------------------
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

// ---------------------------------------------------------
// UI State
// ---------------------------------------------------------
let isResponding = false;
let lastChipClickAt = 0;
let missCount = 0;

// suggestion keyboard state
let activeSuggestionIndex = -1;
let currentSuggestions = [];

// distance flow context (in-memory only; refresh resets)
let distanceCtx = null;

// category clarification flow context
let clarifyCtx = null; // { stage: "needCategory", originalQuery: "..." }

// ticket/request flow context
let ticketCtx = null; // { stage, type, name, email, description, urgency }

// in-memory transcript log (latest messages for ticket emails)
let CHAT_LOG = []; // { role: "User"|"Bot", text: string, ts: number }

// ---------------------------------------------------------
// NORMALISATION + MATCHING
// ---------------------------------------------------------
const normalize = (s) =>
  (s ?? "")
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

// ---------------------------------------------------------
// SAFE HTML RENDERING
// ---------------------------------------------------------
function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;

  const allowedTags = new Set(["B", "STRONG", "I", "EM", "BR", "A", "SMALL"]);
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
      const href = el.getAttribute("href") ?? "";
      const safe = /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
      if (!safe) el.removeAttribute("href");
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }
  }

  toReplace.forEach((node) => node.replaceWith(document.createTextNode(node.textContent)));
  return template.innerHTML;
}

// Convert HTML to plain text (for email transcript)
function htmlToPlainText(html) {
  const template = document.createElement("template");
  template.innerHTML = html ?? "";
  return (template.content.textContent ?? "").replace(/\s+\n/g, "\n").trim();
}

// ---------------------------------------------------------
// TIMESTAMPS (UK, 24-HOUR)
// ---------------------------------------------------------
const UK_TZ = "Europe/London";
function formatUKTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: UK_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

// ---------------------------------------------------------
// DEPOTS + ORIGIN PLACES (EDIT THESE)
// ---------------------------------------------------------
const DEPOTS = {
  "nuneaton": { label: "Nuneaton Depot", lat: 52.5230, lon: -1.4652 }
};

const PLACES = {
  "coventry": { lat: 52.4068, lon: -1.5197 },
  "birmingham": { lat: 52.4895, lon: -1.8980 },
  "leicester": { lat: 52.6369, lon: -1.1398 },
  "london": { lat: 51.5074, lon: -0.1278 },
  "wolverhampton": { lat: 52.5862, lon: -2.1286 }
};

function titleCase(s) {
  const t = (s ?? "").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function distanceMiles(a, b) {
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.asin(Math.sqrt(h)));
}

function parseTravelMode(qNorm) {
  if (qNorm.includes("train") || qNorm.includes("rail")) return "train";
  if (qNorm.includes("bus") || qNorm.includes("coach")) return "bus";
  if (qNorm.includes("walk") || qNorm.includes("walking")) return "walk";
  if (qNorm.includes("car") || qNorm.includes("drive") || qNorm.includes("driving")) return "car";
  return null;
}

function estimateMinutes(miles, mode) {
  const mphMap = { car: 35, train: 55, bus: 20, walk: 3 };
  const mph = mphMap[mode] ?? 35;
  return Math.round((miles / mph) * 60);
}

function modeLabel(mode) {
  const map = { car: "by car", train: "by train", bus: "by bus", walk: "walking" };
  return map[mode] ?? "by car";
}

function findPlaceKey(qNorm) {
  for (const key in PLACES) {
    if (!Object.prototype.hasOwnProperty.call(PLACES, key)) continue;
    if (qNorm.includes(key)) return key;
  }
  return null;
}

function findClosestDepot(originLatLon) {
  let bestKey = null;
  let bestMiles = Infinity;
  for (const key in DEPOTS) {
    if (!Object.prototype.hasOwnProperty.call(DEPOTS, key)) continue;
    const miles = distanceMiles(originLatLon, DEPOTS[key]);
    if (miles < bestMiles) {
      bestMiles = miles;
      bestKey = key;
    }
  }
  return bestKey ? { depotKey: bestKey, miles: bestMiles } : null;
}

// Google Maps directions link
function googleDirectionsURL(originText, depot, mode) {
  const origin = encodeURIComponent(originText);
  const destination = encodeURIComponent(`${depot.lat},${depot.lon}`);
  let travelmode = "driving";
  if (mode === "walk") travelmode = "walking";
  if (mode === "train" || mode === "bus") travelmode = "transit";
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=${travelmode}`;
}

// ---------------------------------------------------------
// QUIET SPELLING CORRECTION
// ---------------------------------------------------------
let VOCAB = new Set();

const PROTECTED_TOKENS = new Set([
  "walking","walk",
  "by","car","train","bus",
  "rail","coach",
  "depot","depots",
  "closest"
]);

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
  if (PROTECTED_TOKENS.has(token)) return null;
  if (shouldSkipToken(token)) return null;
  if (VOCAB.has(token)) return null;

  const maxDist = token.length <= 7 ? 1 : 2;
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
      ...(item.synonyms ?? []),
      ...(item.canonicalKeywords ?? []),
      ...(item.tags ?? []),
      item.category
    ];

    for (const f of fields) {
      const toks = normalize(f).split(" ").filter(Boolean);
      for (const t of toks) {
        if (!shouldSkipToken(t)) vocab.add(t);
      }
    }
  }

  for (const dk in DEPOTS) {
    if (!Object.prototype.hasOwnProperty.call(DEPOTS, dk)) continue;
    normalize(dk).split(" ").forEach((t) => { if (!shouldSkipToken(t)) vocab.add(t); });
    normalize(DEPOTS[dk].label).split(" ").forEach((t) => { if (!shouldSkipToken(t)) vocab.add(t); });
  }

  for (const pk in PLACES) {
    if (!Object.prototype.hasOwnProperty.call(PLACES, pk)) continue;
    normalize(pk).split(" ").forEach((t) => { if (!shouldSkipToken(t)) vocab.add(t); });
  }

  ["walking","walk","by","car","train","bus","rail","coach","depot","depots","closest"].forEach((w) => vocab.add(w));
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

  return { corrected: correctedTokens.join(" "), changed };
}

// ---------------------------------------------------------
// UI / BUBBLES + TRANSCRIPT (No feedback UI)
// ---------------------------------------------------------
function setUIEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  chatWindow.querySelectorAll(".chip-btn").forEach((b) => (b.disabled = !enabled));
}

function pushToTranscript(type, text, opts) {
  const options = opts ?? {};
  const tsDate = options.ts ?? new Date();
  const ts = tsDate.getTime();

  let plain = "";
  if (options.html) plain = htmlToPlainText(text);
  else plain = String(text ?? "").trim();

  const role = (type === "bot") ? "Bot" : "User";
  if (plain) CHAT_LOG.push({ role, text: plain, ts });

  const keep = Math.max(SETTINGS.ticketTranscriptMessages ?? 20, 20) * 3;
  if (CHAT_LOG.length > keep) CHAT_LOG = CHAT_LOG.slice(-keep);
}

function buildTranscript(limit = 20) {
  const take = Math.max(1, limit);
  const slice = CHAT_LOG.slice(-take);
  return slice.map((m) => {
    const time = formatUKTime(new Date(m.ts));
    const msg = (m.text ?? "").replace(/\s+/g, " ").trim();
    return `[${time}] ${m.role}: ${msg}`;
  }).join("\n");
}

function addBubble(text, type, opts) {
  const options = opts ?? {};
  const html = !!options.html;
  const ts = options.ts ?? new Date();

  const row = document.createElement("div");
  row.className = "msg " + type;
  row.dataset.ts = String(ts.getTime());

  const bubble = document.createElement("div");
  bubble.className = "bubble " + type;
  bubble.setAttribute("role", "article");
  bubble.setAttribute("aria-label", type === "bot" ? "Bot message" : "Your message");

  if (html) bubble.innerHTML = sanitizeHTML(text);
  else bubble.textContent = text;

  const time = document.createElement("div");
  time.className = "timestamp";
  time.textContent = formatUKTime(ts);

  row.appendChild(bubble);
  row.appendChild(time);
  chatWindow.appendChild(row);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  pushToTranscript(type, html ? sanitizeHTML(text) : text, { ts, html });
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
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeTyping() {
  const t = chatWindow.querySelector('[data-typing="true"]');
  if (t) t.remove();
}

function addChips(questions, onClick) {
  const qs = questions ?? [];
  if (!qs.length) return;

  const wrap = document.createElement("div");
  wrap.className = "chips";

  qs.slice(0, SETTINGS.chipLimit).forEach((q) => {
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
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

// ---------------------------------------------------------
// TOPICS DRAWER
// ---------------------------------------------------------
function buildCategoryIndex() {
  categoryIndex = new Map();
  FAQS.forEach((item) => {
    const key = (item.category ?? "general").toLowerCase();
    if (!categoryIndex.has(key)) categoryIndex.set(key, []);
    categoryIndex.get(key).push(item);
  });

  const labelMap = {
    general: "General",
    support: "Support",
    location: "Location",
    opening: "Opening times",
    actions: "Actions"
  };

  categories = Array.from(categoryIndex.keys())
    .sort()
    .map((key) => ({
      key,
      label: labelMap[key] ?? (key.charAt(0).toUpperCase() + key.slice(1)),
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

function renderDrawer(selectedKey) {
  const selected = selectedKey ?? null;
  drawerCategoriesEl.innerHTML = "";
  drawerQuestionsEl.innerHTML = "";

  categories.forEach((c) => {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "cat-pill";
    pill.textContent = `${c.label} (${c.count})`;
    pill.setAttribute("aria-selected", String(c.key === selected));
    pill.addEventListener("click", () => renderDrawer(c.key));
    drawerCategoriesEl.appendChild(pill);
  });

  const list = selected && categoryIndex.has(selected) ? categoryIndex.get(selected) : FAQS;
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
drawer?.addEventListener("click", (e) => e.stopPropagation());
drawer?.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });
bindClose(drawerCloseBtn);
bindClose(overlay);
document.addEventListener("keydown", (e) => {
  if (!drawer.hidden && e.key === "Escape") closeDrawer();
});

// ---------------------------------------------------------
// TYPEAHEAD SUGGESTIONS
// ---------------------------------------------------------
function escapeHTML(s) {
  const str = String(s ?? "");
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  };
  return str.replace(/[&<>"']/g, (ch) => map[ch]);
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

    div.addEventListener(
      "touchstart",
      (ev) => {
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
  let q = normalize(query);
  if (!q || q.length < 2) return [];

  const corr = correctQueryTokens(query);
  if (corr.changed && corr.corrected) q = corr.corrected;

  const qTokens = tokenSet(q);

  const scored = FAQS.map((item) => {
    const question = item.question ?? "";
    const syns = item.synonyms ?? [];
    const keys = item.canonicalKeywords ?? [];
    const tags = item.tags ?? [];

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
    categoryLabel: labelMap.get((s.item.category ?? "general").toLowerCase()) ?? "General"
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

// ---------------------------------------------------------
// FAQ MATCHING
// ---------------------------------------------------------
function matchFAQ(query) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(query);

  const scored = FAQS
    .map((item) => {
      const question = item.question ?? "";
      const syns = item.synonyms ?? [];
      const keys = item.canonicalKeywords ?? [];
      const tags = item.tags ?? [];

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
    item: top.item,
    answerHTML: top.item.answer,
    followUps: top.item.followUps ?? []
  };
}

// Category clarification helpers
function categoryKeyFromLabelOrKey(textNorm) {
  for (const c of categories) {
    const keyNorm = normalize(c.key);
    const labelNorm = normalize(c.label);
    if (
      textNorm === keyNorm ||
      textNorm === labelNorm ||
      textNorm.includes(keyNorm) ||
      textNorm.includes(labelNorm)
    ) {
      return c.key;
    }
  }
  return null;
}

function matchFAQFromList(query, list) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(query);

  const scored = (list || [])
    .map((item) => {
      const question = item.question ?? "";
      const syns = item.synonyms ?? [];
      const keys = item.canonicalKeywords ?? [];
      const tags = item.tags ?? [];

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
    item: top.item,
    answerHTML: top.item.answer,
    followUps: top.item.followUps ?? []
  };
}

// ---------------------------------------------------------
// SPECIAL CASES (category clarification + ticket + depot + parking)
// ---------------------------------------------------------
function specialCases(query) {
  const corr = correctQueryTokens(query);
  const q = corr.changed && corr.corrected ? corr.corrected : normalize(query);

  // (4) Category clarification flow
  if (clarifyCtx && clarifyCtx.stage === "needCategory") {
    const pickedKey = categoryKeyFromLabelOrKey(q);

    if (pickedKey && categoryIndex.has(pickedKey)) {
      const list = categoryIndex.get(pickedKey);
      const res = matchFAQFromList(clarifyCtx.originalQuery, list);

      clarifyCtx = null;

      if (res.matched) {
        return {
          matched: true,
          answerHTML: res.answerHTML,
          chips: (res.followUps && res.followUps.length) ? res.followUps : null
        };
      }

      return {
        matched: true,
        answerHTML: `Thanks — I still couldn’t match that under <b>${escapeHTML(pickedKey)}</b>. Try one of these:`,
        chips: res.suggestions ?? []
      };
    }
  }

  // (5) Ticket / request flow (mailto + transcript)
  const wantsTicket =
    q.includes("raise a request") ||
    q.includes("create a ticket") ||
    q.includes("open a ticket") ||
    q.includes("log a ticket") ||
    q.includes("submit a request") ||
    q === "ticket";

  if (!ticketCtx && wantsTicket) {
    ticketCtx = { stage: "needType" };
    return {
      matched: true,
      answerHTML: "Sure — what do you need help with?",
      chips: ["Access / Login", "Pay / Payroll", "Benefits", "General query", "Something else"]
    };
  }

  if (ticketCtx) {
    if (q === "cancel" || q === "stop" || q === "restart") {
      ticketCtx = null;
      return {
        matched: true,
        answerHTML: "No problem — I’ve cancelled that request. If you want to start again, type <b>raise a request</b>."
      };
    }

    if (ticketCtx.stage === "needType") {
      ticketCtx.type = query.trim();
      ticketCtx.stage = "needName";
      return { matched: true, answerHTML: "Thanks — what’s your name?" };
    }

    if (ticketCtx.stage === "needName") {
      ticketCtx.name = query.trim();
      ticketCtx.stage = "needEmail";
      return { matched: true, answerHTML: "And what email should we reply to?" };
    }

    if (ticketCtx.stage === "needEmail") {
      const email = query.trim();
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!ok) return { matched: true, answerHTML: "That doesn’t look like an email — can you retype it?" };
      ticketCtx.email = email;
      ticketCtx.stage = "needDescription";
      return { matched: true, answerHTML: "Briefly describe the issue (1–3 sentences is perfect)." };
    }

    if (ticketCtx.stage === "needDescription") {
      ticketCtx.description = query.trim();
      ticketCtx.stage = "needUrgency";
      return {
        matched: true,
        answerHTML: "How urgent is this?",
        chips: ["Low", "Normal", "High", "Critical"]
      };
    }

    if (ticketCtx.stage === "needUrgency") {
      ticketCtx.urgency = query.trim();

      const transcript = buildTranscript(SETTINGS.ticketTranscriptMessages ?? 20);
      const subject = encodeURIComponent(`[Welfare Support] ${ticketCtx.type} (${ticketCtx.urgency})`);
      const body = encodeURIComponent(
        `Name: ${ticketCtx.name}\n` +
        `Email: ${ticketCtx.email}\n` +
        `Urgency: ${ticketCtx.urgency}\n` +
        `Type: ${ticketCtx.type}\n\n` +
        `Description:\n${ticketCtx.description}\n\n` +
        `Chat transcript (latest messages):\n${transcript}\n\n` +
        `— Sent from Welfare Support chatbot`
      );

      const mailtoHref = `mailto:${SETTINGS.supportEmail}?subject=${subject}&body=${body}`;

      // ✅ FIX: Make the mailto clickable with a proper <a href="...">
      const summary =
        `<b>Request summary</b><br>` +
        `Type: <b>${escapeHTML(ticketCtx.type)}</b><br>` +
        `Urgency: <b>${escapeHTML(ticketCtx.urgency)}</b><br>` +
        `Name: <b>${escapeHTML(ticketCtx.name)}</b><br>` +
        `Email: <b>${escapeHTML(ticketCtx.email)}</b><br><br>` +
        `<a href="${mailtoHref}">Click here to email support with this request (includes chat transcript)</a><br>` +
        `<small>(This opens your email app with the message prefilled — you then press Send.)</small><br><br>` +
        `Want to start another?`;

      ticketCtx = null;

      return {
        matched: true,
        answerHTML: summary,
        chips: ["Raise a request (create a ticket)"]
      };
    }
  }

  // Depot flow: after closest depot is known, user picks travel mode
  if (distanceCtx && distanceCtx.stage === "haveClosest") {
    if (q === "by car" || q === "by train" || q === "by bus" || q === "walking") {
      const mode = (q === "walking") ? "walk" : q.replace("by ", "");
      const depot = DEPOTS[distanceCtx.depotKey];
      const minutes = estimateMinutes(distanceCtx.miles, mode);
      const url = googleDirectionsURL(titleCase(distanceCtx.originKey), depot, mode);

      // ✅ FIX: Make directions a real clickable <a href="...">
      return {
        matched: true,
        answerHTML:
          "Your closest depot is <b>" + depot.label + "</b>." +
          "<br>From <b>" + titleCase(distanceCtx.originKey) + "</b> it’s approximately <b>" +
          Math.round(distanceCtx.miles) + " miles</b>." +
          "<br>Estimated time " + modeLabel(mode) + " is around <b>" + minutes + " minutes</b> (traffic and services can vary)." +
          `<br><a href="${url}">Get directions in Google Maps</a>`,
        chips: ["By car", "By train", "By bus", "Walking"]
      };
    }
  }

  // Depot flow: main trigger
  if (
    q.includes("how far") ||
    q.includes("distance") ||
    q.includes("closest depot") ||
    (q.includes("depot") && q.includes("closest"))
  ) {
    const originKey = findPlaceKey(q);

    if (!originKey) {
      distanceCtx = { stage: "needOrigin" };
      return {
        matched: true,
        answerHTML: "Certainly — what town or city are you travelling from?",
        chips: ["Coventry", "Birmingham", "Leicester", "London"]
      };
    }

    const closest = findClosestDepot(PLACES[originKey]);
    if (!closest) {
      return {
        matched: true,
        answerHTML: "I can do that once I know your starting town/city. Where are you travelling from?"
      };
    }

    const depot = DEPOTS[closest.depotKey];
    distanceCtx = {
      stage: "haveClosest",
      originKey,
      depotKey: closest.depotKey,
      miles: closest.miles
    };

    const modeInText = parseTravelMode(q);
    if (modeInText) {
      const minutes = estimateMinutes(closest.miles, modeInText);
      const url = googleDirectionsURL(titleCase(originKey), depot, modeInText);

      // ✅ FIX: clickable link
      return {
        matched: true,
        answerHTML:
          "Your closest depot is <b>" + depot.label + "</b>." +
          "<br>From <b>" + titleCase(originKey) + "</b> it’s approximately <b>" +
          Math.round(closest.miles) + " miles</b>." +
          "<br>Estimated time " + modeLabel(modeInText) + " is around <b>" + minutes + " minutes</b> (traffic and services can vary)." +
          `<br><a href="${url}">Get directions in Google Maps</a>`,
        chips: ["By car", "By train", "By bus", "Walking"]
      };
    }

    return {
      matched: true,
      answerHTML:
        "Your closest depot is <b>" + depot.label + "</b>." +
        "<br>From <b>" + titleCase(originKey) + "</b> it’s approximately <b>" +
        Math.round(closest.miles) + " miles</b>." +
        "<br>How are you travelling?",
      chips: ["By car", "By train", "By bus", "Walking"]
    };
  }

  // If bot asked for origin and user replies with a city
  if (distanceCtx && distanceCtx.stage === "needOrigin") {
    const originKey2 = findPlaceKey(q) || (PLACES[q] ? q : null);
    if (originKey2) {
      const closest2 = findClosestDepot(PLACES[originKey2]);
      const depot2 = DEPOTS[closest2.depotKey];

      distanceCtx = {
        stage: "haveClosest",
        originKey: originKey2,
        depotKey: closest2.depotKey,
        miles: closest2.miles
      };

      return {
        matched: true,
        answerHTML:
          "Thanks — your closest depot is <b>" + depot2.label + "</b>." +
          "<br>From <b>" + titleCase(originKey2) + "</b> it’s approximately <b>" +
          Math.round(closest2.miles) + " miles</b>." +
          "<br>How are you travelling?",
        chips: ["By car", "By train", "By bus", "Walking"]
      };
    }
  }

  // Parking special case
  if (q.includes("parking") || q.includes("car park")) {
    return { matched: true, answerHTML: "Yes — we have <b>visitor parking</b>. Spaces can be limited during busy times." };
  }

  return null;
}

// ---------------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------------
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

  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a second.", "bot", { ts: new Date() });
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    // 1) Special cases first
    const special = specialCases(text);
    if (special && special.matched) {
      addBubble(special.answerHTML, "bot", { html: true, ts: new Date() });
      if (special.chips && special.chips.length) addChips(special.chips);

      missCount = 0;
      isResponding = false;
      setUIEnabled(true);
      return;
    }

    // 2) FAQ match with quiet spelling correction
    let res = matchFAQ(text);
    if (!res.matched) {
      const corr = correctQueryTokens(text);
      if (corr.changed && corr.corrected) {
        const res2 = matchFAQ(corr.corrected);
        if (res2.matched) res = res2;
        else if ((res2.suggestions ?? []).length > (res.suggestions ?? []).length) res = res2;
      }
    }

    if (res.matched) {
      addBubble(res.answerHTML, "bot", { html: true, ts: new Date() });

      if (res.followUps && res.followUps.length) {
        addBubble("You can also ask:", "bot", { ts: new Date() });
        addChips(res.followUps);
      }

      missCount = 0;
      clarifyCtx = null;
    } else {
      missCount++;

      // Category clarification first on the first miss
      if (missCount === 1 && categories.length) {
        clarifyCtx = { stage: "needCategory", originalQuery: text };
        addBubble("Quick check — what is this about?", "bot", { ts: new Date() });
        addChips(categories.map((c) => c.label));
      } else {
        addBubble("I’m not sure. Did you mean:", "bot", { ts: new Date() });
        addChips(res.suggestions ?? []);
      }

      // Escalate after repeated misses
      if (missCount >= 2) {
        // ✅ FIX: proper clickable mailto anchor
        addBubble(
          `If you’d like, you can contact support at <a href="mailto:${SETTINGS.supportEmail}">${SETTINGS.supportEmail}</a> or call <b>${SETTINGS.supportPhone}</b>.`,
          "bot",
          { html: true, ts: new Date() }
        );
        missCount = 0;
        clarifyCtx = null;
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

input.addEventListener("keydown", (e) => {
  if (!suggestionsEl.hidden) return;
  if (e.key === "Enter") {
    e.preventDefault();
    sendChat();
  }
});

clearBtn.addEventListener("click", () => {
  chatWindow.innerHTML = "";
  missCount = 0;
  distanceCtx = null;
  clarifyCtx = null;
  ticketCtx = null;
  CHAT_LOG = [];
  init();
});

// ---------------------------------------------------------
// LOAD FAQS (SINGLE FETCH)
// ---------------------------------------------------------
fetch("./public/config/faqs.json")
  .then((res) => res.json())
  .then((data) => {
    FAQS = Array.isArray(data) ? data : [];
    faqsLoaded = true;
    buildCategoryIndex();
    buildVocabFromFAQs();
    renderDrawer();
  })
  .catch(() => {
    FAQS = [];
    faqsLoaded = true;
    buildCategoryIndex();
    buildVocabFromFAQs();
    renderDrawer();
  });

// ---------------------------------------------------------
// INIT
// ---------------------------------------------------------
function init() {
  addBubble(SETTINGS.greeting, "bot", { html: true, ts: new Date() });
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
