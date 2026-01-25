
/* public/ai-enhancer.js
   AI-feel enhancer (C1): zero cost, no backend, no API keys.
   - Typo correction (lightweight)
   - Multi-intent splitting ("opening times and email")
   - "Did you mean..." suggestions when confidence is medium
   - Friendly rephrasing + confidence cues
   - Typing indicator + slight delay (optional; enabled in C1)
   - Non-destructive: wraps existing handleUserMessage() without rewriting chat.js
*/

(function () {
  const CONFIG = {
    enabled: true,

    // Typing animation (C1: on)
    typing: {
      enabled: true,
      minDelayMs: 160,
      maxDelayMs: 520,
      dotsIntervalMs: 260
    },

    // Multi-intent splitting (C1: on)
    multiIntent: {
      enabled: true,
      maxParts: 2
    },

    // Suggestions / confidence language (C1: on)
    suggestions: {
      enabled: true,
      // show suggestions if match score is in this range
      showIfScoreBetween: [0.35, 0.68],
      maxSuggestions: 3
    },

    // Typo correction (C1: on)
    typos: {
      enabled: true,
      // Only apply corrections to "short-ish" queries to reduce false positives
      maxChars: 80,
      // Only correct a token if it's close enough (edit distance ratio)
      maxDistanceRatio: 0.34
    },

    // Rephrase style (C1: on)
    rephrase: {
      enabled: true,
      addPreambles: true
    }
  };

  // --- Wait until your app has loaded
  function ready(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else fn();
  }

  // --- Utility
  const norm = (s) =>
    (s ?? "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[“”‘’]/g, '"')
      .replace(/[–—]/g, "-")
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // --- Find your existing globals from chat.js safely
  function getGlobals() {
    const chatWindow = document.getElementById("chatWindow");
    const input = document.getElementById("chatInput");

    // These should exist in your chat.js
    const addBubble = window.addBubble;
    const FAQS = window.FAQS;
    const SETTINGS = window.SETTINGS;

    return { chatWindow, input, addBubble, FAQS, SETTINGS };
  }

  // --- Typing indicator
  function addTypingIndicator(chatWindow) {
    if (!chatWindow) return null;

    const row = document.createElement("div");
    row.className = "msg bot";
    row.dataset.aiTyping = "1";

    const bubble = document.createElement("div");
    bubble.className = "bubble bot";
    bubble.textContent = "…";

    const time = document.createElement("div");
    time.className = "timestamp";
    time.textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    row.appendChild(bubble);
    row.appendChild(time);
    chatWindow.appendChild(row);
    chatWindow.scrollTop = chatWindow.scrollHeight;

    let dots = 1;
    const t = setInterval(() => {
      dots = (dots % 3) + 1;
      bubble.textContent = ".".repeat(dots);
    }, CONFIG.typing.dotsIntervalMs);

    return {
      remove() {
        clearInterval(t);
        row.remove();
      }
    };
  }

  // --- Levenshtein distance (for typo correction)
  function levenshtein(a, b) {
    a = a || ""; b = b || "";
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;

    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + cost);
        prev = tmp;
      }
    }
    return dp[n];
  }

  // --- Score similarity between normalized strings (token overlap + containment)
  function scoreMatch(qNorm, candNorm) {
    if (!qNorm || !candNorm) return 0;
    if (qNorm === candNorm) return 1;
    if (candNorm.includes(qNorm) || qNorm.includes(candNorm)) return 0.92;

    const qT = new Set(qNorm.split(" ").filter(Boolean));
    const cT = new Set(candNorm.split(" ").filter(Boolean));
    let inter = 0;
    for (const t of qT) if (cT.has(t)) inter++;
    const union = new Set([...qT, ...cT]).size;
    return union ? inter / union : 0;
  }

  // --- Build a dictionary of known phrases from FAQ questions+synonyms for typo correction
  function buildPhraseDictionary(FAQS) {
    const dict = new Set();
    (FAQS || []).forEach((f) => {
      if (f?.question) dict.add(norm(f.question));
      (f?.synonyms || []).forEach((s) => dict.add(norm(s)));
      (f?.canonicalKeywords || []).forEach((k) => dict.add(norm(k)));
    });
    // Add some helpful “system” tokens that trigger your specialCases:
    [
      "opening times","opening hours","office hours",
      "open now","available now","is anyone available",
      "bank holiday","bank holidays",
      "raise a request","create a ticket","open a ticket","log a ticket",
      "closest depot","distance","how far","directions",
      "where are you","location","address",
      "contact support","support email","phone number"
    ].forEach((x) => dict.add(norm(x)));
    return [...dict].filter(Boolean);
  }

  // --- Correct typos by snapping query tokens to nearest known tokens (conservative)
  function correctTypos(userText, phraseDict) {
    if (!CONFIG.typos.enabled) return userText;

    const original = userText ?? "";
    if (original.length > CONFIG.typos.maxChars) return original;

    const n = norm(original);
    if (!n) return original;

    const tokens = n.split(" ").filter(Boolean);
    if (tokens.length <= 1) return original; // keep very short text as-is

    // Create a token dictionary from phrases
    const tokenDict = new Set();
    phraseDict.forEach((p) => p.split(" ").forEach((t) => tokenDict.add(t)));
    const tokenList = [...tokenDict];

    // Only attempt to fix tokens that look misspelled
    const fixedTokens = tokens.map((tok) => {
      if (tok.length <= 3) return tok;

      let best = tok;
      let bestScore = 0;

      for (const cand of tokenList) {
        if (cand === tok) return tok;
        // quick length pruning
        const maxLen = Math.max(tok.length, cand.length);
        const dist = levenshtein(tok, cand);
        const ratio = dist / maxLen;
        if (ratio > CONFIG.typos.maxDistanceRatio) continue;

        const score = 1 - ratio;
        if (score > bestScore) {
          bestScore = score;
          best = cand;
        }
      }

      // Only change if clearly better
      return bestScore >= 0.72 ? best : tok;
    });

    // Rebuild as normalized corrected text, but preserve original casing by returning corrected plain
    const corrected = fixedTokens.join(" ").trim();
    return corrected ? corrected : original;
  }

  // --- Detect multi-intent: split by connectors ("and", "&", "also", commas)
  function splitMultiIntent(text) {
    if (!CONFIG.multiIntent.enabled) return [text];

    const raw = (text ?? "").trim();
    if (!raw) return [raw];

    const lower = raw.toLowerCase();
    const separators = [" and ", " also ", " & ", ",", " plus "];
    let parts = [raw];

    for (const sep of separators) {
      if (parts.length >= CONFIG.multiIntent.maxParts) break;
      const next = [];
      for (const p of parts) {
        if (next.length >= CONFIG.multiIntent.maxParts) { next.push(p); continue; }
        const split = p.split(new RegExp(sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
        if (split.length > 1) {
          split.map(s => s.trim()).filter(Boolean).forEach(s => next.push(s));
        } else {
          next.push(p);
        }
      }
      parts = next;
    }

    // keep only up to max parts
    parts = parts.map(p => p.trim()).filter(Boolean).slice(0, CONFIG.multiIntent.maxParts);
    return parts.length ? parts : [raw];
  }

  // --- Suggest FAQ questions if medium confidence
  function getTopSuggestions(userText, FAQS, limit = 3) {
    const q = norm(userText);
    if (!q || !FAQS?.length) return [];

    const scored = [];
    for (const item of FAQS) {
      const variants = [item.question, ...(item.synonyms || [])].filter(Boolean);
      let best = 0;
      for (const v of variants) best = Math.max(best, scoreMatch(q, norm(v)));
      scored.push({ item, best });
    }

    scored.sort((a, b) => b.best - a.best);
    return scored.slice(0, limit).map(x => ({ question: x.item.question, score: x.best }));
  }

  // --- Friendly preambles to make replies feel “AI”
  function choosePreamble(score) {
    if (!CONFIG.rephrase.enabled || !CONFIG.rephrase.addPreambles) return "";
    const high = [
      "Got it — here’s what I found:",
      "Sure — here you go:",
      "Yes — this should help:"
    ];
    const mid = [
      "I think this is what you’re asking — does this look right?",
      "I’m not 100% sure, but this looks like the closest match:",
      "From your message, I believe you mean:"
    ];
    const pool = score >= 0.7 ? high : mid;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // --- Install enhancer: wrap handleUserMessage
  ready(() => {
    if (!CONFIG.enabled) return;

    // handleUserMessage must exist (it’s in your chat.js)
    const originalHandle = window.handleUserMessage;
    if (typeof originalHandle !== "function") {
      console.warn("[AI Enhancer] handleUserMessage not found.");
      return;
    }

    // Build phrase dict after FAQ load (FAQS might load async)
    let phraseDict = [];
    const rebuildDict = () => {
      try {
        phraseDict = buildPhraseDictionary(window.FAQS || []);
      } catch {
        phraseDict = [];
      }
    };
    rebuildDict();
    // re-check dict after a short delay (FAQS fetched)
    setTimeout(rebuildDict, 900);
    setTimeout(rebuildDict, 2000);

    // Wrap
    window.handleUserMessage = async function enhancedHandleUserMessage(text) {
      const { chatWindow, addBubble } = getGlobals();
      const FAQS = window.FAQS || [];

      // If something is off, fallback to original
      if (typeof addBubble !== "function") return originalHandle(text);

      const raw = (text ?? "").trim();
      if (!raw) return;

      // Typing indicator (C1)
      let typing = null;

      // Multi-intent split
      let parts = splitMultiIntent(raw);

      // Typo correction (only used to improve matching, not to change what user sees)
      const correctedParts = parts.map((p) => correctTypos(p, phraseDict));

      // If user typed one message with two intents, we’ll feed them one by one
      // with slight “AI typing” delay between
      for (let i = 0; i < correctedParts.length; i++) {
        const userPart = correctedParts[i];

        // --- Provide “did you mean” suggestions *before* running original logic,
        // but only if it looks like a FAQ query and confidence is medium.
        if (CONFIG.suggestions.enabled && FAQS.length) {
          const suggestions = getTopSuggestions(userPart, FAQS, CONFIG.suggestions.maxSuggestions);
          const best = suggestions[0];
          if (best) {
            const [minS, maxS] = CONFIG.suggestions.showIfScoreBetween;
            if (best.score >= minS && best.score <= maxS) {
              // show a helpful suggestion bubble but do not block normal flow
              const pre = choosePreamble(best.score);
              const lines = suggestions
                .filter(s => s.score >= minS)
                .map(s => `• ${s.question}`)
                .slice(0, CONFIG.suggestions.maxSuggestions);

              if (lines.length >= 2) {
                // AI-like hint
                addBubble(
                  `${pre}<br><small>Did you mean:</small><br>${lines.join("<br>")}`,
                  "bot",
                  { html: true, speak: false }
                );
              }
            }
          }
        }

        // Typing animation before the bot answers (C1)
        if (CONFIG.typing.enabled && chatWindow) {
          typing = addTypingIndicator(chatWindow);
          const delay =
            CONFIG.typing.minDelayMs +
            Math.floor(Math.random() * (CONFIG.typing.maxDelayMs - CONFIG.typing.minDelayMs + 1));
          await sleep(delay);
          typing?.remove();
          typing = null;
        }

