
// Welfare Support – Floating Widget (improved + bugfix)
(function () {
  // Figure out where this script is hosted so the iframe points at the same repo
  const currentScript = document.currentScript || (function () {
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
  btn.setAttribute("aria-haspopup", "dialog");
  btn.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
    width: 60px; height: 60px; border-radius: 50%;
    background: #0078ff; color: #fff; border: none; cursor: pointer;
    box-shadow: 0 6px 18px rgba(0,0,0,0.25);
    font-size: 24px; line-height: 60px;
  `;
  btn.textContent = "💬";
  document.body.appendChild(btn);

  // Iframe popup
  const frame = document.createElement("iframe");
  frame.title = "Welfare Support Chat";
  frame.src = appBase + "index.html";
  frame.setAttribute("aria-label", "Welfare Support chat window");
  frame.style.cssText = `
    position: fixed; bottom: 90px; right: 20px; z-index: 2147483647;
    width: 380px; height: 520px; border: none; border-radius: 14px;
    display: none; background: #fff;
    box-shadow: 0 10px 30px rgba(0,0,0,0.25);
  `;
  document.body.appendChild(frame);

  const isOpen = () => frame.style.display !== "none";
  const open = () => {
    frame.style.display = "block";
    btn.textContent = "✕";
    btn.setAttribute("aria-expanded", "true");
  };
  const close = () => {
    frame.style.display = "none";
    btn.textContent = "💬";
    btn.setAttribute("aria-expanded", "false");
  };
  const toggle = () => (isOpen() ? close() : open());

  btn.addEventListener("click", toggle);

  // ESC closes
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  // Click outside closes (optional)
  document.addEventListener("mousedown", (e) => {
    if (!isOpen()) return;
    if (e.target === btn || e.target === frame) return;
    close();
  });
})();

