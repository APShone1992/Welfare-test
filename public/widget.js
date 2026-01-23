
// Welfare Support – Floating Widget (Improved)
(function () {
  // Detect base URL from this script src (…/public/widget.js)
  const currentScript = document.currentScript || (function () {
    const scripts = document.getElementsByTagName("script");
    return scripts[scripts.length - 1];
  })();

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
    box-shadow: 0 6px 18px rgba(0,0,0,0.25);
    font-size: 24px; line-height: 60px;
    transition: transform .15s ease;
  `;
  btn.addEventListener("mouseenter", () => (btn.style.transform = "scale(1.06)"));
  btn.addEventListener("mouseleave", () => (btn.style.transform = "scale(1)"));
  document.body.appendChild(btn);

  // Iframe popup
  const frame = document.createElement("iframe");
  frame.title = "Welfare Support Chat";
  frame.src = appBase + "index.html";
  frame.style.cssText = `
    position: fixed; bottom: 90px; right: 20px;
    z-index: 2147483647;
    width: 380px; height: 520px;
    border: none; border-radius: 14px;
    display: none; background: #fff;
    box-shadow: 0 10px 30px rgba(0,0,0,0.25);
    opacity: 0; transition: opacity .2s ease;
  `;
  document.body.appendChild(frame);

  function openFrame() {
    frame.style.display = "block";
    requestAnimationFrame(() => (frame.style.opacity = "1"));
  }

  function closeFrame() {
    frame.style.opacity = "0";
    setTimeout(() => (frame.style.display = "none"), 180);
  }

  btn.addEventListener("click", () => {
    const isOpen = frame.style.display === "block";
    if (isOpen) closeFrame();
    else openFrame();
  });
})();
