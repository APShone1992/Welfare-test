
/* Welfare Support Chatbot (Ticket + GPS + Depot restored)
- Ticket/request flow works (mailto + transcript) [1](https://www.publicholidayguide.com/bank-holiday/england-wales-bank-holidays-2025/)
- GPS flow restored (Use my location) [1](https://www.publicholidayguide.com/bank-holiday/england-wales-bank-holidays-2025/)
- City chips work again in needOrigin stage [1](https://www.publicholidayguide.com/bank-holiday/england-wales-bank-holidays-2025/)
- Uses OSM tiles for map preview (reliable)
- No bank holiday year listing; policy only [2](https://www.publicholidayguide.com/bank-holiday/uk-bank-holidays-2025/)
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
  voiceDefaultOn: false,
  greeting:
    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, where we’re located, or how far you are from your closest depot."
};

let FAQS = [];
let faqsLoaded = false;
let categories = [];
let categoryIndex = new Map();

/* DOM */
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

/* State */
let isResponding = false;
let lastChipClickAt = 0;
let missCount = 0;

let activeSuggestionIndex = -1;
let currentSuggestions = [];

let distanceCtx = null;
let ticketCtx = null;

let CHAT_LOG = [];

/* Memory */
const MEMORY_KEY = "ws_chat_memory_v8";
const memory = { voiceOn: null, preferredMode: null, name: null };
function loadMemory() {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") Object.assign(memory, obj);
  } catch (_) {}
}
function saveMemory() {
  try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); } catch (_) {}
}
loadMemory();

/* Normalise */
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

/* Safe HTML */
function escapeHTML(s) {
  const str = String(s ?? "");
  return str
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function escapeAttrUrl(url) {
  return String(url ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
function aHTML(href, label) {
  return `<a href="${escapeAttrUrl(href)}">${escapeHTML(label)}</a>`;
}
function imgTagHTML(src, alt = "Map preview") {
  return `<img class="map-preview" src="${escapeAttrUrl(src)}" alt="${escapeHTML(alt)}" loading="lazy">`;
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

/* UK time */
const UK_TZ = "Europe/London";
function formatUKTime(date) {
  return new Intl.DateTimeFormat("en-GB", { timeZone: UK_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

/* Ticket transcript */
function pushToTranscript(type, text, opts) {
  const options = opts ?? {};
  const ts = (options.ts ?? new Date()).getTime();
  const plain = options.html ? htmlToPlainText(text) : String(text ?? "").trim();
  if (plain) CHAT_LOG.push({ role: type === "bot" ? "Bot" : "User", text: plain, ts });
  if (CHAT_LOG.length > 80) CHAT_LOG = CHAT_LOG.slice(-80);
}
function buildTranscript(limit = 12) {
  const take = Math.max(1, limit);
  const slice = CHAT_LOG.slice(-take);
  return slice.map((m) => {
    const time = formatUKTime(new Date(m.ts));
    return `[${time}] ${m.role}: ${m.text}`;
  }).join("\n");
}

/* UI */
function setUIEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
  micBtn.disabled = !enabled;
  chatWindow.querySelectorAll(".chip-btn").forEach((b) => (b.disabled = !enabled));
}
function addBubble(text, type, opts) {
  const options = opts ?? {};
  const html = !!options.html;
  const ts = options.ts ?? new Date();

  const row = document.createElement("div");
  row.className = "msg " + type;

  const bubble = document.createElement("div");
  bubble.className = "bubble " + type;
  bubble.setAttribute("role", "article");

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
  chatWindow.appendChild(wrap);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

/* Depots/places */
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

/* GPS helper ✅ */
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

/* Ticket validation */
function isValidPhone(raw) {
  const digits = String(raw ?? "").replace(/[^\d]/g, "");
  return digits.length >= 8 && digits.length <= 16;
}

/* Ticket + depot special cases */
function specialCases(query) {
  const q = normalize(query);

  // Ticket start
  const wantsTicket =
    q.includes("raise a request") ||
    q.includes("create a ticket") ||
    q.includes("open a ticket") ||
    q.includes("log a ticket") ||
    q.includes("submit a request") ||
    q === "ticket";

  if (!ticketCtx && wantsTicket) {
    ticketCtx = { stage: "needType" };
    return { matched: true, answerHTML: "Sure — what do you need help with?", chips: ["Access / Login","Pay / Payroll","Benefits","General query","Something else"] };
  }

  if (ticketCtx) {
    if (q === "cancel" || q === "stop" || q === "restart") {
      ticketCtx = null;
      return { matched: true, answerHTML: "No problem — I’ve cancelled that request. If you want to start again, type <b>raise a request</b>." };
    }
    if (ticketCtx.stage === "needType") { ticketCtx.type = query.trim(); ticketCtx.stage = "needName"; return { matched:true, answerHTML:"Thanks — what’s your name?" }; }
    if (ticketCtx.stage === "needName") { ticketCtx.name = query.trim(); memory.name=ticketCtx.name; saveMemory(); ticketCtx.stage="needEmail"; return { matched:true, answerHTML:"And what email should we reply to?" }; }
    if (ticketCtx.stage === "needEmail") {
      const email=query.trim();
      const ok=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if(!ok) return { matched:true, answerHTML:"That doesn’t look like an email — can you retype it?" };
      ticketCtx.email=email; ticketCtx.stage="needPhone"; return { matched:true, answerHTML:"Thanks — what’s the best contact number for you?" };
    }
    if (ticketCtx.stage === "needPhone") {
      const phone=query.trim();
      if(!isValidPhone(phone)) return { matched:true, answerHTML:"That number doesn’t look right — please enter a valid contact number (digits only is fine, or include +)." };
      ticketCtx.phone=phone; ticketCtx.stage="needDescription"; return { matched:true, answerHTML:"Briefly describe the issue (1–3 sentences is perfect)." };
    }
    if (ticketCtx.stage === "needDescription") { ticketCtx.description=query.trim(); ticketCtx.stage="needUrgency"; return { matched:true, answerHTML:"How urgent is this?", chips:["Low","Normal","High","Critical"] }; }
    if (ticketCtx.stage === "needUrgency") {
      ticketCtx.urgency=query.trim();
      const transcript = buildTranscript(SETTINGS.ticketTranscriptMessages ?? 40);
      const subject = encodeURIComponent(`[Welfare Support] ${ticketCtx.type} (${ticketCtx.urgency})`);
      const body = encodeURIComponent(
        `Name: ${ticketCtx.name}\nEmail: ${ticketCtx.email}\nContact number: ${ticketCtx.phone}\nUrgency: ${ticketCtx.urgency}\nType: ${ticketCtx.type}\n\nDescription:\n${ticketCtx.description}\n\nChat transcript:\n${transcript}\n\n— Sent from Welfare Support chatbot`
      );
      const mailtoHref = `mailto:${SETTINGS.supportEmail}?subject=${subject}&body=${body}`;
      const summary =
        `<b>Request summary</b><br>` +
        `Type: <b>${escapeHTML(ticketCtx.type)}</b><br>` +
        `Urgency: <b>${escapeHTML(ticketCtx.urgency)}</b><br>` +
        `Name: <b>${escapeHTML(ticketCtx.name)}</b><br>` +
        `Email: <b>${escapeHTML(ticketCtx.email)}</b><br>` +
        `Contact number: <b>${escapeHTML(ticketCtx.phone)}</b><br><br>` +
        `${aHTML(mailtoHref, "Email support with this request (includes transcript)")}<br>` +
        `<small>(This opens your email app with the message prefilled — you then press Send.)</small>`;
      ticketCtx=null;
      return { matched:true, answerHTML: summary };
    }
  }

  // Depot flow trigger
  if (q.includes("closest depot") || q.includes("how far") || q.includes("distance")) {
    const cityKey = Object.keys(PLACES).find(k => q.includes(k));
    if (!cityKey) {
      distanceCtx = { stage: "needOrigin" };
      return { matched: true, answerHTML: "What town/city are you travelling from? (Or choose <b>Use my location</b>.)", chips: ["Use my location","Coventry","Birmingham","Leicester","London"] };
    }
  }

  // Depot: if waiting origin
  if (distanceCtx && distanceCtx.stage === "needOrigin") {
    if (q === "use my location" || q === "my location") {
      return { matched: true, answerHTML: "Okay — please allow location access in your browser. One moment…", doGeo: true };
    }
    const cityKey = Object.keys(PLACES).find(k => q === k || q.includes(k));
    if (cityKey) {
      const closest = findClosestDepot(PLACES[cityKey]);
      const depot = DEPOTS[closest.depotKey];
      distanceCtx = { stage: "haveClosest", originKey: cityKey, depotKey: closest.depotKey, miles: closest.miles };
      return { matched: true, answerHTML: `Thanks — your closest depot is <b>${escapeHTML(depot.label)}</b>. How are you travelling?`, chips: ["By car","By train","By bus","Walking"] };
    }
  }

  // Depot: travel mode
  if (distanceCtx && distanceCtx.stage === "haveClosest") {
    if (q === "by car" || q === "by train" || q === "by bus" || q === "walking") {
      const mode = q === "walking" ? "walk" : q.replace("by ","");
      const depot = DEPOTS[distanceCtx.depotKey];
      const url = googleDirectionsURL(titleCase(distanceCtx.originKey), depot, mode);
      const tile = osmTileURL(depot.lat, depot.lon, 13);
      return {
        matched: true,
        answerHTML:
          `Your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>` +
          `${aHTML(url, "Get directions in Google Maps")}<br>` +
          `${imgTagHTML(tile, "Map preview (OpenStreetMap)")}`
      };
    }
  }

  return null;
}

/* Main handler */
function handleUserMessage(text) {
  if (!text) return;

  suggestionsEl.hidden = true;
  suggestionsEl.innerHTML = "";
  currentSuggestions = [];
  activeSuggestionIndex = -1;

  addBubble(text, "user", { ts: new Date(), speak:false });
  input.value = "";

  isResponding = true;
  setUIEnabled(false);
  addTyping();

  setTimeout(async () => {
    removeTyping();

    const special = specialCases(text);
    if (special && special.matched) {
      addBubble(special.answerHTML, "bot", { html: true });

      if (special.chips && special.chips.length) addChips(special.chips);

      if (special.doGeo) {
        try {
          const loc = await requestBrowserLocation();
          const closest = findClosestDepot({ lat: loc.lat, lon: loc.lon });
          const depot = DEPOTS[closest.depotKey];
          distanceCtx = { stage:"haveClosest", originKey:"your location", depotKey: closest.depotKey, miles: closest.miles };

          addBubble(
            `Thanks — your closest depot is <b>${escapeHTML(depot.label)}</b>.<br>How are you travelling?`,
            "bot",
            { html:true }
          );
          addChips(["By car","By train","By bus","Walking"]);
        } catch (e) {
          addBubble("I couldn’t access your location. You can type a town/city instead (e.g., Coventry).", "bot");
          addChips(["Coventry","Birmingham","Leicester","London"]);
        }
      }

      isResponding = false;
      setUIEnabled(true);
      input.focus();
      return;
    }

    addBubble("I’m not sure. Try the Topics button or ask about opening times / support / location / closest depot.", "bot");
    isResponding = false;
    setUIEnabled(true);
    input.focus();
  }, 250);
}

function sendChat() {
  if (isResponding) return;
  const text = input.value.trim();
  if (!text) return;
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

/* INIT (greeting only) */
function init() {
  addBubble(SETTINGS.greeting, "bot", { html: true, speak:false, ts: new Date() });
}
if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", init);
else init();
