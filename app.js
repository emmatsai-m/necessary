/* =========================================================
   生活用品採購庫存記錄 — 純前端版（無需建置工具）
   資料透過 Firebase Firestore 即時同步，多人共同編輯。

   資料結構：
   - users/{uid}/purchases/{id}            採購紀錄（原始資料，不變）
   - users/{uid}/inventoryTransactions/{id} 庫存異動（採購/使用/調整，可追溯）
   ========================================================= */

const CATEGORIES = ["清潔用品", "生活用品", "美妝保養", "醫療保健"];
const BASE_UNITS = ["ml", "L", "g", "kg", "片", "顆", "錠", "個", "其他"];
const PACK_UNITS = ["罐", "瓶", "包", "條", "盒", "箱", "組", "個", "其他"];
const MINIMUM_STOCK_DEFAULT = 1; // 最低庫存量，目前全品項統一預設

// ---- Firebase 初始化 ----
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const auth = firebase.auth();

// 登入後才會設定，指向該帳號底下的資料集合
let purchasesRef = null;
let transactionsRef = null;
let unsubscribeSnapshot = null;
let unsubscribeTransactions = null;
let purchasesLoaded = false;
let transactionsLoaded = false;
let migrationInProgress = false;

// ---- 全域狀態 ----
const state = {
  records: [],          // 採購紀錄（來自 purchases）
  transactions: [],      // 庫存異動（來自 inventoryTransactions）
  tab: "input",
  editingId: null,
  confirmDeleteId: null,
  invSearch: "",
  invCategory: "全部",
  invStatusFilter: "all", // all | low | out
  expandedKey: null,
  valSearch: "",
  valCategory: "全部",
  usageModalKey: null,
  detailModalKey: null,
};

// ---- 小工具 ----
const todayStr = () => new Date().toISOString().slice(0, 10);

function fmtDate(d) {
  if (!d) return "—";
  const [y, m, day] = d.split("-");
  return `${y}/${m}/${day}`;
}
function fmtNum(n, maxFrac = 2) {
  const num = Number(n);
  if (Number.isNaN(num)) return n;
  return Number.isInteger(num)
    ? num.toLocaleString()
    : num.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}
function totalBase(r) {
  return (Number(r.packSize) || 0) * (Number(r.packQty) || 0);
}
function unitPrice(r) {
  const tb = totalBase(r);
  if (!tb || r.price === null || r.price === undefined) return null;
  return r.price / tb;
}
function catClass(cat) {
  return CATEGORIES.includes(cat) ? cat : "其他";
}
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
// 商品身分＝品名＋最小單位；用來把同一品項的所有庫存異動歸在一起
function makeProductId(name, baseUnit) {
  const raw = `${(name || "").trim()}__${baseUnit}`;
  return raw.replace(/[\/.#$\[\]]/g, "_") || "unknown";
}

// ---- 初始化下拉選單 ----
function fillSelect(el, options) {
  el.innerHTML = options.map((o) => `<option value="${o}">${o}</option>`).join("");
}
function fillFilterSelect(el, options) {
  el.innerHTML = `<option value="全部">全部分類</option>` +
    options.map((o) => `<option value="${o}">${o}</option>`).join("");
}

document.addEventListener("DOMContentLoaded", () => {
  fillSelect(document.getElementById("f-category"), CATEGORIES);
  fillSelect(document.getElementById("f-baseUnit"), BASE_UNITS);
  fillSelect(document.getElementById("f-packUnit"), PACK_UNITS);
  fillFilterSelect(document.getElementById("inv-category-filter"), CATEGORIES);
  fillFilterSelect(document.getElementById("val-category-filter"), CATEGORIES);
  document.getElementById("f-purchaseDate").value = todayStr();

  setupTabs();
  setupForm();
  setupFilters();
  setupStatusFilter();
  setupModals();
  setupAuthGate();
});

// ---- 登入流程（信箱＋密碼） ----
function setupAuthGate() {
  const form = document.getElementById("auth-gate-form");
  const emailInput = document.getElementById("auth-email-input");
  const passwordInput = document.getElementById("auth-password-input");
  const errorMsg = document.getElementById("auth-gate-error");
  const loginBtn = document.getElementById("login-btn");

  function showError(err) {
    const map = {
      "auth/invalid-email": "信箱格式不正確。",
      "auth/user-not-found": "找不到這個帳號，請確認信箱是否正確，或聯絡管理者確認帳號是否已建立。",
      "auth/wrong-password": "密碼不正確。",
      "auth/invalid-credential": "信箱或密碼不正確。",
      "auth/weak-password": "密碼至少需要 6 碼。",
    };
    errorMsg.textContent = map[err.code] || `發生錯誤：${err.message}`;
    errorMsg.hidden = false;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorMsg.hidden = true;
    loginBtn.disabled = true;
    try {
      await auth.signInWithEmailAndPassword(emailInput.value.trim(), passwordInput.value);
    } catch (err) {
      showError(err);
    } finally {
      loginBtn.disabled = false;
    }
  });

  document.getElementById("logout-btn").addEventListener("click", () => {
    if (!confirm("確定要登出嗎？")) return;
    auth.signOut();
  });

  auth.onAuthStateChanged((user) => {
    if (user) {
      enterApp(user);
    } else {
      if (unsubscribeSnapshot) unsubscribeSnapshot();
      if (unsubscribeTransactions) unsubscribeTransactions();
      purchasesRef = null;
      transactionsRef = null;
      document.getElementById("auth-gate").style.display = "flex";
      document.getElementById("app-root").hidden = true;
    }
  });
}

function enterApp(user) {
  purchasesRef = db.collection("users").doc(user.uid).collection("purchases");
  transactionsRef = db.collection("users").doc(user.uid).collection("inventoryTransactions");
  document.getElementById("user-badge").textContent = user.email;
  document.getElementById("auth-gate").style.display = "none";
  document.getElementById("app-root").hidden = false;

  purchasesLoaded = false;
  transactionsLoaded = false;
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  if (unsubscribeTransactions) unsubscribeTransactions();
  subscribeToFirestore();
  subscribeToTransactions();
}

// ---- 分頁切換 ----
function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      document.getElementById("tab-input").hidden = state.tab !== "input";
      document.getElementById("tab-inventory").hidden = state.tab !== "inventory";
      document.getElementById("tab-value").hidden = state.tab !== "value";
      renderAll();
    });
  });
}

// ---- Firestore 即時訂閱 ----
function subscribeToFirestore() {
  unsubscribeSnapshot = purchasesRef.onSnapshot(
    (snapshot) => {
      state.records = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      purchasesLoaded = true;
      maybeBackfillTransactions();
      renderAll();
    },
    (err) => {
      console.error("Firestore 讀取失敗：", err);
      document.getElementById("recent-list").innerHTML =
        `<div class="empty-state"><p>資料庫連線失敗，請確認 firebase-config.js 是否已填入正確設定，以及 Firestore 安全性規則是否允許存取 users/{你的帳號}/purchases。</p></div>`;
    }
  );
}

function subscribeToTransactions() {
  unsubscribeTransactions = transactionsRef.onSnapshot(
    (snapshot) => {
      state.transactions = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
      transactionsLoaded = true;
      maybeBackfillTransactions();
      renderAll();
    },
    (err) => {
      console.error("庫存異動讀取失敗：", err);
    }
  );
}

// 向後相容：把還沒有對應庫存異動的「舊」採購紀錄，自動補建一筆採購型異動，
// 不會動到原始採購紀錄，也不會影響已經存在的使用/調整紀錄。
function maybeBackfillTransactions() {
  if (!purchasesLoaded || !transactionsLoaded || migrationInProgress) return;
  const existingSourceIds = new Set(
    state.transactions.filter((t) => t.type === "purchase" && t.sourcePurchaseId).map((t) => t.sourcePurchaseId)
  );
  const missing = state.records.filter((r) => !existingSourceIds.has(r.id));
  if (missing.length === 0) return;

  migrationInProgress = true;
  const batch = db.batch();
  missing.forEach((r) => {
    const ref = transactionsRef.doc();
    batch.set(ref, {
      productId: makeProductId(r.name, r.baseUnit),
      productName: r.name,
      baseUnit: r.baseUnit,
      category: r.category,
      type: "purchase",
      quantity: totalBase(r),
      date: r.purchaseDate,
      note: "（系統自動補建，對應既有採購紀錄）",
      sourcePurchaseId: r.id,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: auth.currentUser ? auth.currentUser.email : "",
    });
  });
  batch.commit()
    .catch((err) => console.error("補建庫存異動失敗：", err))
    .finally(() => { migrationInProgress = false; });
}

// ---- 表單（新增／編輯採購紀錄） ----
function setupForm() {
  const form = document.getElementById("purchase-form");
  const baseUnitSel = document.getElementById("f-baseUnit");
  const packUnitSel = document.getElementById("f-packUnit");
  const packSizeInput = document.getElementById("f-packSize");
  const packQtyInput = document.getElementById("f-packQty");
  const priceInput = document.getElementById("f-price");

  baseUnitSel.addEventListener("change", () => {
    document.getElementById("f-customBaseUnit-wrap").style.display = baseUnitSel.value === "其他" ? "block" : "none";
    updateSpecPreview();
  });
  packUnitSel.addEventListener("change", () => {
    document.getElementById("f-customPackUnit-wrap").style.display = packUnitSel.value === "其他" ? "block" : "none";
  });
  [packSizeInput, packQtyInput, priceInput].forEach((el) => el.addEventListener("input", updateSpecPreview));

  document.getElementById("cancel-edit-btn").addEventListener("click", resetForm);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = getFormPayload();
    if (!payload) return;

    const submitBtn = document.getElementById("submit-btn");
    submitBtn.disabled = true;
    try {
      const productId = makeProductId(payload.name, payload.baseUnit);
      const txQuantity = totalBase(payload);

      if (state.editingId) {
        await purchasesRef.doc(state.editingId).update(payload);
        // 同步更新這筆採購對應的庫存異動（不影響其他使用／調整紀錄）
        const existingTx = state.transactions.find(
          (t) => t.type === "purchase" && t.sourcePurchaseId === state.editingId
        );
        if (existingTx) {
          await transactionsRef.doc(existingTx.id).update({
            productId,
            productName: payload.name,
            baseUnit: payload.baseUnit,
            category: payload.category,
            quantity: txQuantity,
            date: payload.purchaseDate,
          });
        } else {
          await transactionsRef.add({
            productId,
            productName: payload.name,
            baseUnit: payload.baseUnit,
            category: payload.category,
            type: "purchase",
            quantity: txQuantity,
            date: payload.purchaseDate,
            note: "",
            sourcePurchaseId: state.editingId,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
            createdBy: auth.currentUser ? auth.currentUser.email : "",
          });
        }
      } else {
        const docRef = await purchasesRef.add({
          ...payload,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        await transactionsRef.add({
          productId,
          productName: payload.name,
          baseUnit: payload.baseUnit,
          category: payload.category,
          type: "purchase",
          quantity: txQuantity,
          date: payload.purchaseDate,
          note: "",
          sourcePurchaseId: docRef.id,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdBy: auth.currentUser ? auth.currentUser.email : "",
        });
      }
      resetForm();
    } catch (err) {
      console.error("儲存失敗：", err);
      alert("儲存失敗，請確認網路連線或 Firebase 設定。");
    } finally {
      submitBtn.disabled = false;
    }
  });

  updateSpecPreview();
}

function updateSpecPreview() {
  const packSize = Number(document.getElementById("f-packSize").value) || 0;
  const packQty = Number(document.getElementById("f-packQty").value) || 0;
  const baseUnitSel = document.getElementById("f-baseUnit");
  const baseUnit = baseUnitSel.value === "其他"
    ? (document.getElementById("f-customBaseUnit").value.trim() || "其他")
    : baseUnitSel.value;
  const total = packSize * packQty;
  const price = document.getElementById("f-price").value;

  let text = `= 共 ${fmtNum(total)} ${baseUnit}`;
  if (price !== "" && !isNaN(Number(price)) && total > 0) {
    text += ` · 約 NT$${fmtNum(Number(price) / total, 3)} / ${baseUnit}`;
  }
  document.getElementById("spec-preview").textContent = text;
}

function getFormPayload() {
  const name = document.getElementById("f-name").value.trim();
  const packSize = document.getElementById("f-packSize").value;
  const packQty = document.getElementById("f-packQty").value;
  if (!name || packSize === "" || packQty === "" || isNaN(Number(packSize)) || isNaN(Number(packQty))) {
    alert("請填寫品名、單一包裝內容量與採購數量。");
    return null;
  }
  const baseUnitSel = document.getElementById("f-baseUnit").value;
  const packUnitSel = document.getElementById("f-packUnit").value;
  const baseUnit = baseUnitSel === "其他"
    ? (document.getElementById("f-customBaseUnit").value.trim() || "其他")
    : baseUnitSel;
  const packUnit = packUnitSel === "其他"
    ? (document.getElementById("f-customPackUnit").value.trim() || "其他")
    : packUnitSel;
  const priceVal = document.getElementById("f-price").value;

  return {
    name,
    category: document.getElementById("f-category").value,
    baseUnit,
    packSize: Number(packSize),
    packUnit,
    packQty: Number(packQty),
    purchaseDate: document.getElementById("f-purchaseDate").value || todayStr(),
    price: priceVal === "" ? null : Number(priceVal),
    purchaser: document.getElementById("f-purchaser").value.trim(),
    note: document.getElementById("f-note").value.trim(),
  };
}

function resetForm() {
  state.editingId = null;
  document.getElementById("purchase-form").reset();
  document.getElementById("f-purchaseDate").value = todayStr();
  document.getElementById("f-customBaseUnit-wrap").style.display = "none";
  document.getElementById("f-customPackUnit-wrap").style.display = "none";
  document.getElementById("form-title").textContent = "新增採購紀錄";
  document.getElementById("cancel-edit-btn").style.display = "none";
  document.getElementById("submit-btn").innerHTML = "➕ 新增紀錄";
  updateSpecPreview();
  renderAll();
}

function startEdit(record) {
  state.editingId = record.id;
  document.getElementById("f-name").value = record.name;
  document.getElementById("f-category").value = record.category;

  const baseUnitSel = document.getElementById("f-baseUnit");
  if (BASE_UNITS.includes(record.baseUnit)) {
    baseUnitSel.value = record.baseUnit;
    document.getElementById("f-customBaseUnit-wrap").style.display = "none";
  } else {
    baseUnitSel.value = "其他";
    document.getElementById("f-customBaseUnit").value = record.baseUnit;
    document.getElementById("f-customBaseUnit-wrap").style.display = "block";
  }
  document.getElementById("f-packSize").value = record.packSize;

  const packUnitSel = document.getElementById("f-packUnit");
  if (PACK_UNITS.includes(record.packUnit)) {
    packUnitSel.value = record.packUnit;
    document.getElementById("f-customPackUnit-wrap").style.display = "none";
  } else {
    packUnitSel.value = "其他";
    document.getElementById("f-customPackUnit").value = record.packUnit;
    document.getElementById("f-customPackUnit-wrap").style.display = "block";
  }
  document.getElementById("f-packQty").value = record.packQty;
  document.getElementById("f-purchaseDate").value = record.purchaseDate;
  document.getElementById("f-price").value = record.price ?? "";
  document.getElementById("f-purchaser").value = record.purchaser || "";
  document.getElementById("f-note").value = record.note || "";

  document.getElementById("form-title").textContent = "編輯採購紀錄";
  document.getElementById("cancel-edit-btn").style.display = "inline-flex";
  document.getElementById("submit-btn").innerHTML = "✏️ 儲存修改";
  updateSpecPreview();

  state.tab = "input";
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === "input"));
  document.getElementById("tab-input").hidden = false;
  document.getElementById("tab-inventory").hidden = true;
  document.getElementById("tab-value").hidden = true;
  document.getElementById("purchase-form").scrollIntoView({ behavior: "smooth", block: "start" });
  renderAll();
}

async function doDelete(id) {
  const ok = confirm("確定要刪除這筆採購紀錄嗎？\n\n刪除採購紀錄可能會影響目前庫存（這筆對應的庫存增加量也會一併移除，但使用／調整紀錄不會被刪除）。");
  if (!ok) {
    state.confirmDeleteId = null;
    renderAll();
    return;
  }
  try {
    await purchasesRef.doc(id).delete();
    const linkedTx = state.transactions.find((t) => t.type === "purchase" && t.sourcePurchaseId === id);
    if (linkedTx) await transactionsRef.doc(linkedTx.id).delete();
    if (state.editingId === id) resetForm();
    state.confirmDeleteId = null;
  } catch (err) {
    console.error("刪除失敗：", err);
    alert("刪除失敗，請確認網路連線。");
  }
}

// ---- 篩選欄 ----
function setupFilters() {
  document.getElementById("inv-search").addEventListener("input", (e) => {
    state.invSearch = e.target.value;
    renderInventory();
  });
  document.getElementById("inv-category-filter").addEventListener("change", (e) => {
    state.invCategory = e.target.value;
    renderInventory();
  });
  document.getElementById("val-search").addEventListener("input", (e) => {
    state.valSearch = e.target.value;
    renderValue();
  });
  document.getElementById("val-category-filter").addEventListener("change", (e) => {
    state.valCategory = e.target.value;
    renderValue();
  });
}

function setupStatusFilter() {
  document.querySelectorAll(".status-filter-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.invStatusFilter = btn.dataset.status;
      document.querySelectorAll(".status-filter-btn").forEach((b) => b.classList.toggle("active", b === btn));
      renderInventory();
    });
  });
}

// ---- 統一渲染 ----
function renderAll() {
  renderRecentList();
  renderInventory();
  renderValue();
  if (state.detailModalKey) renderDetailModal();
}

// ---- 新增紀錄頁：最近 3 筆 ----
function renderRecentList() {
  const sorted = [...state.records].sort((a, b) => (a.purchaseDate < b.purchaseDate ? 1 : -1));
  const recent = sorted.slice(0, 3);
  document.getElementById("recent-caption").textContent =
    `最近輸入的 3 筆紀錄（共 ${state.records.length} 筆，其餘可在庫存總覽 / 性價比比較頁查看）`;

  const container = document.getElementById("recent-list");
  if (recent.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>尚無採購紀錄，從左側新增第一筆吧。</p></div>`;
    return;
  }

  container.innerHTML = recent.map((r) => {
    const cat = catClass(r.category);
    const up = unitPrice(r);
    const isEditing = state.editingId === r.id;
    const isConfirming = state.confirmDeleteId === r.id;
    return `
      <div class="record-row ${isEditing ? "editing" : ""}">
        <div class="record-bar cat-bar-${cat}"></div>
        <div class="record-main">
          <div class="record-title-row">
            <span class="name">${escapeHtml(r.name)}</span>
            <span class="tag-pill cat-${cat}">${escapeHtml(r.category)}</span>
          </div>
          <div class="record-sub mono">
            ${fmtDate(r.purchaseDate)} · ${fmtNum(r.packQty, 0)} ${escapeHtml(r.packUnit)}（每${escapeHtml(r.packUnit)} ${fmtNum(r.packSize)} ${escapeHtml(r.baseUnit)}）
            ${r.price != null ? ` · NT$${r.price}` : ""}${up != null ? ` · NT$${fmtNum(up, 3)}/${escapeHtml(r.baseUnit)}` : ""}
          </div>
        </div>
        <div class="record-qty mono">${fmtNum(totalBase(r))} <span class="unit">${escapeHtml(r.baseUnit)}</span></div>
        <div class="record-actions">
          <button class="icon-btn" data-action="edit" data-id="${r.id}" aria-label="修改">✏️</button>
          ${isConfirming
            ? `<button class="icon-btn icon-btn-danger" data-action="confirm-delete" data-id="${r.id}">確定</button>`
            : `<button class="icon-btn" data-action="ask-delete" data-id="${r.id}" aria-label="刪除">🗑️</button>`}
        </div>
      </div>`;
  }).join("");

  container.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => handleRowAction(btn.dataset.action, btn.dataset.id));
  });
}

function handleRowAction(action, id) {
  const record = state.records.find((r) => r.id === id);
  if (action === "edit" && record) startEdit(record);
  if (action === "ask-delete") { state.confirmDeleteId = id; renderAll(); }
  if (action === "confirm-delete") doDelete(id);
}

// =========================================================
// 庫存總覽（採購 － 使用 ± 調整）
// =========================================================

// 依 productId 彙整所有庫存異動
function computeInventoryMap() {
  const map = new Map();
  for (const t of state.transactions) {
    const key = t.productId;
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: t.productName,
        unit: t.baseUnit,
        category: t.category,
        purchased: 0,
        used: 0,
        adjustment: 0,
        current: 0,
        lastPurchaseDate: null,
        lastUsedDate: null,
        _latestDate: null,
      });
    }
    const g = map.get(key);
    const qty = Number(t.quantity) || 0;
    g.current += qty;

    if (t.type === "purchase") {
      g.purchased += qty;
      if (!g.lastPurchaseDate || t.date > g.lastPurchaseDate) g.lastPurchaseDate = t.date;
    } else if (t.type === "usage") {
      g.used += Math.abs(qty);
      if (!g.lastUsedDate || t.date > g.lastUsedDate) g.lastUsedDate = t.date;
    } else if (t.type === "adjustment") {
      g.adjustment += qty;
    }
    // 品名／分類／單位以最新一筆異動為準（例如編輯採購紀錄改了名稱）
    if (!g._latestDate || t.date >= g._latestDate) {
      g.name = t.productName;
      g.unit = t.baseUnit;
      g.category = t.category;
      g._latestDate = t.date;
    }
  }
  return map;
}

function computeInventoryList() {
  const map = computeInventoryMap();
  return Array.from(map.values()).map((g) => {
    const minimumStock = MINIMUM_STOCK_DEFAULT;
    let status = "ok";
    if (g.current <= 0) status = "out";
    else if (g.current <= minimumStock) status = "low";
    return { ...g, minimumStock, status };
  });
}

function filterInventoryList(list) {
  let out = [...list].sort((a, b) => {
    const da = a.lastPurchaseDate || "";
    const db_ = b.lastPurchaseDate || "";
    return da < db_ ? 1 : -1;
  });
  if (state.invCategory !== "全部") out = out.filter((g) => g.category === state.invCategory);
  if (state.invStatusFilter === "low") out = out.filter((g) => g.status === "low");
  if (state.invStatusFilter === "out") out = out.filter((g) => g.status === "out");
  if (state.invSearch.trim()) {
    const q = state.invSearch.trim().toLowerCase();
    out = out.filter((g) => g.name.toLowerCase().includes(q));
  }
  return out;
}

function renderInvStats(allList) {
  const total = allList.length;
  const ok = allList.filter((g) => g.status === "ok").length;
  const low = allList.filter((g) => g.status === "low").length;
  const out = allList.filter((g) => g.status === "out").length;
  document.getElementById("inv-stats").innerHTML = `
    <div class="inv-stat-card"><span class="num mono">${total}</span><span class="label">📦 商品種類</span></div>
    <div class="inv-stat-card stat-ok"><span class="num mono">${ok}</span><span class="label">🟢 有庫存</span></div>
    <div class="inv-stat-card stat-low"><span class="num mono">${low}</span><span class="label">🟡 低庫存</span></div>
    <div class="inv-stat-card stat-out"><span class="num mono">${out}</span><span class="label">🔴 缺貨</span></div>
  `;
}

function renderInventory() {
  const allList = computeInventoryList();
  renderInvStats(allList);
  const list = filterInventoryList(allList);
  const container = document.getElementById("inventory-grid");

  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>找不到符合條件的品項。</p></div>`;
    return;
  }

  container.innerHTML = list.map((g) => {
    const cat = catClass(g.category);
    const statusLabel = g.status === "out" ? "🔴 缺貨" : g.status === "low" ? "🟡 庫存偏低" : "🟢 有庫存";
    return `
      <div class="inv-card">
        <div class="inv-card-head">
          <div class="inv-card-top">
            <div>
              <span class="tag-pill cat-${cat}">${escapeHtml(g.category)}</span>
              <span class="status-badge status-${g.status}">${statusLabel}</span>
              <h3 class="hand inv-card-name">${escapeHtml(g.name)}</h3>
            </div>
          </div>

          <div class="inv-current-row">
            <span class="num mono">${fmtNum(g.current)}</span>
            <span class="unit">${escapeHtml(g.unit)} 現有庫存</span>
          </div>

          <div class="inv-stock-rows">
            <div class="inv-stock-row"><span>累計購入</span><span class="val">${fmtNum(g.purchased)} ${escapeHtml(g.unit)}</span></div>
            <div class="inv-stock-row"><span>已使用</span><span class="val">${fmtNum(g.used)} ${escapeHtml(g.unit)}</span></div>
          </div>

          <div class="inv-dates">
            最近採購：${fmtDate(g.lastPurchaseDate)}<br/>
            最近使用：${g.lastUsedDate ? fmtDate(g.lastUsedDate) : "—"}
          </div>

          <div class="inv-actions">
            <button type="button" class="btn btn-use" data-action="use" data-key="${g.key}" ${g.current <= 0 ? "disabled" : ""}>➖ 使用</button>
            <button type="button" class="btn btn-outline" data-action="edit-latest" data-key="${g.key}">✏️ 編輯</button>
            <button type="button" class="btn btn-outline" data-action="detail" data-key="${g.key}">📋 明細</button>
          </div>
        </div>
      </div>`;
  }).join("");

  container.querySelectorAll('[data-action="use"]').forEach((btn) => {
    btn.addEventListener("click", () => openUsageModal(btn.dataset.key));
  });
  container.querySelectorAll('[data-action="edit-latest"]').forEach((btn) => {
    btn.addEventListener("click", () => editLatestPurchase(btn.dataset.key));
  });
  container.querySelectorAll('[data-action="detail"]').forEach((btn) => {
    btn.addEventListener("click", () => openDetailModal(btn.dataset.key));
  });
}

// 點卡片上的「編輯」＝編輯這個品項最新一筆採購紀錄
function editLatestPurchase(key) {
  const purchaseTxs = state.transactions.filter(
    (t) => t.productId === key && t.type === "purchase" && t.sourcePurchaseId
  );
  if (purchaseTxs.length === 0) {
    alert("這個品項目前沒有可編輯的採購紀錄（可能只有使用或調整紀錄）。");
    return;
  }
  purchaseTxs.sort((a, b) => (a.date < b.date ? 1 : -1));
  const record = state.records.find((r) => r.id === purchaseTxs[0].sourcePurchaseId);
  if (!record) {
    alert("找不到對應的採購紀錄，可能已被刪除。");
    return;
  }
  startEdit(record);
}

// ---- 使用庫存 Modal ----
function openUsageModal(key) {
  const g = computeInventoryMap().get(key);
  if (!g) return;
  if (g.current <= 0) {
    alert("目前庫存為 0，無法使用。");
    return;
  }
  state.usageModalKey = key;
  document.getElementById("usage-modal-title").textContent = `使用庫存：${g.name}`;
  document.getElementById("usage-current-stock").textContent = `目前庫存：${fmtNum(g.current)} ${g.unit}`;
  const qtyInput = document.getElementById("usage-qty");
  qtyInput.value = 1;
  qtyInput.max = g.current;
  qtyInput.min = 1;
  document.getElementById("usage-date").value = todayStr();
  document.getElementById("usage-note").value = "";
  document.getElementById("usage-error").hidden = true;
  document.getElementById("usage-modal").hidden = false;
}
function closeUsageModal() {
  document.getElementById("usage-modal").hidden = true;
  state.usageModalKey = null;
}
async function confirmUsage() {
  const key = state.usageModalKey;
  if (!key) return;
  const g = computeInventoryMap().get(key);
  const errorMsg = document.getElementById("usage-error");
  if (!g) { closeUsageModal(); return; }

  const qty = Number(document.getElementById("usage-qty").value);
  if (!Number.isFinite(qty) || qty < 1) {
    errorMsg.textContent = "使用數量不能小於 1。";
    errorMsg.hidden = false;
    return;
  }
  if (qty > g.current) {
    errorMsg.textContent = `使用數量不能大於目前庫存（${fmtNum(g.current)} ${g.unit}）。`;
    errorMsg.hidden = false;
    return;
  }
  errorMsg.hidden = true;

  const confirmBtn = document.getElementById("usage-confirm");
  confirmBtn.disabled = true;
  try {
    await transactionsRef.add({
      productId: key,
      productName: g.name,
      baseUnit: g.unit,
      category: g.category,
      type: "usage",
      quantity: -qty,
      date: document.getElementById("usage-date").value || todayStr(),
      note: document.getElementById("usage-note").value.trim(),
      sourcePurchaseId: null,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: auth.currentUser ? auth.currentUser.email : "",
    });
    closeUsageModal();
  } catch (err) {
    console.error("使用紀錄寫入失敗：", err);
    errorMsg.textContent = "寫入失敗，請確認網路連線。";
    errorMsg.hidden = false;
  } finally {
    confirmBtn.disabled = false;
  }
}

// ---- 庫存明細 Modal ----
function openDetailModal(key) {
  state.detailModalKey = key;
  renderDetailModal();
  document.getElementById("detail-modal").hidden = false;
}
function closeDetailModal() {
  document.getElementById("detail-modal").hidden = true;
  state.detailModalKey = null;
}
function renderDetailModal() {
  const key = state.detailModalKey;
  const g = computeInventoryMap().get(key);
  if (!g) { closeDetailModal(); return; }

  document.getElementById("detail-modal-title").textContent = `庫存明細：${g.name}`;

  const txs = state.transactions
    .filter((t) => t.productId === key)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const rowsHtml = txs.map((t) => {
    const icon = t.type === "purchase" ? "🟢" : t.type === "usage" ? "🔴" : "🟡";
    const label = t.type === "purchase" ? "採購" : t.type === "usage" ? "使用" : "調整";
    const sign = t.quantity >= 0 ? "+" : "";
    return `
      <div class="detail-tx-row tx-${t.type}">
        <span class="tx-date">${fmtDate(t.date)}</span>
        <span>${icon} ${label}</span>
        <span class="tx-qty">${sign}${fmtNum(t.quantity)} ${escapeHtml(g.unit)}</span>
        <span class="tx-note">${escapeHtml(t.note || "")}</span>
      </div>`;
  }).join("") || `<p class="muted">尚無異動紀錄。</p>`;

  document.getElementById("detail-modal-body").innerHTML = `
    ${rowsHtml}
    <div class="detail-summary">
      <div class="row"><span>累計購入</span><span class="val">${fmtNum(g.purchased)} ${escapeHtml(g.unit)}</span></div>
      <div class="row"><span>累計使用</span><span class="val">${fmtNum(g.used)} ${escapeHtml(g.unit)}</span></div>
      <div class="row"><span>目前庫存</span><span class="val">${fmtNum(g.current)} ${escapeHtml(g.unit)}</span></div>
    </div>
  `;
}

function setupModals() {
  document.getElementById("usage-modal-close").addEventListener("click", closeUsageModal);
  document.getElementById("usage-cancel").addEventListener("click", closeUsageModal);
  document.getElementById("usage-modal").addEventListener("click", (e) => {
    if (e.target.id === "usage-modal") closeUsageModal();
  });
  document.getElementById("usage-minus").addEventListener("click", () => {
    const input = document.getElementById("usage-qty");
    input.value = Math.max(1, (Number(input.value) || 1) - 1);
  });
  document.getElementById("usage-plus").addEventListener("click", () => {
    const input = document.getElementById("usage-qty");
    const max = Number(input.max) || Infinity;
    input.value = Math.min(max, (Number(input.value) || 1) + 1);
  });
  document.getElementById("usage-confirm").addEventListener("click", confirmUsage);

  document.getElementById("detail-modal-close").addEventListener("click", closeDetailModal);
  document.getElementById("detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "detail-modal") closeDetailModal();
  });
}

// ---- 性價比比較頁 ----
function computeValueGroups() {
  const map = new Map();
  for (const r of state.records) {
    if (r.price === null || r.price === undefined) continue;
    const key = `${r.name.trim()}__${r.baseUnit}`;
    if (!map.has(key)) map.set(key, { key, name: r.name.trim(), unit: r.baseUnit, category: r.category, items: [] });
    map.get(key).items.push(r);
  }
  let list = Array.from(map.values());
  for (const g of list) {
    g.items.sort((a, b) => (unitPrice(a) ?? Infinity) - (unitPrice(b) ?? Infinity));
  }
  list.sort((a, b) => (a.name < b.name ? -1 : 1));
  if (state.valCategory !== "全部") list = list.filter((g) => g.category === state.valCategory);
  if (state.valSearch.trim()) {
    const q = state.valSearch.trim().toLowerCase();
    list = list.filter((g) => g.name.toLowerCase().includes(q));
  }
  return list;
}

function renderValue() {
  const list = computeValueGroups();
  const container = document.getElementById("value-list");
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>目前沒有含金額的紀錄可以比較，新增時記得填寫金額。</p></div>`;
    return;
  }

  container.innerHTML = list.map((g) => {
    const cat = catClass(g.category);
    const rowsHtml = g.items.map((r, i) => {
      const up = unitPrice(r);
      const isBest = i === 0 && g.items.length > 1;
      return `
        <div class="value-row ${isBest ? "best" : ""}">
          <span class="date mono">${fmtDate(r.purchaseDate)}</span>
          <span class="pack mono">${fmtNum(r.packQty, 0)}${escapeHtml(r.packUnit)}（${fmtNum(r.packSize)}${escapeHtml(r.baseUnit)}/${escapeHtml(r.packUnit)}）</span>
          <span class="price mono">NT$${fmtNum(r.price)}</span>
          <span class="unit-price mono">NT$${fmtNum(up, 3)} / ${escapeHtml(g.unit)}</span>
          ${isBest ? `<span class="tag-pill best-badge">👑 最划算</span>` : ""}
          <button class="icon-btn icon-btn-sm" data-action="edit" data-id="${r.id}" aria-label="修改此筆">✏️</button>
        </div>`;
    }).join("");

    return `
      <div class="value-card">
        <div class="value-card-head">
          <span class="tag-pill cat-${cat}">${escapeHtml(g.category)}</span>
          <h3 class="hand">${escapeHtml(g.name)}</h3>
          <span style="font-size:12px;color:var(--ink-soft)">· 換算為每 ${escapeHtml(g.unit)} 單價</span>
        </div>
        ${rowsHtml}
      </div>`;
  }).join("");

  container.querySelectorAll("[data-action='edit']").forEach((btn) => {
    btn.addEventListener("click", () => handleRowAction("edit", btn.dataset.id));
  });
}
