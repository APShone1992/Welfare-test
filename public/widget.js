
// Welfare Support – Floating Widget (Fixed + Upgraded)
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
  btn.style.cssText = `
    position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
    width: 60px; height: 60px; border-radius: 50%;
    background: #0078ff; color: #fff; border: none; cursor: pointer;
    box-shadow: 0 6px 18px rgba(0,0,0,0.25); font-size: 24px; line-height: 60px;
  `;
  btn.textContent = "💬";
  document.body.appendChild(btn);

  // Iframe popup
  const frame = document.createElement("iframe");
  frame.title = "Welfare Support Chat";
  frame.src = appBase + "index.html";
  frame.style.cssText = `
    position: fixed; bottom: 90px; right: 20px; z-index: 2147483647;
    width: 380px; height: 520px; border: none; border-radius: 14px;
    display: none; background: #fff;
    box-shadow: 0 10px 30px rgba(0,0,0,0.25);
  `;
  document.body.appendChild(frame);

  function isOpen() { return frame.style.display !== "none"; }
  function open() { frame.style.display = "block"; }
  function close() { frame.style.display = "none"; }
  function toggle() { isOpen() ? close() : open(); }

  btn.addEventListener("click", toggle);

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  // Responsive (mobile)
  function resize() {
    const small = window.matchMedia("(max-width: 480px)").matches;
    if (small) {
      frame.style.width = "calc(100vw - 24px)";
      frame.style.height = "70vh";
      frame.style.right = "12px";
      frame.style.bottom = "90px";
    } else {
      frame.style.width = "380px";
      frame.style.height = "520px";
      frame.style.right = "20px";
      frame.style.bottom = "90px";
    }
  }
  window.addEventListener("resize", resize);
  resize();
})();
``
