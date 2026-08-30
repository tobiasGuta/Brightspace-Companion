# Brightspace Companion V1.0.1

A lightweight Microsoft Edge companion for CUNY Brightspace focused on one question: **what does the student need to know or do next?**

Brightspace Companion does not try to replace Brightspace. Brightspace remains the source of truth for course content, submissions, grades, and discussions. Companion surfaces current-semester classes, deadlines, announcements, reminders, and important changes, then opens the real Brightspace item/course when needed.

## V1 features

- **Today** view with due-today, classes-today, next-action, and recent announcements.
- **Upcoming** 14-day class/deadline timeline.
- **Current-semester filtering** using Brightspace semester metadata rather than hardcoded school/term names.
- **Course-group filtering** so students can hide old institutions or irrelevant groups.
- **Local recurring class schedule** with days, start/end time, and room/location.
- **Assignment reminders**: 1 day, 3 hours, or 30 minutes before.
- **Class reminders**: 1 hour, 30 minutes, or 10 minutes before.
- **New announcement alerts** on the next Brightspace sync.
- **Deadline-change alerts** when an existing Brightspace due date moves.
- **Automatic sync** when Brightspace loads, when you return to a Brightspace tab after a while, or when you navigate within Brightspace. Auto-sync is rate-limited to roughly once every 10 minutes.
- **Manual Sync Brightspace now** button for an immediate refresh.
- **Test notification** button for checking Edge → Windows notifications instantly.
- Course pinning and global search.

## Announcement and deadline-change behavior

The first successful V1.0 sync establishes a quiet baseline. It does **not** send a pile of notifications for announcements or due dates that already existed before V1.0 was installed.

After the baseline:

- A newly detected current-semester course announcement can generate a Windows notification.
- If the same Brightspace calendar event keeps its identity but its due time changes, Companion can generate a **Deadline changed** notification showing the old and new time.
- Clicking an activity notification opens Brightspace using Brightspace's own announcement link when available, otherwise the relevant course/item.
- Institution/course-group filters are respected, so hidden groups do not generate activity alerts.
- Both alert types can be enabled/disabled under **Schedule → Activity alerts**.

Announcement/change detection runs when Companion successfully syncs Brightspace. It does not continuously poll CUNY while you are away from Brightspace.

## Reminder behavior

### Assignment reminders

Deadlines are cached locally after a successful Brightspace sync. Assignment notifications only use a cache less than **48 hours old** so Companion does not confidently remind you from stale data.

### Class reminders

Recurring lecture times are entered once under **Schedule** and stored locally. Class reminders do not require a Brightspace tab to remain open; Microsoft Edge still needs to be running/allowed to run in the background.

Reminder notification text reports the **actual time remaining** when the alarm runs. For example, a class configured for 9:30 AM with a 30-minute reminder should normally notify around 9:00 AM with `Starts in 30 minutes`.

## Install / update in Microsoft Edge

To preserve your existing filters, class schedule, and reminder settings from V1.4.x, replace the files inside the same unpacked extension folder and click **Reload** rather than removing the extension.

1. Extract the V1.0 ZIP.
2. Copy its files over the files in your existing Brightspace Companion folder.
3. Open `edge://extensions`.
4. Click **Reload** on Brightspace Companion.
5. Refresh an open `https://brightspace.cuny.edu/` tab once.
6. Press **Alt + Shift + B**.
7. Open **Schedule** and confirm **New announcements** and **Deadline changes** are enabled under Activity alerts.

For a fresh install, enable Developer mode in `edge://extensions`, choose **Load unpacked**, and select the folder containing `manifest.json`.

## Privacy / scope

- Host access is restricted to `https://brightspace.cuny.edu/*`.
- Brightspace data retrieval uses read-only `GET` requests.
- No CUNY username/password collection.
- No backend service.
- No remote JavaScript.
- Filters, schedules, cached deadlines, announcement IDs, comparison snapshots, and notification state are stored in `chrome.storage.local` in the Edge profile.

## Product rule

A feature belongs in Companion when it helps a student **remember, prioritize, notice a change, or quickly reach something they need to do**. V1 intentionally does not recreate the LMS.


## V1.0.1 layout patch

- Prevents long announcement titles/body previews from widening the Companion window.
- Removes the horizontal scrollbar introduced by Recent Announcements.
- Announcement rows now wrap and clamp long text cleanly within the existing overlay width.
