# 英語練習登機證 (English Practice — Boarding Pass)

手機 / 電腦皆可用的英語練習網站。Google 登入後，作答紀錄與錯題複習進度會同步存到 Firebase，換裝置也不會掉資料。

目前題庫：**500 題**（單字 / 片語 / 文法，日常生活 + 旅行情境）。

---

## 檔案說明

| 檔案 | 用途 |
|---|---|
| `index.html` | 網站入口 |
| `styles.css` | 視覺樣式（登機證主題） |
| `app.js` | 主程式邏輯（登入、出題、複習機制、Firestore 讀寫） |
| `questions.js` | 題庫資料，**之後要加題目就改這個檔案** |
| `firebase-config.js` | 你的 Firebase 專案連線設定（需要你自己填） |
| `firestore.rules` | 資料庫安全規則（限制只有本人能讀寫自己的資料） |

---

## Step 1 — 建立 Firebase 專案（約 5 分鐘）

1. 前往 https://console.firebase.google.com ，用你的 Google 帳號登入
2. 「新增專案」→ 取名，例如 `english-practice` → 可以關閉 Google Analytics（不需要）
3. 左側選單 **Build → Authentication** → 「開始使用」→ 選 **Sign-in method** 分頁 → 啟用 **Google**
4. 左側選單 **Build → Firestore Database** → 「建立資料庫」→ 選「以**正式版模式**啟動」→ 地區選 `asia-east1`（離台灣最近）
5. 進入 Firestore 的 **規則 (Rules)** 分頁，把 `firestore.rules` 這個檔案的內容整段貼上去，蓋掉原本的內容，按「發布」
6. 左上角齒輪圖示「專案設定」→ 往下捲到「您的應用程式」→ 點 `</>` 網頁圖示 → 應用程式暱稱隨便填 → 註冊後會出現一段 `firebaseConfig = {...}`，把整個物件複製起來，貼到 `firebase-config.js` 對應的欄位裡（取代裡面的 `YOUR_API_KEY` 等預留字）

---

## Step 2 — 推上 GitHub，開啟 GitHub Pages

在你電腦上開一個新資料夾，把這 6 個檔案放進去，然後：

```bash
cd english-practice
git init
git add .
git commit -m "first version: 150 questions + firebase sync"
git branch -M main
git remote add origin https://github.com/你的帳號/english-practice.git
git push -u origin main
```

（沒有這個 repo 的話，先在 GitHub 網頁上「New repository」建立一個空的 `english-practice`，不要勾選自動產生 README，再執行上面的指令）

接著到 GitHub 該 repo 的 **Settings → Pages**：
- Source 選 `Deploy from a branch`
- Branch 選 `main` / `(root)`
- 存檔後等 1–2 分鐘，網址會是：
  `https://你的帳號.github.io/english-practice/`

---

## Step 3 — 把 GitHub Pages 網址加進 Firebase 授權名單（重要，不做這步登入會失敗）

回到 Firebase Console → **Authentication → Settings → Authorized domains** → 「新增網域」，把
`你的帳號.github.io`
加進去（不用加 https:// 也不用加路徑）。

完成後，打開你的網站網址，應該就能看到「使用 Google 登入」畫面了。

---

## 之後怎麼加題目（往 500 題擴充）

打開 `questions.js`，在陣列最後面照格式加新物件就好，記得 `id` 不能重複：

```js
{id:151, type:"grammar", cat:"daily", text:"...", correct:"...", distractors:["...","...","..."], ex:"中文解說"},
```

- `type`：`"vocab"` | `"phrase"` | `"grammar"`
- `cat`：`"daily"` | `"travel"`
- `text` 用 `___` 標記要填空的地方
- `distractors` 一定要 3 個，且不能跟 `correct` 重複

改完存檔、`git add . && git commit -m "add more questions" && git push`，GitHub Pages 會自動重新部署，不用做別的事。

如果想要某個主題加強（例如機場安檢用語、餐廳點餐、警務相關英文），跟我說一聲，我可以針對性地補進去。
