
/* -------------------------------------------------------
   AI‑STYLE SHORT‑TERM MEMORY
---------------------------------------------------------- */

let memory = {
    lastUserMessages: [],
    lastMatchedTopic: null
};

function rememberUserMessage(text) {
    memory.lastUserMessages.push(text);
    if (memory.lastUserMessages.length > 5)
        memory.lastUserMessages.shift(); // keep memory short
}

function updateTopic(topic) {
    memory.lastMatchedTopic = topic;
}

function inferContext(query) {
    const qNorm = normalize(query);

    // Follow-up based purely on last topic
    if (memory.lastMatchedTopic) {
        if (["weekend", "sat", "sun", "bank holiday"].some(w => qNorm.includes(w))) {
            if (memory.lastMatchedTopic.includes("open")) {
                return {
                    matched: true,
                    answerHTML: "We are currently <b>closed on weekends and bank holidays</b>.",
                    contextual: true
                };
            }
        }
    }
    return null;
}

