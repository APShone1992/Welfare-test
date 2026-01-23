
// --- Welfare Support Chat (Upgraded Logic + Original Theme) ---

const SETTINGS = {
  minConfidence: 0.23,
  typingDelay: 300,
  greeting: "Hi! I’m <b>Welfare Support</b>. Ask me a question!",
  helpMsg:
    "You can ask about opening times, support contact, or our location.<br><br>" +
    "<b>Commands:</b><br>• clear<br>• restart<br>• help"
};

let FAQS = [];
let loaded = false;

// DOM
const chatWindow = document.getElementById("chatWindow");
const input = document.getElementById("chatInput");
const sendBtn = document.getElementById("sendBtn");
const chipRow = document.getElementById("chipRow");

// Load FAQs
fetch("public/config/faqs.json")
  .then(r => r.json())
  .then(data => {
    FAQS = data;
    loaded = true;
    buildChips();
  });

// Sanitize HTML
function sanitize(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll("script, iframe, object").forEach(x => x.remove());
  return div.innerHTML;
}

function addBubble(text, type = "bot", html = false) {
  const div = document.createElement("div");
  div.className = "bubble " + type;

  if (html) div.innerHTML = sanitize(text);
  else div.textContent = text;

  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
  div.appendChild(meta);

  chatWindow.appendChild(div);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function addTyping() {
  const t = document.createElement("div");
  t.className = "bubble bot";
  t.setAttribute("data-typing", "yes");
  t.innerHTML = `Typing <span class="typing"><span></span><span></span><span></span></span>`;
  chatWindow.appendChild(t);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function removeTyping() {
  const t = chatWindow.querySelector('[data-typing="yes"]');
  if (t) t.remove();
}

// Simple FAQ matching
function matchFAQ(q) {
  const n = q.toLowerCase();

  let best = null;
  let bestScore = 0;

  for (const item of FAQS) {
    const text = (item.question + " " + (item.synonyms || []).join(" ")).toLowerCase();
    let score = 0;

    if (text.includes(n)) score += 0.6;
    if (n.includes(text)) score += 0.2;
    score += Math.random() * 0.05; // small jitter to avoid ties

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  return bestScore >= SETTINGS.minConfidence ? best : null;
}

// Chips
function buildChips() {
  chipRow.innerHTML = "";
  FAQS.slice(0, 3).forEach(f => {
    const c = document.createElement("div");
    c.className = "chip";
    c.textContent = f.question;
    c.addEventListener("click", () => handleUserMessage(f.question));
    chipRow.appendChild(c);
  });
}

function handleUserMessage(text) {
  if (!text.trim()) return;
  addBubble(text, "user");
  input.value = "";

  const cleaned = text.toLowerCase();

  if (cleaned === "clear") {
    chatWindow.innerHTML = "";
    addBubble("Chat cleared.", "bot");
    return;
  }
  if (cleaned === "restart") {
    chatWindow.innerHTML = "";
    addBubble(SETTINGS.greeting, "bot", true);
    buildChips();
    return;
  }
  if (cleaned === "help") {
    addBubble(SETTINGS.helpMsg, "bot", true);
    return;
  }

  addTyping();

  setTimeout(() => {
    removeTyping();

    if (!loaded) {
      addBubble("Still loading FAQs… try again.", "bot");
      return;
    }

    const res = matchFAQ(text);

    if (res) {
      addBubble(res.answer, "bot", true);
    } else {
      // suggestions
      const sug = FAQS.slice(0, 3).map(x => x.question);
      addBubble(
        "I’m not sure what you meant.<br><br>Did you mean:<br>• " +
          sug.join("<br>• "),
        "bot",
        true
      );
    }
  }, SETTINGS.typingDelay);
}

sendBtn.onclick = () => handleUserMessage(input.value);
input.addEventListener("keydown", e => {
  if (e.key === "Enter") handleUserMessage(input.value);
});

addBubble(SETTINGS.greeting, "bot", true);
