# Brightspace Companion V1.0.2

A lightweight Microsoft Edge companion for CUNY Brightspace focused on one question: **what does the student need to know or do next?**

Brightspace Companion does not try to replace Brightspace. Brightspace remains the source of truth for course content, submissions, grades, quizzes, and discussions. Companion surfaces current-semester classes, deadlines, task state, announcements, reminders, and important changes, then opens the real Brightspace item/course when needed.

## V1 features

- **Today** view with due-today, classes-today, next-action, and recent announcements.
- **Tasks** view with **Overdue / verify completion**, **To do**, and **Completed** sections.
- **Upcoming** 14-day class/deadline timeline.
- **Current-semester filtering** using Brightspace semester metadata rather than hardcoded school/term names.
- **Course-group filtering** so students can hide old institutions or irrelevant groups.
- **Local recurring class schedule** with days, start/end time, and room/location.
- **Assignment reminders**: 1 day, 3 hours, or 30 minutes before.
- **Class reminders**: 1 hour, 30 minutes, or 10 minutes before.
- **New announcement alerts** on the next Brightspace sync.
- **Deadline-change alerts** when an existing Brightspace due date moves.
- **Automatic sync** when Brightspace loads, when you return to a Brightspace tab after a while, or when you navigate within Brightspace. Auto-sync is rate-limited to roughly once every 10 minutes.
- **Sync-health banner** in the command center so stale deadline data cannot silently look like an empty/all-clear schedule.
- **Morning safety check** at about 8:00 AM local time while Edge is able to run extension alarms.
- **Late verification alert** when a synced deadline passed recently and has not been marked completed locally.
- **Notification diagnostics** showing the most recent reminder/alert deliveries recorded by Companion.
- **Manual Sync now** action from the reliability banner.
- **Test notification** button for checking Edge → Windows notifications instantly.
- Course pinning and global search.

## Task completion behavior

The Tasks view intentionally does **not guess** whether you submitted a quiz or assignment.

- **To do** means the deadline is still in the future and you have not marked it complete.
- **Overdue / verify completion** means the synced deadline passed and Companion does not have local completion confirmation.
- **Completed** means **you explicitly marked the item complete in Companion**.
- You can reopen a completed task at any time.

Local completion state is stored in `chrome.storage.local`. Brightspace remains the source of truth. A future release may add Brightspace-verified completion badges for item types where the Brightspace API can prove completion without requiring elevated permissions.

## Reliability / sync-health behavior

V1.0.2 was hardened so missing notifications cannot silently create false confidence.

Deadline cache health is shown directly in the command center:

- Up to **6 hours** since sync: deadline data is shown as fresh.
- Between **6 and 12 hours**: Companion warns that the cache is aging.
- More than **12 hours**: Companion marks deadline data stale and tells you not to treat an empty task list as all clear.

Assignment reminders only use a deadline cache less than **12 hours old**. Class reminders are different: recurring lecture times are stored locally and do not require a Brightspace sync.

Companion can also issue a periodic stale-cache warning. If a deadline passed within the last two hours and the task has not been marked complete locally, Companion uses cautious wording — **Deadline passed — verify completion** — rather than claiming you definitely missed it.

The morning safety check uses the same trust rule. If the cache is stale, it tells you to sync instead of reporting a misleading “nothing due” result.

## Announcement and deadline-change behavior

The first successful V1.0+ sync establishes a quiet baseline. It does **not** send a pile of notifications for announcements or due dates that already existed before the feature was installed.

After the baseline:

- A newly detected current-semester course announcement can generate a Windows notification.
- If the same Brightspace calendar event keeps its identity but its due time changes, Companion can generate a **Deadline changed** notification showing the old and new time.
- Clicking an activity notification opens Brightspace using Brightspace's own announcement link when available, otherwise the relevant course/item.
- Institution/course-group filters are respected, so hidden groups do not generate activity alerts.
- Both alert types can be enabled/disabled under **Schedule → Activity alerts**.

Announcement/change detection runs when Companion successfully syncs Brightspace. It does not continuously poll CUNY while you are away from Brightspace.

## Reminder behavior

### Assignment reminders

Deadlines are cached locally after a successful Brightspace sync. Assignment notifications only use a cache less than **12 hours old** so Companion does not confidently remind you from stale data.

A task marked complete locally is excluded from assignment reminder, late-verification, and morning-digest counts.

### Class reminders

Recurring lecture times are entered once under **Schedule** and stored locally. Class reminders do not require a Brightspace tab to remain open; Microsoft Edge still needs to be running/allowed to run in the background.

Reminder notification text reports the **actual time remaining** when the alarm runs. For example, a class configured for 9:30 AM with a 30-minute reminder should normally notify around 9:00 AM with `Starts in 30 minutes`.

## Install / update in Microsoft Edge

To preserve your existing filters, class schedule, and reminder settings, replace the files inside the same unpacked extension folder and click **Reload** rather than removing the extension.

1. Copy the updated files over the files in your existing Brightspace Companion folder.
2. Open `edge://extensions`.
3. Click **Reload** on Brightspace Companion.
4. Refresh an open `https://brightspace.cuny.edu/` tab once.
5. Press **Alt + Shift + B**.
6. Open **Tasks** and confirm the sync-health banner appears.
7. Open **Schedule** and confirm your reminder/activity settings are still correct.

For a fresh install, enable Developer mode in `edge://extensions`, choose **Load unpacked**, and select the folder containing `manifest.json`.

## Privacy / scope

- Host access is restricted to `https://brightspace.cuny.edu/*`.
- Brightspace data retrieval uses read-only `GET` requests.
- No CUNY username/password collection.
- No backend service.
- No remote JavaScript.
- Filters, schedules, cached deadlines, local task-completion confirmations, announcement IDs, comparison snapshots, notification diagnostics, and notification state are stored in `chrome.storage.local` in the Edge profile.

## Product rule

A feature belongs in Companion when it helps a student **remember, prioritize, notice a change, verify what remains unfinished, or quickly reach something they need to do**.

A second reliability rule now applies:

> **Brightspace is the source of truth. Companion may remind you, but it must not silently create false confidence.**

## V1.0.2 reliability hardening

- Adds the **Tasks** section.
- Adds local **To do / Completed / Overdue** state.
- Adds visible sync freshness and stale-cache warnings.
- Reduces trusted assignment-reminder cache age from 48 hours to 12 hours.
- Adds an 8:00 AM local morning safety check.
- Adds cautious recent-deadline verification alerts.
- Adds notification delivery diagnostics.
- Keeps completion explicit instead of guessing from unreliable signals.

## V1.0.1 layout patch

- Prevents long announcement titles/body previews from widening the Companion window.
- Removes the horizontal scrollbar introduced by Recent Announcements.
- Announcement rows wrap and clamp long text cleanly within the existing overlay width.
