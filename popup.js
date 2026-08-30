const statusEl = document.getElementById("status");
const sourceEl = document.getElementById("source");
const todayEl = document.getElementById("today");
const weekEl = document.getElementById("week");
const classesEl = document.getElementById("classes");
const todayBtn = document.getElementById("todayBtn");
const scheduleBtn = document.getElementById("scheduleBtn");
const scanBtn = document.getElementById("scan");
const testNotificationBtn = document.getElementById("testNotification");
let activeTab;

function setCounts(counts = {}) {
  todayEl.textContent = counts.today ?? "0";
  weekEl.textContent = counts.week ?? "0";
  classesEl.textContent = counts.classesToday ?? "0";
}
function setSource(scan = {}) {
  sourceEl.textContent = `Discovery source: ${scan.source || "—"}`;
  sourceEl.title = scan.detail || "";
}
async function send(type, extra = {}) {
  if (!activeTab?.id) return null;
  try { return await chrome.tabs.sendMessage(activeTab.id, { type, ...extra }); }
  catch { return null; }
}

async function sendTestNotification() {
  const notificationId = "bc-test-notification";
  try {
    await chrome.notifications.clear(notificationId);
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Brightspace Companion",
      message: "Notifications are working ✓",
      priority: 1
    });
    testNotificationBtn.textContent = "Notification sent ✓";
    statusEl.className = "status good";
    statusEl.textContent = "Test notification sent. Check your Windows notification area.";
    setTimeout(() => { testNotificationBtn.textContent = "Test notification"; }, 1800);
  } catch (error) {
    testNotificationBtn.textContent = "Test notification";
    statusEl.className = "status bad";
    statusEl.textContent = "Could not send a test notification. Check Edge and Windows notification settings.";
  }
}

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const supported = activeTab?.url?.startsWith("https://brightspace.cuny.edu/");
  todayBtn.disabled = !supported;
  scheduleBtn.disabled = !supported;
  scanBtn.disabled = !supported;
  if (!supported) {
    statusEl.className = "status bad";
    statusEl.textContent = "Open brightspace.cuny.edu to sync or configure Companion.";
    setCounts(); setSource(); return;
  }
  statusEl.textContent = "Reading Brightspace…";
  const result = await send("BC_GET_STATUS");
  if (!result?.ok) {
    statusEl.className = "status bad";
    statusEl.textContent = "Refresh this Brightspace tab once after updating the extension.";
    return;
  }
  statusEl.className = "status good";
  statusEl.textContent = "Connected. Reminders and activity alerts are stored locally.";
  setCounts(result.counts); setSource(result.scan);
}

todayBtn.addEventListener("click", async () => { await send("BC_OPEN_VIEW", { view: "today" }); window.close(); });
scheduleBtn.addEventListener("click", async () => { await send("BC_OPEN_VIEW", { view: "schedule" }); window.close(); });
testNotificationBtn.addEventListener("click", sendTestNotification);

scanBtn.addEventListener("click", async () => {
  scanBtn.disabled = true; scanBtn.textContent = "Syncing…";
  const result = await send("BC_SCAN");
  if (result?.ok) {
    setCounts(result.counts); setSource(result.scan);
    statusEl.className = "status good"; statusEl.textContent = "Brightspace sync complete.";
  } else {
    statusEl.className = "status bad"; statusEl.textContent = "Sync failed. Refresh Brightspace and try again.";
  }
  scanBtn.textContent = "Sync Brightspace now"; scanBtn.disabled = false;
});
init();
