
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

  // Launcher button
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("aria-label", "Open Welfare Support chat");
  btn.textContent = "💬";
  btn.style.cssText = `
    position: fixed; bottom: 20px; right: 20px;
    z-index: 2147483647;
    width: 60px; height: 60px; border-radius: 50%;
    background: #0078ff; color: #fff; border: none; cursor: pointer;
    box-shadow: 0 10px 25px rgba(0,0,0,0.22);
    font-size: 24px; line-height: 60px;
    transition: transform .15s ease, box-shadow .15s ease;
  `;
  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "scale(1.06)";
    btn.style.boxShadow = "0 14px 35px rgba(0,0,0,0.26)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "scale(1)";
    btn.style.boxShadow = "0 10px 25px rgba(0,0,0,0.22)";
  });
  document.body.appendChild(btn);

  // Iframe popup
  const frame = document.createElement("iframe");
  frame.title = "Welfare Support Chat";
  frame.src = appBase + "index.html";
  frame.style.cssText = `
    position: fixed; bottom: 90px; right: 20px;
    z-index: 2147483647;
    width: 380px; height: 520px;
    border: none; border-radius: 16px;
    display: none; background: #fff;
    box-shadow: 0 18px 45px rgba(0,0,0,0.25);
    opacity: 0; transition: opacity .2s ease;
    overflow: hidden;
  `;

  // Safe default sandbox. If you ever need more permissions, relax this.
  frame.setAttribute("sandbox", "allow-scripts allow-forms allow-same-origin");

  document.body.appendChild(frame);

  function openFrame() {
    frame.style.display = "block";
    requestAnimationFrame(() => (frame.style.opacity = "1"));
  }

  function closeFrame() {
    frame.style.opacity = "0";
    setTimeout(() => (frame.style.display = "none"), 180);
  }

  function isOpen() {
    return frame.style.display === "block";
  }

  btn.addEventListener("click", () => {
    if (isOpen()) closeFrame();
    else openFrame();
  });

  // Close on ESC
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFrame();
  });

  // Close on click outside
  document.addEventListener("click", (e) => {
    const clickedLauncher = e.target === btn;
    const clickedFrame = frame.contains(e.target);
    if (!clickedLauncher && !clickedFrame && isOpen()) closeFrame();
  });
})();
