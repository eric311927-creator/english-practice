// English Practice — App logic
// Auth: Firebase Google Sign-In (syncs progress across phone & computer)
// Data: Firestore doc at /users/{uid} holds { srs, lastSeen, stats }
// srs[id] = { reps, interval(days), nextReview(ms timestamp), lapses }
// Spaced repetition: each correct answer in a row grows the interval along
// SCHEDULE_DAYS; any wrong answer resets reps to 0 and brings the item due
// again immediately (lapses is a lifetime "ever got this wrong" counter,
// independent of the current streak, used for the "frequently missed" view).

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

/* ---------------- Spaced repetition config ---------------- */
const SCHEDULE_DAYS = [1, 3, 7, 14, 30, 60];
const MASTERY_REPS = 4; // reps>=4 means interval>=14 days: "mastered"
const DAY_MS = 24 * 60 * 60 * 1000;

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
let screen = "home"; // home | question | summary | mistakes | dashboard
let currentFilter = null; // null = all, or {kind:'type'|'cat', value:string}

function defaultData(){
  return {
    srs: {},
    lastSeen: {},
    stats: {
      totalAnswered: 0, totalCorrect: 0, sessionsCompleted: 0,
      byType: { vocab:{answered:0,correct:0}, phrase:{answered:0,correct:0}, grammar:{answered:0,correct:0} },
      byCat: { daily:{answered:0,correct:0}, travel:{answered:0,correct:0} }
    }
  };
}

// Upgrades older saved documents (pre-spaced-repetition format) into the
// current shape so existing users don't lose their progress.
function migrateData(raw){
  if(raw && raw.srs){
    raw.stats = raw.stats || {};
    raw.stats.byType = raw.stats.byType || { vocab:{answered:0,correct:0}, phrase:{answered:0,correct:0}, grammar:{answered:0,correct:0} };
    raw.stats.byCat = raw.stats.byCat || { daily:{answered:0,correct:0}, travel:{answered:0,correct:0} };
    raw.lastSeen = raw.lastSeen || {};
    return raw;
  }
  const now = Date.now();
  const srs = {};
  const wrongMap = (raw && raw.wrongMap) || {};
  const lastSeen = (raw && raw.lastSeen) || {};
  Object.keys(wrongMap).forEach(id => {
    srs[id] = { reps:0, interval:0, nextReview: now, lapses: wrongMap[id].count || 1 };
  });
  Object.keys(lastSeen).forEach(id => {
    if(!srs[id]) srs[id] = { reps:1, interval:3, nextReview: now, lapses:0 };
  });
  const oldStats = (raw && raw.stats) || {};
  return {
    srs,
    lastSeen,
    stats: {
      totalAnswered: oldStats.totalAnswered || 0,
      totalCorrect: oldStats.totalCorrect || 0,
      sessionsCompleted: oldStats.sessionsCompleted || 0,
      byType: { vocab:{answered:0,correct:0}, phrase:{answered:0,correct:0}, grammar:{answered:0,correct:0} },
      byCat: { daily:{answered:0,correct:0}, travel:{answered:0,correct:0} }
    }
  };
}

async function loadData(uid){
  try{
    const snap = await getDoc(doc(db, "users", uid));
    if(snap.exists()) return migrateData(snap.data());
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

/* ---------------- Helpers ---------------- */
function shuffle(arr){
  const a = arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

function matchesFilter(q, filter){
  if(!filter) return true;
  if(filter.kind === "type") return q.type === filter.value;
  if(filter.kind === "cat") return q.cat === filter.value;
  if(filter.kind === "review") return !!(DATA.srs[q.id] && DATA.srs[q.id].lapses > 0);
  return true;
}

function poolFor(filter){
  return filter ? QUESTIONS.filter(q => matchesFilter(q, filter)) : QUESTIONS;
}

function srsStatus(s){
  const now = Date.now();
  if(!s) return "new";
  if(s.nextReview <= now) return "due";
  if(s.reps >= MASTERY_REPS) return "mastered";
  return "learning";
}

/* ---------------- Stats / overview ---------------- */
function computeOverview(){
  const now = Date.now();
  const srsIds = Object.keys(DATA.srs).map(Number);
  const dueCount = srsIds.filter(id => DATA.srs[id].nextReview <= now).length;
  const masteredCount = srsIds.filter(id => DATA.srs[id].reps >= MASTERY_REPS).length;
  const newCount = QUESTIONS.length - srsIds.length;
  return { total: QUESTIONS.length, dueCount, masteredCount, newCount, touched: srsIds.length };
}

function computeBreakdown(){
  const typeMeta = [
    {key:"grammar", label:"文法"},
    {key:"phrase", label:"片語"},
    {key:"vocab", label:"單字"}
  ];
  const catMeta = [
    {key:"daily", label:"日常生活"},
    {key:"travel", label:"旅行"}
  ];
  function row(key, label, getter){
    const qs = QUESTIONS.filter(getter);
    const total = qs.length;
    const mastered = qs.filter(q => DATA.srs[q.id] && DATA.srs[q.id].reps >= MASTERY_REPS).length;
    const stat = (key === "daily" || key === "travel") ? DATA.stats.byCat[key] : DATA.stats.byType[key];
    const answered = stat ? stat.answered : 0;
    const correct = stat ? stat.correct : 0;
    const accuracy = answered > 0 ? Math.round((correct / answered) * 100) : null;
    return { key, label, total, mastered, answered, accuracy };
  }
  return {
    byType: typeMeta.map(t => row(t.key, t.label, q => q.type === t.key)),
    byCat: catMeta.map(c => row(c.key, c.label, q => q.cat === c.key))
  };
}

/* ---------------- Question set builder ---------------- */
function buildSet(filter){
  const now = Date.now();
  const pool = poolFor(filter);

  // ── Review-only mode ──────────────────────────────────────────────────────
  // Pull up to 10 questions the user has ever answered wrong, sorted by
  // most lapses first (most-troubled questions come first). Options are
  // freshly shuffled on every call so the answer position is always different
  // from what the user may have memorised.
  if(filter && filter.kind === "review"){
    const lapsed = pool
      .filter(q => DATA.srs[q.id] && DATA.srs[q.id].lapses > 0)
      .sort((a,b) =>
        (DATA.srs[b.id].lapses - DATA.srs[a.id].lapses) ||
        (DATA.srs[a.id].nextReview - DATA.srs[b.id].nextReview)
      );
    // Pick from top-20 most-troubled and shuffle the selection so consecutive
    // review sessions don't always start with the same question.
    const picks = shuffle(lapsed.slice(0, Math.min(lapsed.length, 20))).slice(0, 10);
    return picks.map(q => {
      const options = shuffle([q.correct, ...q.distractors]);
      return {...q, options, correctIndex: options.indexOf(q.correct), isReview: true};
    });
  }
  // ─────────────────────────────────────────────────────────────────────────
  const poolIds = new Set(pool.map(q => q.id));

  let dueIds = Object.keys(DATA.srs)
    .map(Number)
    .filter(id => poolIds.has(id) && DATA.srs[id].nextReview <= now)
    .sort((a,b) => DATA.srs[a].nextReview - DATA.srs[b].nextReview);

  const targetReview = dueIds.length === 0 ? 0 : Math.min(dueIds.length, (Math.random() < 0.5 ? 2 : 3));
  const reviewIds = dueIds.slice(0, targetReview);
  const reviewSet = new Set(reviewIds);

  let remaining = pool.filter(q => !reviewSet.has(q.id));
  remaining.sort((a,b) => (DATA.lastSeen[a.id]||0) - (DATA.lastSeen[b.id]||0));
  remaining = shuffle(remaining.slice(0, Math.min(remaining.length, 40)));
  const newCount = Math.max(0, 10 - reviewIds.length);
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
const FILTER_LABEL = {
  "all": "全部混合",
  "type:grammar": "文法",
  "type:phrase": "片語",
  "type:vocab": "單字",
  "cat:daily": "日常情境",
  "cat:travel": "旅行情境",
  "review:all": "錯題複習"
};

function renderLoading(msg){
  app.innerHTML = `<div class="loading">${msg}</div>`;
}

function renderLogin(){
  app.innerHTML = `
    <div class="masthead">
      <div class="eyebrow">Passport to English · 每日練習</div>
      <h1>英語練習登機證</h1>
      <p>登入後，你的練習紀錄與複習排程會同步到所有裝置。</p>
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

function renderHeader(subtitle){
  const notice = !storageOk
    ? `<div class="storage-notice">⚠ 雲端儲存暫時失敗${storageErrorMsg ? `（${storageErrorMsg}）` : ""}，這次的作答可能不會被記住，但練習仍可正常進行。</div>`
    : "";
  const who = currentUser ? (currentUser.displayName || currentUser.email || "") : "";
  return `
    <div class="masthead">
      <div class="eyebrow">Passport to English · 每日練習</div>
      <h1>英語練習登機證</h1>
      <p>${subtitle}</p>
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

function renderHome(){
  const ov = computeOverview();
  const hasLapses = Object.values(DATA.srs).some(s => s.lapses > 0);
  const lapsedCount = Object.values(DATA.srs).filter(s => s.lapses > 0).length;
  const cats = [
    {key:"all", label:"全部混合", sub:`${QUESTIONS.length} 題`, full:true},
    {key:"type:grammar", label:"文法", sub:`${QUESTIONS.filter(q=>q.type==="grammar").length} 題`},
    {key:"type:phrase", label:"片語", sub:`${QUESTIONS.filter(q=>q.type==="phrase").length} 題`},
    {key:"type:vocab", label:"單字", sub:`${QUESTIONS.filter(q=>q.type==="vocab").length} 題`},
    {key:"cat:daily", label:"日常情境", sub:`${QUESTIONS.filter(q=>q.cat==="daily").length} 題`},
    {key:"cat:travel", label:"旅行情境", sub:`${QUESTIONS.filter(q=>q.cat==="travel").length} 題`}
  ];
  const gridHtml = cats.map(c => `
    <button class="cat-btn${c.full ? " full" : ""}" data-cat="${c.key}">
      ${c.label}
      <span class="cat-sub">${c.sub}</span>
    </button>
  `).join("");

  return `
    ${renderHeader("選一個類別開始練習，或查看學習儀表板。")}
    <div class="pass-card">
      <div class="pass-top" style="padding-bottom:10px;">
        <div class="stat-row">
          <div class="stat-box"><div class="stat-num">${ov.dueCount}</div><div class="stat-label">待複習</div></div>
          <div class="stat-box"><div class="stat-num">${ov.masteredCount}</div><div class="stat-label">已熟練</div></div>
          <div class="stat-box"><div class="stat-num">${ov.newCount}</div><div class="stat-label">未練習</div></div>
        </div>
      </div>
      <div class="perforation"><div class="notch left"></div><div class="notch right"></div></div>
      <div class="pass-bottom">
        <div class="cat-grid">${gridHtml}</div>
        ${lapsedCount > 0 ? `
        <button class="cat-btn review-btn" data-cat="review:all">
          錯題複習
          <span class="cat-sub">${lapsedCount} 題曾答錯 · 選項每次重新排列</span>
        </button>` : ""}
        <button class="ghost-btn" id="dashboardBtn">查看學習儀表板</button>
        ${hasLapses ? `<button class="ghost-btn" id="viewMistakesBtn">查看常錯題目</button>` : ""}
      </div>
    </div>
  `;
}

function renderQuestionScreen(){
  const q = currentSet[idx];
  const catLabel = q.cat === "daily" ? "DAILY LIFE" : "TRAVEL";
  const catClass = q.cat === "daily" ? "daily" : "travel";
  const typeLabel = TYPE_LABEL[q.type] || "";
  const questionHtml = q.text.replace("___", '<span class="blank-mark">___</span>');
  const reviewCount = currentSet.filter(x=>x.isReview).length;
  const filterLabel = FILTER_LABEL[currentFilter ? `${currentFilter.kind}:${currentFilter.value}` : "all"];

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
    ${renderHeader(`${filterLabel}練習。${reviewCount > 0 ? `本組已自動加入 ${reviewCount} 題複習題。` : ""}`)}
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
  const hasLapses = Object.values(DATA.srs).some(s => s.lapses > 0);

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
    ${renderHeader("本回合結果")}
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
        <button class="next-btn" id="newSetBtn">再來一組（${FILTER_LABEL[currentFilter ? `${currentFilter.kind}:${currentFilter.value}` : "all"]}）</button>
        <button class="ghost-btn" id="backHomeBtn">返回首頁</button>
        ${hasLapses ? `<button class="ghost-btn" id="viewMistakesBtn">查看常錯題目</button>` : ""}
      </div>
    </div>
  `;
}

function srsStatusLabel(s){
  const now = Date.now();
  if(s.nextReview <= now) return "待複習";
  if(s.reps >= MASTERY_REPS) return `已熟練 · ${Math.ceil((s.nextReview-now)/DAY_MS)} 天後再複習`;
  return `複習中 · ${Math.ceil((s.nextReview-now)/DAY_MS)} 天後複習`;
}

function renderMistakesScreen(){
  const entries = Object.entries(DATA.srs)
    .filter(([, v]) => v.lapses > 0)
    .sort((a,b) => b[1].lapses - a[1].lapses || a[1].nextReview - b[1].nextReview);

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
            <span class="tag review">錯 ${info.lapses} 次</span>
          </div>
          <div class="mi-q">${q.text.replace("___","____")}</div>
          <div class="mi-a">正確答案：${q.correct}</div>
          <div class="mi-ex">${q.ex}</div>
          <div class="mi-status">${srsStatusLabel(info)}</div>
        </div>`;
    });
  }

  return `
    ${renderHeader("依答錯次數排序，這些題目會優先被排進複習。")}
    <div class="pass-card">
      <div class="pass-top" style="padding-bottom:8px;">
        <div class="summary-title">常錯題目</div>
        <div class="summary-sub">共 ${entries.length} 題曾經答錯過</div>
      </div>
      <div class="perforation"><div class="notch left"></div><div class="notch right"></div></div>
      <div class="pass-bottom">
        ${listHtml}
        <button class="next-btn" id="backHomeBtn">返回首頁</button>
      </div>
    </div>
  `;
}

function renderDashboard(){
  const ov = computeOverview();
  const { byType, byCat } = computeBreakdown();
  const overallAcc = DATA.stats.totalAnswered > 0
    ? Math.round((DATA.stats.totalCorrect / DATA.stats.totalAnswered) * 100)
    : 0;

  function barRow(item){
    const pct = item.total > 0 ? Math.round((item.mastered / item.total) * 100) : 0;
    const accText = item.accuracy === null ? "尚無作答紀錄" : `正確率 ${item.accuracy}%（已作答 ${item.answered} 次）`;
    return `
      <div class="bar-row">
        <div class="bar-label"><span>${item.label}</span><span>${item.mastered}/${item.total} 已熟練</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <div class="bar-sub">${accText}</div>
      </div>`;
  }

  return `
    ${renderHeader("依題型與情境查看你的學習進度。")}
    <div class="pass-card">
      <div class="pass-top" style="padding-bottom:10px;">
        <div class="stat-row">
          <div class="stat-box"><div class="stat-num">${overallAcc}%</div><div class="stat-label">整體正確率</div></div>
          <div class="stat-box"><div class="stat-num">${ov.masteredCount}</div><div class="stat-label">已熟練</div></div>
          <div class="stat-box"><div class="stat-num">${DATA.stats.totalAnswered}</div><div class="stat-label">總作答次數</div></div>
        </div>
      </div>
      <div class="perforation"><div class="notch left"></div><div class="notch right"></div></div>
      <div class="pass-bottom">
        <div class="dash-section-title">依題型</div>
        ${byType.map(barRow).join("")}
        <div class="dash-section-title">依情境</div>
        ${byCat.map(barRow).join("")}
        <button class="next-btn" id="backHomeBtn">返回首頁</button>
      </div>
    </div>
  `;
}

function attachCommon(){
  const logoutBtn = document.getElementById("logoutBtn");
  if(logoutBtn) logoutBtn.addEventListener("click", handleLogout);
  const backHomeBtn = document.getElementById("backHomeBtn");
  if(backHomeBtn) backHomeBtn.addEventListener("click", () => { screen = "home"; render(); });
  const viewMistakesBtn = document.getElementById("viewMistakesBtn");
  if(viewMistakesBtn) viewMistakesBtn.addEventListener("click", () => { screen = "mistakes"; render(); });
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

  if(screen === "home"){
    app.innerHTML = renderHome();
    app.querySelectorAll(".cat-btn").forEach(btn => btn.addEventListener("click", onPickCategory));
    const dashboardBtn = document.getElementById("dashboardBtn");
    if(dashboardBtn) dashboardBtn.addEventListener("click", () => { screen = "dashboard"; render(); });
  } else if(screen === "question"){
    app.innerHTML = renderQuestionScreen();
    if(!answeredState){
      app.querySelectorAll(".option-btn").forEach(btn => btn.addEventListener("click", onSelectOption));
    } else {
      document.getElementById("nextBtn").addEventListener("click", onNext);
    }
  } else if(screen === "summary"){
    app.innerHTML = renderSummaryScreen();
    document.getElementById("newSetBtn").addEventListener("click", () => startNewSet(currentFilter));
  } else if(screen === "mistakes"){
    app.innerHTML = renderMistakesScreen();
  } else if(screen === "dashboard"){
    app.innerHTML = renderDashboard();
  }
  attachCommon();
}

/* ---------------- Interaction ---------------- */
function onPickCategory(e){
  const raw = e.currentTarget.dataset.cat;
  let filter = null;
  if(raw !== "all"){
    const [kind, value] = raw.split(":");
    filter = { kind, value };
  }
  startNewSet(filter);
}

async function onSelectOption(e){
  const i = Number(e.currentTarget.dataset.idx);
  const q = currentSet[idx];
  const correct = i === q.correctIndex;
  answeredState = {selected:i, correct};

  const now = Date.now();
  DATA.lastSeen[q.id] = now;
  DATA.stats.totalAnswered += 1;

  if(!DATA.stats.byType[q.type]) DATA.stats.byType[q.type] = {answered:0, correct:0};
  if(!DATA.stats.byCat[q.cat]) DATA.stats.byCat[q.cat] = {answered:0, correct:0};
  DATA.stats.byType[q.type].answered += 1;
  DATA.stats.byCat[q.cat].answered += 1;

  const prevSrs = DATA.srs[q.id] || {reps:0, interval:0, nextReview:0, lapses:0};

  if(correct){
    DATA.stats.totalCorrect += 1;
    DATA.stats.byType[q.type].correct += 1;
    DATA.stats.byCat[q.cat].correct += 1;
    const reps = prevSrs.reps + 1;
    const interval = SCHEDULE_DAYS[Math.min(reps - 1, SCHEDULE_DAYS.length - 1)];
    DATA.srs[q.id] = { reps, interval, nextReview: now + interval * DAY_MS, lapses: prevSrs.lapses || 0 };
  } else {
    DATA.srs[q.id] = { reps: 0, interval: 0, nextReview: now, lapses: (prevSrs.lapses || 0) + 1 };
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
  if(idx >= currentSet.length) screen = "summary";
  render();
}

async function startNewSet(filter){
  currentFilter = filter !== undefined ? filter : currentFilter;
  idx = 0;
  answeredState = null;
  roundResults = [];
  DATA.stats.sessionsCompleted += 1;
  currentSet = buildSet(currentFilter);
  screen = "question";
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
    screen = "home";
    render();
  } else {
    DATA = null;
    render();
  }
});

render();
