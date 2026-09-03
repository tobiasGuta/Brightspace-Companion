(() => {
  if (window.__brightspaceCompanionReliabilityLoaded) return;
  window.__brightspaceCompanionReliabilityLoaded = true;

  const ROOT_ID = "bc-root";
  const TASK_VIEW = "tasks";
  const COMPLETED_KEY = "bcTaskCompleted";
  const CACHE_FRESH_MS = 6 * 60 * 60 * 1000;
  const CACHE_SAFE_MS = 12 * 60 * 60 * 1000;
  const COMPLETED_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

  let tasksActive = false;
  let renderQueued = false;

  const normalize = (value = "") => String(value).replace(/\s+/g, " ").trim();
  const escapeHtml = value => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  function root() {
    return document.getElementById(ROOT_ID);
  }

  function body() {
    return root()?.querySelector(".bc-body") || null;
  }

  function nav() {
    return root()?.querySelector(".bc-tabs") || null;
  }

  function taskIdentity(item) {
    const url = normalize(item?.url);
    if (url) return `url:${url}`;
    return `task:${Number(item?.orgUnitId) || 0}:${normalize(item?.title).toLowerCase()}`;
  }

  function taskKind(item) {
    const haystack = `${item?.title || ""} ${item?.url || ""}`.toLowerCase();
    if (/(quiz|exam|test|midterm|final)/.test(haystack) || /\/quizzing\//.test(haystack)) return "Quiz / exam";
    if (/(discussion|forum|post|reply)/.test(haystack)) return "Discussion";
    if (/(assignment|paper|project|essay|homework)/.test(haystack) || /(dropbox|assignments)/.test(haystack)) return "Assignment";
    return "Deadline";
  }

  function formatWhen(time) {
    if (!Number.isFinite(Number(time))) return "Due time unavailable";
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(Number(time)));
  }

  function humanAge(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "unknown";
    const minutes = Math.floor(ms / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  async function getData() {
    const data = await chrome.storage.local.get({
      bcDueCache: [],
      bcDueCacheUpdatedAt: 0,
      bcTaskCompleted: {},
      bcNotificationLog: []
    });

    const now = Date.now();
    const completed = data[COMPLETED_KEY] && typeof data[COMPLETED_KEY] === "object"
      ? data[COMPLETED_KEY]
      : {};

    let pruned = false;
    for (const [key, record] of Object.entries(completed)) {
      const at = Number(record?.completedAt || record);
      if (!Number.isFinite(at) || now - at > COMPLETED_RETENTION_MS) {
        delete completed[key];
        pruned = true;
      }
    }
    if (pruned) await chrome.storage.local.set({ [COMPLETED_KEY]: completed });

    return {
      dueItems: Array.isArray(data.bcDueCache) ? data.bcDueCache : [],
      updatedAt: Number(data.bcDueCacheUpdatedAt || 0),
      completed,
      notificationLog: Array.isArray(data.bcNotificationLog) ? data.bcNotificationLog : []
    };
  }

  function classify(dueItems, completed) {
    const now = Date.now();
    const rows = dueItems
      .filter(item => Number.isFinite(Number(item?.due)))
      .map(item => {
        const id = taskIdentity(item);
        const done = completed[id] || null;
        const due = Number(item.due);
        return {
          ...item,
          due,
          id,
          kind: taskKind(item),
          status: done ? "completed" : due < now ? "overdue" : "todo",
          completedAt: Number(done?.completedAt || done || 0) || null
        };
      });

    return {
      todo: rows.filter(row => row.status === "todo").sort((a, b) => a.due - b.due),
      overdue: rows.filter(row => row.status === "overdue").sort((a, b) => b.due - a.due),
      completed: rows.filter(row => row.status === "completed")
        .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0))
    };
  }

  function healthState(updatedAt) {
    if (!updatedAt) {
      return {
        level: "danger",
        title: "No trusted deadline sync yet",
        detail: "Open Brightspace and sync before relying on Companion reminders."
      };
    }
    const age = Date.now() - updatedAt;
    if (age <= CACHE_FRESH_MS) {
      return {
        level: "good",
        title: `Deadline data synced ${humanAge(age)}`,
        detail: "Reminder data is currently fresh."
      };
    }
    if (age <= CACHE_SAFE_MS) {
      return {
        level: "warn",
        title: `Deadline data is aging · synced ${humanAge(age)}`,
        detail: "Sync Brightspace again soon, especially before quizzes or exams."
      };
    }
    return {
      level: "danger",
      title: `Deadline data is stale · synced ${humanAge(age)}`,
      detail: "Do not treat an empty task list as all clear. Sync Brightspace now."
    };
  }

  function healthHtml(updatedAt, compact = false) {
    const health = healthState(updatedAt);
    return `
      <section class="bc-reliability-health bc-reliability-${health.level} ${compact ? "bc-reliability-compact" : ""}">
        <div class="bc-reliability-health-copy">
          <strong>${escapeHtml(health.title)}</strong>
          <span>${escapeHtml(health.detail)}</span>
        </div>
        <button class="bc-reliability-sync" type="button" data-bc-reliability-sync>Sync now</button>
      </section>`;
  }

  function taskCard(item) {
    const complete = item.status === "completed";
    const overdue = item.status === "overdue";
    const statusLabel = complete
      ? "Completed"
      : overdue
        ? "Overdue"
        : (item.due - Date.now() <= 24 * 60 * 60 * 1000 ? "Due soon" : "To do");

    return `
      <article class="bc-task-card bc-task-${escapeHtml(item.status)}">
        <button class="bc-task-open" type="button" data-bc-task-open="${escapeHtml(item.url || "")}" title="Open in Brightspace">
          <span class="bc-task-kind">${escapeHtml(item.kind)}</span>
          <strong class="bc-task-title">${escapeHtml(item.title || "Brightspace task")}</strong>
          <span class="bc-task-meta">${escapeHtml(formatWhen(item.due))}${item.subtitle ? ` · ${escapeHtml(item.subtitle)}` : ""}</span>
        </button>
        <div class="bc-task-actions">
          <span class="bc-task-status">${escapeHtml(statusLabel)}</span>
          <button
            class="bc-task-toggle ${complete ? "bc-task-reopen" : ""}"
            type="button"
            data-bc-task-id="${escapeHtml(item.id)}"
            data-bc-task-action="${complete ? "reopen" : "complete"}">
            ${complete ? "Reopen" : "Mark complete"}
          </button>
        </div>
      </article>`;
  }

  function taskSection(title, items, emptyText) {
    return `
      <section class="bc-task-section">
        <div class="bc-heading"><span>${escapeHtml(title)}</span><span>${items.length}</span></div>
        ${items.length
          ? `<div class="bc-task-list">${items.map(taskCard).join("")}</div>`
          : `<div class="bc-empty bc-empty-small">${escapeHtml(emptyText)}</div>`}
      </section>`;
  }

  function notificationDiagnosticsHtml(log) {
    const rows = log.slice(-5).reverse();
    if (!rows.length) {
      return `
        <section class="bc-task-section">
          <div class="bc-heading"><span>Notification diagnostics</span><span>0</span></div>
          <div class="bc-empty bc-empty-small">No notification events have been recorded yet.</div>
        </section>`;
    }

    const items = rows.map(row => `
      <div class="bc-notification-log-row">
        <strong>${escapeHtml(row.title || row.kind || "Notification")}</strong>
        <span>${escapeHtml(row.message || "")}</span>
        <time>${escapeHtml(formatWhen(Number(row.at)))}</time>
      </div>`).join("");

    return `
      <section class="bc-task-section">
        <div class="bc-heading"><span>Notification diagnostics</span><span>${rows.length}</span></div>
        <div class="bc-notification-log">${items}</div>
      </section>`;
  }

  async function renderTasks() {
    const target = body();
    if (!target || !tasksActive) return;

    const data = await getData();
    if (!tasksActive || body() !== target) return;

    const groups = classify(data.dueItems, data.completed);
    target.innerHTML = `
      <div class="bc-task-view">
        ${healthHtml(data.updatedAt)}
        <div class="bc-task-summary">
          <div class="${groups.overdue.length ? "bc-task-summary-danger" : ""}"><strong>${groups.overdue.length}</strong><span>Overdue</span></div>
          <div><strong>${groups.todo.length}</strong><span>To do</span></div>
          <div><strong>${groups.completed.length}</strong><span>Completed</span></div>
        </div>
        <div class="bc-task-trust-note">
          Completed means <strong>you confirmed it locally</strong>. Companion does not guess that a Brightspace item was submitted.
        </div>
        ${taskSection("Overdue / verify completion", groups.overdue, "No overdue deadlines in the current synced cache.")}
        ${taskSection("To do", groups.todo, "No upcoming deadlines in the current synced cache.")}
        ${taskSection("Completed", groups.completed, "Nothing has been marked complete yet.")}
        ${notificationDiagnosticsHtml(data.notificationLog)}
      </div>`;

    bindTaskControls(target);
  }

  function bindTaskControls(target) {
    target.querySelectorAll("[data-bc-task-open]").forEach(button => {
      button.addEventListener("click", () => {
        const url = button.dataset.bcTaskOpen;
        if (url) location.href = url;
      });
    });

    target.querySelectorAll("[data-bc-task-action]").forEach(button => {
      button.addEventListener("click", async () => {
        const id = button.dataset.bcTaskId;
        if (!id) return;
        const data = await chrome.storage.local.get({ [COMPLETED_KEY]: {} });
        const completed = data[COMPLETED_KEY] && typeof data[COMPLETED_KEY] === "object"
          ? data[COMPLETED_KEY]
          : {};
        if (button.dataset.bcTaskAction === "complete") {
          completed[id] = { completedAt: Date.now() };
        } else {
          delete completed[id];
        }
        await chrome.storage.local.set({ [COMPLETED_KEY]: completed });
        await renderTasks();
      });
    });

    target.querySelectorAll("[data-bc-reliability-sync]").forEach(button => {
      button.addEventListener("click", async () => {
        button.disabled = true;
        button.textContent = "Syncing…";
        try {
          await chrome.runtime.sendMessage({ type: "BC_RELIABILITY_REQUEST_SCAN" });
        } catch {}
        setTimeout(() => {
          if (button.isConnected) {
            button.disabled = false;
            button.textContent = "Sync now";
          }
        }, 2500);
      });
    });
  }

  function ensureTaskTab() {
    const tabs = nav();
    if (!tabs) return;
    let button = tabs.querySelector(`[data-view="${TASK_VIEW}"]`);
    if (!button) {
      button = document.createElement("button");
      button.type = "button";
      button.className = "bc-tab";
      button.dataset.view = TASK_VIEW;
      button.textContent = "Tasks";
      const upcoming = tabs.querySelector('[data-view="upcoming"]');
      if (upcoming?.nextSibling) tabs.insertBefore(button, upcoming.nextSibling);
      else tabs.appendChild(button);
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        tasksActive = true;
        const search = root()?.querySelector(".bc-search");
        if (search) search.value = "";
        activateTaskTab();
        renderTasks();
      });
    }
    activateTaskTab();
  }

  function activateTaskTab() {
    const tabs = nav();
    if (!tabs) return;
    const taskTab = tabs.querySelector(`[data-view="${TASK_VIEW}"]`);
    if (!taskTab) return;
    if (!tasksActive) {
      taskTab.classList.remove("bc-tab-active");
      return;
    }
    tabs.querySelectorAll(".bc-tab").forEach(tab => {
      tab.classList.toggle("bc-tab-active", tab.dataset.view === TASK_VIEW);
    });
  }

  async function ensureGlobalHealth() {
    const target = body();
    if (!target || tasksActive || target.querySelector(".bc-reliability-global")) return;
    const data = await chrome.storage.local.get({ bcDueCacheUpdatedAt: 0 });
    if (tasksActive || body() !== target || target.querySelector(".bc-reliability-global")) return;
    const wrapper = document.createElement("div");
    wrapper.className = "bc-reliability-global";
    wrapper.innerHTML = healthHtml(Number(data.bcDueCacheUpdatedAt || 0), true);
    target.prepend(wrapper);
    bindTaskControls(wrapper);
  }

  function scheduleReconcile() {
    if (renderQueued) return;
    renderQueued = true;
    queueMicrotask(async () => {
      renderQueued = false;
      ensureTaskTab();
      if (tasksActive) {
        if (!body()?.querySelector(".bc-task-view")) await renderTasks();
        activateTaskTab();
      } else {
        await ensureGlobalHealth();
      }
    });
  }

  function installDelegates() {
    const host = root();
    if (!host) return false;

    host.addEventListener("click", event => {
      const tab = event.target.closest?.(".bc-tab");
      if (tab && tab.dataset.view && tab.dataset.view !== TASK_VIEW) {
        tasksActive = false;
      }
    }, true);

    host.querySelector(".bc-search")?.addEventListener("input", () => {
      if (tasksActive) tasksActive = false;
    }, true);

    const observer = new MutationObserver(scheduleReconcile);
    observer.observe(host, { childList: true, subtree: true });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (
        changes.bcDueCache ||
        changes.bcDueCacheUpdatedAt ||
        changes[COMPLETED_KEY] ||
        changes.bcNotificationLog
      ) {
        scheduleReconcile();
        if (tasksActive) renderTasks();
      }
    });

    scheduleReconcile();
    return true;
  }

  if (!installDelegates()) {
    const wait = new MutationObserver(() => {
      if (installDelegates()) wait.disconnect();
    });
    wait.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
