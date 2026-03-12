*** a/public/chat.js
--- b/public/chat.js
@@
-const SETTINGS = {
-  minConfidence: 0.20,
-  suggestionLimit: 5,
-  chipLimit: 6,
-  chipClickCooldownMs: 900,
-  supportEmail: "support@Kelly.co.uk",
-  supportPhone: "01234 567890",
-  ticketTranscriptMessages: 12,
-  greeting:
-    "Hi! I’m <b>Welfare Support</b>. Ask me about opening times, support contact details, where we’re located, or how far you are from your closest depot."};
+const SETTINGS = {
+  minConfidence: 0.20,
+  suggestionLimit: 5,
+  chipLimit: 12, // allow larger topic lists (Department Contacts, etc.)
+  chipClickCooldownMs: 900,
+  supportEmail: "support@Kelly.co.uk",
+  supportPhone: "01234 567890",
+  ticketTranscriptMessages: 12,
+  // Optional: if you have an SMS inbound number for Pay/Deductions, set it here (e.g. "+4420XXXXXXX")
+  paySmsNumber: "",
+  greeting:
+    "Hi! I’m <b>Welfare Support</b> — please use the <b>Topics</b> button to choose what your query is about."};
@@
 let ticketCtx = null;
 let distanceCtx = null;
+let flowCtx = null; // NEW: guided Topics state (manager disputes, equipment, etc.)
@@
 function linkTag(href, label) {
   return `<a href="${escapeAttrUrl(href)}">${escapeHTML(label)}</a>`;
 }
+
+// NEW: contact helpers
+function telHref(num){ return `tel:${String(num ?? "").replace(/[^+\d]/g,"")}`; }
+function telLink(num, label){
+  const lab = label || String(num);
+  return linkTag(telHref(num), lab);
+}
+function smsHref(num, body){
+  const n = String(num ?? "").replace(/[^+\d]/g,"");
+  const b = encodeURIComponent(body ?? "");
+  return `sms:${n}?&body=${b}`;
+}
@@
 function specialCases(text){
   const q = normalize(text);
 
+  // ---------- Guided Topics flows (stateful)
+  if (flowCtx) {
+    // Generic yes/no helper
+    const isYes = (q === "yes" || q === "y");
+    const isNo  = (q === "no"  || q === "n");
+
+    // WORK ALLOCATION
+    if (flowCtx.type === "workAllocation") {
+      if (flowCtx.stage === "askRaised" && (isYes || isNo)) {
+        flowCtx = null;
+        if (isYes) {
+          return { html: `Please contact Welfare directly on ${telLink("02087583060","02087583060")} and <b>hold the line</b>.`, chips: ["Department Contacts","Equipment Query","Pay / Payroll"] };
+        } else {
+          return { html: `Please raise this to your <b>Field</b> and <b>Area Manager</b> first.<br>If there are further concerns after this step please contact Welfare directly on ${telLink("02087583060","02087583060")} and <b>hold the line</b>.`, chips: ["Department Contacts","Equipment Query","Pay / Payroll"] };
+        }
+      }
+    }
+
+    // MANAGER DISPUTE
+    if (flowCtx.type === "managerDispute") {
+      if (flowCtx.stage === "askFieldManager" && (isYes || isNo)) {
+        if (isNo) {
+          flowCtx = null;
+          return { html: `Please contact Welfare directly on ${telLink("02087583060","02087583060")} and <b>hold the line</b>.`, chips: ["Department Contacts","Work Allocation"] };
+        } else {
+          flowCtx.stage = "askContactedAreaManager";
+          return { html: "Have you contacted your <b>Area Manager</b>?", chips: ["Yes","No"] };
+        }
+      }
+      if (flowCtx.stage === "askContactedAreaManager" && (isYes || isNo)) {
+        flowCtx = null;
+        if (isNo) {
+          return { html: `Please contact your <b>Area Manager</b>.<br>If there are any further concerns after this step please contact Welfare directly on ${telLink("02087583060","02087583060")} and <b>hold the line</b>.`, chips: ["Department Contacts","Work Allocation"] };
+        } else {
+          return { html: `Please contact Welfare directly on ${telLink("02087583060","02087583060")} and <b>hold the line</b>.`, chips: ["Department Contacts","Work Allocation"] };
+        }
+      }
+    }
+
+    // EQUIPMENT QUERY
+    if (flowCtx.type === "equipment") {
+      // stage: start -> expect Stock/Tooling/Van
+      if (flowCtx.stage === "start") {
+        const sel = q;
+        if (sel === "stock" || sel === "tooling" || sel === "van") {
+          flowCtx.sel = sel;
+          if (sel === "stock") {
+            flowCtx.stage = "stockAskForm";
+            return { html: "Have you submitted a <b>Stock Form</b> with your Field Manager?", chips: ["Yes","No"] };
+          }
+          if (sel === "tooling") {
+            flowCtx.stage = "toolingAskByBox";
+            return { html: "Has your Field Manager submitted an order through <b>ByBox</b>?", chips: ["Yes","No"] };
+          }
+          if (sel === "van") {
+            flowCtx.stage = "vanAskRaised";
+            return { html: "Have you raised the query of receiving a van to your <b>Field Manager</b> and <b>Area Manager</b>?", chips: ["Yes","No"] };
+          }
+        }
+      }
+      if (flowCtx.stage === "stockAskForm" && (isYes || isNo)) {
+        flowCtx = null;
+        if (isNo) {
+          return { html: "Please contact your <b>Field Manager</b> and complete a <b>Stock Form</b>.", chips: ["Work Allocation","Department Contacts"] };
+        } else {
+          return { html: "Please contact your <b>Field Manager</b> regarding the update of your stock.<br>For any further concerns please contact Welfare directly on " + telLink("02087583060","02087583060") + " and <b>hold the line</b>.", chips: ["Department Contacts","Work Allocation"] };
+        }
+      }
+      if (flowCtx.stage === "toolingAskByBox" && (isYes || isNo)) {
+        flowCtx = null;
+        if (isNo) {
+          return { html: "Please contact your <b>Field Manager</b> and request them to submit an order to <b>ByBox</b>.", chips: ["Department Contacts","Work Allocation"] };
+        } else {
+          return { html: "Please follow up with your <b>Field Manager</b> regarding your order.<br>For any further concerns please contact Welfare directly on " + telLink("02087583060","02087583060") + " and <b>hold the line</b>.", chips: ["Department Contacts","Work Allocation"] };
+        }
+      }
+      if (flowCtx.stage === "vanAskRaised" && (isYes || isNo)) {
+        flowCtx = null;
+        if (isNo) {
+          return { html: "Please contact your <b>Field Manager</b> and query this through.", chips: ["Department Contacts","Work Allocation"] };
+        } else {
+          return { html: "As you have already raised this to your <b>Field</b> and <b>Area Manager</b>, please contact Welfare directly on " + telLink("02087583060","02087583060") + " and <b>hold the line</b>.", chips: ["Department Contacts","Work Allocation"] };
+        }
+      }
+    }
+
+    // DEPARTMENT CONTACTS (and its NTF subflows)
+    if (flowCtx.type === "deptContacts") {
+      if (flowCtx.stage === "chooseDept") {
+        // match department by normalized token
+        const d = q;
+        // direct contact items
+        if (d === "street works") {
+          flowCtx = null;
+          return { html: `Please contact ${linkTag("mailto:Street.Works@kelly.co.uk","Street.Works@kelly.co.uk")} regarding any Street Works queries.` };
+        }
+        if (d === "smart awards") {
+          flowCtx = null;
+          return { html: `Please contact ${linkTag("mailto:smartawards@kelly.co.uk","smartawards@kelly.co.uk")} regarding any Smart Awards queries.` };
+        }
+        if (d === "support team") {
+          flowCtx = null;
+          return { html: `Please call ${telLink("02080164966","02080164966")} for any job support.` };
+        }
+        if (d === "city fibre back office") {
+          flowCtx = null;
+          return { html: `Please call ${telLink("02080164966","02080164966")} for any City Fibre back office / job queries.` };
+        }
+        if (d === "btor allocations team") {
+          flowCtx = null;
+          return { html: `Please call ${telLink("02080164962","02080164962")} for any Open Reach controls queries.` };
+        }
+        if (d === "fleet") {
+          flowCtx = null;
+          return { html: `Please call ${telLink("01582841291","01582841291")} or ${telLink("07940766377","07940766377")} (Out of Hours) for any vehicle or fleet related queries.` };
+        }
+        if (d === "accident line") {
+          flowCtx = null;
+          return { html: `Please call ${telLink("07940792355","07940792355")} for any accident reports (injuries or damage).` };
+        }
+        if (d === "parking line") {
+          flowCtx = null;
+          return { html: `Please call ${telLink("07940792355","07940792355")} for any parking queries.` };
+        }
+        if (d === "recruitment") {
+          flowCtx = null;
+          return { html: `Please call ${telLink("02037583058","02037583058")} for recruitment.` };
+        }
+        if (d === "btor ntf support") {
+          flowCtx = { type:"btorNTF", stage:"chooseArea" };
+          return { html: "Please select which area you are based (BTOR NTF):", chips: ["Wales & Midlands","London & SE","Wessex","North England & Scotland"] };
+        }
+        if (d === "city fibre ntf support") {
+          flowCtx = { type:"cfNTF", stage:"chooseArea" };
+          return { html: "Please select which area you are based (City Fibre NTF):", chips: ["Scotland","Midlands","South","North"] };
+        }
+      }
+    }
+
+    if (flowCtx.type === "btorNTF" && flowCtx.stage === "chooseArea") {
+      flowCtx = null;
+      if (q === "wales midlands" || q === "wales & midlands") {
+        return { html: `For NTF Wales & Midlands, please contact ${telLink("07484034863","07484034863")} or ${telLink("07483932673","07483932673")}.` };
+      }
+      if (q === "london se" || q === "london & se") {
+        return { html: `For NTF London & SE, please contact ${telLink("07814089467","07814089467")} or ${telLink("07814470466","07814470466")}.` };
+      }
+      if (q === "wessex") {
+        return { html: `For NTF Support Wessex, please contact ${telLink("07977670841","07977670841")} or ${telLink("07483555754","07483555754")}.` };
+      }
+      if (q === "north england scotland" || q === "north england & scotland") {
+        return { html: `For NTF Support North England & Scotland, please contact ${telLink("07814089601","07814089601")} or ${telLink("07484082993","07484082993")}.` };
+      }
+    }
+
+    if (flowCtx.type === "cfNTF" && flowCtx.stage === "chooseArea") {
+      flowCtx = null;
+      if (q === "scotland") {
+        return { html: `For NTF Support in Scotland, please contact ${telLink("07866950516","07866950516")} or ${telLink("07773652734","07773652734")}.` };
+      }
+      if (q === "midlands") {
+        return { html: `For NTF Support in Midlands, please contact ${telLink("07773651968","07773651968")}.` };
+      }
+      if (q === "south") {
+        return { html: `For NTF Support in South, please contact ${telLink("07773651950","07773651950")}.` };
+      }
+      if (q === "north") {
+        return { html: `For NTF Support in North, please contact ${telLink("07773652146","07773652146")}, ${telLink("07977330563","07977330563")} or ${telLink("07773652702","07773652702")}.` };
+      }
+    }
+  }
+
   if (q.includes("bank holiday") || q.includes("bank holidays")){
     return { html:"❌ <b>No we are not open on bank holidays.</b>", chips:["What are your opening times?","Is anyone available now?"] };
   }
@@
   if (q.includes("closest depot") || q.includes("how far") || q.includes("distance")){
     distanceCtx = { stage:"needOrigin" };
     return { html:"What town/city are you travelling from? (Or choose <b>Use my location</b>.)", chips:["Use my location","Coventry","Birmingham","Leicester","London"] };
   }
@@
   if (q.includes("where are you") || q.includes("location") || q.includes("address")){
     const d = DEPOTS.nuneaton;
     const tile = osmTileURL(d.lat, d.lon, 13);
     const gmaps = `https://www.google.com/maps?q=${encodeURIComponent(d.lat + "," + d.lon)}`;
     return { html:`We’re based in <b>Nuneaton, UK</b>.<br>${linkTag(gmaps,"Open in Google Maps")}<br>${imgTag(tile)}` };
   }
 
+  // ---------- New: Topics triggers
+  // WORK ALLOCATION
+  if (q === "work allocation") {
+    flowCtx = { type:"workAllocation", stage:"askRaised" };
+    return { html: "Has this been raised with your <b>Field</b> and <b>Area Manager</b>?", chips: ["Yes","No"] };
+  }
+
+  // MANAGER DISPUTE
+  if (q === "manager dispute" || q === "manager disputes") {
+    flowCtx = { type:"managerDispute", stage:"askFieldManager" };
+    return { html: "Is this regarding your <b>Field Manager</b>?", chips: ["Yes","No"] };
+  }
+
+  // DEPARTMENT CONTACTS
+  if (q === "department contacts") {
+    flowCtx = { type:"deptContacts", stage:"chooseDept" };
+    return {
+      html: "Pick a department:",
+      chips: ["Street Works","Smart Awards","Support Team","City Fibre Back Office","BTOR Allocations Team","Fleet","Accident Line","Parking Line","Recruitment","BTOR NTF Support","City Fibre NTF Support"]
+    };
+  }
+
+  // CONTRACT CHANGE QUERIES
+  if (q === "contract change queries" || q === "contract change" || q === "contract changes") {
+    return { html: "For any <b>contract change</b> queries, please raise this to your <b>Area Manager</b>." };
+  }
+
+  // EQUIPMENT QUERY
+  if (q === "equipment query" || q === "equipment") {
+    flowCtx = { type:"equipment", stage:"start" };
+    return { html: "Is this regarding <b>Stock</b>, <b>Tooling</b> or a <b>Van</b>?", chips: ["Stock","Tooling","Van"] };
+  }
+
+  // STREET WORKS (standalone)
+  if (q === "street works" || q === "streetworks") {
+    return { html: `For any Street Works queries please contact ${linkTag("mailto:Street.Works@kelly.co.uk","Street.Works@kelly.co.uk")}.` };
+  }
+
+  // SMART AWARDS (standalone)
+  if (q === "smart awards" || q === "smart award") {
+    return { html: `For any Smart Awards queries please contact ${linkTag("mailto:smartawards@kelly.co.uk","smartawards@kelly.co.uk")}.` };
+  }
+
+  // ID CARDS
+  if (q === "id cards" || q === "id card" || q === "id") {
+    return { html: `If you have <b>lost</b>, <b>not received</b>, or your ID card has <b>expired</b>, please contact ${linkTag("mailto:nuneaton.admin@kelly.co.uk","nuneaton.admin@kelly.co.uk")}.` };
+  }
+
+  // PAY / PAYROLL
+  if (q === "pay" || q === "pay payroll" || q === "payroll") {
+    const smsNum = SETTINGS.paySmsNumber?.trim();
+    const intro = `For any <b>pay</b> queries please call ${telLink("02037583060","02037583060")} and select <b>option 1</b>.`;
+    const smsNote = smsNum
+      ? `<br>Or send a text using your messaging app: ${linkTag(smsHref(smsNum, "Pay query from Welfare Support chatbot"), "Send a text")}.`
+      : "";
+    const tip = `<br><small>(Per Friday meeting 13/02, the ticket system is <b>not</b> used for pay queries.)</small>`;
+    return { html: intro + smsNote + tip, chips: ["Deductions","Department Contacts"] };
+  }
+
+  // DEDUCTIONS
+  if (q === "deductions" || q === "deduction") {
+    const smsNum = SETTINGS.paySmsNumber?.trim();
+    const intro = `For any <b>deduction</b> queries please call ${telLink("02037583060","02037583060")} and select <b>option 1</b>.`;
+    const smsNote = smsNum
+      ? `<br>Or send a text using your messaging app: ${linkTag(smsHref(smsNum, "Deduction query from Welfare Support chatbot"), "Send a text")}.`
+      : "";
+    const tip = `<br><small>(Per Friday meeting 13/02, the ticket system is <b>not</b> used for deduction queries.)</small>`;
+    return { html: intro + smsNote + tip, chips: ["Pay / Payroll","Department Contacts"] };
+  }
+
   return null;
 }
@@
 clearBtn.addEventListener("click", () =>{
   chatWindow.innerHTML="";
   ticketCtx=null;
   distanceCtx=null;
+  flowCtx=null;
   CHAT_LOG=[];
   init();
 });
``
