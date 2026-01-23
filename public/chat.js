
/* -------------------------------------------------------
   Welfare Support – Improved Chat Engine
---------------------------------------------------------- */

const SETTINGS = {
    minConfidence: 0.20,
    topSuggestions: 3,
    boostSubstring: 0.12,
    greeting:
        "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, or our location."
};

let FAQS = [];
let faqsLoaded = false;

/* Load FAQs */
fetch("public/config/faqs.json")
    .then(res => res.json())
    .then(data => {
        FAQS = data || [];
        faqsLoaded = true;
    })
    .catch(() => {
        faqsLoaded = true;
    });

/* -------------------------------------------------------
   TEXT NORMALISATION HELPERS
---------------------------------------------------------- */
const normalize = s =>
    (s || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .replace(/[“”‘’]/g, '"')
        .replace(/[–—]/g, "-")
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, " ")
        .trim();

const tokenSet = s => new Set(normalize(s).split(" ").filter(Boolean));

const jaccard = (a, b) => {
    if (!a.size || !b.size) return 0;
    const inter = new Set([...a].filter(x => b.has(x)));
    return inter.size / new Set([...a, ...b]).size;
};

/* -------------------------------------------------------
   AI-LIKE FAQ MATCHING (UPGRADED)
---------------------------------------------------------- */
function matchFAQ(query) {
    const qNorm = normalize(query);
    const qTokens = tokenSet(query);

    let results = [];

    for (const item of FAQS) {
        const q = normalize(item.question);
        const syns = (item.synonyms || []).map(normalize);
        const tags = (item.tags || []).map(normalize);

        const scoreQ = jaccard(qTokens, tokenSet(item.question));
        const scoreSyn = syns.length ? Math.max(...syns.map(s => jaccard(qTokens, tokenSet(s)))) : 0;
        const scoreTag = tags.length ? Math.max(...tags.map(t => jaccard(qTokens, tokenSet(t)))) : 0;

        const allFields = [q, ...syns, ...tags].join(" ");
        const boost = allFields.includes(qNorm) ? SETTINGS.boostSubstring : 0;

        const score = 0.65 * scoreQ + 0.25 * scoreSyn + 0.10 * scoreTag + boost;

        results.push({ item, score });
    }

    results.sort((a, b) => b.score - a.score);

    if (!results[0] || results[0].score < SETTINGS.minConfidence) {
        return {
            matched: false,
            suggestions: results.slice(0, SETTINGS.topSuggestions).map(r => r.item.question)
        };
    }

    return {
        matched: true,
        answerHTML: results[0].item.answer,
        question: results[0].item.question
    };
}

/* -------------------------------------------------------
   UI HELPERS
---------------------------------------------------------- */
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");

function addBubble(text, type = "bot", isHTML = false) {
    const div = document.createElement("div");
    div.className = `bubble ${type}`;
    div[isHTML ? "innerHTML" : "textContent"] = text;
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function addTyping() {
    const div = document.createElement("div");
    div.className = "bubble bot typing-bubble";
    div.innerHTML = `Typing <span class="typing"><span></span><span></span><span></span></span>`;
    chatWindow.appendChild(div);
    chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeTyping() {
    const bubble = chatWindow.querySelector(".typing-bubble");
    if (bubble) bubble.remove();
}

/* -------------------------------------------------------
   MAIN SEND HANDLER
---------------------------------------------------------- */
function handleUserMessage(text) {
    if (!text) return;

    addBubble(text, "user");
    input.value = "";

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
        } else {
            const suggestions =
                res.suggestions.length
                    ? "<br><br>• " + res.suggestions.join("<br>• ")
                    : "";
            addBubble("I’m not sure. Did you mean:" + suggestions, "bot", true);
        }
    }, 350);
}

function sendChat() {
    handleUserMessage(input.value.trim());
}

/* Enter key */
input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
        e.preventDefault();
        sendChat();
    }
});

/* Button click */
sendBtn.addEventListener("click", sendChat);

/* Greeting */
window.addEventListener("DOMContentLoaded", () => {
    addBubble(SETTINGS.greeting, "bot", true);
});

