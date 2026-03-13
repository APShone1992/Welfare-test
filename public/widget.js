/*
   Welfare Support — Floating Widget Launcher (Optimised 2026)
   -----------------------------------------------------------
   Clean, safe, GitHub Pages–compatible widget loader.
*/

(function () {
  // Get the script path and compute true base URL
  const currentScript = document.currentScript || (function () {
    const scripts = document.getElementsByTagName("script");
    return scripts[scripts.length - 1];
  })();

  if (!currentScript || !currentScript.src) return;

  const scriptURL = new URL(currentScript.src, window.location.href);

  // This ensures the widget works from ANY folder on GitHub Pages
  const appBase = scriptURL.href.replace(/\/public\/widget\.js(?:\?.*)?$/, "/");

  // Load Google Font for the floating button
  const fontLink = document.createElement("link");
  fontLink.rel = "stylesheet";
  fontLink.href = "https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;600&display=swap";
  document.head.appendChild(fontLink);

  // ------------------------------------------
  // FLOATING LAUNCHER BUTTON
  // ------------------------------------------

  const launcher = document.createElement("button");
  launcher.type = "button";
  launcher.setAttribute("aria-label", "Open Welfare Support chat");

  launcher.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" 
      fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
  `;

  Object.assign(launcher.style, {
    position: "fixed",
    bottom: "24px",
    right: "24px",
    width: "56px",
    height: "56px",
    borderRadius: "50%",
    background: "linear-gradient(135deg,#1e4d9b,#1a3a6b)",
    color: "#fff",
    border: "none",
    cursor: "pointer",
    zIndex: "999999",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 8px 24px rgba(26,58,107,0.40),0 2px 8px rgba(26,58,107,0.25)",
    transition: "transform .18s ease, box-shadow .18s ease",
    fontFamily: "'DM Sans', system-ui, sans-serif",
  });

  launcher.addEventListener("mouseenter", () => {
    launcher.style.transform = "scale(1.08)";
    launcher.style.boxShadow = "0 12px 32px rgba(26,58,107,0.45),0 4px 12px rgba(26,58,107,0.25)";
  });

  launcher.addEventListener("mouseleave", () => {
    launcher.style.transform = "scale(1.0)";
    launcher.style.boxShadow = "0 8px 24px rgba(26,58,107,0.40),0 2px 8px rgba(26,58,107,0.25)";
  });

  // Notification badge (pulse once)
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

  const style = document.createElement("style");
  style.textContent = `
    @keyframes wsPulse {
      0%,100% { transform:scale(1); opacity:1; }
      50%     { transform:scale(1.25); opacity:0.7; }
    }
    @keyframes wsFrameIn {
      from { opacity:0; transform:translateY(14px) scale(.96); }
      to   { opacity:1; transform:translateY(0) scale(1); }
    }
  `;
  document.head.appendChild(style);

  launcher.appendChild(badge);
  document.body.appendChild(launcher);

  // ------------------------------------------
  // IFRAME — Embedded Chat Window
  // ------------------------------------------

  const frame = document.createElement("iframe");
  frame.title = "Welfare Support Chat";
  frame.src = appBase + "index.html";

  Object.assign(frame.style, {
    position: "fixed",
    bottom: "92px",
    right: "24px",
    width: "380px",
    height: "560px",
    background: "#fff",
    border: "none",
    borderRadius: "18px",
    zIndex: "999998",
    display: "none",
    opacity: "0",
    boxShadow: "0 24px 64px rgba(13,31,60,0.18),0 4px 16px rgba(13,31,60,0.12),0 0 0 1px rgba(26,58,107,0.08)",
    transition: "opacity .22s ease",
    overflow: "hidden",
  });

  // Sandbox permissions — secure + functional
  frame.setAttribute("sandbox",
    "allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-by-user-activation allow-popups-to-escape-sandbox"
  );
  frame.setAttribute("allow", "geolocation; microphone");

  document.body.appendChild(frame);

  // ------------------------------------------
  // OPEN / CLOSE BEHAVIOUR
  // ------------------------------------------

  function isOpen() {
    return frame.style.display === "block";
  }

  function openFrame() {
    badge.remove(); // remove pulse badge (one time)
    frame.style.display = "block";
    frame.style.animation = "wsFrameIn .25s cubic-bezier(.22,1,.36,1)";
    requestAnimationFrame(() => (frame.style.opacity = "1"));

    // change launcher icon → X
    launcher.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2.2"
        stroke-linecap="round">
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
    }, 180);

    launcher.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
    `;
  }

  launcher.addEventListener("click", () => {
    isOpen() ? closeFrame() : openFrame();
  });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && isOpen()) closeFrame();
  });

  document.addEventListener("click", e => {
    const clickLauncher = launcher.contains(e.target);
    const clickFrame = frame.contains(e.target);
    if (!clickLauncher && !clickFrame && isOpen()) closeFrame();
  });

  // ------------------------------------------
  // RESPONSIVE MODE (Mobile Fullscreen)
  // ------------------------------------------

  function resizeWidget() {
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

  resizeWidget();
  window.addEventListener("resize", resizeWidget);

})();
