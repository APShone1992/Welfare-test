
let FAQ_DATA = [];

/*************************************************
 * LOAD JSON DATA
 *************************************************/
fetch("./json/faqData.json")
  .then(res => res.json())
  .then(data => {
    FAQ_DATA = data;
  });

/*************************************************
 * SESSION MEMORY
 *************************************************/
const memory = {
  askedFollowUps: new Set(
    JSON.parse(sessionStorage.getItem("askedFollowUps") || "[]")
  )
};

function saveMemory() {
  sessionStorage.setItem(
    "askedFollowUps",
    JSON.stringify([...memory.askedFollowUps])
  );
}

/*************************************************
 * MAIN RESPONSE FUNCTION
 *************************************************/
function respondToUser(userText) {
  if (!FAQ_DATA.length) return null;

  const text = userText.toLowerCase();
  let entry = null;

  // Redirects
  for (const e of FAQ_DATA) {
    const r = e.redirects?.find(x => text.includes(x.match));
    if (r) {
      entry = FAQ_DATA.find(f => f.id === r.to);
      break;
    }
  }

  // Match question / synonyms / keywords
  if (!entry) {
    for (const e of FAQ_DATA) {
      if (
        text.includes(e.question.toLowerCase()) ||
        e.synonyms?.some(s => text.includes(s.toLowerCase())) ||
        e.keywords?.some(k => text.includes(k))
      ) {
        entry = e;
        break;
      }
    }
  }

  if (!entry) {
    return { answer: "Sorry, I didn’t understand that.", followUp: null };
  }

  // Context‑aware follow‑up
  let followUp = entry.followups?.find(f =>
    !memory.askedFollowUps.has(f.id)
  );

  if (followUp) {
    memory.askedFollowUps.add(followUp.id);
    saveMemory();
  }

  return {
    answer: entry.answer,
    followUp: followUp ? followUp.label : null
  };
}
