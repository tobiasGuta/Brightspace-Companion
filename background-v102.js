const CHECK_ALARM = "bc-reminder-check";
const DAILY_DIGEST_ALARM = "bc-daily-digest";
const CHECK_EVERY_MINUTES = 1;
const DUE_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const STALE_WARNING_AFTER_MS = 6 * 60 * 60 * 1000;
const STALE_WARNING_REPEAT_MS = 12 * 60 * 60 * 1000;
const LATE_VERIFY_WINDOW_MS = 2 * 60 * 60 * 1000;
const BRIGHTSPACE_HOME = "https://brightspace.cuny.edu/";

const DEFAULT_SETTINGS = {
  assignmentLeads: [1440, 180],
  classLeads: [30]
};

function ensureAlarm() {
  chrome.alarms.create(CHECK_ALARM, { periodInMinutes: CHECK_EVERY_MINUTES });
}

function nextLocalDigestTime(base = new Date()) {
  const next = new Date(base);
  next.setHours(8, 0, 0, 0);
  if (next.getTime() <= base.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

function ensureDailyDigestAlarm() {
  chrome.alarms.create(DAILY_DIGEST_ALARM, { when: nextLocalDigestTime() });
}

ensureAlarm();
ensureDailyDigestAlarm();

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  ensureDailyDigestAlarm();
  checkReminders();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  ensureDailyDigestAlarm();
  checkReminders();
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CHECK_ALARM) checkReminders();
  if (alarm.name === DAILY_DIGEST_ALARM) {
    deliverDailyDigest().finally(ensureDailyDigestAlarm);
  }
});

chrome.commands.onCommand.addListener(async command => {
  if (command !== "toggle-command-center") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith(BRIGHTSPACE_HOME)) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "BC_TOGGLE" }); } catch {}
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "BC_REMINDER_DATA_UPDATED") {
    checkReminders();
    return;
  }

  if (message?.type === "BC_ACTIVITY_ALERTS") {
    deliverActivityAlerts(message.alerts);
    return;
  }

  if (message?.type === "BC_NOTIFICATION_LOG") {
    appendNotificationLog(message.entry);
    return;
  }

  if (message?.type === "BC_RELIABILITY_REQUEST_SCAN" && sender.tab?.id) {
    chrome.tabs.sendMessage(sender.tab.id, { type: "BC_SCAN" })
      .then(response => sendResponse(response || { ok: true }))
      .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
});

chrome.notifications.onClicked.addListener(async notificationId => {
  const data = await chrome.storage.local.get({
    bcNotificationTargets: {},
    bcActivityNotificationTargets: {}
  });
  const reminderTargets = data.bcNotificationTargets || {};
  const activityTargets = data.bcActivityNotificationTargets || {};
  const url = reminderTargets[notificationId] || activityTargets[notificationId];
  if (url) chrome.tabs.create({ url });
  delete reminderTargets[notificationId];
  delete activityTargets[notificationId];
  await chrome.storage.local.set({
    bcNotificationTargets: reminderTargets,
    bcActivityNotificationTargets: activityTargets
  });
  chrome.notifications.clear(notificationId);
});

function localOccurrenceTimestamp(schedule, baseDate = new Date()) {
  const [hour, minute] = String(schedule.startTime || "").split(":").map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  const d = new Date(baseDate);
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

function humanizeMinutesUntil(rawMinutes) {
  const minutes = Math.max(0, Math.ceil(Number(rawMinutes) || 0));
  if (minutes <= 0) return "now";
  if (minutes === 1) return "1 minute";
  if (minutes < 60) return `${minutes} minutes`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const hourLabel = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  if (!remainingMinutes) return hourLabel;
  return `${hourLabel} ${remainingMinutes} ${remainingMinutes === 1 ? "minute" : "minutes"}`;
}

function assignmentNotificationBody(item, minutesUntil) {
  const remaining = humanizeMinutesUntil(minutesUntil);
  return `${remaining === "now" ? "Due now" : `Due in ${remaining}`} · ${item.subtitle || "Brightspace"}`;
}

function classNotificationBody(schedule, minutesUntil) {
  const where = schedule.room ? ` · ${schedule.room}` : "";
  const remaining = humanizeMinutesUntil(minutesUntil);
  return `${remaining === "now" ? "Starts now" : `Starts in ${remaining}`}${where}`;
}

function taskIdentity(item) {
  const url = String(item?.url || "").trim();
  if (url) return `url:${url}`;
  return `task:${Number(item?.orgUnitId) || 0}:${String(item?.title || "").replace(/\s+/g, " ").trim().toLowerCase()}`;
}

function taskIsCompleted(item, completed) {
  return Boolean(completed?.[taskIdentity(item)]);
}

async function appendNotificationLog(entry) {
  const data = await chrome.storage.local.get({ bcNotificationLog: [] });
  const log = Array.isArray(data.bcNotificationLog) ? data.bcNotificationLog : [];
  log.push({
    at: Date.now(),
    kind: String(entry?.kind || "notification"),
    title: String(entry?.title || "Brightspace Companion").slice(0, 120),
    message: String(entry?.message || "").slice(0, 400),
    notificationId: String(entry?.notificationId || "")
  });
  if (log.length > 50) log.splice(0, log.length - 50);
  await chrome.storage.local.set({ bcNotificationLog: log });
}

async function createNotification(id, { title, message, url, kind = "notification", priority = 1 }, targets) {
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    priority
  });
  if (url) targets[id] = url;
  await appendNotificationLog({ kind, title, message, notificationId: id });
}

async function notifyOnce(key, title, message, url, notified, targets, kind = "reminder") {
  if (notified[key]) return false;
  const id = `bc-${key.replace(/[^a-z0-9:_-]/gi, "_").slice(-180)}`;
  await createNotification(id, { title, message, url, kind }, targets);
  notified[key] = Date.now();
  return true;
}

async function deliverActivityAlerts(rawAlerts) {
  const alerts = Array.isArray(rawAlerts) ? rawAlerts.slice(0, 8) : [];
  if (!alerts.length) return;

  const data = await chrome.storage.local.get({
    bcActivityNotifiedKeys: {},
    bcActivityNotificationTargets: {}
  });
  const notified = data.bcActivityNotifiedKeys || {};
  const targets = data.bcActivityNotificationTargets || {};
  const now = Date.now();
  const pruneBefore = now - 90 * 24 * 60 * 60 * 1000;
  for (const [key, at] of Object.entries(notified)) {
    if (!Number.isFinite(at) || at < pruneBefore) delete notified[key];
  }

  for (const alert of alerts) {
    const key = String(alert?.key || "");
    if (!key || notified[key]) continue;
    const id = `bc-activity-${key.replace(/[^a-z0-9:_-]/gi, "_").slice(-160)}`;
    const title = String(alert?.title || "Brightspace Companion").slice(0, 120);
    const message = String(alert?.message || "Brightspace has an update.").slice(0, 400);
    await createNotification(id, {
      title,
      message,
      url: alert?.url ? String(alert.url) : "",
      kind: "activity"
    }, targets);
    notified[key] = now;
  }

  await chrome.storage.local.set({
    bcActivityNotifiedKeys: notified,
    bcActivityNotificationTargets: targets
  });
}

async function maybeWarnStaleCache(data, now, targets) {
  const updatedAt = Number(data.bcDueCacheUpdatedAt || 0);
  const age = updatedAt ? now - updatedAt : Number.POSITIVE_INFINITY;
  if (age <= STALE_WARNING_AFTER_MS) return;

  const lastWarning = Number(data.bcLastStaleWarningAt || 0);
  if (lastWarning && now - lastWarning < STALE_WARNING_REPEAT_MS) return;

  const id = "bc-reliability-stale-cache";
  const title = updatedAt ? "Brightspace Companion needs a sync" : "Sync Brightspace Companion";
  const message = updatedAt
    ? "Deadline data is getting stale. Open Brightspace and sync before relying on reminders."
    : "No trusted deadline sync is available yet. Open Brightspace and sync Companion.";
  await createNotification(id, {
    title,
    message,
    url: BRIGHTSPACE_HOME,
    kind: "reliability",
    priority: 2
  }, targets);
  await chrome.storage.local.set({ bcLastStaleWarningAt: now });
}

async function deliverDailyDigest() {
  const data = await chrome.storage.local.get({
    bcDueCache: [],
    bcDueCacheUpdatedAt: 0,
    bcTaskCompleted: {},
    bcNotificationTargets: {}
  });

  const now = Date.now();
  const updatedAt = Number(data.bcDueCacheUpdatedAt || 0);
  const age = updatedAt ? now - updatedAt : Number.POSITIVE_INFINITY;
  const targets = data.bcNotificationTargets || {};
  const id = `bc-daily-digest-${new Date(now).toISOString().slice(0, 10)}`;

  if (age > DUE_CACHE_MAX_AGE_MS) {
    await createNotification(id, {
      title: "Morning Brightspace check",
      message: "Your deadline cache is stale. Sync Brightspace before treating today as clear.",
      url: BRIGHTSPACE_HOME,
      kind: "daily-digest",
      priority: 2
    }, targets);
    await chrome.storage.local.set({ bcNotificationTargets: targets });
    return;
  }

  const completed = data.bcTaskCompleted && typeof data.bcTaskCompleted === "object"
    ? data.bcTaskCompleted
    : {};
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  const openItems = (Array.isArray(data.bcDueCache) ? data.bcDueCache : [])
    .filter(item => Number.isFinite(Number(item?.due)))
    .filter(item => !taskIsCompleted(item, completed));

  const dueToday = openItems.filter(item => Number(item.due) >= start.getTime() && Number(item.due) <= end.getTime()).length;
  const overdue = openItems.filter(item => Number(item.due) < now).length;

  const parts = [];
  parts.push(dueToday ? `${dueToday} due today` : "Nothing due today in the synced cache");
  if (overdue) parts.push(`${overdue} overdue / verify completion`);

  await createNotification(id, {
    title: "Brightspace morning check",
    message: `${parts.join(" · ")}. Open Tasks to review.`,
    url: BRIGHTSPACE_HOME,
    kind: "daily-digest"
  }, targets);
  await chrome.storage.local.set({ bcNotificationTargets: targets });
}

async function checkReminders() {
  const data = await chrome.storage.local.get({
    bcDueCache: [],
    bcDueCacheUpdatedAt: 0,
    bcClassSchedules: [],
    bcHiddenCourseGroups: [],
    bcCurrentTermKey: "",
    bcReminderSettings: DEFAULT_SETTINGS,
    bcNotifiedKeys: {},
    bcNotificationTargets: {},
    bcTaskCompleted: {},
    bcLastStaleWarningAt: 0
  });

  const now = Date.now();
  const settings = {
    assignmentLeads: Array.isArray(data.bcReminderSettings?.assignmentLeads)
      ? data.bcReminderSettings.assignmentLeads.map(Number)
      : DEFAULT_SETTINGS.assignmentLeads,
    classLeads: Array.isArray(data.bcReminderSettings?.classLeads)
      ? data.bcReminderSettings.classLeads.map(Number)
      : DEFAULT_SETTINGS.classLeads
  };
  const notified = data.bcNotifiedKeys || {};
  const targets = data.bcNotificationTargets || {};
  const completed = data.bcTaskCompleted && typeof data.bcTaskCompleted === "object"
    ? data.bcTaskCompleted
    : {};
  const hiddenGroups = new Set(Array.isArray(data.bcHiddenCourseGroups) ? data.bcHiddenCourseGroups : []);
  const currentTermKey = typeof data.bcCurrentTermKey === "string" ? data.bcCurrentTermKey : "";

  const pruneBefore = now - 21 * 24 * 60 * 60 * 1000;
  for (const [key, at] of Object.entries(notified)) {
    if (!Number.isFinite(at) || at < pruneBefore) delete notified[key];
  }
  for (const id of Object.keys(targets)) {
    if (!id.startsWith("bc-")) delete targets[id];
  }

  await maybeWarnStaleCache(data, now, targets);

  const dueCacheFresh = now - Number(data.bcDueCacheUpdatedAt || 0) <= DUE_CACHE_MAX_AGE_MS;
  if (dueCacheFresh) {
    for (const item of data.bcDueCache || []) {
      const due = Number(item.due);
      if (!Number.isFinite(due) || hiddenGroups.has(item.groupKey) || taskIsCompleted(item, completed)) continue;

      if (due <= now) {
        const lateBy = now - due;
        if (lateBy <= LATE_VERIFY_WINDOW_MS) {
          const key = `verify:${taskIdentity(item)}:${due}`;
          await notifyOnce(
            key,
            "Deadline passed — verify completion",
            `${item.title || "Brightspace item"} was due ${humanizeMinutesUntil(lateBy / 60000)} ago. Check Tasks or Brightspace to confirm it was completed.`,
            item.url,
            notified,
            targets,
            "late-verify"
          );
        }
        continue;
      }

      const minutesUntil = (due - now) / 60000;
      const candidateLead = settings.assignmentLeads
        .filter(lead => Number.isFinite(lead) && lead > 0 && minutesUntil <= lead)
        .sort((a, b) => a - b)[0];
      if (!candidateLead) continue;
      const key = `due:${item.key || item.url}:${due}:lead:${candidateLead}`;
      await notifyOnce(
        key,
        item.title || "Brightspace deadline",
        assignmentNotificationBody(item, minutesUntil),
        item.url,
        notified,
        targets,
        "deadline-reminder"
      );
    }
  }

  for (const schedule of data.bcClassSchedules || []) {
    if (hiddenGroups.has(schedule.groupKey)) continue;
    if (currentTermKey && schedule.termKey && schedule.termKey !== currentTermKey) continue;
    for (let offset = 0; offset <= 1; offset++) {
      const day = new Date(now + offset * 86400000);
      if (!Array.isArray(schedule.days) || !schedule.days.map(Number).includes(day.getDay())) continue;
      const start = localOccurrenceTimestamp(schedule, day);
      if (!Number.isFinite(start) || start <= now) continue;
      const minutesUntil = (start - now) / 60000;
      const candidateLead = settings.classLeads
        .filter(lead => Number.isFinite(lead) && lead > 0 && minutesUntil <= lead)
        .sort((a, b) => a - b)[0];
      if (!candidateLead) continue;
      const key = `class:${schedule.id}:${start}:lead:${candidateLead}`;
      await notifyOnce(
        key,
        schedule.label || "Class reminder",
        classNotificationBody(schedule, minutesUntil),
        schedule.url,
        notified,
        targets,
        "class-reminder"
      );
    }
  }

  await chrome.storage.local.set({
    bcNotifiedKeys: notified,
    bcNotificationTargets: targets
  });
}
