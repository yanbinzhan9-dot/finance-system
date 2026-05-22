const LEGACY_STORAGE_KEY = "finance-system-v1";
const THRESHOLD = 500000;
const expenseCategories = ["采购", "头程物流", "广告费", "平台费", "仓储费", "样品费", "软件工具", "服务费", "商标注册", "店铺订阅费", "差旅费", "其他支出"];
const incomeCategories = ["亚马逊回款", "样品收入", "赔付款", "利息收入", "汇率收益", "其他收入"];
const refundCategories = ["采购退款", "物流退款", "平台退款", "广告退款", "其他退款"];
const adjustmentCategories = ["期初调整", "汇率调整", "差额调整", "其他调整"];
const typeLabels = {
  expense: "支出",
  income: "收入",
  refund: "退款",
  settlement: "结算支付",
  adjustment: "调整"
};

let state = { entries: [], settlements: [] };
let pendingAttachments = [];
let editingAttachments = [];
let settlementPreviewData = null;
let editingSettlementId = "";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

async function loadState() {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error("load failed");
    const data = await response.json();
    state = normalizeState(data);
    await migrateLegacyLocalData();
    await backfillMissingRates();
  } catch {
    alert("无法连接本地数据服务。请用 start-finance-system.bat 启动系统。");
    state = { entries: [], settlements: [] };
  }
}

async function backfillMissingRates() {
  let changed = false;
  for (const entry of state.entries) {
    if (entry.currency !== "USD" || entry.exchangeRate) continue;
    try {
      const rateData = await fetchExchangeRate(entry.date || today());
      entry.exchangeRate = rateData.rate;
      entry.cnyAmount = Number(entry.amount || 0) * Number(rateData.rate);
      entry.note = appendRateNote(entry.note || "", rateData.date, rateData.rate);
      changed = true;
    } catch {
      // Keep pending; it can be filled next time.
    }
  }
  if (changed) await saveState();
}

async function fetchExchangeRate(date) {
  const response = await fetch(`/api/rate?date=${encodeURIComponent(date)}&base=USD&target=CNY`, { cache: "no-store" });
  if (!response.ok) throw new Error("rate failed");
  return response.json();
}

function normalizeState(data) {
  return {
    entries: Array.isArray(data?.entries) ? data.entries : [],
    settlements: Array.isArray(data?.settlements) ? data.settlements : []
  };
}

async function migrateLegacyLocalData() {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw || state.entries.length || state.settlements.length) return;
  try {
    const legacy = normalizeState(JSON.parse(raw));
    if (!legacy.entries.length && !legacy.settlements.length) return;
    state = legacy;
    await saveState();
    localStorage.setItem(`${LEGACY_STORAGE_KEY}-migrated`, "yes");
  } catch {
    // Ignore broken legacy browser-only data.
  }
}

async function saveState() {
  try {
    const response = await fetch("/api/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
    if (!response.ok) throw new Error("save failed");
    state = normalizeState(await response.json());
    return true;
  } catch {
    alert("保存失败：本地数据服务没有连接成功。请确认用 start-finance-system.bat 启动系统。");
    return false;
  }
}

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function money(value) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2
  }).format(Number(value) || 0);
}

function percent(value) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function getInvestmentObligation(netInvestment) {
  const first = Math.min(Math.max(netInvestment, 0), THRESHOLD);
  return {
    zhan: first * 0.6,
    lan: first * 0.4,
    pending: Math.max(netInvestment - THRESHOLD, 0)
  };
}

function getSummary(entries = state.entries) {
  const summary = {
    income: 0,
    expense: 0,
    refund: 0,
    netInvestment: 0,
    zhanPaid: 0,
    lanPaid: 0,
    lanSettled: 0,
    zhanReceived: 0,
    lanReceived: 0
  };

  entries.forEach((entry) => {
    const amount = Number(entry.cnyAmount) || 0;
    if (entry.type === "income") {
      summary.income += amount;
      if ((entry.receiver || entry.person) === "蓝") summary.lanReceived += amount;
      else summary.zhanReceived += amount;
    }
    if (entry.type === "expense") {
      summary.expense += amount;
      if (entry.person === "蓝") summary.lanPaid += amount;
      else summary.zhanPaid += amount;
    }
    if (entry.type === "refund") summary.refund += amount;
    if (entry.type === "settlement") {
      if (entry.person === "蓝" && entry.receiver === "詹") summary.lanSettled += amount;
      if (entry.person === "詹" && entry.receiver === "蓝") summary.lanSettled -= amount;
    }
  });

  summary.netInvestment = Math.max(summary.expense - summary.refund, 0);
  const obligation = getInvestmentObligation(summary.netInvestment);
  summary.zhanObligation = obligation.zhan;
  summary.lanObligation = obligation.lan;
  summary.pendingObligation = obligation.pending;
  summary.zhanContribution = summary.zhanPaid - summary.lanSettled;
  summary.lanContribution = summary.lanPaid + summary.lanSettled;
  summary.lanDue = summary.lanObligation - summary.lanContribution;
  summary.netResult = summary.income - summary.netInvestment;
  return summary;
}

function entriesInRange(start, end) {
  return state.entries.filter((entry) => {
    if (start && entry.date < start) return false;
    if (end && entry.date > end) return false;
    return true;
  });
}

function cumulativeSettlementForRange(start, end) {
  const beforeStart = start ? state.entries.filter((entry) => entry.date < start) : [];
  const throughEnd = end ? state.entries.filter((entry) => entry.date <= end) : state.entries;
  const before = getSummary(beforeStart);
  const after = getSummary(throughEnd);
  const period = getSummary(entriesInRange(start, end));

  return {
    start,
    end,
    periodInvestment: period.netInvestment,
    periodIncome: period.income,
    periodExpense: period.expense,
    periodRefund: period.refund,
    lanDueBefore: before.lanDue,
    lanDueAfter: after.lanDue,
    lanDuePeriod: after.lanDue - before.lanDue,
    lanPaidPeriod: period.lanPaid,
    zhanPaidPeriod: period.zhanPaid,
    netInvestmentAfter: after.netInvestment
  };
}

async function init() {
  $("#entryDate").value = today();
  $("#settlementDate").value = today();
  populateCategories();
  bindEvents();
  updateCurrencyFields();
  await loadState();
  renderAll();
}

function populateCategories() {
  const type = $("#entryType").value;
  const options = getCategoriesByType(type);
  $("#category").innerHTML = options.map((item) => `<option value="${item}">${item}</option>`).join("");
}

function getCategoriesByType(type) {
  if (type === "income") return incomeCategories;
  if (type === "refund") return refundCategories;
  if (type === "settlement") return ["结算"];
  if (type === "adjustment") return adjustmentCategories;
  return expenseCategories;
}

function bindEvents() {
  $$(".nav-tab").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
  $$("[data-jump]").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.jump)));
  $("#entryType").addEventListener("change", handleTypeChange);
  $("#currency").addEventListener("change", updateCurrencyFields);
  $("#currency").addEventListener("change", updateExchangeRateForDate);
  $("#entryDate").addEventListener("change", updateExchangeRateForDate);
  $("#amount").addEventListener("input", updateCurrencyFields);
  $("#exchangeRate").addEventListener("input", updateCurrencyFields);
  $("#attachments").addEventListener("change", handleAttachmentFiles);
  $("#entryForm").addEventListener("submit", saveEntry);
  $("#clearFormBtn").addEventListener("click", resetForm);
  $("#cancelEditBtn").addEventListener("click", resetForm);
  ["searchInput", "filterType", "filterPerson", "filterCurrency", "filterStart", "filterEnd"].forEach((id) => {
    $(`#${id}`).addEventListener("input", renderLedger);
  });
  $("#saveSettlementPaymentBtn").addEventListener("click", saveSettlementPayment);
  $("#cancelSettlementEditBtn").addEventListener("click", resetSettlementForm);
  $("#settlementFrom").addEventListener("change", syncSettlementReceiver);
  $("#exportBtn").addEventListener("click", exportData);
  $("#importInput").addEventListener("change", importData);
  $("#closeImageDialog").addEventListener("click", () => $("#imageDialog").close());
}

function switchView(viewId) {
  $$(".view").forEach((view) => view.classList.toggle("active", view.id === viewId));
  $$(".nav-tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === viewId));
}

function handleTypeChange() {
  const type = $("#entryType").value;
  populateCategories();
  if (type === "settlement") {
    $("#person").value = "蓝";
  }
}

function updateCurrencyFields() {
  const currency = $("#currency").value;
  const amount = Number($("#amount").value) || 0;
  if (currency === "CNY") {
    $("#exchangeRate").value = "1";
    $("#exchangeRate").disabled = true;
    $("#rateHint").textContent = "人民币账目固定为 1";
  } else {
    $("#exchangeRate").disabled = false;
    $("#rateHint").textContent = "正在按账目日期获取汇率...";
  }
  const rate = Number($("#exchangeRate").value) || 0;
  $("#cnyAmount").value = money(amount * rate);
}

async function updateExchangeRateForDate() {
  const currency = $("#currency").value;
  if (currency !== "USD") {
    updateCurrencyFields();
    return;
  }
  const date = $("#entryDate").value || today();
  $("#rateHint").textContent = "正在按账目日期获取汇率...";
  try {
    const data = await fetchExchangeRate(date);
    $("#exchangeRate").value = Number(data.rate).toFixed(4);
    updateCurrencyFields();
    $("#rateHint").textContent = `${data.date} USD/CNY ${Number(data.rate).toFixed(4)}`;
  } catch {
    $("#rateHint").textContent = "未能自动获取汇率，可手动填写";
  }
}

function handleAttachmentFiles(event) {
  const files = Array.from(event.target.files || []);
  Promise.all(files.map(readAndCompressImage)).then((items) => {
    pendingAttachments = items;
    renderAttachmentPreview();
  });
}

function readAndCompressImage(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        const maxSide = 1400;
        const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve({
          id: uid(),
          name: file.name,
          dataUrl: canvas.toDataURL("image/jpeg", 0.78)
        });
      };
      image.onerror = () => resolve({ id: uid(), name: file.name, dataUrl: reader.result });
      image.src = reader.result;
    };
    reader.onerror = () => resolve({ id: uid(), name: file.name, dataUrl: "" });
    reader.readAsDataURL(file);
  });
}

function attachmentSrc(file) {
  return file.url || file.dataUrl || "";
}

function renderAttachmentPreview() {
  const all = [...editingAttachments, ...pendingAttachments];
  $("#attachmentPreview").innerHTML = all.map((file) => `<img src="${attachmentSrc(file)}" alt="${file.name}">`).join("");
}

async function saveEntry(event) {
  event.preventDefault();
  const amount = Number($("#amount").value) || 0;
  const rate = Number($("#exchangeRate").value) || 0;
  const ratePending = $("#currency").value === "USD" && rate <= 0;

  const id = $("#editingId").value || uid();
  const entry = {
    id,
    date: $("#entryDate").value,
    type: $("#entryType").value,
    person: $("#person").value,
    receiver: getReceiverForEntry($("#entryType").value, $("#person").value),
    category: $("#category").value,
    amount,
    currency: $("#currency").value,
    exchangeRate: ratePending ? null : rate || 1,
    cnyAmount: ratePending ? 0 : amount * (rate || 1),
    productName: $("#productName").value.trim(),
    counterparty: "",
    note: buildNote($("#note").value.trim(), $("#currency").value, rate, ratePending),
    attachments: [...editingAttachments, ...pendingAttachments]
  };

  const index = state.entries.findIndex((item) => item.id === id);
  if (index >= 0) state.entries[index] = entry;
  else state.entries.push(entry);

  state.entries.sort((a, b) => b.date.localeCompare(a.date));
  if (!(await saveState())) return;
  resetForm();
  renderAll();
  switchView("ledger");
}

function getReceiverForEntry(type, person) {
  if (type === "settlement") return person === "蓝" ? "詹" : "蓝";
  return person;
}

function buildNote(note, currency, rate, ratePending = false) {
  if (currency !== "USD") return note;
  const date = $("#entryDate").value || today();
  if (ratePending) {
    const pendingText = `按 ${date} 实际汇率待补`;
    return note.includes(pendingText) ? note : [note, pendingText].filter(Boolean).join("；");
  }
  const rateText = `按 ${date} 实际汇率 ${rate} 折算`;
  return appendRateNote(note, date, rate);
}

function appendRateNote(note, date, rate) {
  const cleanNote = note
    .split("；")
    .filter((part) => !part.includes("实际汇率待补") && !part.includes("实际汇率 "))
    .join("；");
  const rateText = `按 ${date} 实际汇率 ${Number(rate).toFixed(4)} 折算`;
  return [cleanNote, rateText].filter(Boolean).join("；");
}

function resetForm() {
  $("#entryForm").reset();
  $("#editingId").value = "";
  $("#entryDate").value = today();
  $("#entryTitle").textContent = "记一笔账";
  pendingAttachments = [];
  editingAttachments = [];
  $("#attachments").value = "";
  $("#attachmentPreview").innerHTML = "";
  $("#exchangeRate").value = "1";
  updateCurrencyFields();
}

function editEntry(id) {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;
  $("#editingId").value = entry.id;
  $("#entryDate").value = entry.date;
  $("#entryType").value = entry.type;
  $("#person").value = entry.person;
  $("#category").value = entry.category;
  $("#amount").value = entry.amount;
  $("#currency").value = entry.currency;
  $("#exchangeRate").value = entry.exchangeRate || "";
  $("#productName").value = entry.productName || "";
  $("#note").value = entry.note;
  pendingAttachments = [];
  editingAttachments = entry.attachments || [];
  $("#entryTitle").textContent = "编辑账目";
  updateCurrencyFields();
  renderAttachmentPreview();
  switchView("entry");
}

async function deleteEntry(id) {
  if (!confirm("确定删除这条账目吗？")) return;
  state.entries = state.entries.filter((item) => item.id !== id);
  if (!(await saveState())) return;
  renderAll();
}

function renderAll() {
  renderDashboard();
  renderLedger();
  renderSettlementHistory();
}

function renderDashboard() {
  const summary = getSummary();
  $("#metricNetInvestment").textContent = money(summary.netInvestment);
  $("#metricThresholdProgress").textContent = percent(summary.netInvestment / THRESHOLD);
  $("#metricThresholdText").textContent = `${money(Math.min(summary.netInvestment, THRESHOLD))} / ${money(THRESHOLD)}`;
  $("#metricNetResult").textContent = money(summary.netResult);
  $("#zhanPaid").textContent = money(summary.zhanContribution);
  $("#lanPaid").textContent = money(summary.lanContribution);
  $("#zhanObligation").textContent = money(summary.zhanObligation);
  $("#lanObligation").textContent = money(summary.lanObligation);
  $("#zhanDiff").textContent = formatDiff(summary.zhanContribution - summary.zhanObligation);
  $("#lanDiff").textContent = formatDiff(summary.lanContribution - summary.lanObligation);
  $("#settlementHint").textContent = summary.pendingObligation > 0 ? "超过首期部分待确认" : "首期规则自动计算";
  $("#settlementReference").textContent = formatSettlementReference(summary.lanDue);

  const positiveZhan = Math.max(summary.zhanContribution, 0);
  const positiveLan = Math.max(summary.lanContribution, 0);
  const max = Math.max(positiveZhan, positiveLan, summary.zhanObligation, summary.lanObligation, 1);
  $("#zhanPaidBar").style.width = percent(positiveZhan / max);
  $("#lanPaidBar").style.width = percent(positiveLan / max);
  $("#zhanObligationBar").style.width = percent(summary.zhanObligation / max);
  $("#lanObligationBar").style.width = percent(summary.lanObligation / max);

  const recent = [...state.entries].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
  $("#recentRows").innerHTML = recent.length ? recent.map(renderRecentRow).join("") : emptyRow(8, "还没有账目，先记一笔。");
}

function renderRecentRow(entry) {
  const thumbs = renderAttachmentThumbs(entry, 2);
  return `<tr>
    <td>${entry.date}</td>
    <td>${typeBadge(entry.type)}</td>
    <td>${entry.person}</td>
    <td>${entry.productName || "-"}</td>
    <td>${entry.category}</td>
    <td>${formatEntryAmount(entry)}</td>
    <td>${thumbs || "-"}</td>
    <td>${entry.note || entry.counterparty || "-"}</td>
  </tr>`;
}

function getFilteredEntries() {
  const keyword = $("#searchInput").value.trim().toLowerCase();
  const type = $("#filterType").value;
  const person = $("#filterPerson").value;
  const currency = $("#filterCurrency").value;
  const start = $("#filterStart").value;
  const end = $("#filterEnd").value;

  return state.entries.filter((entry) => {
    const haystack = [entry.note, entry.productName, entry.category, entry.person, entry.receiver].join(" ").toLowerCase();
    if (keyword && !haystack.includes(keyword)) return false;
    if (type && entry.type !== type) return false;
    if (person && entry.person !== person && entry.receiver !== person) return false;
    if (currency && entry.currency !== currency) return false;
    if (start && entry.date < start) return false;
    if (end && entry.date > end) return false;
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date));
}

function renderLedger() {
  const entries = getFilteredEntries();
  const total = entries.reduce((sum, entry) => sum + (Number(entry.cnyAmount) || 0), 0);
  $("#filterSummary").textContent = `${entries.length} 条，合计 ${money(total)}`;
  $("#ledgerRows").innerHTML = entries.length ? entries.map(renderLedgerRow).join("") : emptyRow(9, "没有匹配的账目。");
}

function renderLedgerRow(entry) {
  const thumbs = renderAttachmentThumbs(entry, 3);
  return `<tr>
    <td>${entry.date}</td>
    <td>${typeBadge(entry.type)}</td>
    <td>${entry.person}</td>
    <td>${entry.productName || "-"}</td>
    <td>${entry.category}</td>
    <td>${formatEntryAmount(entry)}</td>
    <td>${entry.exchangeRate ? Number(entry.exchangeRate).toFixed(4) : "待补"}</td>
    <td>${thumbs || "-"}</td>
    <td>
      <div class="row-actions">
        <button class="icon-btn" title="编辑" onclick="editEntry('${entry.id}')">改</button>
        <button class="icon-btn" title="删除" onclick="deleteEntry('${entry.id}')">删</button>
      </div>
    </td>
  </tr>`;
}

function renderAttachmentThumbs(entry, limit) {
  return (entry.attachments || []).slice(0, limit).map((file) => {
    return `<img class="thumb" src="${attachmentSrc(file)}" alt="${file.name}" onclick="openImage('${entry.id}','${file.id}')">`;
  }).join("");
}

function formatEntryAmount(entry) {
  if (entry.currency === "USD") {
    const usd = `$${Number(entry.amount || 0).toFixed(2)}`;
    return entry.exchangeRate ? `${usd} / ${money(entry.cnyAmount)}` : `${usd} / 待补汇率`;
  }
  return money(entry.cnyAmount);
}

function typeBadge(type) {
  return `<span class="type-pill type-${type}">${typeLabels[type] || type}</span>`;
}

function emptyRow(cols, text) {
  return `<tr><td colspan="${cols}">${text}</td></tr>`;
}

function openImage(entryId, attachmentId) {
  const entry = state.entries.find((item) => item.id === entryId);
  const file = entry?.attachments?.find((item) => item.id === attachmentId);
  if (!file) return;
  $("#dialogImage").src = attachmentSrc(file);
  $("#imageDialog").showModal();
}

async function saveSettlementPayment() {
  const amount = Number($("#settlementAmount").value) || 0;
  if (amount <= 0) {
    alert("请填写本次结算金额。");
    return;
  }
  const date = $("#settlementDate").value || today();
  const from = $("#settlementFrom").value;
  const to = $("#settlementTo").value;
  if (from === to) {
    alert("付款人和收款人不能相同。");
    return;
  }
  const note = $("#settlementNote").value.trim() || `${from}转给${to}`;
  const entry = {
    id: editingSettlementId || uid(),
    date,
    type: "settlement",
    person: from,
    receiver: to,
    category: "结算",
    amount,
    currency: "CNY",
    exchangeRate: 1,
    cnyAmount: amount,
    productName: "",
    counterparty: "",
    note,
    attachments: []
  };
  const index = state.entries.findIndex((item) => item.id === editingSettlementId);
  if (index >= 0) state.entries[index] = entry;
  else state.entries.push(entry);
  state.entries.sort((a, b) => b.date.localeCompare(a.date));
  if (!(await saveState())) return;
  resetSettlementForm();
  renderAll();
}

function renderSettlementHistory() {
  const rows = state.entries
    .filter((entry) => entry.type === "settlement")
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);
  $("#settlementHistoryRows").innerHTML = rows.length
    ? rows.map((entry) => `<tr>
      <td>${entry.date}</td>
      <td>${entry.person} → ${entry.receiver || "-"}</td>
      <td>${money(entry.cnyAmount)}</td>
      <td>${entry.note || "-"}</td>
      <td><div class="row-actions"><button class="icon-btn" onclick="editSettlementPayment('${entry.id}')">改</button><button class="icon-btn" onclick="deleteSettlementPayment('${entry.id}')">删</button></div></td>
    </tr>`).join("")
    : emptyRow(5, "还没有结算记录。");
}

function editSettlementPayment(id) {
  const entry = state.entries.find((item) => item.id === id);
  if (!entry) return;
  editingSettlementId = id;
  $("#settlementDate").value = entry.date || today();
  $("#settlementFrom").value = entry.person || "蓝";
  $("#settlementTo").value = entry.receiver || "詹";
  $("#settlementAmount").value = entry.amount || entry.cnyAmount || "";
  $("#settlementNote").value = entry.note || "";
  $("#saveSettlementPaymentBtn").textContent = "保存修改";
  $("#cancelSettlementEditBtn").style.display = "inline-flex";
}

async function deleteSettlementPayment(id) {
  if (!confirm("确定删除这条结算记录吗？")) return;
  state.entries = state.entries.filter((entry) => entry.id !== id);
  if (!(await saveState())) return;
  if (editingSettlementId === id) resetSettlementForm();
  renderAll();
}

function resetSettlementForm() {
  editingSettlementId = "";
  $("#settlementDate").value = today();
  $("#settlementFrom").value = "蓝";
  $("#settlementTo").value = "詹";
  $("#settlementAmount").value = "";
  $("#settlementNote").value = "";
  $("#saveSettlementPaymentBtn").textContent = "记录结算";
  $("#cancelSettlementEditBtn").style.display = "none";
}

function syncSettlementReceiver() {
  $("#settlementTo").value = $("#settlementFrom").value === "詹" ? "蓝" : "詹";
}

function formatSettlementReference(lanDue) {
  if (lanDue > 0) return `参考：蓝应支付詹 ${money(lanDue)}`;
  if (lanDue < 0) return `参考：詹应支付蓝 ${money(Math.abs(lanDue))}`;
  return "参考：双方暂无待结算差额";
}

function formatDiff(value) {
  if (value > 0) return `多 ${money(value)}`;
  if (value < 0) return `少 ${money(Math.abs(value))}`;
  return "持平";
}

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `财务系统备份-${today()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = normalizeState(JSON.parse(reader.result));
      state = imported;
      if (!(await saveState())) return;
      renderAll();
      alert("导入完成。");
    } catch {
      alert("导入失败，请选择有效的备份文件。");
    }
  };
  reader.readAsText(file);
}

window.editEntry = editEntry;
window.deleteEntry = deleteEntry;
window.openImage = openImage;
window.editSettlementPayment = editSettlementPayment;
window.deleteSettlementPayment = deleteSettlementPayment;

init();
