
// --------------------------------------
// Welfare Support – Improved Chat Engine
// (Refresh clears chat: NO persistence)
// --------------------------------------

const SETTINGS = {
  minConfidence: 0.24,
  topSuggestions: 4,
  boostSubstring: 0.14,
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask about opening times, contacting support, or where we’re located.<br><span class='meta'>Try: <b>topics</b>, <b>help</b>, or <b>clear</b>.</span>",
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

    // Always start fresh on refresh
    chatWindow.innerHTML = "";
    addBubble(SETTINGS.greeting, "bot", true);
  })
  .catch(() => {
    FAQS = [];
    faqsLoaded = true;
    removeSystemNotices();
    setInputEnabled(true);
    chatWindow.innerHTML = "";
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
    .replace(/[\u0300-\u036f]/g, "")
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
  const substringBoost =
    allFields.includes(qNorm) && qNorm.length > 2 ? SETTINGS.boostSubstring : 0;

  const score =
    0.45 * qScore +
    0.18 * synScore +
    0.07 * tagScore +
    0.23 * ngramQ +
    0.07 * ngramSyn +
    substringBoost;

  return { question, answer: item.answer ?? "", score };
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
      const text = document.createTextNode(el.textContent || "");
      el.replaceWith(text);
      continue;
    }

    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      if (el.tagName === "A") {
        if (name === "href") {
          const safe = value.trim().toLowerCase();
