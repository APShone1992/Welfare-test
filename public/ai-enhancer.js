
/* public/ai-enhancer.js (UPGRADED TYPO ENGINE – C1)
   Zero cost, no backend, no API keys.

   Adds:
   - Stronger typo correction (common typos, slang, repeated letters)
   - SymSpell-style fast candidate generation
   - Joined-word splitting (openinghours -> opening hours)
   - Keeps your existing bot logic untouched (specialCases/FAQ/tickets/etc.)
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
      showIfScoreBetween: [0.35, 0.68],
      maxSuggestions: 3
    },

    // Typo correction (UPGRADED)
    typos: {
      enabled: true,
      maxChars: 140,              // allow longer queries than before
      maxEditDistance: 2,         // SymSpell radius
      maxDistanceRatio: 0.38,     // slightly more aggressive but still safe
      minAcceptScore: 0.70        // must be reasonably confident to replace
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

  // --- Utility normalization (similar to your chat.js normalize)
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

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // --- Find your existing globals from chat.js safely
  function getGlobals() {
    const chatWindow = document.getElementById("chatWindow");
    const input = document.getElementById("chatInput");
    const addBubble = window.addBubble;
    return { chatWindow, input, addBubble };
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

  // --- Damerau-Levenshtein (handles transpositions: adn -> and)
  function damerauLevenshtein(a, b) {
    a = a || ""; b = b || "";
    const alen = a.length, blen = b.length;
    if (!alen) return blen;
    if (!blen) return alen;

    const dp = Array.from({ length: alen + 1 }, () => new Array(blen + 1).fill(0));
    for (let i = 0; i <= alen; i++) dp[i][0] = i;
    for (let j = 0; j <= blen; j++) dp[0][j] = j;

    for (let i = 1; i <= alen; i++) {
      for (let j = 1; j <= blen; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,      // deletion
          dp[i][j - 1] + 1,      // insertion
          dp[i - 1][j - 1] + cost // substitution
        );

        // transposition
        if (
          i > 1 && j > 1 &&
          a[i - 1] === b[j - 2] &&
          a[i - 2] === b[j - 1]
        ) {
          dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + cost);
        }
      }
    }
    return dp[alen][blen];
  }

  // --- Similarity score (token overlap + containment)
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

  // --- Common typo + slang map (safe replacements)
  const COMMON_MAP = new Map(Object.entries({
    // transpositions / common typos
    "teh": "the",
    "adn": "and",
    "woudl": "would",
    "thier": "their",
    "recieve": "receive",
    "seperately": "separately",
    "definately": "definitely",
    "occured": "occurred",
    "availble": "available",
    "avaiable": "available",
    "opne": "open",
    "opning": "opening",
    "oppening": "opening",
    "tmes": "times",
    "tmie": "time",
    "contcat": "contact",
    "emial": "email",
    "phne": "phone",
    "numebr": "number",
    "addres": "address",
    "locaiton": "location",
    "dirrections": "directions",
    "direcitons": "directions",
    "depo": "depot",

    // chat slang
    "u": "you",
    "ur": "your",
    "r": "are",
    "pls": "please",
    "plz": "please",
    "thx": "thanks",
    "ty": "thanks",
    "b4": "before",
    "im": "i am",
    "cant": "cant", // keep plain (we normalize punctuation away anyway)
    "dont": "dont"
  }));

  function collapseRepeats(token) {
    // opennnnning -> openning (then corrected further)
    return token.replace(/([a-z])\1{2,}/g, "$1$1");
  }

  function normalizeToken(token) {
    const t = norm(token);
    if (!t) return "";
    return collapseRepeats(t);
  }

  // --- SymSpell delete generation
  function makeDeletes(word, maxDist) {
    const deletes = new Set([word]);
    for (let d = 1; d <= maxDist; d++) {
      const current = Array.from(deletes);
      for (const w of current) {
        if (w.length <= 1) continue;
        for (let i = 0; i < w.length; i++) {
          deletes.add(w.slice(0, i) + w.slice(i + 1));
        }
      }
    }
    deletes.delete(word);
    return deletes;
  }

  // --- Build dictionary from FAQs + helpful words
  function buildDictionaries(FAQS) {
    const wordFreq = new Map();        // token -> weight
    const phraseSet = new Set();       // full phrases (questions + synonyms)

    function addWord(w, weight) {
      if (!w) return;
      const cur = wordFreq.get(w) || 0;
      wordFreq.set(w, cur + weight);
    }
    function addPhrase(p) {
      const np = norm(p);
      if (!np) return;
      phraseSet.add(np);
      np.split(" ").forEach(t => addWord(t, 2));
    }

    (FAQS || []).forEach((f) => {
      if (f?.question) addPhrase(f.question);
      (f?.synonyms || []).forEach(addPhrase);
      (f?.canonicalKeywords || []).forEach((k) => addPhrase(k));
    });

    // Domain/system words that matter for your bot:
    [
      "opening", "times", "hours", "office", "business",
      "open", "closed", "available", "now",
      "bank", "holiday", "holidays",
      "support", "contact", "email", "phone", "number",
      "raise", "request", "ticket", "login", "access", "benefits", "payroll",
      "closest", "depot", "distance", "directions", "location", "address",
      "coventry", "birmingham", "leicester", "london", "nuneaton",
      "walking", "train", "bus", "car"
    ].forEach(w => addWord(w, 3));

    // Very small “common English” helpers (kept short to stay lightweight):
    [
      "what","when","where","how","can","do","i","we","you","are","is","the","a","to","for","and","or",
      "today","tomorrow","please","help"
    ].forEach(w => addWord(w, 1));

    // Build SymSpell delete index: delete -> set(words)
    const deleteIndex = new Map();
    const maxDist = CONFIG.typos.maxEditDistance;

    for (const w of wordFreq.keys()) {
      const deletes = makeDeletes(w, maxDist);
      for (const d of deletes) {
        if (!deleteIndex.has(d)) deleteIndex.set(d, new Set());
        deleteIndex.get(d).add(w);
      }
    }

    return { wordFreq, phraseSet, deleteIndex };
  }

  // --- Attempt to split a joined token into two known words
  function splitJoined(token, wordFreq) {
    if (!token || token.length < 7) return null; // avoid over-splitting short words
    for (let i = 3; i <= token.length - 3; i++) {
      const left = token.slice(0, i);
      const right = token.slice(i);
      if (wordFreq.has(left) && wordFreq.has(right)) {
        return left + " " + right;
      }
    }
    return null;
  }

  function bestCandidate(token, dicts) {
    const { wordFreq, deleteIndex } = dicts;
    if (!token) return null;
    if (wordFreq.has(token)) return { word: token, score: 1, dist: 0 };

    // quick common map
    if (COMMON_MAP.has(token)) {
      const mapped = norm(COMMON_MAP.get(token));
      if (mapped && mapped.includes(" ")) {
        // map might expand token (im -> i am)
        return { word: mapped, score: 0.95, dist: 1 };
      }
      return { word: mapped, score: 0.95, dist: 1 };
    }

    // joined word split
    const split = splitJoined(token, wordFreq);
    if (split) return { word: split, score: 0.88, dist: 1 };

    // SymSpell candidates using deletes
    const deletes = makeDeletes(token, CONFIG.typos.maxEditDistance);
    const candidateSet = new Set();

    for (const d of deletes) {
      const hits = deleteIndex.get(d);
      if (hits) hits.forEach(w => candidateSet.add(w));
    }

    // also try direct delete key
    const directHits = deleteIndex.get(token);
    if (directHits) directHits.forEach(w => candidateSet.add(w));

    if (!candidateSet.size) return null;

    let best = null;
    for (const cand of candidateSet) {
      const dist = damerauLevenshtein(token, cand);
      const maxLen = Math.max(token.length, cand.length);
      const ratio = dist / maxLen;
      if (ratio > CONFIG.typos.maxDistanceRatio) continue;

      const baseScore = 1 - ratio;                 // similarity
      const freqBoost = Math.min(0.12, (wordFreq.get(cand) || 0) / 50); // tiny bias towards domain words
      const score = baseScore + freqBoost;

      if (!best || score > best.score) {
        best = { word: cand, score, dist };
      }
    }
    return best;
  }

  // --- Correct a full query conservatively
  function correctTypos(userText, dicts) {
    if (!CONFIG.typos.enabled) return userText;

    const original = (userText ?? "").trim();
    if (!original) return original;
    if (original.length > CONFIG.typos.maxChars) return original;

    const n = norm(original);
    if (!n) return original;

    // If it exactly matches a known phrase, keep as-is
    if (dicts.phraseSet.has(n)) return n;

    const tokens = n.split(" ").filter(Boolean);
    if (!tokens.length) return original;

    const out = [];
    for (const tokRaw of tokens) {
      let tok = normalizeToken(tokRaw);

      // keep numbers as-is
      if (/^\d+$/.test(tok)) { out.push(tok); continue; }

      // apply common map early (safe)
      if (COMMON_MAP.has(tok)) {
        const mapped = norm(COMMON_MAP.get(tok));
        mapped.split(" ").forEach(x => out.push(x));
        continue;
      }

      // If known word, keep
      if (dicts.wordFreq.has(tok)) { out.push(tok); continue; }

      // Try candidate correction
      const cand = bestCandidate(tok, dicts);
      if (cand && cand.score >= CONFIG.typos.minAcceptScore) {
        cand.word.split(" ").forEach(x => out.push(x));
      } else {
        out.push(tok);
      }
    }

    const corrected = out.join(" ").trim();

    // Phrase-level snap: if corrected is close to a known phrase, snap to phrase
    // (helps with "openinghours" -> "opening times" etc.)
    let bestPhrase = null;
    for (const p of dicts.phraseSet) {
      const s = scoreMatch(corrected, p);
      if (!bestPhrase || s > bestPhrase.score) bestPhrase = { phrase: p, score: s };
    }
    if (bestPhrase && bestPhrase.score >= 0.86) return bestPhrase.phrase;

    return corrected || original;
  }

  // --- Multi-intent: split by connectors
  function splitMultiIntent(text) {
    if (!CONFIG.multiIntent.enabled) return [text];

    const raw = (text ?? "").trim();
    if (!raw) return [raw];

    const separators = [" and ", " also ", " & ", ",", " plus "];
    let parts = [raw];

    for (const sep of separators) {
      if (parts.length >= CONFIG.multiIntent.maxParts) break;
      const next = [];
      for (const p of parts) {
        if (next.length >= CONFIG.multiIntent.maxParts) { next.push(p); continue; }
        const re = new RegExp(sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        const split = p.split(re);
        if (split.length > 1) {
          split.map(s => s.trim()).filter(Boolean).forEach(s => next.push(s));
        } else next.push(p);
      }
      parts = next;
    }

    return parts.map(p => p.trim()).filter(Boolean).slice(0, CONFIG.multiIntent.maxParts) || [raw];
  }

  // --- Suggestions from FAQs if medium confidence
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

  // --- Friendly preambles
  function choosePreamble(score) {
    if (!CONFIG.rephrase.enabled || !CONFIG.rephrase.addPreambles) return "";
    const high = ["Got it — here’s what I found:", "Sure — here you go:", "Yes — this should help:"];
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

    const originalHandle = window.handleUserMessage;
    if (typeof originalHandle !== "function") {
      console.warn("[AI Enhancer] handleUserMessage not found.");
      return;
    }

    // Build dictionaries after FAQ load (FAQS fetched async)
    let dicts = { wordFreq: new Map(), phraseSet: new Set(), deleteIndex: new Map() };
    const rebuild = () => {
      try {
        dicts = buildDictionaries(window.FAQS || []);
      } catch {
        dicts = { wordFreq: new Map(), phraseSet: new Set(), deleteIndex: new Map() };
      }
    };
    rebuild();
    setTimeout(rebuild, 900);
    setTimeout(rebuild, 2000);

    window.handleUserMessage = async function enhancedHandleUserMessage(text) {
      const { chatWindow, addBubble } = getGlobals();
      const FAQS = window.FAQS || [];

      if (typeof addBubble !== "function") return originalHandle(text);

      const raw = (text ?? "").trim();
      if (!raw) return;

      // Split intents
      const parts = splitMultiIntent(raw);

      // Correct each part to improve matching (does NOT change your core answers)
      const correctedParts = parts.map((p) => correctTypos(p, dicts));

      for (let i = 0; i < correctedParts.length; i++) {
        const userPart = correctedParts[i];

        // AI-like suggestions if medium confidence
        if (CONFIG.suggestions.enabled && FAQS.length) {
          const suggestions = getTopSuggestions(userPart, FAQS, CONFIG.suggestions.maxSuggestions);
          const best = suggestions[0];
          if (best) {
            const [minS, maxS] = CONFIG.suggestions.showIfScoreBetween;
            if (best.score >= minS && best.score <= maxS) {
              const pre = choosePreamble(best.score);
              const lines = suggestions
                .filter(s => s.score >= minS)
                .map(s => `• ${s.question}`)
                .slice(0, CONFIG.suggestions.maxSuggestions);

              if (lines.length >= 2) {
                addBubble(
                  `${pre}<br><small>Did you mean:</small><br>${lines.join("<br>")}`,
                  "bot",
                  { html: true, speak: false }
                );
              }
            }
          }
        }

        // Typing animation
        if (CONFIG.typing.enabled && chatWindow) {
          const typing = addTypingIndicator(chatWindow);
          const delay =
            CONFIG.typing.minDelayMs +
            Math.floor(Math.random() * (CONFIG.typing.maxDelayMs - CONFIG.typing.minDelayMs + 1));
          await sleep(delay);
          typing?.remove();
        }

        // Call your original chatbot logic
        await originalHandle(userPart);
      }
    };

    console.log("[AI Enhancer] Enabled (C1) + Upgraded typo correction.");
  });
})();
