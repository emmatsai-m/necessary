# 生活用品採購庫存記錄

純前端網站（HTML + CSS + JS），不需要安裝任何軟體或建置工具，可以直接上傳到 GitHub、用 GitHub Pages 部署，資料庫使用 Firebase Firestore，多人可以即時共同編輯同一份紀錄。

## 檔案說明

- `index.html`：網站主畫面（新增紀錄 / 庫存總覽 / 性價比比較 三個分頁，含「使用庫存」「庫存明細」彈出視窗）
- `style.css`：荷蘭鄉村手繪風配色與版面樣式，含手機／平板／電腦的自適應排版
- `app.js`：所有功能邏輯（新增、修改、刪除、使用庫存、庫存加總、性價比計算）
- `firebase-config.js`：**要自己填**的 Firebase 專案設定值

## 這個版本新增了什麼

- **庫存不再等於「累計買了多少」**，而是分開記錄「採購」「使用」「調整」三種庫存異動，現有庫存＝採購增加－使用減少±調整。
- **使用庫存時可以直接以「罐」「瓶」等採購包裝為單位輸入**（例如沐浴乳直接填「用了1罐」），系統會依最近一次採購的包裝規格（例如 700ml/罐）自動換算成最小單位計算，也可以切換成「以 ml 精確輸入」，適合用掉不到一整罐的情況。庫存卡片上也會同步顯示「約 X 罐」方便對照。
- 庫存總覽卡片新增：累計購入、已使用、最近採購／使用日期、庫存狀態（🟢有庫存／🟡庫存偏低／🔴缺貨），以及 [➖ 使用]（先開啟視窗確認再送出）[✏️ 編輯]（編輯最新一筆採購）[📋 明細]（完整異動時間軸）三個操作。
- **[📋 明細] 現在是修改／刪除原始資料的主要入口**：每一筆採購或使用紀錄旁邊都有 ✏️（修改）🗑️（刪除）。點採購紀錄的 ✏️ 會直接跳去編輯表單；點使用紀錄的 ✏️ 會用同一個「使用庫存」視窗開啟編輯（可以改數量、單位、日期、備註）；🗑️ 刪除使用或調整紀錄不需要跳頁，刪除後庫存會自動把這筆的影響加回來——如果不小心誤用導致庫存變成負數，就是從這裡修正或刪掉那筆誤用即可。
- 庫存總覽上方新增統計列（商品種類／有庫存／低庫存／缺貨）與「全部／庫存不足／已用完」篩選鈕。
- 低庫存門檻目前全品項統一為 1（現有庫存 ≤ 1 顯示「庫存偏低」），還沒有做每個品項各自設定門檔的介面。
- 刪除採購紀錄時會多一層瀏覽器跳出視窗二次確認，並提醒「可能會影響目前庫存」；刪除使用／調整紀錄也一樣會先跳出確認視窗。

## 登入是怎麼運作的

打開網站會先看到「登入」畫面，用信箱＋密碼登入。網站上**沒有開放自助註冊**——這組帳號要由你自己先在 Firebase 主控台手動建立好（步驟見下方），之後兩人就用同一組信箱密碼登入，會同步看到同一份資料。登入狀態由 Firebase Authentication 處理，關閉瀏覽器再打開通常還是登入狀態，要換人使用時按頁首的「登出」即可。

⚠️ 密碼請設定得複雜一點（不要用生日、手機號碼這種），因為只要有這組信箱密碼就能讀寫你們的資料。

## 把程式碼公開在 GitHub 上安全嗎？

安全，這是 Firebase 官方認可的常見做法。`firebase-config.js` 裡的 `apiKey` 等設定值**不是密碼**，只是告訴瀏覽器要連到哪個 Firebase 專案，本身沒有讀寫資料的權限；真正決定「誰能讀寫」的是 Firestore 的安全性規則（下面「部署前要做的事」那段的 `request.auth.uid == userId`），而不是把設定值藏起來。你們的登入密碼從頭到尾都只存在 Firebase 主控台的使用者列表裡，沒有寫進任何檔案。

唯一比較次要的疑慮是：因為 `apiKey` 公開，理論上有技術能力的人可以繞過網站畫面，直接呼叫 Firebase 幫自己在你的專案下建立新帳號（雖然還是完全碰不到你們的資料，因為 UID 對不上）。想徹底堵住這條路，可以用下面「進階安全性設定」把規則再收緊一層。

## 進階安全性設定（選用，建議設定）

把 Firestore 規則多加一個條件，直接把你們共用帳號的 UID 寫死在規則裡，這樣就算有陌生人自己註冊了新帳號，規則也會直接擋下（因為他的 UID 永遠對不上你寫死的那組）。

你的 UID 在 Firebase 主控台 → Authentication → Users 的列表裡，信箱旁邊會列出一串英數字，複製它，換掉下面的 `"你的UID"`：

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/purchases/{docId} {
      allow read, write: if request.auth != null && request.auth.uid == userId && userId == "你的UID";
    }
    match /users/{userId}/inventoryTransactions/{docId} {
      allow read, write: if request.auth != null && request.auth.uid == userId && userId == "你的UID";
    }
  }
}
```

貼到 Firestore 的「規則」分頁整段覆蓋即可，不會影響既有資料；之後如果想再增加第二個帳號共用，把 `userId == "你的UID"` 那段改成 `(userId == "帳號A的UID" || userId == "帳號B的UID")` 即可。

## 部署前要做的事

1. 打開 `firebase-config.js`，把裡面 6 個欄位換成你自己 Firebase 專案的設定值（Firebase 主控台 → 專案設定 → 一般 → 我的應用程式 → SDK 設定與程式碼）。
2. 到 Firebase 主控台的「Authentication」功能，開啟「電子郵件/密碼」這個登入方式（預設是關閉的，需要手動啟用）。
3. 同樣在「Authentication」的使用者列表裡，手動新增一組使用者（輸入你們要共用的信箱與密碼）——這一步只需要做一次，之後兩人就用這組帳號登入。
4. 在 Firebase 主控台建立 Firestore 資料庫（原生模式即可）。資料會存在 `users/{你的帳號UID}/purchases` 與 `users/{你的帳號UID}/inventoryTransactions` 底下，網站第一次寫入時自動建立，不用手動建立。
5. 到 Firestore 的「規則」分頁，貼上以下規則（只有登入本人才能讀寫自己帳號底下的資料，這次多了 `inventoryTransactions` 這個集合）：
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{userId}/purchases/{docId} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
       match /users/{userId}/inventoryTransactions/{docId} {
         allow read, write: if request.auth != null && request.auth.uid == userId;
       }
     }
   }
   ```
   如果你原本已經套用過舊版規則（只有 `purchases` 那段），把上面完整內容整段覆蓋貼上即可，不會影響既有資料。
6. 把整個資料夾（這 5 個檔案）上傳到你的 GitHub repository，開啟 GitHub Pages 即可瀏覽。

## 既有資料會怎麼處理（向後相容）

如果你之前已經用舊版累積了一些採購紀錄，這版網站第一次打開時，會自動幫每一筆「還沒有對應庫存異動」的舊採購紀錄，補建一筆「採購」型的庫存異動（不會動到原始採購紀錄本身）。所以升級後現有庫存會先等於「目前累計買的量」，「已使用」則是 0，之後你再用 [➖ 使用] 記錄用掉多少即可，不會遺失任何既有資料。

⚠️ 有一個小限制：如果之後編輯採購紀錄時把**品名或最小單位改掉**，系統會把它視為換成另一個品項，之前記錄在舊品名底下的「使用」紀錄不會自動跟著搬過去（庫存會因此對不上）。建議品名／最小單位盡量不要事後更改；真的需要更名的話再跟我說，我可以幫忙處理資料搬移。

**已修正的問題：** 早期版本的補建邏輯，如果兩人（或同一人的兩個分頁／裝置）剛好在差不多時間打開網站，可能會各自重複補建同一筆舊採購，導致庫存總覽出現「多出來的採購量」與重複的「系統自動補建」文字。現在補建邏輯已改成每筆舊採購對應固定的紀錄，不會再重複產生；網站也會在打開時自動偵測並清掉過去已經產生的重複紀錄，不需要手動處理。

## 資料結構

**`purchases`（每一筆代表一次採購，原始資料，編輯／刪除都在這裡動）**

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

**`inventoryTransactions`（庫存異動，可完整追溯庫存為什麼變成目前數字）**

| 欄位 | 說明 |
|---|---|
| productId | 品項識別碼（＝品名＋最小單位） |
| productName / baseUnit / category | 品名／最小單位／分類（異動當下的快照） |
| type | `purchase`（採購增加）／`usage`（使用減少）／`adjustment`（人工調整） |
| quantity | 對庫存的影響量，以 baseUnit 計；usage 一律存負數 |
| date | 異動日期 |
| note | 備註 |
| sourcePurchaseId | 若為 purchase 型，對應到 `purchases` 集合的文件 id（用於編輯／刪除同步） |
| createdAt / createdBy | 建立時間／建立者信箱 |

之後如果想調整分類、單位選項，直接編輯 `app.js` 最上面的 `CATEGORIES` / `BASE_UNITS` / `PACK_UNITS` 三個陣列即可，不需要改其他地方。
