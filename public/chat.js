
// ------------------------------------------------------------
// Welfare Support – Chat Engine (no storage)
// Features: quick replies, safer HTML, commands, typo-tolerant matching
// ------------------------------------------------------------

const SETTINGS = {
  minConfidence: 0.22,
  topSuggestions: 4,
  boostSubstring: 0.10,
  boostEditDistance: 0.18,
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, contacting support, or where we’re located.",
  quickStarts: ["Opening times", "Contact support", "Where are you located?"],
  allowAnswerHtml: true
};

let FAQS = [];
let faqsLoaded = false;

// --------------------- Utilities ---------------------
const normalize = (s) =>
  (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”‘’]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const tokenSet = (s) => new Set(normalize(s).split(" ").filter(Boolean));

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
};

// Small Levenshtein implementation for better fuzzy matching
const levenshtein = (a, b) => {
  a = normalize(a);
  b = normalize(b);
  if (!a && !b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;

  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
};

const similarityFromEditDistance = (a, b) => {
  const dist = levenshtein(a, b);
  const maxLen = Math.max(normalize(a).length, normalize(b).length) || 1;
  return 1 - dist / maxLen; // 0..1
};

// Basic sanitiser: allows a safe subset of tags/attrs.
// If you need full sanitisation, use a vetted library like DOMPurify.
const sanitizeHtml = (html) => {
  const allowedTags = new Set(["B", "STRONG", "I", "EM", "BR", "P", "UL", "OL", "LI", "A", "CODE"]);
  const allowedAttrs = { A: new Set(["href", "title", "target", "rel"]) };

  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  const walker = document.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT, null);

  const toRemove = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;

    if (!allowedTags.has(el.tagName)) {
      toRemove.push(el);
      continue;
    }

    // Strip event handlers and disallowed attributes
    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      const allowed = (allowedAttrs[el.tagName] && allowedAttrs[el.tagName].has(name)) || false;
      if (name.startsWith("on") || !allowed) el.removeAttribute(attr.name);
    });

    if (el.tagName === "A") {
      // Enforce safe links
      const href = el.getAttribute("href") || "";
      const isSafe =
        href.startsWith("http") ||
        href.startsWith("mailto:") ||
        href.startsWith("/") ||
        href.startsWith("#");

      if (!isSafe) el.removeAttribute("href");
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }
  }

  toRemove.forEach((el) => {
    const text = doc.createTextNode(el.textContent || "");
    el.replaceWith(text);
  });

  return doc.body.innerHTML;
};

// --------------------- FAQ loading ---------------------
async function loadFaqs() {
  try {
    const res = await fetch("public/config/faqs.json", { cache: "no-store" });
    FAQS = await res.json();
  } catch {
    FAQS = [];
  } finally {
    faqsLoaded = true;
  }
}
loadFaqs();

// --------------------- Matching ---------------------
function scoreItem(query, item) {
  const qNorm = normalize(query);
  const qTokens = tokenSet(query);

  const question = item.question || "";
  const synonyms = (item.synonyms || []).map((s) => s || "");
  const tags = (item.tags || []).map((t) => t || "");

  const fields = [question, ...synonyms, ...tags];
  const anyFieldNorm = fields.map(normalize).join(" ");

  const scoreQ = jaccard(qTokens, tokenSet(question));
  const scoreSyn = synonyms.length ? Math.max(...synonyms.map((s) => jaccard(qTokens, tokenSet(s)))) : 0;
  const scoreTags = tags.length ? Math.max(...tags.map((t) => jaccard(qTokens, tokenSet(t)))) : 0;

  // edit-distance similarity (helps with typos)
  const scoreEdit = Math.max(
    similarityFromEditDistance(query, question),
    ...(synonyms.map((s) => similarityFromEditDistance(query, s)))
  );

  const boostSub = anyFieldNorm.includes(qNorm) && qNorm.length >= 4 ? SETTINGS.boostSubstring : 0;

  // Weighted blend
  const score =
    0.55 * scoreQ +
    0.20 * scoreSyn +
    0.10 * scoreTags +
    SETTINGS.boostEditDistance * scoreEdit +
    boostSub;

  return score;
}

function matchFAQ(query) {
  const results = FAQS.map((item) => ({ item, score: scoreItem(query, item) }))
    .sort((a, b) => b.score - a.score);

  const top = results[0];
  if (!top || top.score < SETTINGS.minConfidence) {
    return {
      matched: false,
      suggestions: results
        .slice(0, SETTINGS.topSuggestions)
        .map((r) => r.item.question)
        .filter(Boolean)
    };
  }

  return {
    matched: true,
    question: top.item.question,
    answerHTML: top.item.answer,
    quickReplies: top.item.quickReplies || null
  };
}

// --------------------- UI ---------------------
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const clearBtn = document.getElementById("clearBtn");
const quickRepliesEl = document.getElementById("quickReplies");
const chatForm = document.getElementById("chatForm");

function renderQuickReplies(chips) {
  quickRepliesEl.innerHTML = "";
  const items = chips && chips.length ? chips : SETTINGS.quickStarts;

  items.forEach((label) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = label;
    btn.addEventListener("click", () => handleUserMessage(label));
    quickRepliesEl.appendChild(btn);
  });
}

function addBubble(text, type = "bot", isHTML = false) {
  const div = document.createElement("div");
  div.className = "bubble " + type;

  if (isHTML) {
    div.innerHTML = SETTINGS.allowAnswerHtml ? sanitizeHtml(text) : "";
  } else {
    div.textContent = text;
  }

  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
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

function clearChat() {
  chatWindow.innerHTML = "";
  addBubble(SETTINGS.greeting, "bot", true);
  renderQuickReplies();
}

function handleCommand(text) {
  const t = normalize(text);

  if (t === "/clear" || t === "clear" || t === "restart") {
    clearChat();
    return true;
  }

  if (t === "/help" || t === "help") {
    addBubble(
      "You can ask things like <b>opening times</b>, <b>contact support</b>, or <b>location</b>. " +
        "Commands: <code>/help</code>, <code>/clear</code>.",
      "bot",
      true
    );
    renderQuickReplies();
    return true;
  }

  return false;
}

function handleUserMessage(text) {
  if (!text) return;

  addBubble(text, "user");
  input.value = "";

  if (handleCommand(text)) return;

  addTyping();
  setTimeout(() => {
    removeTyping();

    if (!faqsLoaded) {
      addBubble("Loading knowledge base… please try again in a moment.", "bot");
      return;
    }

    const res = matchFAQ(text);
    if (res.matched) {
      addBubble(res.answerHTML, "bot", true);
      renderQuickReplies(res.quickReplies || res.suggestions);
    } else {
      const suggestions =
        res.suggestions && res.suggestions.length
          ? "<br><br><b>Try:</b><br>• " + res.suggestions.join("<br>• ")
          : "";

      addBubble("I’m not sure yet." + suggestions, "bot", true);
      renderQuickReplies(res.suggestions);
    }
  }, 350);
}

// Events
chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  handleUserMessage(input.value.trim());
});

clearBtn.addEventListener("click", clearChat);

window.addEventListener("DOMContentLoaded", () => {
  // Always start fresh on refresh (NO STORAGE)
  clearChat();
  input.focus();
});
