(() => {
  if (window.__brightspaceCompanionLoaded) return;
  window.__brightspaceCompanionLoaded = true;

  const state = {
    courses: [],
    dueItems: [],
    announcements: [],
    newAnnouncementKeys: new Set(),
    favorites: new Set(),
    hiddenCourseGroups: new Set(),
    termFilter: "current",
    query: "",
    selectedIndex: 0,
    flatVisibleItems: [],
    scan: {
      source: "Starting…",
      api: "not-tested",
      detail: ""
    }
  };

  const API_CACHE_MS = 60_000;
  const AUTO_SYNC_MIN_INTERVAL_MS = 10 * 60_000;
  const AUTO_SYNC_ROUTE_DEBOUNCE_MS = 1500;
  const ANNOUNCEMENT_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
  const DEFAULT_ALERT_SETTINGS = { announcements: true, deadlineChanges: true };
  let lastApiScanAt = 0;
  let lastAutoSyncAt = 0;
  let lastObservedUrl = location.href;
  let autoSyncTimer = null;
  let cachedVersions = null;
  let scanInFlight = null;

  const normalize = (value = "") => String(value).replace(/\s+/g, " ").trim();
  const absoluteUrl = (href) => {
    try { return new URL(href, location.href).href; } catch { return null; }
  };

  function uniqueByUrl(items) {
    const seen = new Set();
    return items.filter(item => {
      if (!item.url || seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    });
  }

  function currentHomeOrgUnitId() {
    const match = location.pathname.match(/^\/d2l\/home\/(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  function currentCourseOrgUnitId() {
    const pathPatterns = [
      /\/d2l\/home\/(\d+)/i,
      /\/d2l\/le\/content\/(\d+)/i,
      /\/d2l\/lms\/dropbox\/user\/folders_list\.d2l\?ou=(\d+)/i,
      /\/d2l\/lms\/quizzing\/user\/quizzes_list\.d2l\?ou=(\d+)/i
    ];
    for (const p of pathPatterns) {
      const m = location.href.match(p);
      if (m) return Number(m[1]);
    }
    const query = new URL(location.href).searchParams;
    const ou = query.get("ou") || query.get("ouId") || query.get("orgUnitId");
    return ou && /^\d+$/.test(ou) ? Number(ou) : null;
  }

  function compareVersions(a, b) {
    const pa = String(a).split(".").map(n => Number(n) || 0);
    const pb = String(b).split(".").map(n => Number(n) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function latestVersionFor(data, productCode) {
    const code = productCode.toLowerCase();
    const versions = [];
    const rows = Array.isArray(data) ? data : [data];
    for (const row of rows) {
      if (!row || String(row.ProductCode || "").toLowerCase() !== code) continue;
      if (row.LatestVersion) versions.push(String(row.LatestVersion));
      if (row.Version) versions.push(String(row.Version));
      if (Array.isArray(row.SupportedVersions)) versions.push(...row.SupportedVersions.map(String));
    }
    versions.sort(compareVersions);
    return versions.at(-1) || null;
  }

  async function fetchJson(url) {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { "Accept": "application/json" }
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json();
  }

  async function getApiVersions() {
    if (cachedVersions) return cachedVersions;
    const data = await fetchJson("/d2l/api/versions/");
    const lp = latestVersionFor(data, "lp");
    const le = latestVersionFor(data, "le");
    if (!lp || !le) throw new Error(`Could not negotiate API versions (lp=${lp || "?"}, le=${le || "?"})`);
    cachedVersions = { lp, le };
    return cachedVersions;
  }

  function listItems(page) {
    if (Array.isArray(page)) return page;
    if (Array.isArray(page?.Items)) return page.Items;
    if (Array.isArray(page?.Objects)) return page.Objects;
    if (Array.isArray(page?.Results)) return page.Results;
    return [];
  }

  async function fetchPaged(baseUrl, maxPages = 8) {
    const items = [];
    let bookmark = null;
    for (let page = 0; page < maxPages; page++) {
      const u = new URL(baseUrl, location.origin);
      if (bookmark) u.searchParams.set("bookmark", bookmark);
      const data = await fetchJson(u.pathname + u.search);
      items.push(...listItems(data));
      const paging = data?.PagingInfo || data?.Paging || {};
      const hasMore = Boolean(paging.HasMoreItems ?? paging.HasMore ?? false);
      const next = paging.Bookmark || paging.NextBookmark || null;
      if (!hasMore || !next || next === bookmark) break;
      bookmark = String(next);
    }
    return items;
  }

  function isCourseOffering(entry) {
    const org = entry?.OrgUnit || entry;
    const type = org?.Type || {};
    const descriptor = `${type.Name || ""} ${type.Code || ""}`.toLowerCase();
    return Number(type.Id) === 3 || descriptor.includes("course offering") || descriptor === "course";
  }

  function looksInstitutionalOrg(entry) {
    const org = entry?.OrgUnit || entry || {};
    const name = normalize(org.Name || "");
    const code = normalize(org.Code || "");
    const type = org.Type || {};
    const descriptor = `${type.Name || ""} ${type.Code || ""}`.toLowerCase();

    // Never present obvious organization containers as student courses.
    // CUNY can expose college/school org units through enrollment data with
    // course-like home URLs, so URL shape alone is not a safe discriminator.
    if (/\b(organization|department|faculty|semester|term|campus)\b/i.test(descriptor) &&
        !descriptor.includes("course offering")) return true;

    const institutionalName = /\b(college|university|school|campus)\s*$/i.test(name);
    const courseLikeCode = /\d/.test(code);
    if (institutionalName && !courseLikeCode) return true;

    return false;
  }

  function bracketLabels(title) {
    const labels = [];
    const re = /\[([^\]]+)\]/g;
    let match;
    while ((match = re.exec(title || ""))) {
      const value = normalize(match[1]);
      if (value) labels.push(value);
    }
    return labels;
  }

  function institutionLabelFromTitle(title) {
    const ignored = /^(?:lecture|lab|laboratory|seminar|recitation|tutorial|online|hybrid|in[- ]person|synchronous|asynchronous|section|class|course|practicum|\d+)$/i;
    const labels = bracketLabels(title).reverse();
    for (const label of labels) {
      if (!/[a-z]/i.test(label) || ignored.test(label)) continue;
      if (/^(?:fall|spring|summer|winter)\b/i.test(label)) continue;
      return label;
    }
    return "";
  }

  function courseGroupKey(code, title) {
    const cleanCode = normalize(code);
    const prefix = cleanCode.match(/^([a-z][a-z0-9]{1,15})[_-]/i)?.[1];
    if (prefix) return `code:${prefix.toUpperCase()}`;

    const label = institutionLabelFromTitle(title);
    if (label) return `label:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

    return "other";
  }

  function applyCourseGroups(courses) {
    const metadata = new Map();

    for (const course of courses) {
      course.groupKey = courseGroupKey(course.code || "", course.title || "");

      if (!metadata.has(course.groupKey)) {
        metadata.set(course.groupKey, { labels: new Map(), count: 0 });
      }

      const meta = metadata.get(course.groupKey);
      meta.count++;

      const label = institutionLabelFromTitle(course.title || "");
      if (label) meta.labels.set(label, (meta.labels.get(label) || 0) + 1);
    }

    for (const course of courses) {
      const meta = metadata.get(course.groupKey);
      let label = "";

      if (meta?.labels?.size) {
        label = [...meta.labels.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
      }

      if (!label && course.groupKey.startsWith("code:")) {
        label = course.groupKey.slice(5);
      }
      if (!label) label = "Other courses";

      course.groupLabel = label;
    }

    return courses;
  }

  function discoveredCourseGroups() {
    const groups = new Map();

    for (const course of state.courses) {
      const key = course.groupKey || "other";
      const label = course.groupLabel || "Other courses";
      if (!groups.has(key)) groups.set(key, { key, label, count: 0 });
      groups.get(key).count++;
    }

    return [...groups.values()].sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
    );
  }

  function groupIsVisible(groupKey) {
    return !groupKey || !state.hiddenCourseGroups.has(groupKey);
  }

  function safeTimestamp(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  function termKeyFromSemester(semester) {
    if (!semester) return "other";
    const id = Number(semester.Identifier ?? semester.Id);
    if (Number.isFinite(id) && id > 0) return `term:${id}`;
    const code = normalize(semester.Code || "");
    if (code) return `term-code:${code.toLowerCase()}`;
    const name = normalize(semester.Name || "");
    if (name) return `term-name:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    return "other";
  }

  async function attachCourseTerms(lpVersion, courses) {
    const ids = courses.map(c => c.orgUnitId).filter(Number.isFinite).slice(0, 25);
    if (!ids.length) return courses;

    let rows = [];
    const query = new URLSearchParams({ orgUnitIdsCSV: ids.join(",") });
    try {
      rows = await fetchJson(`/d2l/api/lp/${lpVersion}/courses/parents?${query}`);
    } catch {
      // Older Brightspace installs expose the predecessor route. Keep this as
      // a compatibility fallback rather than guessing semesters from titles.
      try { rows = await fetchJson(`/d2l/api/lp/${lpVersion}/courses/parentorgunits?${query}`); } catch {}
    }

    const byCourse = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      const courseId = Number(row?.CourseOfferingId);
      if (Number.isFinite(courseId)) byCourse.set(courseId, row);
    }

    for (const course of courses) {
      const row = byCourse.get(Number(course.orgUnitId));
      const semester = Array.isArray(row?.Semesters) ? row.Semesters[0] : row?.Semester;
      course.termKey = termKeyFromSemester(semester);
      course.termLabel = normalize(semester?.Name || semester?.Code || (course.termKey === "other" ? "Other" : "Semester"));
    }
    return courses;
  }

  function discoveredTerms() {
    const terms = new Map();
    for (const course of state.courses) {
      const key = course.termKey || "other";
      const label = course.termLabel || (key === "other" ? "Other" : "Semester");
      if (!terms.has(key)) terms.set(key, { key, label, count: 0, starts: [], ends: [] });
      const term = terms.get(key);
      term.count++;
      if (Number.isFinite(course.accessStart)) term.starts.push(course.accessStart);
      if (Number.isFinite(course.accessEnd)) term.ends.push(course.accessEnd);
    }

    const seasonRank = label => {
      const text = String(label || "").toLowerCase();
      const year = Number(text.match(/\b(20\d{2})\b/)?.[1]);
      if (!Number.isFinite(year)) return null;
      let season = 0;
      if (/\b(spring|sp)\b/.test(text)) season = 1;
      else if (/\b(summer|su)\b/.test(text)) season = 2;
      else if (/\b(fall|autumn|fa)\b/.test(text)) season = 3;
      else if (/\b(winter|wi)\b/.test(text)) season = 4;
      return year * 10 + season;
    };

    return [...terms.values()].map(term => ({
      ...term,
      start: term.starts.length ? Math.min(...term.starts) : null,
      end: term.ends.length ? Math.max(...term.ends) : null,
      labelRank: seasonRank(term.label)
    })).sort((a, b) => {
      if (a.key === "other") return 1;
      if (b.key === "other") return -1;
      const ar = Number.isFinite(a.labelRank) ? a.labelRank : -1;
      const br = Number.isFinite(b.labelRank) ? b.labelRank : -1;
      if (ar !== br) return br - ar;
      const as = Number.isFinite(a.start) ? a.start : -1;
      const bs = Number.isFinite(b.start) ? b.start : -1;
      if (as !== bs) return bs - as;
      return a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
    });
  }

  function currentTermKey() {
    const terms = discoveredTerms().filter(t => t.key !== "other");
    if (!terms.length) return null;
    const now = Date.now();

    const active = terms.filter(term => {
      const hasBoundary = Number.isFinite(term.start) || Number.isFinite(term.end);
      if (!hasBoundary) return false;
      return (!Number.isFinite(term.start) || now >= term.start) && (!Number.isFinite(term.end) || now <= term.end);
    });
    if (active.length) return active.sort((a, b) => (b.start || 0) - (a.start || 0))[0].key;

    // Generic academic-term fallback when dates are not exposed. This uses
    // semester names returned by Brightspace; no college or course names are
    // hardcoded. Fall is treated as Aug-Dec, Spring as Jan-May, Summer Jun-Jul.
    const d = new Date(now);
    const month = d.getMonth() + 1;
    const season = month >= 8 ? 3 : month >= 6 ? 2 : 1;
    const expected = d.getFullYear() * 10 + season;
    const exact = terms.find(term => term.labelRank === expected);
    if (exact) return exact.key;

    const ranked = terms.filter(t => Number.isFinite(t.labelRank)).sort((a, b) => Math.abs(a.labelRank - expected) - Math.abs(b.labelRank - expected));
    return ranked[0]?.key || terms[0]?.key || null;
  }

  function effectiveTermKey() {
    if (state.termFilter === "all") return "all";
    if (state.termFilter === "current") return currentTermKey() || "all";
    const exists = discoveredTerms().some(term => term.key === state.termFilter);
    return exists ? state.termFilter : (currentTermKey() || "all");
  }

  function termIsVisible(termKey) {
    const effective = effectiveTermKey();
    return effective === "all" || (termKey || "other") === effective;
  }

  function courseIsVisible(course) {
    return groupIsVisible(course.groupKey) && termIsVisible(course.termKey);
  }

  function visibleCourses() {
    return state.courses.filter(courseIsVisible);
  }

  function visibleDueItems() {
    return state.dueItems.filter(item => groupIsVisible(item.groupKey) && termIsVisible(item.termKey));
  }

  function visibleAnnouncements() {
    return state.announcements.filter(item => groupIsVisible(item.groupKey) && termIsVisible(item.termKey));
  }

  async function collectCoursesFromApi(lpVersion) {
    const enrollments = await fetchPaged(`/d2l/api/lp/${lpVersion}/enrollments/myenrollments/?isActive=true`);
    const candidates = enrollments.filter(e => e?.Access?.CanAccess !== false);
    let courses = candidates.filter(e => isCourseOffering(e) && !looksInstitutionalOrg(e));

    // Some installations customize org-unit type labels. If the normal course type
    // filter returns nothing, only fall back to accessible org units that look like
    // navigable course homes and have an ID distinct from the current org homepage.
    if (!courses.length) {
      const current = currentHomeOrgUnitId();
      courses = candidates.filter(e => {
        const org = e?.OrgUnit || {};
        return org.Id && Number(org.Id) !== current && !looksInstitutionalOrg(e) &&
          org.HomeUrl && /\/d2l\/home\/\d+/i.test(org.HomeUrl);
      });
    }

    const mapped = courses.map(entry => {
      const org = entry.OrgUnit || {};
      const code = normalize(org.Code || "");
      return {
        type: "course",
        title: normalize(org.Name || `Course ${org.Id}`),
        subtitle: code ? `${code} · Course` : "Course",
        code,
        url: absoluteUrl(org.HomeUrl || `/d2l/home/${org.Id}`),
        orgUnitId: Number(org.Id),
        pinnedInBrightspace: Boolean(entry.PinDate),
        accessStart: safeTimestamp(entry?.Access?.StartDate),
        accessEnd: safeTimestamp(entry?.Access?.EndDate),
        termKey: "other",
        termLabel: "Other"
      };
    }).filter(c => c.url && c.title).sort((a, b) => a.title.localeCompare(b.title));

    const grouped = applyCourseGroups(mapped);
    return attachCourseTerms(lpVersion, grouped);
  }

  function dateForCalendarEvent(event) {
    const raw = event?.StartDateTime || event?.StartDay || event?.EndDateTime || event?.EndDay || null;
    if (!raw) return { raw: "", time: null };
    const d = new Date(raw);
    return { raw, time: Number.isNaN(d.getTime()) ? null : d.getTime() };
  }

  function formatDateTime(time) {
    if (!time) return "date unavailable";
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(time));
  }

  async function collectDueFromApi(leVersion, courses) {
    const ids = courses.map(c => c.orgUnitId).filter(Number.isFinite).slice(0, 100);
    if (!ids.length) return [];

    const start = new Date(Date.now() - 30 * 86400000).toISOString();
    const end = new Date(Date.now() + 45 * 86400000).toISOString();
    const u = new URL(`/d2l/api/le/${leVersion}/calendar/events/myEvents/`, location.origin);
    u.searchParams.set("orgUnitIdsCSV", ids.join(","));
    u.searchParams.set("startDateTime", start);
    u.searchParams.set("endDateTime", end);
    u.searchParams.set("eventType", "DueDate");
    u.searchParams.set("association", "Any");

    const events = await fetchPaged(u.pathname + u.search, 8);
    const courseById = new Map(courses.map(c => [c.orgUnitId, c]));

    return events.map(event => {
      const date = dateForCalendarEvent(event);
      const course = courseById.get(Number(event.OrgUnitId));
      const entityLink = event?.AssociatedEntity?.Link || event?.AssociatedEntityInfo?.Link;
      const url = absoluteUrl(entityLink || event.CalendarEventViewUrl || course?.url || `/d2l/home/${event.OrgUnitId}`);
      const courseName = normalize(event.OrgUnitName || course?.title || "Brightspace");
      return {
        type: "due",
        eventId: Number(event.CalendarEventId || event.Id || 0) || null,
        key: `api:${event.OrgUnitId}:${event.CalendarEventId || event.Id || normalize(event.Title || "due")}:${date.raw}`,
        title: normalize(event.Title || "Due item"),
        subtitle: `${courseName} · Due ${formatDateTime(date.time)}`,
        due: date.time,
        dueRaw: date.raw,
        url,
        orgUnitId: Number(event.OrgUnitId),
        groupKey: course?.groupKey || "",
        groupLabel: course?.groupLabel || "",
        termKey: course?.termKey || "other",
        termLabel: course?.termLabel || "Other"
      };
    }).filter(item => item.url && item.title)
      .sort((a, b) => (a.due ?? Number.MAX_SAFE_INTEGER) - (b.due ?? Number.MAX_SAFE_INTEGER));
  }


  function richTextToPlain(value) {
    if (!value) return "";
    if (typeof value === "string") return normalize(value.replace(/<[^>]*>/g, " "));
    const text = normalize(value.Text || value.PlainText || "");
    if (text) return text;
    return normalize(String(value.Html || "")
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"));
  }

  function parseNewsIds(apiUrl = "") {
    const match = String(apiUrl).match(/\/d2l\/api\/le\/[^/]+\/(\d+)\/news(?:\/(\d+))?/i);
    return {
      orgUnitId: match ? Number(match[1]) : null,
      newsItemId: match?.[2] ? Number(match[2]) : null
    };
  }

  function announcementFromFeedRow(row, courseById) {
    const meta = row?.MessageMetaData || {};
    const resource = row?.Resource || {};
    const apiUrl = meta.ApiViewUrl || "";
    const type = normalize(row?.Type || "").toLowerCase();
    if (!type.includes("news") && !/\/news(?:\/|$)/i.test(apiUrl)) return null;

    const parsed = parseNewsIds(apiUrl);
    const orgUnitId = Number(resource.OrgUnitId ?? parsed.orgUnitId);
    const course = courseById.get(orgUnitId);
    if (!course) return null;
    if (resource.IsHidden === true || resource.IsPublished === false) return null;

    const id = Number(resource.Id ?? parsed.newsItemId) || null;
    const published = safeTimestamp(resource.StartDate || meta.Date || resource.CreatedDate || resource.LastModifiedDate);
    const title = normalize(resource.Title || meta.Title || "Announcement");
    const summary = richTextToPlain(meta.Summary || resource.Body);
    const identifier = normalize(meta.Identifier || "");
    const key = `news:${orgUnitId}:${id || identifier || title.toLowerCase()}`;
    return {
      type: "announcement",
      key,
      announcementId: id,
      title,
      subtitle: `${course.title} · ${published ? formatDateTime(published) : "Announcement"}${summary ? ` · ${summary.slice(0, 120)}` : ""}`,
      summary,
      published,
      url: absoluteUrl(meta.WebViewUrl || course.url),
      orgUnitId,
      courseTitle: course.title,
      groupKey: course.groupKey || "",
      groupLabel: course.groupLabel || "",
      termKey: course.termKey || "other",
      termLabel: course.termLabel || "Other"
    };
  }

  async function collectAnnouncementsFromApi(lpVersion, leVersion, courses) {
    const courseById = new Map(courses.map(c => [Number(c.orgUnitId), c]));
    const since = new Date(Date.now() - ANNOUNCEMENT_LOOKBACK_MS).toISOString();
    const current = currentTermKey();
    const relevant = courses
      .filter(course => groupIsVisible(course.groupKey))
      .filter(course => !current || (course.termKey || "other") === current)
      .slice(0, 25);

    // The per-course news route is the source of truth for announcements.
    // Query only visible current-semester courses so old enrollments do not
    // create request or notification noise.
    const settled = await Promise.allSettled(relevant.map(async course => {
      const u = new URL(`/d2l/api/le/${leVersion}/${course.orgUnitId}/news/`, location.origin);
      u.searchParams.set("since", since);
      const rows = await fetchJson(u.pathname + u.search);
      return (Array.isArray(rows) ? rows : listItems(rows)).map(resource => {
        if (resource?.IsHidden === true || resource?.IsPublished === false) return null;
        const id = Number(resource?.Id) || null;
        const published = safeTimestamp(resource?.StartDate || resource?.CreatedDate || resource?.LastModifiedDate);
        const title = normalize(resource?.Title || "Announcement");
        const summary = richTextToPlain(resource?.Body);
        return {
          type: "announcement",
          key: `news:${course.orgUnitId}:${id || title.toLowerCase()}`,
          announcementId: id,
          title,
          subtitle: `${course.title} · ${published ? formatDateTime(published) : "Announcement"}${summary ? ` · ${summary.slice(0, 120)}` : ""}`,
          summary,
          published,
          url: course.url,
          orgUnitId: course.orgUnitId,
          courseTitle: course.title,
          groupKey: course.groupKey || "",
          groupLabel: course.groupLabel || "",
          termKey: course.termKey || "other",
          termLabel: course.termLabel || "Other"
        };
      }).filter(Boolean);
    }));

    const directItems = settled.flatMap(result => result.status === "fulfilled" ? result.value : []);
    const anyDirectSucceeded = !settled.length || settled.some(result => result.status === "fulfilled");
    if (anyDirectSucceeded) {
      return [...new Map(directItems.map(item => [item.key, item])).values()]
        .sort((a, b) => (b.published || 0) - (a.published || 0));
    }

    // Compatibility fallback: Brightspace's current-user feed is a single
    // request and supplies the real WebViewUrl for recognized news items.
    const u = new URL(`/d2l/api/lp/${lpVersion}/feed/`, location.origin);
    u.searchParams.set("since", since);
    const feed = await fetchJson(u.pathname + u.search);
    const rows = Array.isArray(feed) ? feed : listItems(feed);
    const items = rows.map(row => announcementFromFeedRow(row, courseById)).filter(Boolean)
      .filter(item => groupIsVisible(item.groupKey))
      .filter(item => !current || (item.termKey || "other") === current);
    return [...new Map(items.map(item => [item.key, item])).values()]
      .sort((a, b) => (b.published || 0) - (a.published || 0));
  }

  function stableDeadlineIdentity(item) {
    if (Number.isFinite(Number(item.eventId)) && Number.isFinite(Number(item.orgUnitId))) {
      return `event:${Number(item.orgUnitId)}:${Number(item.eventId)}`;
    }
    if (item.url) return `url:${item.url}`;
    return `title:${Number(item.orgUnitId) || 0}:${normalize(item.title).toLowerCase()}`;
  }

  function activityDateLabel(time) {
    if (!Number.isFinite(Number(time))) return "unknown";
    return new Intl.DateTimeFormat(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    }).format(new Date(Number(time)));
  }

  async function processDeadlineChanges(items) {
    const data = await chrome.storage.local.get({
      bcDeadlineSnapshot: {},
      bcDeadlineSnapshotReady: false
    });
    const previous = data.bcDeadlineSnapshot && typeof data.bcDeadlineSnapshot === "object" ? data.bcDeadlineSnapshot : {};
    const current = {};
    const alerts = [];

    for (const item of items) {
      if (!Number.isFinite(item.due)) continue;
      const identity = stableDeadlineIdentity(item);
      current[identity] = {
        due: item.due, title: item.title, url: item.url, orgUnitId: item.orgUnitId || null,
        courseTitle: state.courses.find(c => Number(c.orgUnitId) === Number(item.orgUnitId))?.title || "Brightspace",
        groupKey: item.groupKey || "", termKey: item.termKey || "other"
      };
      const old = previous[identity];
      if (!data.bcDeadlineSnapshotReady || !old || !Number.isFinite(Number(old.due))) continue;
      if (Math.abs(Number(old.due) - Number(item.due)) < 60_000) continue;
      if (!state.alertSettings.deadlineChanges || !groupIsVisible(item.groupKey)) continue;
      const currentTerm = currentTermKey();
      if (currentTerm && (item.termKey || "other") !== currentTerm) continue;
      const courseTitle = state.courses.find(c => Number(c.orgUnitId) === Number(item.orgUnitId))?.title || "Brightspace";
      alerts.push({
        key: `deadline-change:${identity}:${Number(old.due)}:${Number(item.due)}`,
        title: "Deadline changed",
        message: `${courseTitle} · ${item.title}\n${activityDateLabel(old.due)} → ${activityDateLabel(item.due)}`,
        url: item.url
      });
    }

    await chrome.storage.local.set({ bcDeadlineSnapshot: current, bcDeadlineSnapshotReady: true });
    if (alerts.length) {
      try { chrome.runtime.sendMessage({ type: "BC_ACTIVITY_ALERTS", alerts }); } catch {}
    }
  }

  async function processAnnouncements(items) {
    const termKey = currentTermKey() || "current";
    const data = await chrome.storage.local.get({
      bcSeenAnnouncementKeys: [],
      bcAnnouncementBaselineTerms: {}
    });
    const seen = new Set(Array.isArray(data.bcSeenAnnouncementKeys) ? data.bcSeenAnnouncementKeys : []);
    const baselines = data.bcAnnouncementBaselineTerms && typeof data.bcAnnouncementBaselineTerms === "object" ? data.bcAnnouncementBaselineTerms : {};
    const baselineReady = baselines[termKey] === true;
    const currentItems = items.filter(item => (item.termKey || "other") === termKey || termKey === "current");
    const newItems = baselineReady ? currentItems.filter(item => !seen.has(item.key)) : [];
    state.newAnnouncementKeys = new Set(newItems.map(item => item.key));

    for (const item of currentItems) seen.add(item.key);
    baselines[termKey] = true;
    // Keep storage bounded while retaining enough IDs to avoid duplicate alerts.
    const keys = [...seen].slice(-500);
    await chrome.storage.local.set({
      bcSeenAnnouncementKeys: keys,
      bcAnnouncementBaselineTerms: baselines
    });

    if (!state.alertSettings.announcements || !newItems.length) return;
    const alerts = newItems
      .filter(item => groupIsVisible(item.groupKey))
      .slice(0, 5)
      .map(item => ({
        key: `announcement:${item.key}`,
        title: "New announcement",
        message: `${item.courseTitle || "Brightspace"} · ${item.title}`,
        url: item.url
      }));
    if (alerts.length) {
      try { chrome.runtime.sendMessage({ type: "BC_ACTIVITY_ALERTS", alerts }); } catch {}
    }
  }

  // ----- Deep DOM fallback -------------------------------------------------
  // Brightspace uses web components and can place useful links inside open
  // shadow roots and same-origin iframes. V1 only searched document itself.

  function deepRoots() {
    const roots = [document];
    const seen = new Set(roots);
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      let all = [];
      try { all = [...root.querySelectorAll("*")]; } catch {}
      for (const el of all) {
        if (el.shadowRoot && !seen.has(el.shadowRoot)) {
          seen.add(el.shadowRoot);
          roots.push(el.shadowRoot);
        }
        if (el.tagName === "IFRAME") {
          try {
            const doc = el.contentDocument;
            if (doc && !seen.has(doc)) {
              seen.add(doc);
              roots.push(doc);
            }
          } catch {}
        }
      }
    }
    return roots;
  }

  function deepQueryAll(selector) {
    const result = [];
    const seen = new Set();
    for (const root of deepRoots()) {
      try {
        for (const el of root.querySelectorAll(selector)) {
          if (!seen.has(el)) { seen.add(el); result.push(el); }
        }
      } catch {}
    }
    return result;
  }

  function composedParent(el) {
    if (el?.parentElement) return el.parentElement;
    const root = el?.getRootNode?.();
    return root?.host || null;
  }

  function nearbyLabel(el) {
    const values = [];
    let node = el;
    for (let depth = 0; node && depth < 6; depth++, node = composedParent(node)) {
      values.push(node.getAttribute?.("aria-label"), node.getAttribute?.("title"), node.textContent);
    }
    return values.map(normalize).find(v => v && v.length >= 3 && v.length <= 220) || "";
  }

  function cleanCourseTitle(text) {
    return normalize(text)
      .replace(/^(course|open course)\s*[:-]?\s*/i, "")
      .replace(/\s+(course home|homepage)$/i, "");
  }

  function collectCoursesFromDom() {
    const currentId = currentHomeOrgUnitId();
    const found = [];
    deepQueryAll('[href*="/d2l/home/"]').forEach(el => {
      const href = el.getAttribute?.("href") || el.href;
      const url = absoluteUrl(href);
      if (!url) return;
      const match = new URL(url).pathname.match(/^\/d2l\/home\/(\d+)/i);
      const id = match ? Number(match[1]) : null;
      if (!id || id === currentId) return;

      const title = cleanCourseTitle(
        el.getAttribute?.("aria-label") || el.getAttribute?.("title") || nearbyLabel(el)
      );
      if (title.length < 3 || title.length > 180) return;
      if (/^(cuny|city university of new york)$/i.test(title)) return;
      if (/\b(college|university|school|campus)\s*$/i.test(title)) return;
      found.push({ type: "course", title, subtitle: "Course · page fallback", code: "", url, orgUnitId: id });
    });
    return applyCourseGroups(uniqueByUrl(found).slice(0, 50));
  }

  function extractDateFromText(text) {
    const t = normalize(text);
    const patterns = [
      /(?:due|ends?|deadline)\s*[:\-]?\s*((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?([a-z]{3,9}\.?\s+\d{1,2}(?:,\s*\d{4})?(?:\s+(?:at\s+)?\d{1,2}:\d{2}\s*(?:am|pm)?)?)/i,
      /(?:due|ends?|deadline)\s*[:\-]?\s*(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s+\d{1,2}:\d{2}\s*(?:am|pm)?)?)/i
    ];
    for (const p of patterns) {
      const m = t.match(p);
      if (!m) continue;
      const raw = normalize(m.slice(1).filter(Boolean).join(" "));
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) return { raw, parsed };
      return { raw, parsed: null };
    }
    return null;
  }

  function collectDueFromDom() {
    const candidates = [];
    const selector = [
      '[href*="/d2l/le/dropbox/"]',
      '[href*="/d2l/lms/dropbox/"]',
      '[href*="/d2l/lms/quizzing/"]',
      '[href*="/d2l/le/content/"]',
      '[href*="calendar"]'
    ].join(",");

    deepQueryAll(selector).forEach(el => {
      let node = el;
      let text = "";
      for (let depth = 0; node && depth < 5; depth++, node = composedParent(node)) {
        const candidate = normalize(node.textContent || "");
        if (/\b(due|deadline|ends?)\b/i.test(candidate)) { text = candidate; break; }
      }
      const date = extractDateFromText(text);
      if (!date) return;

      let title = normalize(el.getAttribute?.("aria-label") || el.getAttribute?.("title") || nearbyLabel(el));
      if (title.length < 3) title = text.slice(0, 120);
      if (title.length > 180) title = title.slice(0, 177) + "…";
      const url = absoluteUrl(el.getAttribute?.("href") || el.href);
      if (!url) return;

      candidates.push({
        type: "due",
        key: `dom:${url}:${date.raw}`,
        title,
        subtitle: `Due ${date.raw} · page fallback`,
        due: date.parsed ? date.parsed.getTime() : null,
        dueRaw: date.raw,
        url
      });
    });

    return uniqueByUrl(candidates)
      .sort((a, b) => (a.due ?? Number.MAX_SAFE_INTEGER) - (b.due ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 50);
  }



  const DEFAULT_REMINDER_SETTINGS = {
    assignmentLeads: [1440, 180],
    classLeads: [30]
  };

  Object.assign(state, {
    view: "today",
    classSchedules: [],
    reminderSettings: structuredClone(DEFAULT_REMINDER_SETTINGS),
    alertSettings: structuredClone(DEFAULT_ALERT_SETTINGS),
    scheduleEditorOpen: false,
    editingScheduleId: null
  });

  async function loadPreferences() {
    const data = await chrome.storage.local.get({
      bcFavorites: [],
      bcHiddenCourseGroups: [],
      bcTermFilter: "current",
      bcClassSchedules: [],
      bcReminderSettings: DEFAULT_REMINDER_SETTINGS,
      bcAlertSettings: DEFAULT_ALERT_SETTINGS,
      bcLastAutoSyncAt: 0
    });
    state.favorites = new Set(Array.isArray(data.bcFavorites) ? data.bcFavorites : []);
    state.hiddenCourseGroups = new Set(
      Array.isArray(data.bcHiddenCourseGroups) ? data.bcHiddenCourseGroups : []
    );
    state.termFilter = typeof data.bcTermFilter === "string" ? data.bcTermFilter : "current";
    state.classSchedules = Array.isArray(data.bcClassSchedules) ? data.bcClassSchedules : [];
    lastAutoSyncAt = Number(data.bcLastAutoSyncAt || 0);
    state.alertSettings = {
      announcements: data.bcAlertSettings?.announcements !== false,
      deadlineChanges: data.bcAlertSettings?.deadlineChanges !== false
    };
    state.reminderSettings = {
      assignmentLeads: Array.isArray(data.bcReminderSettings?.assignmentLeads)
        ? data.bcReminderSettings.assignmentLeads.map(Number).filter(Number.isFinite)
        : [...DEFAULT_REMINDER_SETTINGS.assignmentLeads],
      classLeads: Array.isArray(data.bcReminderSettings?.classLeads)
        ? data.bcReminderSettings.classLeads.map(Number).filter(Number.isFinite)
        : [...DEFAULT_REMINDER_SETTINGS.classLeads]
    };
  }

  async function toggleCourseGroup(groupKey) {
    if (!groupKey) return;
    if (state.hiddenCourseGroups.has(groupKey)) state.hiddenCourseGroups.delete(groupKey);
    else state.hiddenCourseGroups.add(groupKey);

    await chrome.storage.local.set({
      bcHiddenCourseGroups: [...state.hiddenCourseGroups]
    });

    state.selectedIndex = 0;
    await persistReminderCache();
    render();
  }

  async function setTermFilter(value) {
    state.termFilter = value || "current";
    await chrome.storage.local.set({ bcTermFilter: state.termFilter });
    state.selectedIndex = 0;
    await persistReminderCache();
    render();
  }

  async function toggleFavorite(url) {
    if (state.favorites.has(url)) state.favorites.delete(url);
    else state.favorites.add(url);
    await chrome.storage.local.set({ bcFavorites: [...state.favorites] });
    render();
  }

  function reminderCacheItems() {
    const current = currentTermKey();
    return state.dueItems
      .filter(item => groupIsVisible(item.groupKey))
      .filter(item => !current || (item.termKey || "other") === current)
      .filter(item => Number.isFinite(item.due))
      .map(item => ({
        key: item.key || `due:${item.orgUnitId || 0}:${item.url}:${item.due}`,
        title: item.title,
        subtitle: item.subtitle,
        due: item.due,
        url: item.url,
        orgUnitId: item.orgUnitId || null,
        groupKey: item.groupKey || "",
        termKey: item.termKey || "other"
      }));
  }

  async function persistReminderCache() {
    await chrome.storage.local.set({
      bcDueCache: reminderCacheItems(),
      bcDueCacheUpdatedAt: Date.now(),
      bcCurrentTermKey: currentTermKey() || ""
    });
    try { chrome.runtime.sendMessage({ type: "BC_REMINDER_DATA_UPDATED" }); } catch {}
  }

  async function performScan({ forceApi = false } = {}) {
    const canReuseApi = !forceApi && state.scan.api === "ok" && Date.now() - lastApiScanAt < API_CACHE_MS;
    if (canReuseApi) {
      render();
      return;
    }

    try {
      const versions = await getApiVersions();
      const apiCourses = await collectCoursesFromApi(versions.lp);
      if (!apiCourses.length) throw new Error("API returned no course offerings");
      state.courses = apiCourses;

      let apiDue = [];
      let calendarError = "";
      try {
        apiDue = await collectDueFromApi(versions.le, apiCourses);
      } catch (error) {
        calendarError = normalize(error?.message || error);
      }

      let announcements = [];
      let announcementError = "";
      try {
        announcements = await collectAnnouncementsFromApi(versions.lp, versions.le, apiCourses);
      } catch (error) {
        announcementError = normalize(error?.message || error);
      }

      state.dueItems = apiDue.length ? apiDue : collectDueFromDom();
      state.announcements = announcements;

      // Change/new-item detection is API-only so DOM layout changes can never
      // manufacture a false Windows alert. First successful sync is baseline.
      if (!calendarError) await processDeadlineChanges(apiDue);
      if (!announcementError) await processAnnouncements(announcements);

      const details = [`LP ${versions.lp} · LE ${versions.le}`];
      if (calendarError) details.push(`calendar fallback: ${calendarError}`);
      if (announcementError) details.push(`announcements unavailable: ${announcementError}`);
      state.scan = {
        source: apiDue.length || !calendarError ? "Brightspace API" : "API courses + page deadlines",
        api: "ok",
        detail: details.join(" · ")
      };
      lastApiScanAt = Date.now();
    } catch (error) {
      state.courses = collectCoursesFromDom();
      state.dueItems = collectDueFromDom();
      state.announcements = [];
      state.scan = {
        source: "Deep page scan",
        api: "fallback",
        detail: normalize(error?.message || error)
      };
    }

    lastAutoSyncAt = Date.now();
    await chrome.storage.local.set({ bcLastAutoSyncAt: lastAutoSyncAt });
    await persistReminderCache();
    render();
  }

  function scanPage(options = {}) {
    if (scanInFlight && !options.forceApi) return scanInFlight;
    scanInFlight = performScan(options).finally(() => { scanInFlight = null; });
    return scanInFlight;
  }

  async function maybeAutoSync({ force = false } = {}) {
    const now = Date.now();
    if (!force && now - lastAutoSyncAt < AUTO_SYNC_MIN_INTERVAL_MS) return;
    try {
      await scanPage({ forceApi: true });
    } catch {
      // Auto-sync is best-effort. The normal in-page UI still exposes sync
      // status and lets the student retry manually if Brightspace is offline.
    }
  }

  function scheduleAutoSync({ force = false } = {}) {
    clearTimeout(autoSyncTimer);
    autoSyncTimer = setTimeout(() => maybeAutoSync({ force }), AUTO_SYNC_ROUTE_DEBOUNCE_MS);
  }

  function installNavigationAutoSync() {
    const onPotentialNavigation = () => {
      if (location.href === lastObservedUrl) return;
      lastObservedUrl = location.href;
      scheduleAutoSync();
    };

    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      if (typeof original !== "function") continue;
      history[method] = function(...args) {
        const result = original.apply(this, args);
        queueMicrotask(onPotentialNavigation);
        return result;
      };
    }

    addEventListener("popstate", onPotentialNavigation, true);
    addEventListener("hashchange", onPotentialNavigation, true);
    addEventListener("pageshow", () => scheduleAutoSync(), true);
    addEventListener("focus", () => scheduleAutoSync(), true);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") scheduleAutoSync();
    }, true);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function startOfDay(time = Date.now()) {
    const d = new Date(time);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function endOfDay(time = Date.now()) {
    const d = new Date(time);
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  function sameLocalDay(a, b) {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
  }

  function formatClock(time) {
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(time));
  }

  function formatDayHeading(time) {
    if (sameLocalDay(time, Date.now())) return "Today";
    if (sameLocalDay(time, Date.now() + 86400000)) return "Tomorrow";
    return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(new Date(time));
  }

  function formatTimeValue(hhmm) {
    const [h, m] = String(hhmm || "").split(":").map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return "";
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(d);
  }

  function scheduleCourse(schedule) {
    return state.courses.find(c => Number(c.orgUnitId) === Number(schedule.orgUnitId)) || null;
  }

  function scheduleIsVisible(schedule) {
    const course = scheduleCourse(schedule);
    return !course || courseIsVisible(course);
  }

  function classOccurrence(schedule, dayTime) {
    const d = new Date(dayTime);
    const [hour, minute] = String(schedule.startTime || "").split(":").map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    d.setHours(hour, minute, 0, 0);
    const start = d.getTime();
    const [endHour, endMinute] = String(schedule.endTime || "").split(":").map(Number);
    const end = Number.isFinite(endHour) && Number.isFinite(endMinute)
      ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), endHour, endMinute, 0, 0).getTime()
      : null;
    const course = scheduleCourse(schedule);
    const title = schedule.label || course?.title || "Class";
    const room = normalize(schedule.room || "");
    const when = end ? `${formatClock(start)}–${formatClock(end)}` : formatClock(start);
    return {
      type: "class",
      scheduleId: schedule.id,
      title,
      subtitle: `Class · ${when}${room ? ` · ${room}` : ""}`,
      start,
      end,
      room,
      url: course?.url || schedule.url || location.origin,
      orgUnitId: Number(schedule.orgUnitId) || null,
      groupKey: course?.groupKey || ""
    };
  }

  function classOccurrences(daysAhead = 8) {
    const result = [];
    const base = startOfDay();
    for (let offset = 0; offset < daysAhead; offset++) {
      const day = new Date(base + offset * 86400000);
      const weekday = day.getDay();
      for (const schedule of state.classSchedules) {
        if (!scheduleIsVisible(schedule)) continue;
        if (!Array.isArray(schedule.days) || !schedule.days.map(Number).includes(weekday)) continue;
        const item = classOccurrence(schedule, day.getTime());
        if (item) result.push(item);
      }
    }
    return result.sort((a, b) => a.start - b.start);
  }

  function visibleUpcomingDue() {
    const now = Date.now();
    return visibleDueItems().filter(item => Number.isFinite(item.due) && item.due >= startOfDay(now) - 1);
  }

  function filtered(items) {
    if (!state.query) return items;
    return items.filter(i => `${i.title || ""} ${i.subtitle || ""}`.toLowerCase().includes(state.query));
  }

  function dueChip(item) {
    if (!item.due) return `<span class="bc-chip">due</span>`;
    const delta = item.due - Date.now();
    if (delta < 0) return `<span class="bc-chip bc-overdue">past due</span>`;
    const minutes = Math.ceil(delta / 60000);
    if (minutes < 60) return `<span class="bc-chip bc-soon">${minutes}m</span>`;
    const hours = Math.ceil(minutes / 60);
    if (hours <= 24) return `<span class="bc-chip bc-soon">${hours}h</span>`;
    const days = Math.ceil(hours / 24);
    return `<span class="bc-chip">${days}d</span>`;
  }

  function classChip(item) {
    const delta = item.start - Date.now();
    if (delta >= 0 && delta < 3600000) return `<span class="bc-chip bc-soon">in ${Math.max(1, Math.ceil(delta / 60000))}m</span>`;
    return `<span class="bc-chip">${formatClock(item.start)}</span>`;
  }

  function itemHtml(item, globalIndex) {
    const icon = item.type === "course" ? "▤" : item.type === "class" ? "▦" : item.type === "announcement" ? "!" : "◷";
    const isFav = state.favorites.has(item.url);
    return `
      <div class="bc-item ${item.type === "announcement" ? "bc-announcement" : ""} ${globalIndex === state.selectedIndex ? "bc-active" : ""}" data-index="${globalIndex}" data-url="${escapeHtml(item.url)}">
        <div class="bc-icon">${icon}</div>
        <div class="bc-copy">
          <div class="bc-title">${escapeHtml(item.title)}</div>
          <div class="bc-subtitle">${escapeHtml(item.subtitle || "")}</div>
        </div>
        ${item.type === "due" ? dueChip(item) : item.type === "class" ? classChip(item) : item.type === "announcement" && state.newAnnouncementKeys.has(item.key) ? `<span class="bc-chip bc-new">new</span>` : ""}
        ${item.type === "course" ? `<button class="bc-star ${isFav ? "bc-favorite" : ""}" title="${isFav ? "Unpin" : "Pin"}" data-favorite-url="${escapeHtml(item.url)}">${isFav ? "★" : "☆"}</button>` : ""}
      </div>`;
  }

  function section(title, items, startIndex) {
    if (!items.length) return { html: "", next: startIndex };
    const html = items.map((item, idx) => itemHtml(item, startIndex + idx)).join("");
    return {
      html: `<section class="bc-section"><div class="bc-heading"><span>${escapeHtml(title)}</span><span>${items.length}</span></div><div class="bc-list">${html}</div></section>`,
      next: startIndex + items.length
    };
  }

  function termFiltersHtml() {
    const terms = discoveredTerms();
    const currentKey = currentTermKey();
    if (!terms.length || (!currentKey && terms.length === 1 && terms[0].key === "other")) return "";

    const effective = effectiveTermKey();
    const ordered = [...terms].sort((a, b) => {
      if (a.key === currentKey) return -1;
      if (b.key === currentKey) return 1;
      return 0;
    });
    const buttons = ordered.map(term => {
      const selected = effective === term.key;
      const value = term.key === currentKey ? "current" : term.key;
      const current = term.key === currentKey;
      return `
        <button class="bc-filter-chip bc-term-chip ${selected ? "" : "bc-filter-hidden"}" type="button" data-course-term="${escapeHtml(value)}" aria-pressed="${selected ? "true" : "false"}">
          <span class="bc-filter-state">${selected ? "✓" : "○"}</span>
          <span>${escapeHtml(term.label)}${current ? ` <span class="bc-current-term">Current</span>` : ""}</span>
          <span class="bc-filter-count">${term.count}</span>
        </button>`;
    }).join("");
    const allSelected = effective === "all";
    const allButton = `
      <button class="bc-filter-chip bc-term-chip ${allSelected ? "" : "bc-filter-hidden"}" type="button" data-course-term="all" aria-pressed="${allSelected ? "true" : "false"}">
        <span class="bc-filter-state">${allSelected ? "✓" : "○"}</span><span>All terms</span><span class="bc-filter-count">${state.courses.length}</span>
      </button>`;

    return `
      <section class="bc-filter-section bc-term-filter-section">
        <div class="bc-heading"><span>Semester</span><span>${visibleCourses().length}/${state.courses.length} shown</span></div>
        <div class="bc-filter-row">${buttons}${allButton}</div>
      </section>`;
  }

  function courseFiltersHtml() {
    const groups = discoveredCourseGroups();
    if (groups.length < 2 && !groups.some(g => state.hiddenCourseGroups.has(g.key))) return "";

    const buttons = groups.map(group => {
      const hidden = state.hiddenCourseGroups.has(group.key);
      return `
        <button class="bc-filter-chip ${hidden ? "bc-filter-hidden" : ""}" type="button" data-course-group="${escapeHtml(group.key)}" aria-pressed="${hidden ? "false" : "true"}">
          <span class="bc-filter-state">${hidden ? "○" : "✓"}</span>
          <span>${escapeHtml(group.label)}</span>
          <span class="bc-filter-count">${group.count}</span>
        </button>`;
    }).join("");

    return `
      <section class="bc-filter-section">
        <div class="bc-heading"><span>Course groups</span></div>
        <div class="bc-filter-row">${buttons}</div>
      </section>`;
  }

  function navHtml() {
    const tabs = [
      ["today", "Today"],
      ["upcoming", "Upcoming"],
      ["schedule", "Schedule"],
      ["courses", "Courses"]
    ];
    return `<nav class="bc-tabs">${tabs.map(([id, label]) => `<button type="button" class="bc-tab ${state.view === id ? "bc-tab-active" : ""}" data-view="${id}">${label}</button>`).join("")}</nav>`;
  }

  function overviewHtml() {
    const now = Date.now();
    const todayDue = visibleDueItems().filter(i => Number.isFinite(i.due) && i.due >= startOfDay(now) && i.due <= endOfDay(now));
    const weekEnd = endOfDay(now + 6 * 86400000);
    const weekDue = visibleDueItems().filter(i => Number.isFinite(i.due) && i.due >= startOfDay(now) && i.due <= weekEnd);
    const todayClasses = classOccurrences(1);
    return `
      <div class="bc-overview">
        <div><strong>${todayDue.length}</strong><span>Due today</span></div>
        <div><strong>${todayClasses.length}</strong><span>Classes today</span></div>
        <div><strong>${weekDue.length}</strong><span>Next 7 days</span></div>
      </div>`;
  }

  function nextActionHtml() {
    const now = Date.now();
    const candidates = [
      ...visibleDueItems().filter(i => Number.isFinite(i.due) && i.due >= now).map(i => ({ ...i, at: i.due })),
      ...classOccurrences(8).filter(i => i.start >= now).map(i => ({ ...i, at: i.start }))
    ].sort((a, b) => a.at - b.at);
    const next = candidates[0];
    if (!next) return "";
    const label = next.type === "class" ? "Next class" : "Next deadline";
    const when = sameLocalDay(next.at, now)
      ? `Today · ${formatClock(next.at)}`
      : `${formatDayHeading(next.at)} · ${formatClock(next.at)}`;
    return `<section class="bc-next"><div class="bc-next-label">${label}</div><div class="bc-next-title">${escapeHtml(next.title)}</div><div class="bc-next-meta">${escapeHtml(when)}${next.room ? ` · ${escapeHtml(next.room)}` : ""}</div></section>`;
  }

  function searchResultsHtml() {
    const classItems = classOccurrences(30);
    const items = filtered([...visibleCourses(), ...visibleDueItems(), ...visibleAnnouncements(), ...classItems]);
    state.flatVisibleItems = items;
    let index = 0;
    const result = section("Search results", items, index);
    return result.html || `<div class="bc-empty">No matching classes, deadlines, announcements, or courses.</div>`;
  }

  function todayViewHtml() {
    const now = Date.now();
    const todayStart = startOfDay(now), todayEnd = endOfDay(now);
    const todayClasses = classOccurrences(1).filter(i => i.start >= todayStart && i.start <= todayEnd);
    const todayDue = visibleDueItems().filter(i => Number.isFinite(i.due) && i.due >= todayStart && i.due <= todayEnd);
    const tomorrowDue = visibleDueItems().filter(i => Number.isFinite(i.due) && i.due > todayEnd && i.due <= endOfDay(now + 86400000));
    const tomorrowClasses = classOccurrences(2).filter(i => i.start > todayEnd);

    const timeline = [...todayClasses, ...todayDue].sort((a, b) => (a.start || a.due) - (b.start || b.due));
    const tomorrow = [...tomorrowClasses, ...tomorrowDue].sort((a, b) => (a.start || a.due) - (b.start || b.due));
    state.flatVisibleItems = [...timeline, ...tomorrow];

    const recentAnnouncements = visibleAnnouncements()
      .filter(item => !Number.isFinite(item.published) || item.published >= Date.now() - ANNOUNCEMENT_LOOKBACK_MS)
      .slice(0, 5);

    let index = 0, html = overviewHtml() + nextActionHtml();
    let s = section("Recent announcements", recentAnnouncements, index); html += s.html; index = s.next;
    s = section("Today", timeline, index); html += s.html; index = s.next;
    s = section("Tomorrow", tomorrow, index); html += s.html; index = s.next;
    state.flatVisibleItems = [...recentAnnouncements, ...timeline, ...tomorrow];
    if (!recentAnnouncements.length && !timeline.length && !tomorrow.length) html += `<div class="bc-empty">Nothing scheduled for today or tomorrow. Nice.</div>`;
    return html;
  }

  function upcomingViewHtml() {
    const start = startOfDay();
    const end = endOfDay(Date.now() + 13 * 86400000);
    const items = [
      ...visibleDueItems().filter(i => Number.isFinite(i.due) && i.due >= start && i.due <= end),
      ...classOccurrences(14)
    ].sort((a, b) => (a.start || a.due) - (b.start || b.due));

    state.flatVisibleItems = items;
    if (!items.length) return `<div class="bc-empty">Nothing upcoming in the next 14 days.</div>`;

    let index = 0, html = "";
    const days = new Map();
    for (const item of items) {
      const at = item.start || item.due;
      const key = new Date(at).toDateString();
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(item);
    }
    for (const dayItems of days.values()) {
      const at = dayItems[0].start || dayItems[0].due;
      const s = section(formatDayHeading(at), dayItems, index);
      html += s.html; index = s.next;
    }
    return html;
  }

  function daysSummary(days) {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return (days || []).map(Number).sort().map(d => names[d]).join(" / ");
  }

  function scheduleCardHtml(schedule) {
    const course = scheduleCourse(schedule);
    const title = schedule.label || course?.title || "Class";
    const times = `${formatTimeValue(schedule.startTime)}${schedule.endTime ? `–${formatTimeValue(schedule.endTime)}` : ""}`;
    return `
      <div class="bc-schedule-card">
        <div class="bc-schedule-main">
          <div class="bc-title">${escapeHtml(title)}</div>
          <div class="bc-subtitle">${escapeHtml(daysSummary(schedule.days))} · ${escapeHtml(times)}${schedule.room ? ` · ${escapeHtml(schedule.room)}` : ""}</div>
        </div>
        <button class="bc-mini-btn" type="button" data-edit-schedule="${escapeHtml(schedule.id)}">Edit</button>
        <button class="bc-mini-btn bc-mini-danger" type="button" data-delete-schedule="${escapeHtml(schedule.id)}">Delete</button>
      </div>`;
  }

  function reminderToggleHtml(kind, value, label) {
    const leads = kind === "assignment" ? state.reminderSettings.assignmentLeads : state.reminderSettings.classLeads;
    const checked = leads.includes(value);
    return `<label class="bc-reminder-option"><input type="checkbox" data-reminder-kind="${kind}" data-reminder-value="${value}" ${checked ? "checked" : ""}/><span>${escapeHtml(label)}</span></label>`;
  }

  function alertToggleHtml(kind, label) {
    const checked = state.alertSettings[kind] !== false;
    return `<label class="bc-reminder-option"><input type="checkbox" data-alert-kind="${kind}" ${checked ? "checked" : ""}/><span>${escapeHtml(label)}</span></label>`;
  }

  function scheduleEditorHtml() {
    if (!state.scheduleEditorOpen) return "";
    const existing = state.classSchedules.find(s => s.id === state.editingScheduleId) || {};
    const visible = visibleCourses();
    const selectedOrg = Number(existing.orgUnitId) || Number(visible[0]?.orgUnitId) || 0;
    const selectedDays = new Set((existing.days || []).map(Number));
    const days = [[1,"Mon"],[2,"Tue"],[3,"Wed"],[4,"Thu"],[5,"Fri"],[6,"Sat"],[0,"Sun"]];

    return `
      <form class="bc-editor" id="bc-schedule-form">
        <div class="bc-editor-title">${existing.id ? "Edit class" : "Add class schedule"}</div>
        <label class="bc-field"><span>Course</span><select name="orgUnitId" required ${visible.length ? "" : "disabled"}>
          ${visible.map(c => `<option value="${c.orgUnitId}" ${Number(c.orgUnitId) === selectedOrg ? "selected" : ""}>${escapeHtml(c.title)}</option>`).join("") || `<option>No courses in this semester filter</option>`}
        </select></label>
        <div class="bc-field"><span>Days</span><div class="bc-day-grid">
          ${days.map(([value,label]) => `<label><input type="checkbox" name="days" value="${value}" ${selectedDays.has(value) ? "checked" : ""}/><span>${label}</span></label>`).join("")}
        </div></div>
        <div class="bc-field-grid">
          <label class="bc-field"><span>Starts</span><input name="startTime" type="time" value="${escapeHtml(existing.startTime || "09:00")}" required /></label>
          <label class="bc-field"><span>Ends</span><input name="endTime" type="time" value="${escapeHtml(existing.endTime || "")}" /></label>
        </div>
        <label class="bc-field"><span>Room / location <em>optional</em></span><input name="room" type="text" maxlength="80" value="${escapeHtml(existing.room || "")}" placeholder="Room 6.63 or Zoom" /></label>
        <div class="bc-editor-actions"><button class="bc-secondary-btn" type="button" id="bc-cancel-schedule">Cancel</button><button class="bc-primary-btn" type="submit">Save class</button></div>
      </form>`;
  }

  function scheduleViewHtml() {
    state.flatVisibleItems = [];
    const schedules = state.classSchedules.filter(scheduleIsVisible);
    return `
      <section class="bc-settings-block">
        <div class="bc-settings-head"><div><strong>Class schedule</strong><span>Stored only in this Edge profile</span></div><button class="bc-primary-small" id="bc-add-schedule" type="button">+ Add class</button></div>
        ${schedules.length ? `<div class="bc-schedule-list">${schedules.map(scheduleCardHtml).join("")}</div>` : `<div class="bc-empty bc-empty-small">Add your recurring class times once and Companion will put them into Today/Upcoming and remind you before class.</div>`}
      </section>
      ${scheduleEditorHtml()}
      <section class="bc-settings-block">
        <div class="bc-settings-head"><div><strong>Assignment reminders</strong><span>Uses deadlines from your last Brightspace sync</span></div></div>
        <div class="bc-reminder-grid">
          ${reminderToggleHtml("assignment", 1440, "1 day before")}
          ${reminderToggleHtml("assignment", 180, "3 hours before")}
          ${reminderToggleHtml("assignment", 30, "30 minutes before")}
        </div>
      </section>
      <section class="bc-settings-block">
        <div class="bc-settings-head"><div><strong>Class reminders</strong><span>Works from your local class schedule</span></div></div>
        <div class="bc-reminder-grid">
          ${reminderToggleHtml("class", 60, "1 hour before")}
          ${reminderToggleHtml("class", 30, "30 minutes before")}
          ${reminderToggleHtml("class", 10, "10 minutes before")}
        </div>
      </section>
      <section class="bc-settings-block">
        <div class="bc-settings-head"><div><strong>Activity alerts</strong><span>Checked whenever Companion syncs Brightspace</span></div></div>
        <div class="bc-reminder-grid">
          ${alertToggleHtml("announcements", "New announcements")}
          ${alertToggleHtml("deadlineChanges", "Deadline changes")}
        </div>
      </section>
      <div class="bc-privacy-note">Reminder and alert data stays in Edge. Companion does not collect your CUNY password or send your schedule to a backend.</div>`;
  }

  function coursesViewHtml() {
    const courses = visibleCourses();
    const favoriteCourses = filtered(courses.filter(c => state.favorites.has(c.url)));
    const otherCourses = filtered(courses.filter(c => !state.favorites.has(c.url)));
    state.flatVisibleItems = [...favoriteCourses, ...otherCourses];
    let index = 0, html = termFiltersHtml() + courseFiltersHtml();
    let s = section("Pinned courses", favoriteCourses, index); html += s.html; index = s.next;
    s = section("Courses", otherCourses, index); html += s.html;
    if (!state.flatVisibleItems.length) html += `<div class="bc-empty">No visible courses match your filters.</div>`;
    return html;
  }

  function sourceHtml() {
    const sourceClass = state.scan.api === "ok" ? "bc-source-ok" : state.scan.api === "fallback" ? "bc-source-fallback" : "";
    return `<div class="bc-source ${sourceClass}">Synced from: ${escapeHtml(state.scan.source)}${state.scan.detail ? ` · ${escapeHtml(state.scan.detail)}` : ""}</div>`;
  }

  function createRoot() {
    const root = document.createElement("div");
    root.id = "bc-root";
    root.innerHTML = `
      <div class="bc-shell" role="dialog" aria-modal="true" aria-label="Brightspace Companion">
        <div class="bc-topbar">
          <div class="bc-logo">B</div>
          <input class="bc-search" type="text" autocomplete="off" spellcheck="false" placeholder="Search your schedule, deadlines, courses…" />
          <span class="bc-kbd">Esc</span>
        </div>
        <div class="bc-nav-slot"></div>
        <div class="bc-body"></div>
      </div>`;
    document.documentElement.appendChild(root);

    const input = root.querySelector(".bc-search");
    input.addEventListener("input", () => {
      state.query = input.value.trim().toLowerCase();
      state.selectedIndex = 0;
      render();
    });
    root.addEventListener("mousedown", e => { if (e.target === root) close(); });
    return root;
  }

  const root = createRoot();
  const body = root.querySelector(".bc-body");
  const search = root.querySelector(".bc-search");
  const navSlot = root.querySelector(".bc-nav-slot");

  async function saveScheduleFromForm(form) {
    const fd = new FormData(form);
    const days = fd.getAll("days").map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6);
    if (!days.length) {
      form.querySelector(".bc-day-grid")?.classList.add("bc-field-error");
      return;
    }
    const orgUnitId = Number(fd.get("orgUnitId"));
    const course = state.courses.find(c => Number(c.orgUnitId) === orgUnitId);
    if (!course) return;
    const existing = state.classSchedules.find(s => s.id === state.editingScheduleId);
    const entry = {
      id: existing?.id || (crypto.randomUUID ? crypto.randomUUID() : `schedule-${Date.now()}`),
      orgUnitId,
      label: course.title,
      url: course.url,
      groupKey: course.groupKey || "",
      groupLabel: course.groupLabel || "",
      termKey: course.termKey || "other",
      termLabel: course.termLabel || "Other",
      days,
      startTime: String(fd.get("startTime") || ""),
      endTime: String(fd.get("endTime") || ""),
      room: normalize(fd.get("room") || "")
    };
    if (existing) state.classSchedules = state.classSchedules.map(s => s.id === existing.id ? entry : s);
    else state.classSchedules.push(entry);
    await chrome.storage.local.set({ bcClassSchedules: state.classSchedules });
    state.scheduleEditorOpen = false;
    state.editingScheduleId = null;
    try { chrome.runtime.sendMessage({ type: "BC_REMINDER_DATA_UPDATED" }); } catch {}
    render();
  }

  async function deleteSchedule(id) {
    state.classSchedules = state.classSchedules.filter(s => s.id !== id);
    await chrome.storage.local.set({ bcClassSchedules: state.classSchedules });
    try { chrome.runtime.sendMessage({ type: "BC_REMINDER_DATA_UPDATED" }); } catch {}
    render();
  }

  async function updateReminder(kind, value, enabled) {
    const field = kind === "assignment" ? "assignmentLeads" : "classLeads";
    const set = new Set(state.reminderSettings[field]);
    enabled ? set.add(value) : set.delete(value);
    state.reminderSettings[field] = [...set].sort((a, b) => b - a);
    await chrome.storage.local.set({ bcReminderSettings: state.reminderSettings });
    try { chrome.runtime.sendMessage({ type: "BC_REMINDER_DATA_UPDATED" }); } catch {}
  }

  async function updateAlertSetting(kind, enabled) {
    if (!Object.hasOwn(DEFAULT_ALERT_SETTINGS, kind)) return;
    state.alertSettings[kind] = Boolean(enabled);
    await chrome.storage.local.set({ bcAlertSettings: state.alertSettings });
  }

  function bindRenderedEvents() {
    navSlot.querySelectorAll(".bc-tab").forEach(btn => btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      state.query = "";
      search.value = "";
      state.selectedIndex = 0;
      render();
    }));

    body.querySelectorAll("[data-course-term]").forEach(btn => btn.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); setTermFilter(btn.dataset.courseTerm);
    }));
    body.querySelectorAll("[data-course-group]").forEach(btn => btn.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); toggleCourseGroup(btn.dataset.courseGroup);
    }));
    body.querySelectorAll(".bc-item").forEach(el => el.addEventListener("click", e => {
      if (e.target.closest(".bc-star")) return;
      navigate(el.dataset.url);
    }));
    body.querySelectorAll(".bc-star").forEach(btn => btn.addEventListener("click", e => {
      e.preventDefault(); e.stopPropagation(); toggleFavorite(btn.dataset.favoriteUrl);
    }));

    body.querySelector("#bc-add-schedule")?.addEventListener("click", () => {
      state.scheduleEditorOpen = true; state.editingScheduleId = null; render();
    });
    body.querySelector("#bc-cancel-schedule")?.addEventListener("click", () => {
      state.scheduleEditorOpen = false; state.editingScheduleId = null; render();
    });
    body.querySelector("#bc-schedule-form")?.addEventListener("submit", e => {
      e.preventDefault(); saveScheduleFromForm(e.currentTarget);
    });
    body.querySelectorAll("[data-edit-schedule]").forEach(btn => btn.addEventListener("click", () => {
      state.scheduleEditorOpen = true; state.editingScheduleId = btn.dataset.editSchedule; render();
    }));
    body.querySelectorAll("[data-delete-schedule]").forEach(btn => btn.addEventListener("click", () => deleteSchedule(btn.dataset.deleteSchedule)));
    body.querySelectorAll("[data-reminder-kind]").forEach(input => input.addEventListener("change", () => {
      updateReminder(input.dataset.reminderKind, Number(input.dataset.reminderValue), input.checked);
    }));
    body.querySelectorAll("[data-alert-kind]").forEach(input => input.addEventListener("change", () => {
      updateAlertSetting(input.dataset.alertKind, input.checked);
    }));
  }

  function render() {
    navSlot.innerHTML = navHtml();

    if (state.query) body.innerHTML = searchResultsHtml() + sourceHtml();
    else if (state.view === "upcoming") body.innerHTML = upcomingViewHtml() + sourceHtml();
    else if (state.view === "schedule") body.innerHTML = scheduleViewHtml() + sourceHtml();
    else if (state.view === "courses") body.innerHTML = coursesViewHtml() + sourceHtml();
    else body.innerHTML = todayViewHtml() + sourceHtml();

    if (state.selectedIndex >= state.flatVisibleItems.length) state.selectedIndex = Math.max(0, state.flatVisibleItems.length - 1);
    bindRenderedEvents();
    const active = body.querySelector(".bc-item.bc-active");
    active?.scrollIntoView({ block: "nearest" });
  }

  function navigate(url) {
    if (!url) return;
    close();
    location.href = url;
  }

  function open() {
    root.classList.add("bc-open");
    search.value = state.query;
    requestAnimationFrame(() => search.focus());
    scanPage();
  }

  function close() {
    root.classList.remove("bc-open");
    search.blur();
  }

  function toggle() { root.classList.contains("bc-open") ? close() : open(); }

  document.addEventListener("keydown", e => {
    if (e.altKey && e.shiftKey && e.code === "KeyB") {
      e.preventDefault(); toggle(); return;
    }
    if (!root.classList.contains("bc-open")) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }

    const interactive = e.target?.closest?.("form input, form select, form button, .bc-tab, .bc-filter-chip, .bc-mini-btn, .bc-primary-small, .bc-reminder-option");
    if (interactive) return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (state.flatVisibleItems.length) state.selectedIndex = Math.min(state.selectedIndex + 1, state.flatVisibleItems.length - 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (state.flatVisibleItems.length) state.selectedIndex = Math.max(state.selectedIndex - 1, 0);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = state.flatVisibleItems[state.selectedIndex];
      if (item) navigate(item.url);
    }
  }, true);

  function statusCounts() {
    const now = Date.now();
    const todayStart = startOfDay(now), todayEnd = endOfDay(now), weekEnd = endOfDay(now + 6 * 86400000);
    return {
      courses: visibleCourses().length,
      due: visibleDueItems().length,
      totalCourses: state.courses.length,
      totalDue: state.dueItems.length,
      today: visibleDueItems().filter(i => Number.isFinite(i.due) && i.due >= todayStart && i.due <= todayEnd).length,
      week: visibleDueItems().filter(i => Number.isFinite(i.due) && i.due >= todayStart && i.due <= weekEnd).length,
      classesToday: classOccurrences(1).length,
      classSchedules: state.classSchedules.length,
      announcements: visibleAnnouncements().length
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "BC_TOGGLE") {
      toggle(); sendResponse({ ok: true }); return;
    }
    if (message?.type === "BC_OPEN_VIEW") {
      state.view = ["today","upcoming","schedule","courses"].includes(message.view) ? message.view : "today";
      state.query = "";
      open(); render(); sendResponse({ ok: true }); return;
    }
    if (message?.type === "BC_SCAN" || message?.type === "BC_GET_STATUS") {
      scanPage({ forceApi: message.type === "BC_SCAN" }).then(() => {
        sendResponse({ ok: true, counts: statusCounts(), scan: state.scan });
      }).catch(error => sendResponse({ ok: false, error: normalize(error?.message || error) }));
      return true;
    }
  });

  installNavigationAutoSync();
  loadPreferences().then(() => maybeAutoSync({ force: true }));

  let timer;
  const observer = new MutationObserver(() => {
    if (!root.classList.contains("bc-open")) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.scan.api !== "ok") {
        state.courses = collectCoursesFromDom();
        state.dueItems = collectDueFromDom();
        state.announcements = [];
      }
      render();
    }, 1200);
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
