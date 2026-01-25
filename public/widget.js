
// Welfare Support – Floating Widget (Clean + Polished)
// - Embeds the chat page in an iframe
// - Auto-detects base URL from this script src
// - Adds ESC close + click-outside close
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

  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Open Welfare Support chat");
  btn.textContent = "💬";
  btn.style.cssText = [
    "position: fixed",
    "bottom: 20px",
    "right: 20px",
    "z-index: 2147483647",
    "width: 60px",
    "height: 60px",
    "border-radius: 50%",
    "background: #0078ff",
    "color: #fff",
    "border: none",
    "cursor: pointer",
    "box-shadow: 0 10px 25px rgba(0,0,0,0.22)",
    "font-size: 24px",
    "line-height: 60px",
    "transition: transform .15s ease, box-shadow .15s ease"
  ].join("; ");

  btn.addEventListener("mouseenter", function () {
    btn.style.transform = "scale(1.06)";
    btn.style.boxShadow = "0 14px 35px rgba(0,0,0,0.26)";
  });
  btn.addEventListener("mouseleave", function () {
    btn.style.transform = "scale(1)";
    btn.style.boxShadow = "0 10px 25px rgba(0,0,0,0.22)";
  });

  document.body.appendChild(btn);

  const frame = document.createElement("iframe");
  frame.title = "Welfare Support Chat";
  frame.src = appBase + "index.html";
  frame.style.cssText = [
    "position: fixed",
    "bottom: 90px",
    "right: 20px",
    "z-index: 2147483647",
    "width: 380px",
    "height: 520px",
    "border: none",
    "border-radius: 16px",
    "display: none",
    "background: #fff",
    "box-shadow: 0 18px 45px rgba(0,0,0,0.25)",
    "opacity: 0",
    "transition: opacity .2s ease",
    "overflow: hidden"
  ].join("; ");

  // ✅ FIX: allow mailto links to open from inside the iframe
  // allow-popups + allow-top-navigation-by-user-activation enables mailto: to open user mail client.
  frame.setAttribute(
    "sandbox",
    "allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation"
  );

  document.body.appendChild(frame);

  function openFrame() {
    frame.style.display = "block";
    requestAnimationFrame(function () {
      frame.style.opacity = "1";
    });
  }
  function closeFrame() {
    frame.style.opacity = "0";
    setTimeout(function () {
      frame.style.display = "none";
    }, 180);
  }
  function isOpen() {
    return frame.style.display === "block";
  }

  btn.addEventListener("click", function () {
    if (isOpen()) closeFrame();
    else openFrame();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeFrame();
  });

  document.addEventListener("click", function (e) {
    const clickedLauncher = e.target === btn;
    const clickedFrame = frame.contains(e.target);
    if (!clickedLauncher && !clickedFrame && isOpen()) closeFrame();
  });
})();
