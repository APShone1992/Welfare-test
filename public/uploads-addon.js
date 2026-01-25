
// public/uploads-addon.js
// Add-on: Attachment picker + (optional) upload links
// Works without modifying your existing chat.js.
// Limitations: cannot auto-attach files to mailto. We can provide filenames + optional uploaded links.

(function () {
  const ADDON = {
    maxFiles: 5,
    maxFileSizeMB: 10, // local limit check (client-side)
    enableUploads: false, // set true only if you add an upload endpoint (Option B)
    uploadEndpoint: "",   // e.g. "https://your-upload-service/upload"
  };

  const state = {
    files: [],
    links: [] // {name,url}
  };

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === "style") node.style.cssText = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "class") node.className = v;
      else node.setAttribute(k, v);
    });
    children.forEach(c => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return node;
  }

  function waitForUI() {
    const inputArea = document.querySelector(".input-area");
    const sendBtn = document.getElementById("sendBtn");
    const chatWindow = document.getElementById("chatWindow");
    if (!inputArea || !sendBtn || !chatWindow) return false;

    // Create hidden file input
    const fileInput = el("input", {
      type: "file",
      multiple: "true",
      accept: "image/*,.pdf,.doc,.docx,.txt",
      style: "display:none"
    });

    // Create attachment button
    const attachBtn = el("button", {
      type: "button",
      id: "attachBtn",
      class: "icon-btn",
      "aria-label": "Attach files",
      title: "Attach files",
    }, ["📎"]);

    // Insert before Send button (keeps your existing layout)
    inputArea.insertBefore(attachBtn, sendBtn);
    document.body.appendChild(fileInput);

    attachBtn.addEventListener("click", () => fileInput.click());

    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = ""; // allow same file reselect

      if (!files.length) return;

      // enforce max files
      const availableSlots = Math.max(0, ADDON.maxFiles - state.files.length);
      const picked = files.slice(0, availableSlots);

      const tooMany = files.length > availableSlots;
      if (tooMany) {
        pushBot(chatWindow, `You can attach up to ${ADDON.maxFiles} files. I added the first ${picked.length}.`);
      }

      // size check
      const ok = [];
      for (const f of picked) {
        const mb = f.size / (1024 * 1024);
        if (mb > ADDON.maxFileSizeMB) {
          pushBot(chatWindow, `“${escapeHtml(f.name)}” is ${mb.toFixed(1)}MB which is above the ${ADDON.maxFileSizeMB}MB limit.`);
        } else {
          ok.push(f);
        }
      }

      if (!ok.length) return;

      state.files.push(...ok);

      // show in chat
      pushUser(chatWindow, `Attached ${ok.length} file(s)`);
      pushBot(chatWindow, renderFileList(ok), true);

      // optional: upload and return links
      if (ADDON.enableUploads && ADDON.uploadEndpoint) {
        try {
          pushBot(chatWindow, "Uploading files…");
          const links = await uploadFiles(ok);
          state.links.push(...links);
          pushBot(chatWindow, renderLinkList(links), true);
          pushBot(chatWindow, "Tip: When you create a ticket, paste these links into the email if needed.");
        } catch (e) {
          pushBot(chatWindow, "Upload failed. You can still attach the files manually in your email.");
        }
      } else {
        pushBot(
          chatWindow,
          "When your email opens to support, please attach these files manually (your email app will prompt you)."
        );
      }

      // add a “Clear attachments” chip-like button below list
      addInlineActions(chatWindow);
    });

    // Add a small style block so attachment button blends in
    const style = el("style", {}, [`
      #attachBtn { font-size: 16px; }
      .attach-actions { display:flex; gap:8px; margin:8px 0 2px; flex-wrap:wrap; }
      .attach-action-btn{
        border:1px solid #cfd8ea;
        background:#f6f9ff;
        color:#0b2a66;
        padding:8px 10px;
        border-radius:999px;
        cursor:pointer;
        font-size:13px;
      }
    `]);
    document.head.appendChild(style);

    return true;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  // Minimal bubble renderer matching your DOM structure
  function pushUser(chatWindow, text) {
    pushBubble(chatWindow, text, "user", false);
  }
  function pushBot(chatWindow, text, html = false) {
    pushBubble(chatWindow, text, "bot", html);
  }
  function pushBubble(chatWindow, text, type, html) {
    const row = document.createElement("div");
    row.className = "msg " + type;

    const bubble = document.createElement("div");
    bubble.className = "bubble " + type;

    if (html) bubble.innerHTML = text;
    else bubble.textContent = text;

    const time = document.createElement("div");
    time.className = "timestamp";
    const now = new Date();
    time.textContent = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

    row.appendChild(bubble);
    row.appendChild(time);
    chatWindow.appendChild(row);
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }

  function renderFileList(files) {
    const items = files.map(f => {
      const mb = (f.size / (1024 * 1024)).toFixed(1);
      return `<li><b>${escapeHtml(f.name)}</b> <small>(${mb}MB)</small></li>`;
    }).join("");
    return `<div><b>Files selected:</b><ul>${items}</ul></div>`;
  }

  function renderLinkList(links) {
    const items = links.map(x => `<li><a href="${escapeHtml(x.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(x.name)}</a></li>`).join("");
    return `<div><b>Uploaded links:</b><ul>${items}</ul></div>`;
  }

  function addInlineActions(chatWindow) {
    // remove existing action bar
    chatWindow.querySelectorAll(".attach-actions").forEach(n => n.remove());

    const bar = el("div", { class: "attach-actions" });

    const clearBtn = el("button", {
      type: "button",
      class: "attach-action-btn",
      onclick: () => {
        state.files = [];
        state.links = [];
        pushBot(chatWindow, "Attachments cleared.");
        bar.remove();
      }
    }, ["Clear attachments"]);

    const copyBtn = el("button", {
      type: "button",
      class: "attach-action-btn",
      onclick: async () => {
        const text =
          state.links.length
            ? state.links.map(l => `${l.name}: ${l.url}`).join("\n")
            : state.files.map(f => f.name).join("\n");

        try {
          await navigator.clipboard.writeText(text);
          pushBot(chatWindow, "Copied attachment info to clipboard.");
        } catch {
          pushBot(chatWindow, "Could not copy to clipboard in this browser.");
        }
      }
    }, ["Copy attachment info"]);

    bar.appendChild(clearBtn);
    bar.appendChild(copyBtn);
    chatWindow.appendChild(bar);
    chatWindow.scrollTop = chatWindow.scrollHeight;
  }

  async function uploadFiles(files) {
    // Option B: requires an endpoint
    const results = [];
    for (const f of files) {
      const form = new FormData();
      form.append("file", f, f.name);

      const res = await fetch(ADDON.uploadEndpoint, { method: "POST", body: form });
      if (!res.ok) throw new Error("Upload failed");
      const data = await res.json(); // expected { url: "https://..." }
      if (!data?.url) throw new Error("No URL returned");

      results.push({ name: f.name, url: data.url });
    }
    return results;
  }

  // Boot
  const ok = waitForUI();
  if (!ok) {
    // try again a few times (in case scripts load late)
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (waitForUI() || tries > 20) clearInterval(t);
    }, 200);
  }
})();
