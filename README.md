# SpeakPrep · 英文口說練習教練

一個純前端的網頁 App（PWA），用來練習**訪談提問、會議討論**等情境的英文口說。
沉浸式全英文練習，卡住時可以用中文求救；每場練習結束會給你**全英文的詳細回饋**。

- **AI 大腦**：Google Gemini（免費額度）
- **語音**：手機／瀏覽器內建的語音辨識與朗讀（Web Speech API）
- **費用**：$0（Gemini 免費額度 + GitHub Pages 免費部署）
- **無後端**：金鑰與紀錄只存在你自己的瀏覽器，不會上傳到任何伺服器

---

## 功能

- 兩大情境類別：**工作**（策略投資／訪談標的／談合作／內部討論，含光通訊、散熱、晶片、封裝、先進封裝、半導體材料、AI、硬體組裝、消費性電子、醫療 CDMO 等領域）與**旅遊生活**。
- 兩個練習模組：**主動提問（Asking Questions）**、**會議討論（Meeting Discussion）**。
- 難度可選（Easy / Medium / Hard），也能貼「自訂背景」讓 AI 依情況出題。
- **中文求救（Rescue mode）**：對話中用中文提問或按「🆘 用中文問」，AI 會暫時切成教練，給你 1–2 個道地英文講法，再把你帶回英文情境。求救內容**不計入評分**。
- **練習後回饋（全英文）**：總分、流利度與填充詞統計、文法／用字修正、更道地的講法、實用單字與句型、可執行建議。
- 練習紀錄與分數保存在本機。

---

## 第一步：申請免費的 Gemini API 金鑰

1. 前往 <https://aistudio.google.com/apikey>（用 Google 帳號登入）。
2. 點 **Create API key**，複製那串以 `AIza...` 開頭的金鑰。
3. 打開 App → 右上角 **⚙ 設定** → 貼上金鑰 → **儲存**。

> 金鑰格式：Google 2026 年起的新金鑰以 `AQ.` 開頭（舊版是 `AIza`），兩種都能用。
> 免費額度：Gemini Flash 系列每天數百∼上千次，個人練習綽綽有餘，免綁信用卡。
> 推薦模型：`gemini-3.5-flash`（最新旗艦）；想更快可用 `gemini-3.1-flash-lite`。
> 注意：免費額度的內容 Google 可能用於改善產品，練習用沒問題，但**請勿輸入公司機密**。

---

## 第二步：推到 GitHub 並開啟 GitHub Pages

在這個資料夾裡執行（把 `你的帳號` 換成你的 GitHub 使用者名稱）：

```bash
git init
git add .
git commit -m "SpeakPrep: English speaking coach"
git branch -M main
git remote add origin https://github.com/你的帳號/speakprep.git
git push -u origin main
```

接著到 GitHub 網站上：

1. 進入這個 repo → **Settings** → 左側 **Pages**。
2. **Source** 選 `Deploy from a branch`，Branch 選 `main` / `/ (root)`，按 **Save**。
3. 等 1–2 分鐘，頁面上方會出現你的網址，格式類似：
   `https://你的帳號.github.io/speakprep/`

> 這一步就跟你 DD 會議記錄專案一樣，推上去、開 Pages、拿到網址。

---

## 第三步：放到手機上（像 App 一樣）

用手機瀏覽器打開上面那個網址，然後：

- **Android（Chrome）**：右上角選單 → **加到主畫面 / 安裝應用程式**。
- **iPhone（Safari）**：下方分享鈕 → **加入主畫面**。

之後點主畫面上的圖示，就會全螢幕開啟，用起來跟一般 App 一樣。第一次打開後，記得先到 ⚙ 設定貼上金鑰。

---

## 跨裝置同步（選填，比照會議記錄專案做法）

不設定就只存本機。要在電腦和手機之間同步練習紀錄，做法跟 `meeting-notes` 相同——把資料存到一個**私人** repo 的 `sessions.json`：

1. 另外開一個**私人** repo，例如 `english-speaking-coach-data`。
2. 建立一把 **Fine-grained personal access token**：<https://github.com/settings/personal-access-tokens>
   - Repository access 只勾這個 data repo。
   - Permissions → Repository permissions → **Contents: Read and write**。
3. 打開 App → ⚙ 設定 → 「跨裝置同步」：
   - 資料 repo 填 `你的帳號/english-speaking-coach-data`
   - 貼上 token → 儲存。
4. 每次練習結束會自動上傳；換裝置貼上同一組設定，開 App 就會自動合併同步。

原理：App 用 GitHub Contents API 讀寫該私人 repo 的 `sessions.json`。含刪除墓碑（tombstone）與時間戳合併，刪除會跨裝置生效、也不會覆蓋別台的較新編輯。token 只存在各裝置本機瀏覽器。

## 手機語音支援說明（重要）

- **語音辨識（你說話 → 文字）**：**Android Chrome 支援最好**。iPhone Safari 支援較不穩定，若麥克風沒反應，直接用**打字輸入**即可（功能完全一樣，打中文會自動觸發求救模式）。
- **語音朗讀（AI 唸出回覆）**：iOS / Android 大多可用，可在設定關閉。
- 需要在 **https 網址（GitHub Pages 就是 https）** 下麥克風才會啟用；用 `file://` 直接開檔案時麥克風可能被瀏覽器擋住。

---

## 本機測試（選用）

因為麥克風需要 https 或 localhost，建議這樣在本機試：

```bash
# 在專案資料夾執行其一
python -m http.server 8000
# 或
npx serve
```

然後瀏覽器開 <http://localhost:8000> 。

---

## 檔案結構

```
index.html            介面結構
styles.css            樣式（深色、手機優先）
app.js                所有邏輯：情境、Gemini 串接、語音、回饋、紀錄
manifest.webmanifest  PWA 設定（加到主畫面用）
sw.js                 Service Worker（離線快取 App 外殼）
icons/                App 圖示
```

## 想之後改成用 Claude？

架構已把 API 呼叫集中在 `app.js` 的 `callGemini()`。要換成付費的 Claude API，
只需改那一個函式的網址、標頭與回應解析即可，其餘不用動。

---

*Made with Cowork.*
