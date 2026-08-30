const CHECK_ALARM = "bc-reminder-check";
const CHECK_EVERY_MINUTES = 1;
const DUE_CACHE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

const DEFAULT_SETTINGS = {
  assignmentLeads: [1440, 180],
  classLeads: [30]
};

function ensureAlarm() {
  chrome.alarms.create(CHECK_ALARM, { periodInMinutes: CHECK_EVERY_MINUTES });
}

ensureAlarm();

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  checkReminders();
});
chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  checkReminders();
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === CHECK_ALARM) checkReminders();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-command-center") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith("https://brightspace.cuny.edu/")) return;
  try { await chrome.tabs.sendMessage(tab.id, { type: "BC_TOGGLE" }); } catch {}
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "BC_REMINDER_DATA_UPDATED") checkReminders();
  if (message?.type === "BC_ACTIVITY_ALERTS") deliverActivityAlerts(message.alerts);
});

chrome.notifications.onClicked.addListener(async notificationId => {
  const data = await chrome.storage.local.get({ bcNotificationTargets: {}, bcActivityNotificationTargets: {} });
  const reminderTargets = data.bcNotificationTargets || {};
  const activityTargets = data.bcActivityNotificationTargets || {};
  const url = reminderTargets[notificationId] || activityTargets[notificationId];
  if (url) chrome.tabs.create({ url });
  delete reminderTargets[notificationId];
  delete activityTargets[notificationId];
  await chrome.storage.local.set({ bcNotificationTargets: reminderTargets, bcActivityNotificationTargets: activityTargets });
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

async function notifyOnce(key, title, message, url, notified, targets) {
  if (notified[key]) return false;
  const id = `bc-${key.replace(/[^a-z0-9:_-]/gi, "_").slice(-180)}`;
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title,
    message,
    priority: 1
  });
  notified[key] = Date.now();
  if (url) targets[id] = url;
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
    await chrome.notifications.create(id, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: String(alert?.title || "Brightspace Companion").slice(0, 120),
      message: String(alert?.message || "Brightspace has an update.").slice(0, 400),
      priority: 1
    });
    notified[key] = now;
    if (alert?.url) targets[id] = String(alert.url);
  }

  await chrome.storage.local.set({
    bcActivityNotifiedKeys: notified,
    bcActivityNotificationTargets: targets
  });
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
    bcNotificationTargets: {}
  });

  const now = Date.now();
  const settings = {
    assignmentLeads: Array.isArray(data.bcReminderSettings?.assignmentLeads) ? data.bcReminderSettings.assignmentLeads.map(Number) : DEFAULT_SETTINGS.assignmentLeads,
    classLeads: Array.isArray(data.bcReminderSettings?.classLeads) ? data.bcReminderSettings.classLeads.map(Number) : DEFAULT_SETTINGS.classLeads
  };
  const notified = data.bcNotifiedKeys || {};
  const targets = data.bcNotificationTargets || {};
  const hiddenGroups = new Set(Array.isArray(data.bcHiddenCourseGroups) ? data.bcHiddenCourseGroups : []);
  const currentTermKey = typeof data.bcCurrentTermKey === "string" ? data.bcCurrentTermKey : "";

  // Prune old dedupe entries/targets so storage does not grow forever.
  const pruneBefore = now - 21 * 24 * 60 * 60 * 1000;
  for (const [key, at] of Object.entries(notified)) if (!Number.isFinite(at) || at < pruneBefore) delete notified[key];
  for (const id of Object.keys(targets)) {
    if (!id.startsWith("bc-")) delete targets[id];
  }

  // Assignment reminders use the last successful Brightspace sync. We stop
  // notifying after 48h without a sync to avoid presenting stale deadlines.
  const dueCacheFresh = now - Number(data.bcDueCacheUpdatedAt || 0) <= DUE_CACHE_MAX_AGE_MS;
  if (dueCacheFresh) {
    for (const item of data.bcDueCache || []) {
      const due = Number(item.due);
      if (!Number.isFinite(due) || due <= now || hiddenGroups.has(item.groupKey)) continue;
      const minutesUntil = (due - now) / 60000;
      const candidateLead = settings.assignmentLeads
        .filter(lead => Number.isFinite(lead) && lead > 0 && minutesUntil <= lead)
        .sort((a, b) => a - b)[0];
      if (!candidateLead) continue;
      const key = `due:${item.key || item.url}:${due}:lead:${candidateLead}`;
      await notifyOnce(key, item.title || "Brightspace deadline", assignmentNotificationBody(item, minutesUntil), item.url, notified, targets);
    }
  }

  // Recurring class schedule is fully local and remains reliable without a
  // Brightspace sync. Check today and tomorrow so long lead times still work.
  for (const schedule of data.bcClassSchedules || []) {
    if (hiddenGroups.has(schedule.groupKey)) continue;
    // V1.4 schedules had no termKey; keep those working for backwards
    // compatibility. New schedules are scoped to the semester they belong to.
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
      const dateKey = new Date(start).toISOString().slice(0, 10);
      const key = `class:${schedule.id}:${start}:lead:${candidateLead}`;
      await notifyOnce(key, schedule.label || "Class reminder", classNotificationBody(schedule, minutesUntil), schedule.url, notified, targets);
    }
  }

  await chrome.storage.local.set({ bcNotifiedKeys: notified, bcNotificationTargets: targets });
}
