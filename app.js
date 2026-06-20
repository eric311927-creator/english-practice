// English Practice — App logic
// Auth: Firebase Google Sign-In (syncs progress across phone & computer)
// Data: Firestore doc at /users/{uid} holds { wrongMap, lastSeen, stats }

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  getRedirectResult, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

import { firebaseConfig } from "./firebase-config.js";
import { QUESTIONS } from "./questions.js";

/* ---------------- Firebase setup ---------------- */
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
const provider = new GoogleAuthProvider();

/* ---------------- State ---------------- */
let currentUser = null;
let DATA = null;
let currentSet = [];
let idx = 0;
let answeredState = null;
let roundResults = [];
let storageOk = true;
let storageErrorMsg = null;
let loginError = null;
let authReady = false;
let showMistakesView = false;

function defaultData(){
  return { wrongMap:{}, lastSeen:{}, stats:{totalAnswered:0,totalCorrect:0,sessionsCompleted:0} };
}

async function loadData(uid){
  try{
    const snap = await getDoc(doc(db, "users", uid));
    if(snap.exists()){
      const d = snap.data();
      return {
        wrongMap: d.wrongMap || {},
        lastSeen: d.lastSeen || {},
        stats: d.stats || {totalAnswered:0,totalCorrect:0,sessionsCompleted:0}
      };
    }
  }catch(e){ /* first-time user, doc doesn't exist yet */ }
  return defaultData();
}

async function saveData(data){
  if(!currentUser) return;
  try{
    await setDoc(doc(db, "users", currentUser.uid), data);
    storageOk = true;
    storageErrorMsg = null;
  }catch(e){
    storageOk = false;
    storageErrorMsg = (e && (e.code || e.message)) ? (e.code || e.message) : String(e);
  }
}

/* ---------------- Question set builder ---------------- */
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function buildSet(){
  const wrongIds = Object.keys(DATA.wrongMap).filter(id => DATA.wrongMap[id].count > 0);
  wrongIds.sort((a,b) => {
    const cb = DATA.wrongMap[b].count - DATA.wrongMap[a].count;
    if(cb !== 0) return cb;
    return (DATA.lastSeen[a]||0) - (DATA.lastSeen[b]||0);
  });
  const targetReview = wrongIds.length === 0 ? 0 : Math.min(wrongIds.length, (Math.random() < 0.5 ? 2 : 3));
  const reviewIds = wrongIds.slice(0, targetReview).map(Number);
  const reviewSet = new Set(reviewIds);

  let remaining = QUESTIONS.filter(q => !reviewSet.has(q.id));
  remaining.sort((a,b) => (DATA.lastSeen[a.id]||0) - (DATA.lastSeen[b.id]||0));
  remaining = shuffle(remaining.slice(0, Math.min(remaining.length, 40)));
  const newCount = 10 - reviewIds.length;
  const newPicks = remaining.slice(0, newCount);

  let finalQs = [
    ...reviewIds.map(id => ({...QUESTIONS.find(q=>q.id===id), isReview:true})),
    ...newPicks.map(q => ({...q, isReview:false}))
  ];
  finalQs = shuffle(finalQs);

  finalQs = finalQs.map(q => {
    const options = shuffle([q.correct, ...q.distractors]);
    return {...q, options, correctIndex: options.indexOf(q.correct)};
  });

  return finalQs;
}

/* ---------------- Render ---------------- */
const app = document.getElementById("app");
const TYPE_LABEL = { vocab: "VOCAB", phrase: "PHRASE", grammar: "GRAMMAR" };

function renderLoading(msg){
  app.innerHTML = `<div class="loading">${msg}</div>`;
}

function renderLogin(){
  app.innerHTML = `
    <div class="masthead">
      <div class="eyebrow">Passport to English · 每日練習</div>
      <h1>英語練習登機證</h1>
      <p>登入後，你的練習紀錄與錯題複習進度會同步到所有裝置。</p>
    </div>
    <div class="pass-card">
      <div class="pass-top" style="text-align:center; padding-bottom:24px;">
        <div class="stamp" style="margin-top:10px;">
          <div class="score-num" style="font-size:1.1rem;">PASS</div>
          <div class="score-den">REQUIRED</div>
        </div>
        <div class="summary-title">請先登入</div>
        <div class="summary-sub">用 Google 帳號一鍵登入，開始今天的練習</div>
        ${loginError ? `<div class="feedback bad" style="margin-top:14px; text-align:left;">${loginError}</div>` : ""}
        <button class="next-btn" id="loginBtn" style="margin-top:18px;">使用 Google 登入</button>
      </div>
    </div>
  `;
  document.getElementById("loginBtn").addEventListener("click", handleLogin);
}

function renderHeader(reviewCount){
  const notice = !storageOk
    ? `<div class="storage-notice">⚠ 雲端儲存暫時失敗${storageErrorMsg ? `（${storageErrorMsg}）` : ""}，這次的作答可能不會被記住，但練習仍可正常進行。</div>`
    : "";
  const who = currentUser ? (currentUser.displayName || currentUser.email || "") : "";
  return `
    <div class="masthead">
      <div class="eyebrow">Passport to English · 每日練習</div>
      <h1>英語練習登機證</h1>
      <p>日常生活 + 旅行情境，混合單字、片語與文法。${reviewCount > 0 ? `本組已自動加入 ${reviewCount} 題複習題。` : ""}</p>
      ${notice}
    </div>
    <div class="user-row">
      <span>${who}</span>
      <button class="logout-link" id="logoutBtn">登出</button>
    </div>
  `;
}

function renderProgress(){
  let dots = "";
  for(let i=0;i<currentSet.length;i++){
    let cls = "dot";
    if(i === idx && answeredState === null) cls += " current";
    const result = roundResults[i];
    if(result) cls += result.isCorrect ? " correct" : " wrong";
    dots += `<div class="${cls}" title="${currentSet[i].isReview ? "複習題" : "新題"}">${i+1}</div>`;
  }
  return `<div class="progress-row">${dots}</div>`;
}

function renderQuestionScreen(){
  const q = currentSet[idx];
  const catLabel = q.cat === "daily" ? "DAILY LIFE" : "TRAVEL";
  const catClass = q.cat === "daily" ? "daily" : "travel";
  const typeLabel = TYPE_LABEL[q.type] || "";
  const questionHtml = q.text.replace("___", '<span class="blank-mark">___</span>');

  let optionsHtml = "";
  q.options.forEach((opt, i) => {
    let cls = "option-btn";
    let disabled = "";
    if(answeredState){
      disabled = "disabled";
      if(i === q.correctIndex) cls += " is-correct";
      else if(i === answeredState.selected) cls += " is-wrong";
      cls += " is-disabled";
    }
    optionsHtml += `
      <button class="${cls}" data-idx="${i}" ${disabled}>
        <span class="option-letter">${String.fromCharCode(65+i)}</span>
        <span>${opt}</span>
      </button>
    `;
  });

  let feedbackHtml = "";
  if(answeredState){
    if(answeredState.correct){
      feedbackHtml = `<div class="feedback ok"><div class="fb-head">答對了</div>${q.ex}</div>`;
    } else {
      feedbackHtml = `<div class="feedback bad"><div class="fb-head">正確答案：${q.correct}</div>${q.ex}</div>`;
    }
    feedbackHtml += `<button class="next-btn" id="nextBtn">${idx === currentSet.length-1 ? "查看結果" : "下一題"}</button>`;
  }

  return `
    ${renderHeader(currentSet.filter(x=>x.isReview).length)}
    ${renderProgress()}
    <div class="pass-card">
      <div class="pass-top">
        <div class="pass-row">
          <div>
            <span class="tag ${catClass}">${catLabel}</span>
            <span class="tag type-tag">${typeLabel}</span>
            ${q.isReview ? '<span class="tag review">複習</span>' : ""}
          </div>
          <div class="flight-no">NO. ${String(idx+1).padStart(2,"0")} / ${currentSet.length}</div>
        </div>
        <div class="question-text">${questionHtml}</div>
      </div>
      <div class="perforation"><div class="notch left"></div><div class="notch right"></div></div>
      <div class="pass-bottom">
        ${optionsHtml}
        ${feedbackHtml}
      </div>
    </div>
  `;
}

function renderSummaryScreen(){
  const correctCount = roundResults.filter(r=>r.isCorrect).length;
  const mistakes = roundResults.filter(r=>!r.isCorrect);
  const poolRemaining = Object.keys(DATA.wrongMap).filter(id => DATA.wrongMap[id].count > 0).length;

  let mistakesHtml = "";
  if(mistakes.length === 0){
    mistakesHtml = `<div class="all-correct">這組全對，太厲害了！</div>`;
  } else {
    mistakes.forEach(m => {
      mistakesHtml += `
        <div class="mistake-item">
          <div class="mi-q">${m.text.replace("___","____")}</div>
          <div class="mi-a">正確答案：${m.correctAnswer}</div>
          <div class="mi-ex">${m.ex}</div>
        </div>`;
    });
  }

  return `
    ${renderHeader(0)}
    <div class="pass-card">
      <div class="pass-top" style="padding-bottom:8px;">
        <div class="stamp">
          <div class="score-num">${correctCount}/${currentSet.length}</div>
          <div class="score-den">CLEARED</div>
        </div>
        <div class="summary-title">本回合結果</div>
        <div class="summary-sub">答對 ${correctCount} 題，答錯 ${currentSet.length-correctCount} 題</div>
      </div>
      <div class="perforation"><div class="notch left"></div><div class="notch right"></div></div>
      <div class="pass-bottom">
        ${mistakesHtml}
        <div class="pool-note">複習庫目前還有 ${poolRemaining} 題待加強 · 題庫共 ${QUESTIONS.length} 題</div>
        <button class="next-btn" id="newSetBtn">再來一組</button>
        ${poolRemaining > 0 ? `<button class="ghost-btn" id="viewMistakesBtn">查看常錯題目（${poolRemaining}）</button>` : ""}
      </div>
    </div>
  `;
}

function renderMistakesScreen(){
  const entries = Object.entries(DATA.wrongMap)
    .filter(([, v]) => v.count > 0)
    .sort((a,b) => b[1].count - a[1].count || (b[1].lastWrong||0) - (a[1].lastWrong||0));

  let listHtml = "";
  if(entries.length === 0){
    listHtml = `<div class="all-correct">目前沒有常錯題目，太棒了！</div>`;
  } else {
    entries.forEach(([id, info]) => {
      const q = QUESTIONS.find(x => x.id === Number(id));
      if(!q) return;
      const catLabel = q.cat === "daily" ? "DAILY LIFE" : "TRAVEL";
      const catClass = q.cat === "daily" ? "daily" : "travel";
      listHtml += `
        <div class="mistake-item">
          <div class="pass-row" style="margin-bottom:6px;">
            <div>
              <span class="tag ${catClass}">${catLabel}</span>
              <span class="tag type-tag">${TYPE_LABEL[q.type] || ""}</span>
            </div>
            <span class="tag review">錯 ${info.count} 次</span>
          </div>
          <div class="mi-q">${q.text.replace("___","____")}</div>
          <div class="mi-a">正確答案：${q.correct}</div>
          <div class="mi-ex">${q.ex}</div>
        </div>`;
    });
  }

  return `
    ${renderHeader(0)}
    <div class="pass-card">
      <div class="pass-top" style="padding-bottom:8px;">
        <div class="summary-title">常錯題目</div>
        <div class="summary-sub">依答錯次數排序，這些題目下次出題會優先被抽進複習</div>
      </div>
      <div class="perforation"><div class="notch left"></div><div class="notch right"></div></div>
      <div class="pass-bottom">
        ${listHtml}
        <button class="next-btn" id="backBtn">返回</button>
      </div>
    </div>
  `;
}

function render(){
  if(!authReady){
    renderLoading("登入狀態確認中…");
    return;
  }
  if(!currentUser){
    renderLogin();
    return;
  }
  if(!DATA){
    renderLoading("載入練習紀錄中…");
    return;
  }
  if(showMistakesView){
    app.innerHTML = renderMistakesScreen();
    document.getElementById("backBtn").addEventListener("click", () => { showMistakesView = false; render(); });
    const logoutBtn0 = document.getElementById("logoutBtn");
    if(logoutBtn0) logoutBtn0.addEventListener("click", handleLogout);
    return;
  }
  if(idx < currentSet.length){
    app.innerHTML = renderQuestionScreen();
    if(!answeredState){
      app.querySelectorAll(".option-btn").forEach(btn => btn.addEventListener("click", onSelectOption));
    } else {
      document.getElementById("nextBtn").addEventListener("click", onNext);
    }
  } else {
    app.innerHTML = renderSummaryScreen();
    document.getElementById("newSetBtn").addEventListener("click", startNewSet);
    const viewMistakesBtn = document.getElementById("viewMistakesBtn");
    if(viewMistakesBtn) viewMistakesBtn.addEventListener("click", () => { showMistakesView = true; render(); });
  }
  const logoutBtn = document.getElementById("logoutBtn");
  if(logoutBtn) logoutBtn.addEventListener("click", handleLogout);
}

/* ---------------- Interaction ---------------- */
async function onSelectOption(e){
  const i = Number(e.currentTarget.dataset.idx);
  const q = currentSet[idx];
  const correct = i === q.correctIndex;
  answeredState = {selected:i, correct};

  DATA.lastSeen[q.id] = Date.now();
  DATA.stats.totalAnswered += 1;
  if(correct){
    DATA.stats.totalCorrect += 1;
    if(DATA.wrongMap[q.id]) delete DATA.wrongMap[q.id];
  } else {
    const prev = DATA.wrongMap[q.id] || {count:0};
    DATA.wrongMap[q.id] = {count: prev.count + 1, lastWrong: Date.now()};
  }

  roundResults[idx] = {
    isCorrect: correct,
    text: q.text,
    ex: q.ex,
    correctAnswer: q.correct
  };
  render();
  await saveData(DATA);
  render();
}

function onNext(){
  answeredState = null;
  idx += 1;
  render();
}

async function startNewSet(){
  idx = 0;
  answeredState = null;
  roundResults = [];
  DATA.stats.sessionsCompleted += 1;
  currentSet = buildSet();
  render();
  await saveData(DATA);
  render();
}

/* ---------------- Auth ---------------- */
async function handleLogin(){
  loginError = null;
  try{
    await signInWithPopup(auth, provider);
  }catch(e){
    // Popup blocked (common on some mobile browsers) — fall back to redirect.
    if(e.code === "auth/popup-blocked" || e.code === "auth/cancelled-popup-request"){
      try{ await signInWithRedirect(auth, provider); }
      catch(e2){ loginError = "登入失敗：" + e2.message; render(); }
    } else {
      loginError = "登入失敗：" + e.message;
      render();
    }
  }
}

async function handleLogout(){
  await signOut(auth);
}

/* ---------------- Init ---------------- */
getRedirectResult(auth).catch(() => {});

onAuthStateChanged(auth, async (user) => {
  authReady = true;
  currentUser = user;
  if(user){
    render();
    DATA = await loadData(user.uid);
    currentSet = buildSet();
    idx = 0;
    answeredState = null;
    roundResults = [];
    render();
  } else {
    DATA = null;
    render();
  }
});

render();
