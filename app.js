/* =========================================================
   生活用品採購庫存記錄 — 純前端版（無需建置工具）
   資料透過 Firebase Firestore 即時同步，多人共同編輯。
   ========================================================= */

const CATEGORIES = ["清潔用品", "生活用品", "美妝保養", "醫療保健"];
const BASE_UNITS = ["ml", "L", "g", "kg", "片", "顆", "錠", "個", "其他"];
const PACK_UNITS = ["罐", "瓶", "包", "條", "盒", "箱", "組", "個", "其他"];
const ROOM_STORAGE_KEY = "household-inventory-room-code";

// ---- Firebase 初始化 ----
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// 房間代碼與對應的資料集合，進入房間後才會設定
let currentRoomCode = null;
let purchasesRef = null;
let unsubscribeSnapshot = null;

// ---- 全域狀態 ----
const state = {
  records: [],
  tab: "input",
  editingId: null,
  confirmDeleteId: null,
  invSearch: "",
  invCategory: "全部",
  expandedKey: null,
  valSearch: "",
  valCategory: "全部",
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
  setupRoomGate();
});

// ---- 房間代碼進入流程 ----
function setupRoomGate() {
  const gateForm = document.getElementById("room-gate-form");
  const codeInput = document.getElementById("room-code-input");
  const errorMsg = document.getElementById("room-gate-error");

  gateForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = codeInput.value.trim();
    if (!code) {
      errorMsg.hidden = false;
      return;
    }
    errorMsg.hidden = true;
    enterRoom(code);
  });

  document.getElementById("leave-room-btn").addEventListener("click", () => {
    if (!confirm("確定要切換房間嗎？切換後需要重新輸入房間代碼才能看到目前這份資料。")) return;
    localStorage.removeItem(ROOM_STORAGE_KEY);
    location.reload();
  });

  const savedCode = localStorage.getItem(ROOM_STORAGE_KEY);
  if (savedCode) {
    enterRoom(savedCode);
  }
}

function enterRoom(code) {
  currentRoomCode = code;
  localStorage.setItem(ROOM_STORAGE_KEY, code);
  purchasesRef = db.collection("rooms").doc(code).collection("purchases");

  document.getElementById("room-badge").textContent = code;
  document.getElementById("room-gate").style.display = "none";
  document.getElementById("app-root").hidden = false;

  if (unsubscribeSnapshot) unsubscribeSnapshot();
  subscribeToFirestore();
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
      renderAll();
    },
    (err) => {
      console.error("Firestore 讀取失敗：", err);
      document.getElementById("recent-list").innerHTML =
        `<div class="empty-state"><p>資料庫連線失敗，請確認 firebase-config.js 是否已填入正確設定，以及 Firestore 安全性規則是否允許存取 rooms/${escapeHtml(currentRoomCode)}/purchases。</p></div>`;
    }
  );
}

// ---- 表單 ----
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
      if (state.editingId) {
        await purchasesRef.doc(state.editingId).update(payload);
      } else {
        await purchasesRef.add({
          ...payload,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
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
  try {
    await purchasesRef.doc(id).delete();
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

// ---- 統一渲染 ----
function renderAll() {
  renderRecentList();
  renderInventory();
  renderValue();
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

// ---- 庫存總覽頁 ----
function computeInventory() {
  const map = new Map();
  for (const r of state.records) {
    const key = `${r.name.trim()}__${r.baseUnit}`;
    if (!map.has(key)) {
      map.set(key, { key, name: r.name.trim(), unit: r.baseUnit, category: r.category, total: 0, lastDate: r.purchaseDate, count: 0, items: [] });
    }
    const g = map.get(key);
    g.total += totalBase(r);
    g.count += 1;
    g.items.push(r);
    if (r.purchaseDate > g.lastDate) g.lastDate = r.purchaseDate;
    g.category = r.category;
  }
  let list = Array.from(map.values()).sort((a, b) => (a.lastDate < b.lastDate ? 1 : -1));
  if (state.invCategory !== "全部") list = list.filter((g) => g.category === state.invCategory);
  if (state.invSearch.trim()) {
    const q = state.invSearch.trim().toLowerCase();
    list = list.filter((g) => g.name.toLowerCase().includes(q));
  }
  return list;
}

function renderInventory() {
  const list = computeInventory();
  const container = document.getElementById("inventory-grid");
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><p>找不到符合條件的品項。</p></div>`;
    return;
  }

  container.innerHTML = list.map((g) => {
    const cat = catClass(g.category);
    const expanded = state.expandedKey === g.key;
    const detailHtml = expanded
      ? `<div class="inv-detail">${
          [...g.items].sort((a, b) => (a.purchaseDate < b.purchaseDate ? 1 : -1)).map((r) => {
            const isConfirming = state.confirmDeleteId === r.id;
            return `
              <div class="inv-detail-row">
                <span class="date mono">${fmtDate(r.purchaseDate)}</span>
                <span class="qty mono">${fmtNum(r.packQty, 0)}${escapeHtml(r.packUnit)} · ${fmtNum(totalBase(r))}${escapeHtml(r.baseUnit)}</span>
                <span class="who">${escapeHtml(r.purchaser || "—")}${r.note ? " · " + escapeHtml(r.note) : ""}</span>
                <button class="icon-btn icon-btn-sm" data-action="edit" data-id="${r.id}" aria-label="修改此筆">✏️</button>
                ${isConfirming
                  ? `<button class="icon-btn icon-btn-sm icon-btn-danger" data-action="confirm-delete" data-id="${r.id}">確定</button>`
                  : `<button class="icon-btn icon-btn-sm" data-action="ask-delete" data-id="${r.id}" aria-label="刪除此筆">🗑️</button>`}
              </div>`;
          }).join("")
        }</div>`
      : "";

    return `
      <div class="inv-card">
        <div class="inv-card-head ${expanded ? "expanded" : ""}">
          <div class="inv-card-top">
            <div>
              <span class="tag-pill cat-${cat}">${escapeHtml(g.category)}</span>
              <h3 class="hand inv-card-name">${escapeHtml(g.name)}</h3>
            </div>
            <button class="inv-toggle" data-action="toggle" data-key="${g.key}">${expanded ? "收合" : `${g.count} 筆`}</button>
          </div>
          <div class="inv-total">
            <span class="num mono">${fmtNum(g.total)}</span>
            <span class="unit">${escapeHtml(g.unit)} 現有庫存</span>
          </div>
          <div class="inv-last mono">最近購買 ${fmtDate(g.lastDate)}</div>
        </div>
        ${detailHtml}
      </div>`;
  }).join("");

  container.querySelectorAll("[data-action='toggle']").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.expandedKey = state.expandedKey === btn.dataset.key ? null : btn.dataset.key;
      renderInventory();
    });
  });
  container.querySelectorAll("[data-action='edit'], [data-action='ask-delete'], [data-action='confirm-delete']").forEach((btn) => {
    btn.addEventListener("click", () => handleRowAction(btn.dataset.action, btn.dataset.id));
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
