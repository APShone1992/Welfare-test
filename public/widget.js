// Welfare Support — Floating Widget
(function () {
  const currentScript =
    document.currentScript ||
    (function () {
      const scripts = document.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();

  if (!currentScript || !currentScript.src) return;

  const scriptURL = new URL(currentScript.src, window.location.href);
  const appBase = scriptURL.href.replace(/\/public\/widget\.js(?:\?.*)?$/, "/");

  // Inject Google Fonts for widget launcher tooltip
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;600&display=swap";
  document.head.appendChild(link);

  // --- Launcher Button ---
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Open Welfare Support chat");
  btn.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      style="display:block;">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  `;

  Object.assign(btn.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    zIndex: "2147483647",
    width: "56px",
    height: "56px",
    borderRadius: "50%",
    background: "linear-gradient(135deg, #1e4d9b 0%, #1a3a6b 100%)",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    boxShadow: "0 8px 24px rgba(26,58,107,0.40), 0 2px 8px rgba(26,58,107,0.20)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "transform 0.18s ease, box-shadow 0.18s ease",
    fontFamily: "'DM Sans', system-ui, sans-serif",
  });

  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "scale(1.08)";
    btn.style.boxShadow = "0 12px 32px rgba(26,58,107,0.48), 0 4px 12px rgba(26,58,107,0.22)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "scale(1)";
    btn.style.boxShadow = "0 8px 24px rgba(26,58,107,0.40), 0 2px 8px rgba(26,58,107,0.20)";
  });

  // Notification badge (subtle pulse to draw attention on first load)
  const badge = document.createElement("span");
  Object.assign(badge.style, {
    position: "absolute",
    top: "2px",
    right: "2px",
    width: "12px",
    height: "12px",
    borderRadius: "50%",
    background: "#e53e3e",
    border: "2px solid #fff",
    animation: "wsPulse 2s ease-in-out 3",
  });

  // Inject pulse keyframes
  const style = document.createElement("style");
  style.textContent = `
    @keyframes wsPulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.25); opacity: 0.7; }
    }
    @keyframes wsFrameIn {
      from { opacity: 0; transform: translateY(12px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
  `;
  document.head.appendChild(style);
  btn.appendChild(badge);
  document.body.appendChild(btn);

  // --- Chat iframe ---
  const frame = document.createElement("iframe");
  frame.title = "Welfare Support Chat";
  frame.src = appBase + "index.html";

  Object.assign(frame.style, {
    position: "fixed",
    bottom: "92px",
    right: "24px",
    zIndex: "2147483647",
    width: "380px",
    height: "560px",
    border: "none",
    borderRadius: "18px",
    display: "none",
    background: "#fff",
    boxShadow: "0 20px 60px rgba(13,31,60,0.18), 0 4px 16px rgba(13,31,60,0.10), 0 0 0 1px rgba(26,58,107,0.08)",
    opacity: "0",
    transition: "opacity 0.22s ease",
    overflow: "hidden",
  });

  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
  );
  frame.setAttribute("allow", "geolocation; microphone");
  document.body.appendChild(frame);

  // --- Open / Close ---
  function openFrame() {
    // Remove badge on first open
    badge.remove();

    frame.style.display = "block";
    frame.style.animation = "wsFrameIn 0.25s cubic-bezier(0.22,1,0.36,1) both";
    requestAnimationFrame(() => (frame.style.opacity = "1"));

    // Swap icon to X
    btn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
        style="display:block;">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    `;
  }

  function closeFrame() {
    frame.style.opacity = "0";
    setTimeout(() => {
      frame.style.display = "none";
      frame.style.animation = "";
    }, 200);

    // Restore chat icon
    btn.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
        style="display:block;">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    `;
  }

  function isOpen() {
    return frame.style.display === "block";
  }

  btn.addEventListener("click", () => (isOpen() ? closeFrame() : openFrame()));
  document.addEventListener("keydown", (e) => e.key === "Escape" && closeFrame());
  document.addEventListener("click", (e) => {
    const clickedLauncher = e.target === btn || btn.contains(e.target);
    const clickedFrame = frame.contains(e.target);
    if (!clickedLauncher && !clickedFrame && isOpen()) closeFrame();
  });

  // Responsive: on small screens use full-width frame
  function applyResponsive() {
    if (window.innerWidth <= 440) {
      Object.assign(frame.style, {
        width: "100vw",
        height: "85vh",
        bottom: "0",
        right: "0",
        borderRadius: "18px 18px 0 0",
      });
    } else {
      Object.assign(frame.style, {
        width: "380px",
        height: "560px",
        bottom: "92px",
        right: "24px",
        borderRadius: "18px",
      });
    }
  }

  applyResponsive();
  window.addEventListener("resize", applyResponsive);
})();
