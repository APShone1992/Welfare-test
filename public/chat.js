
/* Welfare Support Chat (Stable build)
   - Ticket flow works end-to-end (mailto + transcript) [1](https://www.publicholidayguide.com/bank-holiday/england-wales-bank-holidays-2025/)
   - GPS works (called directly from click handler)
   - City chips work (no GPS)
   - Map preview uses OSM tile (img)
   - Startup greeting only [1](https://www.publicholidayguide.com/bank-holiday/england-wales-bank-holidays-2025/)
*/

const SETTINGS = {
  minConfidence: 0.20,
  topSuggestions: 3,
  boostSubstring: 0.12,
  chipLimit: 6,
  chipClickCooldownMs: 900,
  suggestionLimit: 5,
  supportEmail: "support@Kelly.co.uk",
  supportPhone: "01234 567890",
  ticketTranscriptMessages: 12,
  ticketTranscriptMaxLine: 140,
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, where we’re located, or how far you are from your closest depot."
};

// ----- DOM
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

const micBtn = document.getElementById("micBtn");
const voiceBtn = document.getElementById("voiceBtn");

// ----- State
let FAQS = [];
let faqsLoaded = false;
let categories = [];
let categoryIndex = new Map();

let isResponding = false;
let lastChipClickAt = 0;

let activeSuggestionIndex = -1;
let currentSuggestions = [];

let distanceCtx = null; // { stage: 'needOrigin'|'haveClosest', originKey, depotKey, miles }
let ticketCtx = null;   // { stage, type, name, email, phone, description, urgency }
let CHAT_LOG = [];      // transcript

// ----- Utils
const normalize = (s) =>
  (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[“”‘’]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function escapeHTML(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function escapeAttrUrl(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function sanitizeHTML(html) {
  const template = document.createElement("template");
  template.innerHTML = html;

  const allowedTags = new Set(["B","STRONG","I","EM","BR","A","SMALL","IMG"]);
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const toReplace = [];

  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!allowedTags.has(el.tagName)) { toReplace.push(el); continue; }

    [...el.attributes].forEach((attr) => {
      const name = attr.name.toLowerCase();
      if (el.tagName === "A" && (name === "href" || name === "target" || name === "rel")) return;
      if (el.tagName === "IMG" && (name === "src" || name === "alt" || name === "class" || name === "loading")) return;
      el.removeAttribute(attr.name);
    });

    if (el.tagName === "A") {
      const href = el.getAttribute("href") ?? "";
      const safe = /^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^tel:/i.test(href);
      if (!safe) el.removeAttribute("href");
      el.setAttribute("rel", "noopener noreferrer");
      el.setAttribute("target", "_blank");
    }

    if (el.tagName === "IMG") {
      const src = el.getAttribute("src") ?? "";
      if (!/^https:\/\//i.test(src)) toReplace.push(el);
      else el.setAttribute("loading", "lazy");
    }
  }

  toReplace.forEach((node) => node.replaceWith(document.createTextNode(node.textContent ?? "")));
  return template.innerHTML;
}

function htmlToPlainText(html) {
  const t = document.createElement("template");
  t.innerHTML = html ?? "";
  return (t.content.textContent ?? "").trim();
}

// UK time
const UK_TZ = "Europe/London";
function formatUKTime(date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function addBubble(text, type, opts = {}) {
  const html = !!opts.html;
  const ts = opts.ts ?? new Date();

  const row = document.createElement("div");
  row.className = "msg " + type;

  const bubble = document.createElement("div");
  bubble.className = "bubble " + type;

  if (html) bubble.innerHTML = sanitizeHTML(text);
  else bubble.textContent = text;

  const time = document.createElement("div");
  time.className = "timestamp";
  time.textContent = formatUKTime(ts);

  row.appendChild(bubble);
  row.appendChild(time);
  chatWindow.appendChild(row);
  chatWindow.scrollTop = chatWindow.scrollHeight;

  // transcript
  const plain = html ? htmlToPlainText(text) : String(text ?? "").trim();
  if (plain) CHAT_LOG.push({ role: type === "bot" ? "Bot" : "User", text: plain, ts: ts.getTime() });
  if (CHAT_LOG.length > 100) CHAT_LOG = CHAT_LOG.slice(-100);
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

function setUIEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  micBtn.disabled = !enabled;
  chatWindow.querySelectorAll(".chip-btn").forEach((b) => (b.disabled = !enabled));
}

// ----- Map helpers (OSM tile)
function lonLatToTileXY(lon, lat, z) {
  const latRad = lat * Math.PI / 180;
  const n = Math.pow(2, z);
  const x = Math.floor((lon + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}
function osmTileURL(lat, lon, zoom = 13) {
  const t = lonLatToTileXY(lon, lat, zoom);
  return `https://tile.openstreetmap.org/${zoom}/${t.x}/${t.y}.png`;
}
function imgHTML(src, alt = "Map preview") {
  return `<img class="map-preview" src="${escapeAttrUrl(src)}" alt="${escapeHTML(alt)}">`;
}
function aHTML(href, label) {
  return `<a href="${escapeAttrUrl(href)}">${escapeHTML(label)}</a>`;
}

// ----- Depots/places
const DEPOTS = { nuneaton: { label: "Nuneaton Depot", lat: 52.5230, lon: -1.4652 } };
const PLACES = {
  coventry: { lat: 52.4068, lon: -1.5197 },
  birmingham: { lat: 52.4895, lon: -1.8980 },
  leicester: { lat: 52.6369, lon: -1.1398 },
  london: { lat: 51.5074, lon: -0.1278 }
};

function titleCase(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function toRad(deg){ return (deg*Math.PI)/180; }
function distanceMiles(a,b){
  const R=3958.8;
  const dLat=toRad(b.lat-a.lat), dLon=toRad(b.lon-a.lon);
  const lat1=toRad(a.lat), lat2=toRad(b.lat);
  const h=Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return R*(2*Math.asin(Math.sqrt(h)));
}
function findClosestDepot(origin){
  let bestKey=null, best=Infinity;
  for (const k in DEPOTS){
    const miles=distanceMiles(origin, DEPOTS[k]);
    if (miles<best){ best=miles; bestKey=k; }
  }
  return bestKey ? { depotKey: bestKey, miles: best } : null;
}
function googleDirectionsURL(originText, depot, mode){
  const origin=encodeURIComponent(originText);
  const dest=encodeURIComponent(`${depot.lat},${depot.lon}`);
  const travelmode = mode === "walk" ? "walking" : (mode === "train" || mode === "bus") ? "transit" : "driving";
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${dest}&travelmode=${travelmode}`;
}

// ----- Ticket helpers
function buildTranscript(limit = 12) {
  const slice = CHAT_LOG.slice(-Math.max(1, limit));
  return slice.map((m) => `[${formatUKTime(new Date(m.ts))}] ${m.role}: ${m.text}`).join("\n");
}
function isValidPhone(raw) {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  return digits.length >= 8 && digits.length <= 16;
}

// ----- GPS (called directly from click)
function requestBrowserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Geolocation not supported"));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
    );
  });
}

// ----- Chips (with GPS direct-call support)
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

    b.addEventListener("click", async () => {
      const now = Date.now();
      if (isResponding) return;
      if (now - lastChipClickAt < SETTINGS.chipClickCooldownMs) return;
      lastChipClickAt = now;

      wrap.querySelectorAll(".chip-btn").forEach((btn) => (btn.disabled = true));

      // ✅ GPS is triggered *here* (user activation preserved)
      if (q === "Use my location" && distanceCtx && distanceCtx.stage === "needOrigin") {
        await handleUseMyLocation();
        input.focus();
        return;
      }

      if (typeof onClick === "function") onClick(q);
      else handleUserMessage(q);
      input.focus();
    });

    wrap.appendChild(b);
  });

  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

async function handleUseMyLocation() {
  // show as user action
  addBubble("Use my location", "user", { ts: new Date() });
  isResponding = true;
  setUIEnabled(false);
  addTyping();

  try {
    const loc = await requestBrowserLocation();
    removeTyping();

    const closest = findClosestDepot({ lat: loc.lat, lon: loc.lon });
    if (!closest) {
      addBubble("I couldn’t determine a nearby depot from your location. Please type a town/city instead.", "bot", { ts: new Date() });
      addChips(["Coventry","Birmingham","Leicester","London"]);
    } else {
      const depot = DEPOTS[closest.depotKey];
      distanceCtx = { stage: "haveClosest", originKey: "your location", depotKey: closest.depotKey, miles: closest.miles };

      addBubble(
        `Thanks — your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>How are you travelling?`,
        "bot",
        { html: true, ts: new Date() }
      );
      addChips(["By car","By train","By bus","Walking"]);
    }
  } catch (e) {
    removeTyping();
    addBubble("I couldn’t access your location. Please allow location permission, or type a town/city instead.", "bot", { ts: new Date() });
    addChips(["Coventry","Birmingham","Leicester","London"]);
  } finally {
    isResponding = false;
    setUIEnabled(true);
  }
}

// ----- Ticket flow + Depot flow (special cases)
function specialCases(text) {
  const q = normalize(text);

  // Bank holidays policy (no listing)
  if (q.includes("bank holiday") || q.includes("bank holidays")) {
    return { matched: true, html: `❌ <b>No — we are not open on bank holidays.</b>` };
  }

  // Ticket trigger
  const wantsTicket =
    q.includes("raise a request") || q.includes("create a ticket") || q.includes("open a ticket") ||
    q.includes("log a ticket") || q.includes("submit a request") || q === "ticket";

  if (!ticketCtx && wantsTicket) {
    ticketCtx = { stage: "needType" };
    return { matched: true, html: "Sure — what do you need help with?", chips: ["Access / Login","Pay / Payroll","Benefits","General query","Something else"] };
  }

  if (ticketCtx) {
    if (q === "cancel" || q === "stop" || q === "restart") {
      ticketCtx = null;
      return { matched: true, html: "No problem — I’ve cancelled that request. If you want to start again, type <b>raise a request</b>." };
    }

    if (ticketCtx.stage === "needType") {
      ticketCtx.type = text.trim();
      ticketCtx.stage = "needName";
      return { matched: true, html: "Thanks — what’s your name?" };
    }
    if (ticketCtx.stage === "needName") {
      ticketCtx.name = text.trim();
      ticketCtx.stage = "needEmail";
      return { matched: true, html: "And what email should we reply to?" };
    }
    if (ticketCtx.stage === "needEmail") {
      const email = text.trim();
      const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!ok) return { matched: true, html: "That doesn’t look like an email — can you retype it?" };
      ticketCtx.email = email;
      ticketCtx.stage = "needPhone";
      return { matched: true, html: "Thanks — what’s the best contact number for you?" };
    }
    if (ticketCtx.stage === "needPhone") {
      const phone = text.trim();
      if (!isValidPhone(phone)) return { matched: true, html: "That number doesn’t look right — please enter a valid contact number (digits only is fine, or include +)." };
      ticketCtx.phone = phone;
      ticketCtx.stage = "needDescription";
      return { matched: true, html: "Briefly describe the issue (1–3 sentences is perfect)." };
    }
    if (ticketCtx.stage === "needDescription") {
      ticketCtx.description = text.trim();
      ticketCtx.stage = "needUrgency";
      return { matched: true, html: "How urgent is this?", chips: ["Low","Normal","High","Critical"] };
    }
    if (ticketCtx.stage === "needUrgency") {
      ticketCtx.urgency = text.trim();
      const transcript = buildTranscript(SETTINGS.ticketTranscriptMessages ?? 40);
      const subject = encodeURIComponent(`[Welfare Support] ${ticketCtx.type} (${ticketCtx.urgency})`);
      const body = encodeURIComponent(
        `Name: ${ticketCtx.name}\nEmail: ${ticketCtx.email}\nContact number: ${ticketCtx.phone}\nUrgency: ${ticketCtx.urgency}\nType: ${ticketCtx.type}\n\nDescription:\n${ticketCtx.description}\n\nChat transcript:\n${transcript}\n\n— Sent from Welfare Support chatbot`
      );
      const mailtoHref = `mailto:${SETTINGS.supportEmail}?subject=${subject}&body=${body}`;

      const html =
        `<b>Request summary</b><br>` +
        `Type: <b>${escapeHTML(ticketCtx.type)}</b><br>` +
        `Urgency: <b>${escapeHTML(ticketCtx.urgency)}</b><br>` +
        `Name: <b>${escapeHTML(ticketCtx.name)}</b><br>` +
        `Email: <b>${escapeHTML(ticketCtx.email)}</b><br>` +
        `Contact number: <b>${escapeHTML(ticketCtx.phone)}</b><br><br>` +
        `${aHTML(mailtoHref, "Email support with this request (includes transcript)")}<br>` +
        `<small>(This opens your email app with the message prefilled — you then press Send.)</small>`;

      ticketCtx = null;
      return { matched: true, html, chips: ["Raise a request (create a ticket)"] };
    }
  }

  // Depot trigger
  if (q.includes("closest depot") || q.includes("how far") || q.includes("distance")) {
    if (!distanceCtx) distanceCtx = { stage: "needOrigin" };
    return { matched: true, html: "What town/city are you travelling from? (Or choose <b>Use my location</b>.)", chips: ["Use my location","Coventry","Birmingham","Leicester","London"] };
  }

  // Depot city reply (when awaiting origin)
  if (distanceCtx && distanceCtx.stage === "needOrigin") {
    const cityKey = Object.keys(PLACES).find(k => q === k || q.includes(k));
    if (cityKey) {
      const closest = findClosestDepot(PLACES[cityKey]);
      const depot = DEPOTS[closest.depotKey];
      distanceCtx = { stage: "haveClosest", originKey: cityKey, depotKey: closest.depotKey, miles: closest.miles };
      return { matched: true, html: `Thanks — your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>How are you travelling?`, chips: ["By car","By train","By bus","Walking"] };
    }
  }

  // Depot mode selection
  if (distanceCtx && distanceCtx.stage === "haveClosest") {
    if (q === "by car" || q === "by train" || q === "by bus" || q === "walking") {
      const mode = q === "walking" ? "walk" : q.replace("by ","");
      const depot = DEPOTS[distanceCtx.depotKey];
      const originLabel = distanceCtx.originKey === "your location" ? "your location" : titleCase(distanceCtx.originKey);
      const url = googleDirectionsURL(originLabel, depot, mode);
      const tile = osmTileURL(depot.lat, depot.lon, 13);

      return {
        matched: true,
        html:
          `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
          `${aHTML(url, "Get directions in Google Maps")}<br>` +
          `${imgHTML(tile, "OpenStreetMap preview")}`
      };
    }
  }

  return null;
}

// ----- Main handler
function handleUserMessage(text) {
  if (!text) return;

  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
  currentSuggestions = [];
  activeSuggestionIndex = -1;

  addBubble(text, "user", { ts: new Date() });

  isResponding = true;
  setUIEnabled(false);
  addTyping();

  setTimeout(() => {
    removeTyping();

    const special = specialCases(text);
    if (special && special.matched) {
      addBubble(special.html, "bot", { html: true, ts: new Date() });
      if (special.chips && special.chips.length) addChips(special.chips);
      isResponding = false;
      setUIEnabled(true);
      input.value = "";
      input.focus();
      return;
    }

    // fallback to FAQ match (simple)
    const q = normalize(text);
    const hit = FAQS.find(f => normalize(f.question) === q) || null;
    if (hit) addBubble(hit.answer, "bot", { html: true, ts: new Date() });
    else addBubble("I’m not sure — try the Topics button, or ask about opening times / support / location / closest depot.", "bot", { ts: new Date() });

    isResponding = false;
    setUIEnabled(true);
    input.value = "";
    input.focus();
  }, 220);
}

function sendChat() {
  if (isResponding) return;
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  handleUserMessage(text);
}
sendBtn.addEventListener("click", sendChat);

clearBtn.addEventListener("click", () => {
  chatWindow.innerHTML = "";
  ticketCtx = null;
  distanceCtx = null;
  CHAT_LOG = [];
  init();
  input.focus();
});

// ----- Topics drawer
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
    opening: "Opening times",
    actions: "Actions"
  };

  categories = Array.from(categoryIndex.keys()).sort().map((key) => ({
    key,
    label: labelMap[key] ?? (key.charAt(0).toUpperCase() + key.slice(1)),
    count: categoryIndex.get(key).length
  }));
}

function openDrawer() {
  overlay.hidden = false;
  drawer.hidden = false;
  drawerCloseBtn?.focus();
}
function closeDrawer() {
  overlay.hidden = true;
  drawer.hidden = true;
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

topicsBtn?.addEventListener("click", () => { if (faqsLoaded) openDrawer(); });
overlay?.addEventListener("click", () => closeDrawer());
drawerCloseBtn?.addEventListener("click", () => closeDrawer());

// ----- Load FAQs
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

// ----- Init (greeting only)
function init() {
  addBubble(SETTINGS.greeting, "bot", { html: true, ts: new Date() });
}
if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", init);
else init();
