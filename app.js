const storageKey = "night-space-state";
const syncStorageKey = "night-space-github-sync";
const syncFileName = "yb-study-sync.json";
const weekdays = ["週一", "週二", "週三", "週四", "週五"];
const defaultSubjects = ["國文", "英文", "數學", "物理", "化學", "生物", "歷史", "地理", "公民"];
const taskTypes = { exam: "考試", homework: "作業", practice: "練習" };
const taskLists = { exam: "#exam-list", homework: "#homework-list", practice: "#daily-list" };

let toastTimer;
let swRegistration = null;
let selectedPackingDay = "today";
let chatRequestInProgress = false;
let timetableScanInProgress = false;
let syncTimer;
let syncInProgress = false;
let syncSettings = { token: "", gistId: "", updatedAt: 0, lastSyncedAt: 0 };
let syncStatus = "未設定";
let state = createDefaultState();

function createDefaultState() {
  return {
    focusMinutes: 0,
    completedCount: 0,
    tasks: [],
    bookmarks: [],
    timetable: Array.from({ length: 8 }, () => Array(5).fill("")),
    bindings: {},
    packingTime: "21:30",
    packingChecked: {},
    lastReminderDate: "",
    aiConfig: { provider: "openai", baseUrl: "", apiKey: "", textModel: "", visionModel: "" },
    chatMessages: []
  };
}

function normalizeState(saved) {
  const normalized = createDefaultState();
  normalized.focusMinutes = Number.isFinite(saved.focusMinutes) ? saved.focusMinutes : 0;
  normalized.completedCount = Number.isFinite(saved.completedCount) ? saved.completedCount : 0;
  normalized.tasks = Array.isArray(saved.tasks) ? saved.tasks.map((task) => ({
    ...task,
    type: taskTypes[task.type] ? task.type : "homework",
    subject: typeof task.subject === "string" ? task.subject : "",
    scope: typeof task.scope === "string" ? task.scope : "",
    goal: typeof task.goal === "string" ? task.goal : "",
    completed: Boolean(task.completed),
    completedOn: typeof task.completedOn === "string" ? task.completedOn : ""
  })) : [];
  normalized.tasks.forEach((task) => {
    if (task.type === "practice" && task.completed && !task.completedOn) {
      task.completedOn = localDateString(new Date());
      task.completed = false;
    }
  });
  normalized.bookmarks = Array.isArray(saved.bookmarks) ? saved.bookmarks : [];
  normalized.timetable = Array.from({ length: 8 }, (_, period) =>
    Array.from({ length: 5 }, (_, day) =>
      typeof saved.timetable?.[period]?.[day] === "string" ? saved.timetable[period][day] : ""
    )
  );
  normalized.bindings = saved.bindings && typeof saved.bindings === "object" && !Array.isArray(saved.bindings) ? saved.bindings : {};
  normalized.packingTime = /^\d{2}:\d{2}$/.test(saved.packingTime || "") ? saved.packingTime : "21:30";
  normalized.packingChecked = saved.packingChecked && typeof saved.packingChecked === "object" ? saved.packingChecked : {};
  normalized.lastReminderDate = typeof saved.lastReminderDate === "string" ? saved.lastReminderDate : "";
  const savedAiConfig = saved.aiConfig && typeof saved.aiConfig === "object" ? saved.aiConfig : {};
  normalized.aiConfig = {
    provider: ["openai", "ollama", "gemini"].includes(savedAiConfig.provider) ? savedAiConfig.provider : "openai",
    baseUrl: typeof savedAiConfig.baseUrl === "string" ? savedAiConfig.baseUrl : "",
    apiKey: typeof savedAiConfig.apiKey === "string" ? savedAiConfig.apiKey : "",
    textModel: typeof savedAiConfig.textModel === "string" ? savedAiConfig.textModel : "",
    visionModel: typeof savedAiConfig.visionModel === "string" ? savedAiConfig.visionModel : ""
  };
  normalized.chatMessages = Array.isArray(saved.chatMessages)
    ? saved.chatMessages.filter((message) =>
      message && ["user", "assistant"].includes(message.role) && typeof message.content === "string"
    ).slice(-40)
    : [];
  return normalized;
}

try {
  state = normalizeState(JSON.parse(localStorage.getItem(storageKey) || "{}"));
} catch (error) {
  console.warn("無法讀取已儲存的使用狀態。", error);
}

try {
  const savedSyncSettings = JSON.parse(localStorage.getItem(syncStorageKey) || "{}");
  syncSettings = {
    token: typeof savedSyncSettings.token === "string" ? savedSyncSettings.token : "",
    gistId: typeof savedSyncSettings.gistId === "string" ? savedSyncSettings.gistId : "",
    updatedAt: Number.isFinite(savedSyncSettings.updatedAt) ? savedSyncSettings.updatedAt : 0,
    lastSyncedAt: Number.isFinite(savedSyncSettings.lastSyncedAt) ? savedSyncSettings.lastSyncedAt : 0
  };
} catch (error) {
  console.warn("無法讀取 GitHub 同步設定。", error);
}

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function saveState() {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state));
    syncSettings.updatedAt = Date.now();
    saveSyncSettings();
    scheduleCloudUpload();
  } catch (error) {
    console.error("無法儲存使用狀態。", error);
    showToast("儲存失敗，請檢查瀏覽器儲存空間。");
  }
}

function saveSyncSettings() {
  try {
    localStorage.setItem(syncStorageKey, JSON.stringify(syncSettings));
  } catch (error) {
    console.error("無法儲存 GitHub 同步設定。", error);
    showToast("同步設定儲存失敗，請檢查瀏覽器儲存空間。");
  }
}

function setSyncStatus(status) {
  syncStatus = status;
  const statusElement = document.querySelector("#github-sync-status");
  const lastSyncedElement = document.querySelector("#github-sync-last-time");
  if (!statusElement || !lastSyncedElement) return;
  statusElement.textContent = status;
  statusElement.classList.toggle("is-connected", status === "已同步");
  lastSyncedElement.textContent = syncSettings.lastSyncedAt
    ? new Intl.DateTimeFormat("zh-TW", { dateStyle: "short", timeStyle: "short" }).format(syncSettings.lastSyncedAt)
    : "尚未同步";
}

function persistSyncForm() {
  syncSettings.token = document.querySelector("#github-token").value.trim();
  syncSettings.gistId = document.querySelector("#github-gist-id").value.trim();
  saveSyncSettings();
  if (!syncSettings.token) {
    window.clearTimeout(syncTimer);
    setSyncStatus("未設定");
  } else if (syncStatus === "未設定" || syncStatus === "已同步") {
    setSyncStatus("待同步");
  }
}

function scheduleCloudUpload() {
  if (!syncSettings.token) return;
  window.clearTimeout(syncTimer);
  syncTimer = window.setTimeout(() => {
    uploadToGist({ manual: false }).catch((error) => {
      console.error("GitHub Gist 自動同步失敗：", error);
      setSyncStatus("同步失敗");
    });
  }, 2000);
}

function createCloudDocument() {
  const cloudState = JSON.parse(JSON.stringify(state));
  cloudState.aiConfig.apiKey = "";
  return {
    updatedAt: syncSettings.updatedAt || Date.now(),
    data: cloudState
  };
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${syncSettings.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers
    }
  });
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body.message === "string" ? `：${body.message}` : "";
    } catch (error) {
      console.warn("無法讀取 GitHub API 錯誤內容。", error);
    }
    throw new Error(`GitHub API 錯誤 (${response.status})${detail}`);
  }
  return response.json();
}

async function uploadToGist({ manual = true } = {}) {
  persistSyncForm();
  if (!syncSettings.token) throw new Error("請先填寫 GitHub Token。");
  if (syncInProgress) {
    if (!manual) {
      scheduleCloudUpload();
      return;
    }
    throw new Error("另一項同步作業仍在進行中。");
  }
  if (!syncSettings.updatedAt) {
    syncSettings.updatedAt = Date.now();
    saveSyncSettings();
  }
  syncInProgress = true;
  setSyncStatus("同步中");
  try {
    const cloudDocument = createCloudDocument();
    const requestBody = {
      description: "學業中控 App 自動同步資料",
      files: { [syncFileName]: { content: JSON.stringify(cloudDocument) } }
    };
    const gist = syncSettings.gistId
      ? await githubRequest(`/gists/${encodeURIComponent(syncSettings.gistId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody)
      })
      : await githubRequest("/gists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...requestBody, public: false })
      });
    if (!gist.id) throw new Error("GitHub 未回傳有效的 Gist ID。");
    syncSettings.gistId = gist.id;
    syncSettings.lastSyncedAt = Date.now();
    saveSyncSettings();
    document.querySelector("#github-gist-id").value = gist.id;
    setSyncStatus("已同步");
    if (manual) showToast("資料已上傳至 GitHub Gist。");
    if (syncSettings.updatedAt !== cloudDocument.updatedAt) scheduleCloudUpload();
  } finally {
    syncInProgress = false;
  }
}

async function pullFromGist() {
  persistSyncForm();
  if (!syncSettings.token) throw new Error("請先填寫 GitHub Token。");
  if (!syncSettings.gistId) throw new Error("請先填入 Gist ID，或先使用「立即上傳同步」建立 Gist。");
  if (syncInProgress) throw new Error("另一項同步作業仍在進行中。");
  syncInProgress = true;
  setSyncStatus("同步中");
  try {
    const gist = await githubRequest(`/gists/${encodeURIComponent(syncSettings.gistId)}`);
    const file = gist.files && gist.files[syncFileName];
    if (!file || typeof file.content !== "string") {
      throw new Error(`Gist 中找不到 ${syncFileName}。`);
    }
    const cloudDocument = JSON.parse(file.content);
    if (!cloudDocument || !Number.isFinite(cloudDocument.updatedAt) || !cloudDocument.data || typeof cloudDocument.data !== "object") {
      throw new Error("Gist 同步資料格式無效。");
    }
    if (cloudDocument.updatedAt > syncSettings.updatedAt) {
      const localApiKey = state.aiConfig.apiKey;
      state = normalizeState(cloudDocument.data);
      state.aiConfig.apiKey = localApiKey;
      localStorage.setItem(storageKey, JSON.stringify(state));
      syncSettings.updatedAt = cloudDocument.updatedAt;
      syncSettings.lastSyncedAt = Date.now();
      saveSyncSettings();
      renderDate();
      renderTasks();
      renderBookmarks();
      renderTimetable();
      renderBindings();
      renderPacking();
      renderNotificationStatus();
      renderAiConfig();
      renderChat();
      document.querySelector("#packing-time").value = state.packingTime;
      setSyncStatus("已同步");
      showToast("已從 GitHub Gist 套用較新的資料。");
    } else {
      syncSettings.lastSyncedAt = Date.now();
      saveSyncSettings();
      setSyncStatus("已同步");
      showToast("本機資料較新或相同，未覆蓋本機資料。");
      if (syncSettings.updatedAt > cloudDocument.updatedAt) scheduleCloudUpload();
    }
  } finally {
    syncInProgress = false;
  }
}

async function runSync(action) {
  try {
    await action();
  } catch (error) {
    console.error("GitHub Gist 同步失敗：", error);
    setSyncStatus("同步失敗");
    showToast(error.message || "GitHub Gist 同步失敗，請檢查連線與設定。");
  }
}

function renderSyncSettings() {
  document.querySelector("#github-token").value = syncSettings.token;
  document.querySelector("#github-gist-id").value = syncSettings.gistId;
  setSyncStatus(syncSettings.token ? (syncSettings.lastSyncedAt ? "已同步" : "待同步") : "未設定");
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function taskCompleted(task) {
  return task.type === "practice"
    ? task.completedOn === localDateString(new Date())
    : Boolean(task.completed);
}

function formatDate(dateString) {
  if (!dateString) return "未設定日期";
  const date = new Date(`${dateString}T00:00:00`);
  return new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric" }).format(date);
}

function daysUntil(dateString) {
  if (!dateString) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateString}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function renderDate() {
  const now = new Date();
  document.querySelector("#date-label").textContent = new Intl.DateTimeFormat("zh-TW", {
    month: "long",
    day: "numeric",
    weekday: "long"
  }).format(now);
}

function renderTasks() {
  const today = localDateString(new Date());
  const groups = { exam: [], homework: [], practice: [] };
  state.tasks.forEach((task) => {
    if (groups[task.type]) groups[task.type].push(task);
  });

  Object.entries(groups).forEach(([type, tasks]) => {
    const list = document.querySelector(taskLists[type]);
    list.replaceChildren();
    tasks.sort((a, b) => {
      const dateOrder = (a.date || "9999").localeCompare(b.date || "9999");
      if (dateOrder !== 0) return dateOrder;
      return String(a.title).localeCompare(String(b.title), "zh-Hant");
    });

    if (!tasks.length) {
      list.append(makeElement("p", "empty-state", type === "practice" ? "尚未建立每日練習" : "沒有排定項目"));
    }

    tasks.forEach((task) => {
      const done = taskCompleted(task);
      const overdue = type === "homework" && !done && task.date && (
        task.date < today || (task.date === today && task.time && task.time < new Date().toTimeString().slice(0, 5))
      );
      const row = makeElement("article", `task-row${done ? " is-complete" : ""}${overdue ? " is-overdue" : ""}`);
      const checkbox = makeElement("input", "task-toggle");
      checkbox.type = "checkbox";
      checkbox.checked = done;
      checkbox.dataset.taskAction = "toggle";
      checkbox.dataset.taskId = task.id;
      checkbox.setAttribute("aria-label", `標記「${task.title}」${done ? "未完成" : "完成"}`);

      const copy = makeElement("div", "task-copy");
      copy.append(makeElement("strong", "task-name", task.title));
      const meta = [];
      if (task.subject) meta.push(task.subject);
      if (type === "exam" && task.scope) meta.push(`範圍：${task.scope}`);
      if (type === "practice" && task.goal) meta.push(task.goal);
      if (type === "exam" || type === "homework") {
        meta.push(`${type === "exam" ? "考期" : "期限"} ${formatDate(task.date)}${task.time ? ` ${task.time}` : ""}`);
      }
      if (overdue) meta.push("逾期");
      if (meta.length) copy.append(makeElement("span", "task-meta", meta.join(" · ")));

      const actions = makeElement("div", "task-actions");
      if (type === "exam" && task.date && !done) {
        const days = daysUntil(task.date);
        const countdown = days === 0 ? "D-Day" : days > 0 ? `D-${days}` : `D+${Math.abs(days)}`;
        actions.append(makeElement("span", `countdown${days <= 3 ? " is-soon" : ""}`, countdown));
      }
      const editButton = makeElement("button", "row-action", "編輯");
      editButton.type = "button";
      editButton.dataset.taskAction = "edit";
      editButton.dataset.taskId = task.id;
      editButton.setAttribute("aria-label", `編輯「${task.title}」`);
      const deleteButton = makeElement("button", "row-action delete-action", "刪除");
      deleteButton.type = "button";
      deleteButton.dataset.taskAction = "delete";
      deleteButton.dataset.taskId = task.id;
      deleteButton.setAttribute("aria-label", `刪除「${task.title}」`);
      actions.append(editButton, deleteButton);
      row.append(checkbox, copy, actions);
      list.append(row);
    });
  });

  const dailyTasks = groups.practice;
  const dailyDone = dailyTasks.filter(taskCompleted).length;
  const dailyPercent = dailyTasks.length ? (dailyDone / dailyTasks.length) * 100 : 0;
  document.querySelector("#daily-count").textContent = String(dailyTasks.length);
  document.querySelector("#daily-progress-label").textContent = `${dailyDone} / ${dailyTasks.length} 完成`;
  document.querySelector("#daily-progress").style.width = `${dailyPercent}%`;
  document.querySelector("#exam-count").textContent = String(groups.exam.length);
  document.querySelector("#homework-count").textContent = String(groups.homework.length);
  const openCount = state.tasks.filter((task) => !taskCompleted(task)).length;
  document.querySelector("#open-task-count").textContent = String(openCount);
}

function updateTaskFields() {
  const type = document.querySelector("#task-type").value;
  const isPractice = type === "practice";
  const isExam = type === "exam";
  document.querySelector("#task-date-field").classList.toggle("hidden", isPractice);
  document.querySelector("#task-time-field").classList.toggle("hidden", type !== "homework");
  document.querySelector("#task-scope-field").classList.toggle("hidden", !isExam);
  document.querySelector("#task-goal-field").classList.toggle("hidden", !isPractice);
  document.querySelector("#task-date").required = !isPractice;
  document.querySelector("#task-goal").required = isPractice;
  document.querySelector("#task-subject").required = !isPractice;
}

function openTaskDialog(task) {
  const form = document.querySelector("#task-form");
  form.reset();
  document.querySelector("#task-dialog-title").textContent = task ? "編輯項目" : "新增項目";
  document.querySelector("#task-id").value = task?.id || "";
  document.querySelector("#task-type").value = task?.type || "exam";
  document.querySelector("#task-title").value = task?.title || "";
  document.querySelector("#task-subject").value = task?.subject || "";
  document.querySelector("#task-scope").value = task?.scope || "";
  document.querySelector("#task-date").value = task?.date || "";
  document.querySelector("#task-time").value = task?.time || "";
  document.querySelector("#task-goal").value = task?.goal || "";
  updateTaskFields();
  document.querySelector("#task-dialog").showModal();
  document.querySelector("#task-title").focus();
}

function closeTaskDialog() {
  document.querySelector("#task-dialog").close();
}

function renderBookmarks() {
  const grid = document.querySelector("#bookmark-grid");
  grid.replaceChildren();
  if (!state.bookmarks.length) {
    grid.append(makeElement("p", "empty-state", "尚未新增常用連結"));
    return;
  }
  state.bookmarks.forEach((bookmark) => {
    const card = makeElement("article", "bookmark-card");
    const link = document.createElement("a");
    link.className = "bookmark-link";
    link.href = bookmark.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const icon = makeElement("span", "bookmark-icon", bookmark.name.trim().charAt(0).toUpperCase() || "↗");
    icon.setAttribute("aria-hidden", "true");
    const copy = makeElement("span", "bookmark-copy");
    copy.append(makeElement("strong", "", bookmark.name));
    let domain = bookmark.url;
    try {
      domain = new URL(bookmark.url).hostname.replace(/^www\./, "");
    } catch (error) {
      console.warn("已略過格式錯誤的捷徑網址。", error);
    }
    copy.append(makeElement("span", "", domain));
    link.append(icon, copy);
    link.setAttribute("aria-label", `在新分頁開啟 ${bookmark.name}`);
    const removeButton = makeElement("button", "bookmark-delete", "×");
    removeButton.type = "button";
    removeButton.dataset.bookmarkId = bookmark.id;
    removeButton.setAttribute("aria-label", `刪除「${bookmark.name}」捷徑`);
    card.append(link, removeButton);
    grid.append(card);
  });
}

function renderTimetable() {
  const body = document.querySelector("#timetable-body");
  body.replaceChildren();
  for (let period = 0; period < 8; period += 1) {
    const row = document.createElement("tr");
    row.append(makeElement("th", "", String(period + 1)));
    for (let day = 0; day < 5; day += 1) {
      const cell = document.createElement("td");
      const input = makeElement("input", "timetable-input");
      input.type = "text";
      input.maxLength = 24;
      input.value = state.timetable[period][day];
      input.dataset.period = String(period);
      input.dataset.day = String(day);
      input.setAttribute("aria-label", `${weekdays[day]}第 ${period + 1} 節`);
      input.placeholder = "—";
      cell.append(input);
      row.append(cell);
    }
    body.append(row);
  }
}

function allBindingSubjects() {
  return [...new Set([
    ...defaultSubjects,
    ...Object.keys(state.bindings),
    ...state.timetable.flat().filter(Boolean),
    ...state.tasks.map((task) => task.subject).filter(Boolean)
  ])]
    .sort((a, b) => {
      const ai = defaultSubjects.indexOf(a);
      const bi = defaultSubjects.indexOf(b);
      if (ai >= 0 && bi >= 0) return ai - bi;
      if (ai >= 0) return -1;
      if (bi >= 0) return 1;
      return a.localeCompare(b, "zh-Hant");
    });
}

function renderBindings() {
  const grid = document.querySelector("#binding-grid");
  grid.replaceChildren();
  allBindingSubjects().forEach((subject) => {
    const row = makeElement("div", "binding-row");
    const label = makeElement("label", "", subject);
    const input = makeElement("input", "binding-input");
    input.type = "text";
    input.maxLength = 160;
    input.value = Array.isArray(state.bindings[subject]) ? state.bindings[subject].join("，") : "";
    input.placeholder = "課本、講義";
    input.dataset.subject = subject;
    input.id = `binding-${encodeURIComponent(subject)}`;
    label.htmlFor = input.id;
    row.append(label, input);
    grid.append(row);
  });
}

function packingBooks(offset) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const day = date.getDay() - 1;
  if (day < 0 || day > 4) return { date, subjects: [], books: [] };
  const subjects = [...new Set(state.timetable.map((period) => period[day].trim()).filter(Boolean))];
  const books = [];
  subjects.forEach((subject) => {
    const linkedBooks = Array.isArray(state.bindings[subject]) ? state.bindings[subject].filter((book) => book.trim()) : [];
    if (linkedBooks.length) linkedBooks.forEach((book) => books.push(book.trim()));
    else books.push(`${subject}（尚未設定講義）`);
  });
  return { date, subjects, books: [...new Set(books)] };
}

function renderPacking() {
  const offset = selectedPackingDay === "tomorrow" ? 1 : 0;
  const { date, subjects, books } = packingBooks(offset);
  const list = document.querySelector("#packing-list");
  list.replaceChildren();
  if (date.getDay() === 0 || date.getDay() === 6) {
    list.append(makeElement("p", "empty-state", "週末沒有平日課表"));
    return;
  }
  if (!subjects.length) {
    list.append(makeElement("p", "empty-state", "這天尚未安排課程"));
    return;
  }
  const dateKey = localDateString(date);
  books.forEach((book) => {
    const label = makeElement("label", "packing-item");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(state.packingChecked[`${dateKey}|${book}`]);
    checkbox.dataset.packKey = `${dateKey}|${book}`;
    label.append(checkbox, makeElement("span", "", book));
    list.append(label);
  });
}

function renderNotificationStatus() {
  const status = document.querySelector("#notification-status");
  const button = document.querySelector("#notification-button");
  if (!("Notification" in window)) {
    status.textContent = "此瀏覽器不支援通知";
    button.disabled = true;
  } else if (Notification.permission === "granted") {
    status.textContent = `每日 ${state.packingTime} 提醒準備明天的課本`;
    button.textContent = "通知已啟用";
    button.disabled = true;
  } else if (Notification.permission === "denied") {
    status.textContent = "通知權限已封鎖";
    button.textContent = "通知已封鎖";
    button.disabled = true;
  } else {
    status.textContent = `每日 ${state.packingTime} 提醒準備明天的課本`;
    button.textContent = "啟用提醒";
    button.disabled = false;
  }
}

async function requestNotifications() {
  if (!("Notification" in window)) {
    showToast("此瀏覽器不支援通知功能。");
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    renderNotificationStatus();
    showToast(permission === "granted" ? "已啟用書包提醒。" : "尚未取得通知權限。");
  } catch (error) {
    console.error("無法取得通知權限：", error);
    showToast("無法啟用通知，請檢查瀏覽器權限。");
  }
}

async function checkPackingReminder() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const now = new Date();
  if (now.toTimeString().slice(0, 5) < state.packingTime) return;
  const today = localDateString(now);
  if (state.lastReminderDate === today) return;
  const { books } = packingBooks(1);
  const pendingStudy = state.tasks
    .filter((task) => !taskCompleted(task))
    .slice(0, 3)
    .map((task) => task.title);
  const reminderParts = [];
  if (books.length) reminderParts.push(`明天帶：${books.slice(0, 5).join("、")}${books.length > 5 ? "…" : ""}`);
  if (pendingStudy.length) reminderParts.push(`待讀：${pendingStudy.join("、")}`);
  const body = reminderParts.join("；") || "明天課表尚未安排，請先確認課程。";
  try {
    if (swRegistration) {
      await swRegistration.showNotification("書包提醒", { body, icon: "./icon-192.svg", tag: "packing-reminder" });
    } else {
      new Notification("書包提醒", { body, tag: "packing-reminder" });
    }
    state.lastReminderDate = today;
    saveState();
  } catch (error) {
    console.error("無法發送書包提醒：", error);
    showToast("通知發送失敗，請檢查瀏覽器設定。");
  }
}

function getAiConfig(modelField) {
  const config = state.aiConfig;
  const requiredModel = modelField || "textModel";
  if (!config.baseUrl.trim()) throw new Error("請先在「設定」填入 API Base URL。");
  if (!config[requiredModel].trim()) {
    throw new Error(requiredModel === "visionModel" ? "請先在「設定」填入視覺模型名稱。" : "請先在「設定」填入文字模型名稱。");
  }
  if (config.provider === "gemini" && !config.apiKey.trim()) throw new Error("Gemini API 需要 API Key。");
  return config;
}

function apiEndpoint(baseUrl, path) {
  return `${baseUrl.trim().replace(/\/+$/, "")}/${path}`;
}

function extractResponseText(payload) {
  if (typeof payload?.choices?.[0]?.message?.content === "string") return payload.choices[0].message.content;
  if (Array.isArray(payload?.choices?.[0]?.message?.content)) {
    return payload.choices[0].message.content.map((part) => part.text || "").join("");
  }
  if (typeof payload?.message?.content === "string") return payload.message.content;
  if (Array.isArray(payload?.candidates?.[0]?.content?.parts)) {
    return payload.candidates[0].content.parts.map((part) => part.text || "").join("");
  }
  throw new Error("AI 回應格式不符合預期，沒有找到文字內容。");
}

async function requestAi(messages, options = {}) {
  const config = getAiConfig(options.modelField);
  const model = options.model || config.textModel;
  const headers = { "Content-Type": "application/json" };
  let url;
  let body;

  if (config.provider === "gemini") {
    url = apiEndpoint(config.baseUrl, `models/${encodeURIComponent(model)}:generateContent`);
    const contents = messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        const parts = [];
        if (typeof message.content === "string") {
          parts.push({ text: message.content });
        } else {
          parts.push(...message.content);
        }
        return { role: message.role === "assistant" ? "model" : "user", parts };
      });
    const systemMessage = messages.find((message) => message.role === "system");
    body = {
      contents,
      ...(systemMessage ? { systemInstruction: { parts: [{ text: systemMessage.content }] } } : {})
    };
    url += `?key=${encodeURIComponent(config.apiKey)}`;
  } else if (config.provider === "ollama") {
    const base = config.baseUrl.trim().replace(/\/+$/, "");
    url = /\/api\/chat$/i.test(base) ? base : apiEndpoint(base.replace(/\/api$/i, ""), "api/chat");
    body = {
      model,
      stream: false,
      messages: messages.map((message) => ({
        role: message.role,
        content: typeof message.content === "string" ? message.content : message.content.find((part) => part.text)?.text || "",
        ...(message.images ? { images: message.images } : {})
      }))
    };
    if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  } else {
    const base = config.baseUrl.trim().replace(/\/+$/, "");
    url = /\/chat\/completions$/i.test(base) ? base : apiEndpoint(base, "chat/completions");
    body = { model, messages, stream: false };
    if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  }

  let response;
  try {
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (error) {
    throw new Error(`無法連線至 AI API（可能是網路、CORS 或 Base URL 設定問題）：${error.message}`);
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`AI API 回應 ${response.status}：${detail.slice(0, 500)}`);
  }
  return extractResponseText(await response.json());
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]);
}

function renderMarkdown(text) {
  if (!window.marked || !window.DOMPurify) return escapeHtml(text).replace(/\n/g, "<br>");
  const renderer = new window.marked.Renderer();
  renderer.code = ({ text: code, lang }) => {
    const language = typeof lang === "string" && /^[\w+-]+$/.test(lang) ? lang : "";
    const highlighted = language && window.hljs?.getLanguage(language)
      ? window.hljs.highlight(code, { language }).value
      : escapeHtml(code);
    return `<pre><code class="hljs${language ? ` language-${language}` : ""}">${highlighted}</code></pre>`;
  };
  const html = window.marked.parse(text, { gfm: true, breaks: true, renderer });
  return window.DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["img", "style", "iframe", "video", "audio", "form"]
  });
}

function renderChat() {
  const container = document.querySelector("#chat-messages");
  container.replaceChildren();
  if (!state.chatMessages.length) {
    container.append(makeElement("p", "chat-empty", "連線設定完成後，在下方輸入問題開始對話。"));
  }
  state.chatMessages.forEach((message) => {
    const article = makeElement("article", `chat-message ${message.role === "user" ? "user-message" : "assistant-message"}`);
    article.append(makeElement("span", "message-role", message.role === "user" ? "你" : "AI 助教"));
    const content = makeElement("div", "message-content");
    content.innerHTML = renderMarkdown(message.content);
    article.append(content);
    container.append(article);
  });
  container.scrollTop = container.scrollHeight;
}

function renderAiConfig() {
  const form = document.querySelector("#ai-settings-form");
  form.elements.provider.value = state.aiConfig.provider;
  form.elements.baseUrl.value = state.aiConfig.baseUrl;
  form.elements.apiKey.value = state.aiConfig.apiKey;
  form.elements.textModel.value = state.aiConfig.textModel;
  form.elements.visionModel.value = state.aiConfig.visionModel;
  const ready = Boolean(state.aiConfig.baseUrl.trim() && state.aiConfig.textModel.trim() && state.aiConfig.visionModel.trim());
  const connection = document.querySelector("#ai-connection-state");
  connection.textContent = ready ? "已設定" : "未設定";
  connection.classList.toggle("is-connected", ready);
  const chatStatus = document.querySelector("#chat-status");
  chatStatus.textContent = state.aiConfig.baseUrl && state.aiConfig.textModel
    ? `模型：${state.aiConfig.textModel}`
    : "先到「設定」填入 AI 連線資訊";
}

function imageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result !== "string") {
        reject(new Error("無法讀取圖片資料。"));
        return;
      }
      resolve(reader.result);
    });
    reader.addEventListener("error", () => reject(new Error("圖片讀取失敗。")));
    reader.readAsDataURL(file);
  });
}

function parseTimetableResponse(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (error) {
    const objectText = cleaned.match(/\{[\s\S]*\}/)?.[0];
    if (!objectText) throw new Error("視覺模型沒有回傳有效 JSON。");
    try {
      parsed = JSON.parse(objectText);
    } catch (parseError) {
      throw new Error("視覺模型回傳的 JSON 格式無效。");
    }
  }
  const matrix = parsed.timetable;
  if (!Array.isArray(matrix) || matrix.length !== 8 || matrix.some((row) =>
    !Array.isArray(row) || row.length !== 5 || row.some((cell) => typeof cell !== "string")
  )) {
    throw new Error("課表 JSON 必須包含 8 列、每列 5 個文字欄位的 timetable。");
  }
  return matrix.map((row) => row.map((cell) => cell.trim().slice(0, 24)));
}

async function scanTimetable(file) {
  const status = document.querySelector("#scan-status");
  const input = document.querySelector("#timetable-image");
  if (timetableScanInProgress) {
    input.value = "";
    return;
  }
  if (!file.type.startsWith("image/")) {
    showToast("請選擇圖片檔案。");
    input.value = "";
    return;
  }
  if (file.size > 15 * 1024 * 1024) {
    showToast("圖片需小於 15 MB，請先縮小圖片。");
    input.value = "";
    return;
  }
  let config;
  try {
    config = getAiConfig("visionModel");
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message);
    input.value = "";
    return;
  }

  const scanButton = document.querySelector(".upload-button");
  timetableScanInProgress = true;
  input.disabled = true;
  scanButton.setAttribute("aria-disabled", "true");
  status.textContent = "正在上傳圖片並分析課表…";
  try {
    const dataUrl = await imageToDataUrl(file);
    const base64 = dataUrl.split(",")[1];
    const prompt = "你是課表辨識器。請辨識圖片中的高中課表，回傳且只回傳 JSON，不要使用 Markdown 程式碼框或任何額外文字。格式必須嚴格為 {\"timetable\":[[\"週一第1節\",\"週二第1節\",\"週三第1節\",\"週四第1節\",\"週五第1節\"], ...共 8 列...]}。陣列必須恰有 8 列，每列恰有 5 個字串，欄位順序為週一到週五，列順序為第 1 到第 8 節。空白課程請回傳空字串。只填入科目名稱，不要包含星期、節次或備註。看不清楚的格子回傳空字串。";
    let message;
    if (config.provider === "gemini") {
      message = { role: "user", content: [
        { text: prompt },
        { inlineData: { mimeType: file.type, data: base64 } }
      ] };
    } else if (config.provider === "ollama") {
      message = { role: "user", content: prompt, images: [base64] };
    } else {
      message = { role: "user", content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl } }
      ] };
    }
    const result = await requestAi(
      [{ role: "system", content: "你只負責讀取課表圖片並遵守使用者指定的 JSON 輸出格式。" }, message],
      { model: config.visionModel, modelField: "visionModel" }
    );
    const matrix = parseTimetableResponse(result);
    state.timetable = matrix;
    renderTimetable();
    renderBindings();
    renderPacking();
    saveState();
    const filled = matrix.flat().filter(Boolean).length;
    status.textContent = `AI 已解析 ${filled} 格課程，請檢查並手動修正。`;
    showToast(`課表解析完成，共辨識 ${filled} 格。`);
  } catch (error) {
    console.error("AI 課表掃描失敗：", error);
    status.textContent = error.message;
    showToast("課表掃描失敗，請檢查 AI 設定與圖片後重試。");
  } finally {
    timetableScanInProgress = false;
    input.disabled = false;
    scanButton.removeAttribute("aria-disabled");
    input.value = "";
  }
}

async function sendChatMessage(text) {
  if (chatRequestInProgress) return;
  const status = document.querySelector("#chat-status");
  const sendButton = document.querySelector("#chat-send");
  const input = document.querySelector("#chat-input");
  try {
    getAiConfig();
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message);
    return;
  }
  chatRequestInProgress = true;
  state.chatMessages.push({ role: "user", content: text });
  state.chatMessages = state.chatMessages.slice(-40);
  renderChat();
  saveState();
  sendButton.disabled = true;
  status.textContent = "AI 思考中…";
  try {
    const history = state.chatMessages.slice(-20).map(({ role, content }) => ({ role, content }));
    const answer = await requestAi([
      { role: "system", content: "你是繁體中文學習助教。請用清楚、準確且適合高中生的方式回答；程式碼使用 Markdown fenced code block，數學內容請清楚排版。不要捏造不存在的資訊。" },
      ...history
    ]);
    state.chatMessages.push({ role: "assistant", content: answer });
    state.chatMessages = state.chatMessages.slice(-40);
    renderChat();
    saveState();
    status.textContent = `模型：${state.aiConfig.textModel}`;
  } catch (error) {
    console.error("AI 對話失敗：", error);
    status.textContent = error.message;
    showToast("AI 回覆失敗，請檢查連線設定。");
  } finally {
    chatRequestInProgress = false;
    sendButton.disabled = false;
    input.focus();
  }
}

document.querySelector("#open-task-modal").addEventListener("click", () => openTaskDialog(null));
document.querySelector("#close-task-modal").addEventListener("click", closeTaskDialog);
document.querySelector("#cancel-task-modal").addEventListener("click", closeTaskDialog);
document.querySelector("#task-type").addEventListener("change", updateTaskFields);
document.querySelector("#task-dialog").addEventListener("click", (event) => {
  if (event.target === event.currentTarget) closeTaskDialog();
});

document.querySelector("#task-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const id = String(data.get("id") || "");
  const type = String(data.get("type"));
  const title = String(data.get("title") || "").trim();
  if (!title) return;
  const existing = state.tasks.find((task) => task.id === id);
  const task = {
    id: id || (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`),
    type,
    title,
    subject: String(data.get("subject") || "").trim(),
    scope: type === "exam" ? String(data.get("scope") || "").trim() : "",
    date: type === "practice" ? "" : String(data.get("date") || ""),
    time: type === "homework" ? String(data.get("time") || "") : "",
    goal: type === "practice" ? String(data.get("goal") || "").trim() : "",
    completed: existing && existing.type !== "practice" ? existing.completed : false,
    completedOn: existing && type === "practice" ? existing.completedOn : ""
  };
  if (existing) Object.assign(existing, task);
  else state.tasks.push(task);
  saveState();
  renderTasks();
  renderBindings();
  closeTaskDialog();
  showToast(existing ? "項目已更新。" : "項目已新增。");
});

document.querySelector("#dashboard").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-task-action]");
  if (!button) return;
  const action = button.dataset.taskAction;
  const task = state.tasks.find((item) => item.id === button.dataset.taskId);
  if (!task) return;
  if (action === "edit") {
    openTaskDialog(task);
  } else if (action === "delete") {
    state.tasks = state.tasks.filter((item) => item.id !== task.id);
    saveState();
    renderTasks();
    showToast("項目已刪除。");
  }
});

document.querySelector("#dashboard").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-task-action='toggle']");
  if (!checkbox) return;
  const task = state.tasks.find((item) => item.id === checkbox.dataset.taskId);
  if (!task) return;
  if (task.type === "practice") {
    task.completedOn = checkbox.checked ? localDateString(new Date()) : "";
  } else {
    task.completed = checkbox.checked;
  }
  saveState();
  renderTasks();
});

document.querySelector("#bookmark-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.querySelector("#bookmark-name").value.trim();
  let url;
  try {
    url = new URL(document.querySelector("#bookmark-url").value.trim());
  } catch (error) {
    showToast("請輸入有效的網址。");
    return;
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    showToast("網址僅支援 http 或 https。");
    return;
  }
  state.bookmarks.push({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    url: url.href
  });
  event.currentTarget.reset();
  renderBookmarks();
  saveState();
  showToast("連結已新增。");
});

document.querySelector("#bookmark-grid").addEventListener("click", (event) => {
  const button = event.target.closest("[data-bookmark-id]");
  if (!button) return;
  state.bookmarks = state.bookmarks.filter((bookmark) => bookmark.id !== button.dataset.bookmarkId);
  renderBookmarks();
  saveState();
});

document.querySelector("#timetable-body").addEventListener("input", (event) => {
  const input = event.target.closest("[data-period]");
  if (!input) return;
  state.timetable[Number(input.dataset.period)][Number(input.dataset.day)] = input.value.slice(0, 24);
  renderBindings();
  renderPacking();
  saveState();
});

document.querySelector("#binding-grid").addEventListener("change", (event) => {
  const input = event.target.closest("[data-subject]");
  if (!input) return;
  state.bindings[input.dataset.subject] = input.value.split(/[,，、]/).map((book) => book.trim()).filter(Boolean);
  renderPacking();
  saveState();
});

document.querySelector("#subject-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#subject-name");
  const subject = input.value.trim();
  if (!subject) return;
  if (allBindingSubjects().includes(subject)) {
    showToast("科目已存在。");
    return;
  }
  state.bindings[subject] = [];
  input.value = "";
  renderBindings();
  saveState();
});

document.querySelector("#timetable-image").addEventListener("change", (event) => {
  const file = event.currentTarget.files[0];
  if (file) scanTimetable(file);
});

document.querySelectorAll("[data-pack-day]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedPackingDay = button.dataset.packDay;
    document.querySelectorAll("[data-pack-day]").forEach((item) => {
      item.classList.toggle("is-selected", item === button);
    });
    renderPacking();
  });
});

document.querySelector("#packing-list").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-pack-key]");
  if (!checkbox) return;
  state.packingChecked[checkbox.dataset.packKey] = checkbox.checked;
  saveState();
});

document.querySelector("#packing-time").addEventListener("change", (event) => {
  state.packingTime = event.currentTarget.value || "21:30";
  renderNotificationStatus();
  saveState();
});
document.querySelector("#notification-button").addEventListener("click", requestNotifications);

document.querySelector("#ai-settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const baseUrl = form.elements.baseUrl.value.trim();
  if (!baseUrl) {
    showToast("請填入 API Base URL。");
    form.elements.baseUrl.focus();
    return;
  }
  try {
    const parsedUrl = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("URL 只能使用 HTTP 或 HTTPS。");
  } catch (error) {
    showToast(error.message === "URL 只能使用 HTTP 或 HTTPS。" ? error.message : "API Base URL 格式無效。");
    form.elements.baseUrl.focus();
    return;
  }
  const config = {
    provider: form.elements.provider.value,
    baseUrl,
    apiKey: form.elements.apiKey.value.trim(),
    textModel: form.elements.textModel.value.trim(),
    visionModel: form.elements.visionModel.value.trim()
  };
  if (config.provider === "gemini" && !config.apiKey) {
    showToast("Gemini API 需要 API Key。");
    form.elements.apiKey.focus();
    return;
  }
  state.aiConfig = config;
  saveState();
  renderAiConfig();
  showToast("AI 連線設定已儲存。");
});

document.querySelector("#clear-ai-key").addEventListener("click", () => {
  state.aiConfig.apiKey = "";
  document.querySelector("#ai-api-key").value = "";
  saveState();
  renderAiConfig();
  showToast("已清除儲存的 API Key。");
});

document.querySelector("#github-sync-form").addEventListener("submit", (event) => {
  event.preventDefault();
});
document.querySelector("#github-sync-form").addEventListener("input", persistSyncForm);
document.querySelector("#github-upload").addEventListener("click", () => runSync(() => uploadToGist()));
document.querySelector("#github-pull").addEventListener("click", () => runSync(pullFromGist));

document.querySelector("#ai-provider").addEventListener("change", (event) => {
  const baseInput = document.querySelector("#ai-base-url");
  const providerHints = {
    openai: "https://api.siliconflow.cn/v1",
    ollama: "http://localhost:11434",
    gemini: "https://generativelanguage.googleapis.com/v1beta"
  };
  baseInput.placeholder = providerHints[event.currentTarget.value];
  document.querySelector("#ai-api-key").placeholder = event.currentTarget.value === "ollama"
    ? "選填，視伺服器設定而定"
    : "輸入 API Key";
});

document.querySelector("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.querySelector("#chat-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  sendChatMessage(message);
});

document.querySelector("#chat-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    document.querySelector("#chat-form").requestSubmit();
  }
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    const input = document.querySelector("#chat-input");
    input.value = `${button.dataset.prompt}${input.value}`;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
});

document.querySelector("#clear-chat").addEventListener("click", () => {
  if (!state.chatMessages.length) return;
  state.chatMessages = [];
  saveState();
  renderChat();
  showToast("對話紀錄已清除。");
});

const menuToggle = document.querySelector("#menu-toggle");
const drawer = document.querySelector("#nav-drawer");
const drawerBackdrop = document.querySelector("#drawer-backdrop");
const drawerControls = [
  document.querySelector("#close-drawer"),
  ...drawer.querySelectorAll(".nav-item")
];

function setDrawerOpen(open, restoreFocus = true) {
  drawer.classList.toggle("is-open", open);
  drawerBackdrop.classList.toggle("is-open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  drawer.setAttribute("aria-modal", String(open));
  menuToggle.setAttribute("aria-expanded", String(open));
  menuToggle.setAttribute("aria-label", open ? "關閉導覽選單" : "開啟導覽選單");
  document.body.classList.toggle("drawer-open", open);
  drawerControls.forEach((control) => {
    control.tabIndex = open ? 0 : -1;
  });
  if (open) {
    drawer.querySelector(".nav-item.is-active").focus({ preventScroll: true });
  } else if (restoreFocus) {
    menuToggle.focus({ preventScroll: true });
  }
}

menuToggle.addEventListener("click", () => {
  setDrawerOpen(menuToggle.getAttribute("aria-expanded") !== "true");
});
document.querySelector("#close-drawer").addEventListener("click", () => setDrawerOpen(false));
drawerBackdrop.addEventListener("click", () => setDrawerOpen(false));
document.addEventListener("keydown", (event) => {
  if (menuToggle.getAttribute("aria-expanded") !== "true") return;
  if (event.key === "Escape") {
    event.preventDefault();
    setDrawerOpen(false);
    return;
  }
  if (event.key !== "Tab") return;
  const focusable = drawerControls.filter((control) => control.tabIndex >= 0);
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
setDrawerOpen(false, false);

document.querySelectorAll("[data-workspace]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-workspace]").forEach((item) => {
      item.classList.toggle("is-active", item === button);
      if (item === button) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    });
    document.querySelectorAll(".workspace").forEach((workspace) => {
      const active = workspace.id === button.dataset.workspace;
      workspace.hidden = !active;
      workspace.classList.toggle("is-active", active);
    });
    const workspaceTitle = document.querySelector(`#${button.dataset.workspace}-title`);
    document.querySelector("#current-page-title").textContent = workspaceTitle.textContent;
    setDrawerOpen(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
});

renderDate();
renderTasks();
renderBookmarks();
renderTimetable();
renderBindings();
renderPacking();
renderNotificationStatus();
renderAiConfig();
renderChat();
renderSyncSettings();
document.querySelector("#packing-time").value = state.packingTime;
if (syncSettings.token && syncSettings.gistId) runSync(pullFromGist);

let activeDate = localDateString(new Date());
window.setInterval(() => {
  const date = localDateString(new Date());
  if (date === activeDate) return;
  activeDate = date;
  renderDate();
  renderTasks();
  renderPacking();
}, 30 * 1000);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js")
    .then((registration) => {
      swRegistration = registration;
      const activateWaiting = () => {
        if (registration.waiting && navigator.serviceWorker.controller) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      };
      activateWaiting();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed") activateWaiting();
        });
      });
    })
    .catch((error) => console.error("Service Worker 註冊失敗：", error));
}
window.setInterval(checkPackingReminder, 30 * 1000);
