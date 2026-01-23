
// Welfare Support – Floating Widget (Improved)

(function () {

    const currentScript = document.currentScript ||
        (function () {
            const s = document.getElementsByTagName("script");
            return s[s.length - 1];
        })();

    const scriptURL = new URL(currentScript.src, window.location.href);
    const appBase = scriptURL.href.replace(/\/public\/widget\.js(?:\?.*)?$/, "/");

    /* -------- Floating button -------- */
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Open Welfare Support chat");
    btn.textContent = "💬";
    btn.style.cssText = `
        position: fixed; bottom: 20px; right: 20px;
        z-index: 999999;
        width: 60px; height: 60px;
        border-radius: 50%;
        background: #0078ff; color: white;
        border: none; cursor: pointer;
        box-shadow: 0 6px 18px rgba(0,0,0,.25);
        font-size: 26px;
        transition: transform .2s;
    `;
    btn.onmouseenter = () => btn.style.transform = "scale(1.08)";
    btn.onmouseleave = () => btn.style.transform = "scale(1)";
    document.body.appendChild(btn);

    /* -------- Popup chat window -------- */
    const frame = document.createElement("iframe");
    frame.src = appBase + "index.html";
    frame.title = "Welfare Support Chat";
    frame.style.cssText = `
        position: fixed; bottom: 90px; right: 20px;
        width: 380px; height: 520px;
        border: none; border-radius: 14px;
        box-shadow: 0 10px 30px rgba(0,0,0,.25);
        display: none; background: white;
        z-index: 999999;
        opacity: 0; transition: opacity .25s ease;
    `;
    document.body.appendChild(frame);

    btn.addEventListener("click", () => {
        const isOpen = frame.style.display === "block";

        if (!isOpen) {
            frame.style.display = "block";
            requestAnimationFrame(() => frame.style.opacity = "1");
        } else {
            frame.style.opacity = "0";
            setTimeout(() => frame.style.display = "none", 200);
        }
    });
})();
