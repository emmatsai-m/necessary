# 生活用品採購庫存記錄

純前端網站（HTML + CSS + JS），不需要安裝任何軟體或建置工具，可以直接上傳到 GitHub、用 GitHub Pages 部署，資料庫使用 Firebase Firestore，多人可以即時共同編輯同一份紀錄。

## 檔案說明

- `index.html`：網站主畫面（新增紀錄 / 庫存總覽 / 性價比比較 三個分頁）
- `style.css`：荷蘭鄉村手繪風配色與版面樣式，含手機／平板／電腦的自適應排版
- `app.js`：所有功能邏輯（新增、修改、刪除、庫存加總、性價比計算）
- `firebase-config.js`：**要自己填**的 Firebase 專案設定值

## 房間代碼是怎麼運作的

打開網站第一次會先看到「輸入房間代碼」的畫面。兩人只要約定同一組代碼（例如 `cozy-kitchen-42`），輸入後看到的就是同一份資料，即時同步。代碼會存在瀏覽器裡（`localStorage`），所以同一台裝置、同一個瀏覽器之後打開不用再輸入；想換另一份資料，按頁首的「切換房間」即可重新輸入。

⚠️ 這個機制**不是帳號密碼登入**，比較像「知道代碼就能進去」的共用連結，任何人只要猜到或拿到你們的房間代碼就能讀寫資料，請選一組不容易被猜到的代碼（不要用太簡單的字，例如 `1234` 或 `test`），並避免公開分享出去。如果之後想要更嚴謹的帳號驗證機制，可以再照你規劃的「彈性增加登入或加密驗證方式」疊加 Firebase Authentication。

## 部署前要做的事

1. 打開 `firebase-config.js`，把裡面 6 個欄位換成你自己 Firebase 專案的設定值（Firebase 主控台 → 專案設定 → 一般 → 我的應用程式 → SDK 設定與程式碼）。
2. 在 Firebase 主控台建立 Firestore 資料庫（原生模式即可）。資料會存在 `rooms/{房間代碼}/purchases` 底下，網站第一次寫入時自動建立，不用手動建立。
3. 到 Firestore 的「規則」分頁，貼上以下規則（允許依房間代碼讀寫該房間底下的資料）：
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /rooms/{roomCode}/purchases/{docId} {
         allow read, write: if true;
       }
     }
   }
   ```
4. 把整個資料夾（這 5 個檔案）上傳到你的 GitHub repository，開啟 GitHub Pages 即可瀏覽。

## 資料結構（Firestore 的 `purchases` 集合，每一筆代表一次採購）

| 欄位 | 說明 |
|---|---|
| name | 品名 |
| category | 分類（清潔用品／生活用品／美妝保養／醫療保健） |
| baseUnit | 計價最小單位（ml、g、片、顆…） |
| packSize | 每 1 個採購單位含多少最小單位 |
| packUnit | 採購單位（罐、瓶、包…） |
| packQty | 買了幾個採購單位 |
| purchaseDate | 購買日期（YYYY-MM-DD） |
| price | 金額（可留空） |
| purchaser | 採購人（可留空） |
| note | 備註（可留空） |

之後如果想調整分類、單位選項，直接編輯 `app.js` 最上面的 `CATEGORIES` / `BASE_UNITS` / `PACK_UNITS` 三個陣列即可，不需要改其他地方。
