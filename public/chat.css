
:root {
    --blue: #0078ff;
    --blue-dark: #005fcc;
    --bg: #e7f0ff;
    --bot-bg: #eef4ff;
    --bot-text: #001a4d;
    --shadow: 0 4px 14px rgba(0,0,0,0.1);
}

* { box-sizing: border-box; }

body {
    margin: 0;
    background: var(--bg);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
}

/* Chat container */
.chat-container {
    max-width: 520px;
    background: white;
    margin: 32px auto;
    border-radius: 14px;
    box-shadow: var(--shadow);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}

/* Header */
.chat-header {
    display: flex;
    align-items: center;
    gap: 10px;
    background: var(--blue);
    color: white;
    padding: 14px 16px;
}

.bot-avatar {
    width: 32px;
    height: 32px;
}

/* Window */
.chat-window {
    padding: 16px;
    overflow-y: auto;
    flex: 1;
}

/* Bubbles */
.bubble {
    max-width: 80%;
    padding: 10px 14px;
    border-radius: 16px;
    margin: 8px 0;
    line-height: 1.45;
    font-size: 15px;
    animation: fadeIn 0.15s ease-out;
}

.bubble.bot {
    background: var(--bot-bg);
    color: var(--bot-text);
    margin-right: auto;
    border-bottom-left-radius: 6px;
}

.bubble.user {
    background: var(--blue);
    color: white;
    margin-left: auto;
    border-bottom-right-radius: 6px;
}

/* Input area */
.input-area {
    display: flex;
    padding: 10px;
    gap: 10px;
    border-top: 1px solid #e5e5e5;
}

.input-area input {
    flex: 1;
    padding: 12px;
    border-radius: 10px;
    border: 1px solid #cfd8ea;
}

.input-area button {
    padding: 10px 16px;
    background: var(--blue);
    border-radius: 10px;
    border: none;
    color: white;
    cursor: pointer;
}

.input-area button:hover {
    background: var(--blue-dark);
}

/* Typing dots */
.typing span {
    display: inline-block;
    width: 6px;
    height: 6px;
    margin: 0 2px;
    background: #9bb8f8;
    border-radius: 50%;
    animation: blink 1.2s infinite ease-in-out;
}

.typing span:nth-child(2) { animation-delay: .15s; }
.typing span:nth-child(3) { animation-delay: .3s; }

@keyframes blink {
    0%, 80%, 100% { opacity: .3; }
    40% { opacity: 1; }
}

@keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
}

@media (max-width: 560px) {
    .chat-container {
        margin: 0;
        border-radius: 0;
        height: 100vh;
    }
}
