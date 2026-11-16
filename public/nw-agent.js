/* JiraTime NewersWorld agent.
 * Runs INSIDE your logged-in NewersWorld tab (via bookmarklet). Talks only to the JiraTime page
 * (origin below) with postMessage. Page DOM/fetch logic is reused from the Office Buddy timesheet content script.
 * It uses the tab's own login; no cookie or token is read or sent anywhere. */
(function () {
  "use strict";
  var APP_ORIGIN = "__APP_ORIGIN__";
  var toApp = function () { return window.opener || (window.parent !== window ? window.parent : null); };
  var st = window.__JT_STATE = window.__JT_STATE || { acked: false, timer: null };
  var host = APP_ORIGIN.replace(/^https?:\/\//, "");
  function say(text, bad) {
    try {
      var d = document.createElement("div");
      d.textContent = text;
      d.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:420px;background:" + (bad ? "#b91c1c" : "#4f46e5") + ";color:#fff;padding:10px 16px;border-radius:10px;font:14px system-ui;box-shadow:0 6px 20px rgba(0,0,0,.3)";
      document.body.appendChild(d); setTimeout(function () { d.remove(); }, bad ? 9000 : 3500);
    } catch (e) { /* ignore */ }
  }
  // Tell the JiraTime page we are here. The page answers with "ack"; only then do we claim success.
  function announce(first) {
    var t = toApp();
    if (first) {
      st.acked = false;
      say("Connecting to " + host + "…");
      setTimeout(function () {
        if (!st.acked) showPanel("No live link to JiraTime (" + host + ") — manual mode. In JiraTime click \"Copy request\", then press \"Read clipboard\" here (or paste into the box).");
      }, 3500);
    }
    if (t && !t.closed) t.postMessage({ jt: "ready" }, APP_ORIGIN);   // the app can also reach us without this (it pings the tab it opened)
  }
  if (window.__JT_AGENT_LOADED) { announce(true); if (document.getElementById("jt-panel")) window.__JT_SHOWPANEL && window.__JT_SHOWPANEL(); return; }
  window.__JT_AGENT_LOADED = true;
  // Keep re-announcing quietly, so the app reconnects by itself after it was reloaded.
  st.timer = setInterval(function () { announce(false); }, 5000);

  var handlers = [];
  var chrome = { runtime: { onMessage: { addListener: function (f) { handlers.push(f); } } } };

/**
 * timesheet-content.js — Chrome MV3 content script for NewersWorld timesheet.
 * Target: https://newersworld.tothenew.com/*
 *
 * Messages (msg.type):
 *   TIMESHEET_PING
 *   TIMESHEET_GET_WEEK_INFO
 *   TIMESHEET_FILL_DATE  { dateStr, tasks, save?: boolean }
 *   TIMESHEET_CLEAR_DATE { dateStr }
 *   TIMESHEET_GET_DATE_STATE { dateStr }
 *   TIMESHEET_FETCH_WEEK_API { startDate, endDate } // YYYY-MM-DD
 *   TIMESHEET_SAVE_API { payload }
 *   TIMESHEET_SAVE_WEEK
 *   TIMESHEET_NAVIGATE   { direction: 'prev' | 'next' }
 *
 * Never auto-saves unless save === true or TIMESHEET_SAVE_WEEK.
 */
(() => {
  "use strict";

  
  

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const DATE_RE = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/;
  const MAX_TASKS = 40;
  const MAX_DESC_LEN = 2000;
  const MAX_HOURS = 24;

  // ── helpers ────────────────────────────────────────────────────────────────

  function strip(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function parseDateStr(dateStr) {
    const m = String(dateStr || "").trim().match(DATE_RE);
    if (!m) return null;
    const day = parseInt(m[1], 10);
    const mon = MONTHS.indexOf(m[2]);
    const year = parseInt(m[3], 10);
    if (mon < 0 || day < 1 || day > 31 || year < 2000 || year > 2100) return null;
    const dt = new Date(year, mon, day);
    dt.setHours(0, 0, 0, 0);
    if (dt.getFullYear() !== year || dt.getMonth() !== mon || dt.getDate() !== day) return null;
    return dt;
  }

  function toDateStr(date) {
    return `${String(date.getDate()).padStart(2, "0")}-${MONTHS[date.getMonth()]}-${date.getFullYear()}`;
  }

  function parseDisplayedRange(text) {
    const raw = strip(text);
    let m = raw.match(/(\d{1,2})\s*-\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})/);
    if (m) {
      let y = parseInt(m[4], 10);
      if (y < 100) y += 2000;
      const mon = MONTHS.indexOf(
        m[3].charAt(0).toUpperCase() + m[3].slice(1).toLowerCase()
      );
      if (mon < 0) return null;
      const start = new Date(y, mon, parseInt(m[1], 10));
      const end = new Date(y, mon, parseInt(m[2], 10));
      start.setHours(0, 0, 0, 0);
      end.setHours(0, 0, 0, 0);
      return { start, end, startStr: toDateStr(start), endStr: toDateStr(end) };
    }
    m = raw.match(/(\d{1,2})\s+([A-Za-z]{3})\s*-\s*(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})/);
    if (m) {
      let y = parseInt(m[5], 10);
      if (y < 100) y += 2000;
      const m1 = MONTHS.indexOf(
        m[2].charAt(0).toUpperCase() + m[2].slice(1).toLowerCase()
      );
      const m2 = MONTHS.indexOf(
        m[4].charAt(0).toUpperCase() + m[4].slice(1).toLowerCase()
      );
      if (m1 < 0 || m2 < 0) return null;
      const start = new Date(y, m1, parseInt(m[1], 10));
      const end = new Date(y, m2, parseInt(m[3], 10));
      start.setHours(0, 0, 0, 0);
      end.setHours(0, 0, 0, 0);
      return { start, end, startStr: toDateStr(start), endStr: toDateStr(end) };
    }
    return null;
  }

  function getRangeText() {
    const sel = document.querySelector("#timesheet_step_4");
    if (!sel) return "";
    const ph = sel.querySelector(
      ".mat-select-placeholder, .mat-select-value-text, .mat-select-value .mat-select-min-line"
    );
    if (ph && ph.textContent) return strip(ph.textContent);
    return strip(sel.textContent);
  }

  function getRangeFromLocation() {
    const match = String(window.location.href).match(/[?&]date=(\d{2}-[A-Za-z]{3}-\d{4})/);
    const start = match ? parseDateStr(match[1]) : null;
    if (!start) return null;
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start, end, startStr: toDateStr(start), endStr: toDateStr(end) };
  }

  function getRangeFromWeekStart(weekStart) {
    const start = parseDateStr(weekStart);
    if (!start) return null;
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return { start, end, startStr: toDateStr(start), endStr: toDateStr(end) };
  }

  function getWeekInfo(weekStart) {
    const rangeText = getRangeText();
    const range =
      getRangeFromWeekStart(weekStart) ||
      parseDisplayedRange(rangeText) ||
      getRangeFromLocation();
    const tasks = scrapeTasks();
    const rows = Array.from(document.querySelectorAll(".detailing"));
    const detailingCount = rows.length;
    return {
      ok: true,
      ready: detailingCount > 0,
      rangeText: rangeText || null,
      range: range
        ? {
            start: range.startStr,
            end: range.endStr,
            startMs: range.start.getTime(),
            endMs: range.end.getTime()
          }
        : null,
      tasks,
      dateStates: getDateStates(range, rows),
      detailingCount
    };
  }

  function getTaskName(row) {
    const selectors = [
      "mat-select-trigger p",
      "mat-select-trigger",
      ".mat-mdc-select-value-text",
      ".mat-mdc-select-min-line",
      ".mat-select-value-text",
      ".mat-select-min-line",
      "select option:checked"
    ];
    for (const selector of selectors) {
      const element = row.querySelector(selector);
      const value = strip(element?.textContent || element?.value || "");
      if (value && !/^(select|choose|assigned)\s*(task|work order)?$/i.test(value)) {
        return value;
      }
    }
    const select = row.querySelector("mat-select, select");
    const ariaName = strip(
      select?.getAttribute("aria-label") ||
      select?.getAttribute("data-value") ||
      select?.getAttribute("value") ||
      ""
    );
    return /^(select|choose|task|work order)$/i.test(ariaName) ? "" : ariaName;
  }

  function scrapeTasks() {
    const rows = Array.from(document.querySelectorAll(".detailing"));
    const seen = new Set();
    const out = [];
    for (const row of rows) {
      let name = getTaskName(row);
      if (!name) {
        const sel = row.querySelector("mat-select");
        name = sel ? strip(sel.getAttribute("placeholder") || "") : "";
      }
      if (!name || name === "Unknown Task" || name === "Select Task") continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ taskName: name });
    }
    if (!out.length) {
      const globalSelectors = [
        "mat-select-trigger",
        ".mat-mdc-select-value-text",
        ".mat-select-value-text",
        "select option:checked"
      ];
      for (const element of document.querySelectorAll(globalSelectors.join(","))) {
        const name = strip(element.textContent || element.value || "");
        if (
          !name ||
          /^(select|choose|current week|previous week|next week)$/i.test(name) ||
          /^\d/.test(name) ||
          /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(name) ||
          seen.has(name)
        ) {
          continue;
        }
        seen.add(name);
        out.push({ taskName: name });
      }
    }
    return out;
  }

  function getDateStates(range, rows) {
    if (!range) return [];
    const states = [];
    for (let colIndex = 0; colIndex < 7; colIndex++) {
      const date = new Date(range.start);
      date.setDate(range.start.getDate() + colIndex);
      const entries = [];
      for (const row of rows) {
        const hours = Array.from(row.querySelectorAll("thead th input[type='number']"))[colIndex];
        const comment = Array.from(row.querySelectorAll("tbody td textarea"))[colIndex];
        const hoursValue = hours ? strip(hours.value) : "";
        const description = comment ? strip(comment.value) : "";
        if (Number(hoursValue) <= 0 && !description) continue;
        entries.push({
          taskName: getTaskName(row),
          hours: hoursValue,
          description
        });
      }
      states.push({
        dateStr: toDateStr(date),
        filled: entries.length > 0,
        entries
      });
    }
    return states;
  }

  function resolveColumnIndex(dateStr) {
    const targetDate = parseDateStr(dateStr);
    if (!targetDate) return { colIndex: -1, error: "Invalid dateStr: " + dateStr };

    const rangeText = getRangeText();
    const range = parseDisplayedRange(rangeText);
    let colIndex = -1;

    if (range && targetDate >= range.start && targetDate <= range.end) {
      colIndex = Math.floor((targetDate.getTime() - range.start.getTime()) / 86400000);
    }

    if (colIndex < 0 || colIndex > 6) {
      const targetDay = targetDate.getDate();
      const dayNumberEls = Array.from(document.querySelectorAll(".day-number"));
      for (let i = 0; i < dayNumberEls.length; i++) {
        if (parseInt(strip(dayNumberEls[i].textContent), 10) === targetDay) {
          colIndex = i;
          break;
        }
      }
    }

    // NewersWorld weeks are Monday-first. This remains reliable when their
    // date-range and day-number CSS selectors change.
    if (colIndex < 0 || colIndex > 6) {
      colIndex = (targetDate.getDay() + 6) % 7;
    }

    if (colIndex < 0 || colIndex > 6) {
      return {
        colIndex: -1,
        rangeText,
        error: "Day not found for " + dateStr + " (range: " + (rangeText || "n/a") + ")."
      };
    }
    return { colIndex, rangeText, range };
  }

  /**
   * Native value setter + input/change/blur so Angular/Material bindings pick up values.
   */
  function typeIntoElement(el, value) {
    const str = String(value);
    el.focus();
    el.click();
    if (typeof el.select === "function") el.select();
    el.dispatchEvent(new Event("focus", { bubbles: true }));
    try {
      el.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: str,
        inputType: str ? "insertText" : "deleteContentBackward"
      }));
    } catch (_error) {
      /* InputEvent constructor is unavailable in some Chrome versions. */
    }

    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && typeof desc.set === "function") {
      desc.set.call(el, str);
    } else {
      el.value = str;
    }

    try {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        data: str,
        inputType: str ? "insertText" : "deleteContentBackward"
      }));
    } catch (_error) {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));

    for (const char of str) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
    }

    el.blur();
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function sanitizeTasks(raw) {
    if (!Array.isArray(raw)) return { ok: false, error: "tasks must be an array", tasks: [] };
    if (raw.length > MAX_TASKS) {
      return { ok: false, error: "Too many tasks (max " + MAX_TASKS + ")", tasks: [] };
    }
    const tasks = [];
    for (const t of raw) {
      if (!t || typeof t !== "object") continue;
      const taskName = strip(String(t.taskName || "")).slice(0, 200);
      let hours = t.hours;
      if (hours === undefined || hours === null || hours === "") hours = "8";
      const hoursNum = Number(hours);
      if (!Number.isFinite(hoursNum) || hoursNum < 0 || hoursNum > MAX_HOURS) {
        return {
          ok: false,
          error: "Invalid hours for task " + (taskName || "(unnamed)") + ": " + hours,
          tasks: []
        };
      }
      const description = strip(String(t.description || "")).slice(0, MAX_DESC_LEN);
      tasks.push({
        taskName,
        hours: String(hoursNum),
        description
      });
    }
    return { ok: true, tasks };
  }

  function fillDate(dateStr, tasks, doSave, allowOverwrite) {
    const col = resolveColumnIndex(dateStr);
    if (col.colIndex < 0) {
      return { ok: false, dateStr, filled: 0, error: col.error, rangeText: col.rangeText || null };
    }

    const detailingRows = Array.from(document.querySelectorAll(".detailing"));
    if (!detailingRows.length) {
      return { ok: false, dateStr, filled: 0, error: "No task rows found.", colIndex: col.colIndex };
    }

    const existing = detailingRows.flatMap((row) => {
      const taskName = getTaskName(row);
      const hours = Array.from(row.querySelectorAll("thead th input[type='number']"))[col.colIndex];
      const comment = Array.from(row.querySelectorAll("tbody td textarea"))[col.colIndex];
      const hoursValue = hours ? strip(hours.value) : "";
      const commentValue = comment ? strip(comment.value) : "";
      return Number(hoursValue) > 0 || commentValue
        ? [{ taskName, hours: hoursValue, description: commentValue }]
        : [];
    });
    if (existing.length > 0 && allowOverwrite !== true) {
      return {
        ok: true,
        dateStr,
        status: "ALREADY_FILLED",
        alreadyFilled: true,
        filled: 0,
        attempted: 0,
        existing
      };
    }

    const perTask = [];
    let filled = 0;

    for (const [taskIndex, task] of tasks.entries()) {
      let targetRow = null;
      for (const row of detailingRows) {
        const rowName = getTaskName(row);
        if (task.taskName && rowName.toLowerCase() === task.taskName.toLowerCase()) {
          targetRow = row;
          break;
        }
      }
      if (!targetRow && !task.taskName && detailingRows.length === 1) {
        targetRow = detailingRows[0];
      }
      if (!targetRow && detailingRows.length === 1 && tasks.length === 1) {
        targetRow = detailingRows[0];
      }
      if (!targetRow && detailingRows[taskIndex]) {
        targetRow = detailingRows[taskIndex];
      }

      if (!targetRow) {
        perTask.push({
          taskName: task.taskName || "",
          ok: false,
          error: "Task row not found"
        });
        continue;
      }

      const hoursInputs = Array.from(targetRow.querySelectorAll("thead th input[type='number']"));
      const hoursInput = hoursInputs[col.colIndex];
      let hoursSet = false;
      if (hoursInput && !hoursInput.disabled) {
        typeIntoElement(hoursInput, task.hours);
        hoursSet = true;
      }

      const commentTextareas = Array.from(targetRow.querySelectorAll("tbody td textarea"));
      const commentTextarea = commentTextareas[col.colIndex];
      let commentSet = false;
      if (commentTextarea && !commentTextarea.disabled) {
        typeIntoElement(commentTextarea, task.description || "");
        commentSet = true;
      }

      const rowOk = hoursSet || commentSet;
      if (rowOk) filled++;
      perTask.push({
        taskName: task.taskName || getTaskName(targetRow),
        ok: rowOk,
        hoursSet,
        commentSet,
        hours: task.hours,
        error: rowOk ? null : "Inputs disabled or missing"
      });
    }

    const result = {
      ok: filled > 0,
      dateStr,
      colIndex: col.colIndex,
      rangeText: col.rangeText || null,
      filled,
      attempted: tasks.length,
      tasks: perTask,
      saved: false,
      saveResult: null
    };

    if (doSave === true) {
      const saveResult = clickSave();
      result.saved = saveResult.status === "CLICKED";
      result.saveResult = saveResult;
    }

    return result;
  }

  function clearDate(dateStr) {
    const col = resolveColumnIndex(dateStr);
    if (col.colIndex < 0) {
      return { ok: false, dateStr, cleared: 0, error: col.error };
    }
    const rows = Array.from(document.querySelectorAll(".detailing"));
    if (!rows.length) {
      return { ok: false, dateStr, cleared: 0, error: "No task rows found." };
    }

    let cleared = 0;
    const tasks = [];
    const failures = [];
    for (const row of rows) {
      const taskName = getTaskName(row);
      const hours = Array.from(row.querySelectorAll("thead th input[type='number']"))[col.colIndex];
      const comment = Array.from(row.querySelectorAll("tbody td textarea"))[col.colIndex];
      const hadHours = !!(hours && strip(hours.value) && Number(hours.value) !== 0);
      const hadComment = !!(comment && strip(comment.value));
      if (!hadHours && !hadComment) continue;
      if (hours && !hours.disabled) typeIntoElement(hours, "0");
      if (comment && !comment.disabled) typeIntoElement(comment, "");
      const hoursCleared = !hadHours || !!(hours && Number(hours.value || 0) === 0);
      const commentCleared = !hadComment || !!(comment && !strip(comment.value));
      if (hoursCleared && commentCleared) {
        cleared++;
        tasks.push({ taskName, hoursCleared: hadHours, commentCleared: hadComment });
      } else {
        failures.push({
          taskName,
          error: "NewersWorld input rejected the clear operation",
          currentHours: hours?.value || "",
          currentDescription: comment?.value || ""
        });
      }
    }
    return {
      ok: failures.length === 0,
      dateStr,
      status: failures.length ? "CLEAR_REJECTED" : cleared > 0 ? "CLEARED" : "ALREADY_EMPTY",
      cleared,
      alreadyEmpty: cleared === 0 && failures.length === 0,
      tasks,
      failures,
      error: failures.length ? failures[0].error : null
    };
  }

  function getDateState(dateStr) {
    const col = resolveColumnIndex(dateStr);
    if (col.colIndex < 0) return { ok: false, dateStr, error: col.error };
    const entries = [];
    for (const row of document.querySelectorAll(".detailing")) {
      const hours = Array.from(row.querySelectorAll("thead th input[type='number']"))[col.colIndex];
      const comment = Array.from(row.querySelectorAll("tbody td textarea"))[col.colIndex];
      const hoursValue = hours ? strip(hours.value) : "";
      const description = comment ? strip(comment.value) : "";
      if (Number(hoursValue) <= 0 && !description) continue;
      entries.push({ taskName: getTaskName(row), hours: hoursValue, description });
    }
    return { ok: true, dateStr, filled: entries.length > 0, entries };
  }

  function clickSave() {
    if (document.activeElement && typeof document.activeElement.blur === "function") {
      document.activeElement.blur();
    }
    const candidates = Array.from(document.querySelectorAll("button")).filter((btn) => {
      const label = strip(btn.textContent || "").toUpperCase();
      const visible = !!(btn.offsetWidth || btn.offsetHeight || btn.getClientRects().length);
      return visible && label.includes("SAVE");
    });
    const saveBtn = candidates.find((btn) => !btn.disabled);
    if (!candidates.length) return { ok: false, status: "NO_BUTTON" };
    if (!saveBtn) {
      return { ok: false, status: "DISABLED", candidates: candidates.length };
    }
    try {
      saveBtn.scrollIntoView({ behavior: "instant", block: "center" });
    } catch (_e) {
      /* ignore */
    }
    saveBtn.click();
    return { ok: true, status: "CLICKED" };
  }

  function navigate(direction) {
    const dir = String(direction || "").toLowerCase();
    if (dir !== "prev" && dir !== "next") {
      return { ok: false, error: "direction must be 'prev' or 'next'" };
    }

    let el = null;
    if (dir === "prev") {
      el =
        document.querySelector("#timesheet_tour_step2 .arrow_btn:not(.next_btn)") ||
        document.querySelector("div[mwlcalendarpreviousview].arrow_btn") ||
        document.querySelector("div[mwlcalendarpreviousview]");
    } else {
      el =
        document.querySelector("#timesheet_tour_step2 .next_btn") ||
        document.querySelector("div[mwlcalendarnextview]");
    }

    if (!el) {
      return { ok: false, direction: dir, error: "Navigation control not found" };
    }
    el.click();
    return { ok: true, direction: dir, before: getWeekInfo() };
  }

  // ── message listener ───────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;

    const type = msg.type || msg.action;
    if (!type || typeof type !== "string" || !type.startsWith("TIMESHEET_")) return;

    if (type === "TIMESHEET_FETCH_WEEK_API") {
      const startDate = String(msg.startDate || "");
      const endDate = String(msg.endDate || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
        sendResponse({ ok: false, error: "Invalid API date range" });
        return false;
      }
      const url =
        "https://newersworld-api.tothenew.com/social-attendance/timesheet/week-view" +
        `?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`;
      fetch(url, {
        method: "GET",
        credentials: "include",
        headers: { Accept: "application/json, text/plain, */*" },
        cache: "no-store"
      })
        .then(async (response) => {
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            sendResponse({
              ok: false,
              status: response.status,
              error: data?.message || `Week-view API returned ${response.status}`
            });
            return;
          }
          sendResponse({ ok: true, status: response.status, data });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message || String(error) });
        });
      return true;
    }

    if (type === "TIMESHEET_SAVE_API") {
      if (!Array.isArray(msg.payload) || !msg.payload.length || msg.payload.length > 100) {
        sendResponse({ ok: false, error: "Invalid timesheet save payload" });
        return false;
      }
      const payload = [];
      for (const item of msg.payload) {
        const tsbID = Number(item?.tsbID);
        const hours = item?.hours === null ? null : Number(item?.hours);
        const comment = item?.comment === null ? null : String(item?.comment || "").slice(0, 2000);
        if (
          !Number.isInteger(tsbID) ||
          tsbID <= 0 ||
          (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 24))
        ) {
          sendResponse({ ok: false, error: "Invalid timesheet record in save payload" });
          return false;
        }
        payload.push({
          tsbID,
          hours: hours === null ? null : String(hours).padStart(2, "0"),
          comment: comment || null
        });
      }
      fetch("https://newersworld-api.tothenew.com/social-attendance/timesheet/save", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        cache: "no-store"
      })
        .then(async (response) => {
          const data = await response.json().catch(() => null);
          if (!response.ok) {
            sendResponse({
              ok: false,
              status: response.status,
              error: data?.message || `Timesheet save API returned ${response.status}`,
              data
            });
            return;
          }
          sendResponse({
            ok: true,
            status: response.status,
            message: data?.message || "Timesheet saved successfully.",
            data
          });
        })
        .catch((error) => {
          sendResponse({ ok: false, error: error?.message || String(error) });
        });
      return true;
    }

    try {
      switch (type) {
        case "TIMESHEET_PING":
          sendResponse({
            ok: true,
            alive: true,
            href: location.href,
            ready: document.querySelectorAll(".detailing").length > 0
          });
          break;

        case "TIMESHEET_GET_WEEK_INFO":
          sendResponse(getWeekInfo(msg.weekStart));
          break;

        case "TIMESHEET_FILL_DATE": {
          const dateStr = strip(String(msg.dateStr || ""));
          if (!parseDateStr(dateStr)) {
            sendResponse({ ok: false, error: "Invalid dateStr (expected DD-Mon-YYYY)", dateStr });
            break;
          }
          const sanitized = sanitizeTasks(msg.tasks);
          if (!sanitized.ok) {
            sendResponse({ ok: false, error: sanitized.error, dateStr });
            break;
          }
          const doSave = msg.save === true;
          sendResponse(fillDate(dateStr, sanitized.tasks, doSave, msg.overwrite === true));
          break;
        }

        case "TIMESHEET_CLEAR_DATE": {
          const dateStr = strip(String(msg.dateStr || ""));
          if (!parseDateStr(dateStr)) {
            sendResponse({ ok: false, error: "Invalid dateStr (expected DD-Mon-YYYY)", dateStr });
            break;
          }
          sendResponse(clearDate(dateStr));
          break;
        }

        case "TIMESHEET_GET_DATE_STATE": {
          const dateStr = strip(String(msg.dateStr || ""));
          if (!parseDateStr(dateStr)) {
            sendResponse({ ok: false, error: "Invalid dateStr (expected DD-Mon-YYYY)", dateStr });
            break;
          }
          sendResponse(getDateState(dateStr));
          break;
        }

        case "TIMESHEET_SAVE_WEEK":
          sendResponse({
            ok: true,
            ...clickSave(),
            week: getWeekInfo()
          });
          break;

        case "TIMESHEET_NAVIGATE":
          sendResponse(navigate(msg.direction));
          break;

        default:
          sendResponse({ ok: false, error: "Unknown timesheet message: " + type });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err)
      });
    }

    return false;
  });
})();

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  async function gotoWeek(mondayStr) {
    var want = "#/timesheet?date=" + mondayStr;
    if (location.hash !== want) location.hash = want;
    await sleep(1800);
    for (var i = 0; i < 80; i++) { if (document.querySelectorAll(".detailing").length) break; await sleep(250); }
    await sleep(800);
    return { ok: document.querySelectorAll(".detailing").length > 0, hash: location.hash };
  }


  // ---------- operations (same logic the JiraTime page used to drive remotely) ----------
  var NWM = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var pad2 = function (n) { return String(n).padStart(2, "0"); };
  var isoOf = function (d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); };
  var addD = function (s, n) { var d = new Date(s + "T00:00:00"); d.setDate(d.getDate() + n); return isoOf(d); };
  var mondayOf = function (s) { var d = new Date(s + "T00:00:00"); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoOf(d); };
  var toNwStr = function (s) { return s.slice(8) + "-" + NWM[+s.slice(5, 7) - 1] + "-" + s.slice(0, 4); };
  var clean = function (s) { return String(s || "").replace(/\s+/g, " ").trim(); };
  var isWknd = function (s) { var d = new Date(s + "T00:00:00").getDay(); return d === 0 || d === 6; };
  function call(msg) {
    return new Promise(function (res) {
      var done = false, once = function (r) { if (!done) { done = true; res(r); } };
      handlers.forEach(function (h) { try { h(msg, {}, once); } catch (err) { once({ ok: false, error: String(err) }); } });
      setTimeout(function () { once({ ok: false, error: "No response from page script" }); }, 60000);
    });
  }
  async function fetchRaw(monday) { return call({ type: "TIMESHEET_FETCH_WEEK_API", startDate: monday, endDate: addD(monday, 6) }); }
  function normalize(data, monday) {
    if (!data || typeof data !== "object") return null;
    var states = {}, tasks = {}, i;
    for (i = 0; i < 7; i++) { var d0 = addD(monday, i); states[d0] = { dateStr: d0, filled: false, entries: [], records: [], onLeave: false, leaveTypes: [], isEditable: false }; }
    var projects = (data.projects || []).concat(data.nonAllocatedProjects || []);
    projects.forEach(function (p) { (p.tasks || []).forEach(function (t) {
      var taskName = clean(t.taskName || "Development"); tasks[taskName] = 1;
      (t.dates || []).forEach(function (day) {
        var st = states[String(day.date || "")]; if (!st) return;
        var rec = { taskName: taskName, hours: String(Number(day.hours || 0)), description: clean(day.comment), tsbID: day.tsbID == null ? null : day.tsbID, isEditable: day.isEditable !== false, dateStr: st.dateStr };
        st.records.push(rec); if (rec.isEditable) st.isEditable = true;
        (day.leavesDetails || []).forEach(function (lv) { var x = clean(lv && lv.leaveType); if (x && !/week\s*off/i.test(x)) { st.onLeave = true; if (st.leaveTypes.indexOf(x) < 0) st.leaveTypes.push(x); } });
        if (Number(day.hours || 0) > 0 || clean(day.comment)) { st.filled = true; st.entries.push(rec); }
      });
    }); });
    var all = []; Object.keys(states).forEach(function (k) { all = all.concat(states[k].records); });
    return { ok: true, states: states, tasks: Object.keys(tasks), records: all };
  }
  async function fetchWeek(monday) {
    var r = await fetchRaw(monday);
    if (!r || !r.ok) return { ok: false, status: r && r.status, error: (r && r.error) || "Week-view API failed" };
    return normalize(r.data, monday) || { ok: false, error: "Unexpected NewersWorld response" };
  }
  function buildPayload(api, changes) {
    var overrides = {}, missing = {}, payload = [];
    Object.keys(changes).forEach(function (date) {
      var records = (api.states[date] && api.states[date].records) || [], used = {};
      changes[date].forEach(function (t) {
        var rec = records.filter(function (r) { return !used[r.tsbID] && clean(r.taskName).toLowerCase() === clean(t.taskName).toLowerCase(); })[0];
        if (!rec && records.length === 1 && changes[date].length === 1) rec = records[0];
        if (!rec || !rec.tsbID) { missing[date] = 1; return; }
        used[rec.tsbID] = 1; overrides[rec.tsbID] = { hours: String(Number(t.hours)), comment: clean(t.description) || null };
      });
    });
    if (Object.keys(missing).length) return { ok: false, needsDomFill: true, error: "No booking rows for " + Object.keys(missing).join(", ") };
    api.records.forEach(function (r) {
      if (!r.tsbID || isWknd(r.dateStr)) return;
      var hours = Number(r.hours || 0) > 0 ? String(Number(r.hours)) : null, comment = clean(r.description) || null, o = overrides[r.tsbID];
      if (o) { hours = o.hours; comment = o.comment; }
      payload.push({ tsbID: r.tsbID, hours: hours, comment: comment });
    });
    return payload.length ? { ok: true, payload: payload } : { ok: false, error: "No editable records for this week" };
  }
  function matches(state, tpls) {
    if (!state || !state.filled) return false;
    return tpls.every(function (t) { return state.entries.some(function (e) {
      return (clean(e.taskName).toLowerCase() === clean(t.taskName).toLowerCase() || (tpls.length === 1 && state.entries.length === 1)) &&
        Math.abs(Number(e.hours || 0) - Number(t.hours || 0)) < 0.001 && clean(e.description) === clean(t.description); }); });
  }
  async function readWeeks(mondays) {
    var out = {};
    for (var i = 0; i < mondays.length; i++) {
      var r = await fetchRaw(mondays[i]);
      out[mondays[i]] = r && r.ok ? { ok: true, data: r.data } : { ok: false, status: r && r.status, error: (r && r.error) || "Week-view API failed" };
    }
    return out;
  }
  async function execute(items) {
    var results = [], push = function (date, status, ok, error) { results.push({ date: date, status: status, ok: ok, error: error || "" }); }, groups = {};
    items.forEach(function (it) { (groups[mondayOf(it.date)] = groups[mondayOf(it.date)] || []).push(it); });
    for (var monday of Object.keys(groups)) {
      var list = groups[monday], api = await fetchWeek(monday);
      if (!api.ok) { list.forEach(function (r) { push(r.date, "error", false, api.status === 401 || api.status === 403 ? "NewersWorld session expired — log in again" : api.error); }); continue; }
      var changes = {}, pending = [];
      list.forEach(function (r) {
        var st = api.states[r.date];
        if (st && st.onLeave) return push(r.date, "leave_skipped", true);
        if (st && !st.isEditable) return push(r.date, "locked_skipped", true);
        if (st && st.filled && !r.wasFilled) return push(r.date, "already_filled", true);
        var tpl = [{ taskName: r.task, hours: String(r.hours), description: r.description }];
        changes[r.date] = tpl; pending.push({ date: r.date, tpl: tpl, wasFilled: !!r.wasFilled });
      });
      if (!pending.length) continue;
      var built = buildPayload(api, changes);
      if (built.ok) {
        var save = await call({ type: "TIMESHEET_SAVE_API", payload: built.payload });
        if (!save || !save.ok) { pending.forEach(function (p) { push(p.date, "filled_not_saved", false, (save && save.error) || "Save failed"); }); continue; }
        await sleep(500);
      } else if (built.needsDomFill) {
        var go = await gotoWeek(toNwStr(monday));
        if (!go.ok) { pending.forEach(function (p) { push(p.date, "error", false, "Could not open the week in this tab"); }); continue; }
        var any = false;
        for (var p of pending) {
          var f = await call({ type: "TIMESHEET_FILL_DATE", dateStr: toNwStr(p.date), tasks: p.tpl, save: false, overwrite: p.wasFilled });
          if (f && f.ok && !f.alreadyFilled) any = true;
          else if (f && f.alreadyFilled) { push(p.date, "already_filled", true); p.skip = true; }
          else { push(p.date, "error", false, (f && f.error) || "Fill failed"); p.skip = true; }
          await sleep(150);
        }
        if (!any) continue;
        await sleep(500);
        var sv = await call({ type: "TIMESHEET_SAVE_WEEK" });
        if (!(sv && sv.ok && sv.status === "CLICKED")) { pending.filter(function (x) { return !x.skip; }).forEach(function (x) { push(x.date, "filled_not_saved", false, "Save button: " + ((sv && (sv.status || sv.error)) || "unknown")); }); continue; }
        await sleep(2800);
      } else { pending.forEach(function (p2) { push(p2.date, "error", false, built.error); }); continue; }
      var check = await fetchWeek(monday);
      pending.filter(function (x) { return !x.skip; }).forEach(function (x) {
        if (matches(check.ok ? check.states[x.date] : null, x.tpl)) push(x.date, "filled_saved", true);
        else push(x.date, "fill_not_persisted", false, check.error || "Portal shows different values after save");
      });
    }
    return results;
  }
  async function runOp(type, payload) {
    try {
      if (type === "JT_READ") return { ok: true, data: await readWeeks(payload.mondays || []) };
      if (type === "JT_EXECUTE") return { ok: true, data: await execute(payload.items || []) };
      return { ok: false, error: "Unknown operation" };
    } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  }

  // ---------- manual mode: copy/paste panel (works even when the pages cannot talk to each other) ----------
  var pendingReq = null;
  function showPanel(message) {
    var p = document.getElementById("jt-panel");
    if (!p) {
      p = document.createElement("div"); p.id = "jt-panel";
      p.style.cssText = "position:fixed;right:16px;bottom:16px;width:400px;z-index:2147483647;background:#111827;color:#fff;font:13px system-ui;padding:14px;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45)";
      var btn = "background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:6px 12px;margin:6px 6px 0 0;cursor:pointer", ta = "width:100%;height:56px;box-sizing:border-box;background:#0b1020;color:#e5e7eb;border:1px solid #374151;border-radius:8px;margin-top:6px;font:11px monospace";
      p.innerHTML = '<b>JiraTime agent</b><span id="jt-x" style="float:right;cursor:pointer">✕</span><div id="jt-msg" style="margin:8px 0;opacity:.92"></div>' +
        '<textarea id="jt-in" placeholder="Paste the request here (Ctrl+V)" style="' + ta + '"></textarea>' +
        '<button id="jt-read" style="' + btn + '">Read clipboard</button><button id="jt-run" style="' + btn + '" disabled>Run</button>' +
        '<textarea id="jt-out" readonly placeholder="Result appears here" style="' + ta + '"></textarea><button id="jt-copy" style="' + btn + '">Copy result</button>';
      document.body.appendChild(p);
      p.querySelector("#jt-x").onclick = function () { p.remove(); };
      p.querySelector("#jt-read").onclick = function () { navigator.clipboard.readText().then(loadReq).catch(function () { setMsg("Clipboard blocked — paste into the box instead (Ctrl+V)."); }); };
      p.querySelector("#jt-in").addEventListener("input", function (e) { loadReq(e.target.value); });
      p.querySelector("#jt-run").onclick = runPending;
      p.querySelector("#jt-copy").onclick = function () { var o = p.querySelector("#jt-out"); o.select(); navigator.clipboard.writeText(o.value).then(function () { setMsg("Result copied ✓ — go back to JiraTime and press “Paste result”."); }).catch(function () { document.execCommand("copy"); setMsg("Result selected — press Ctrl+C."); }); };
    }
    setMsg(message || "");
    navigator.clipboard.readText().then(function (t) { if (/^JTREQ:/.test(t || "")) loadReq(t); }).catch(function () { /* needs a click on "Read clipboard" */ });
  }
  function setMsg(t) { var m = document.getElementById("jt-msg"); if (m) m.textContent = t; }
  function loadReq(text) {
    if (!/^JTREQ:/.test(String(text || "").trim())) return;
    try { pendingReq = JSON.parse(String(text).trim().slice(6)); } catch (e) { setMsg("That request text is damaged. Copy it again from JiraTime."); return; }
    var p = document.getElementById("jt-panel"); if (!p) return;
    p.querySelector("#jt-in").value = String(text).trim().slice(0, 200) + "…";
    if (pendingReq.type === "JT_READ") { setMsg("Reading " + pendingReq.payload.mondays.length + " week(s) (read-only)…"); runPending(); }
    else {
      var n = (pendingReq.payload.items || []).length;
      setMsg("JiraTime asks to FILL " + n + " day(s) in your NewersWorld timesheet. Check the preview in JiraTime, then press Run.");
      p.querySelector("#jt-run").disabled = false;
    }
  }
  async function runPending() {
    if (!pendingReq) return;
    var req = pendingReq, p = document.getElementById("jt-panel");
    p.querySelector("#jt-run").disabled = true; setMsg("Working… keep this tab open.");
    var r = await runOp(req.type, req.payload);
    var out = "JTRES:" + JSON.stringify({ id: req.id, ok: r.ok, data: r.data, error: r.error });
    p.querySelector("#jt-out").value = out; pendingReq = null;
    navigator.clipboard.writeText(out).then(function () { setMsg("Done. Result copied ✓ — go back to JiraTime and press “Paste result”."); }).catch(function () { setMsg("Done. Press “Copy result”, then go back to JiraTime and press “Paste result”."); });
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== APP_ORIGIN || !e.data || !e.source) return;
    if (e.data.jt === "req") st.acked = true;      // the app is talking to us, so the link works
    if (e.data.jt === "ack") { if (!st.acked) { st.acked = true; say("JiraTime agent connected ✓ (" + host + ")"); } return; }
    if (e.data.jt !== "req") return;
    var id = e.data.id, msg = e.data.msg || {};
    var reply = function (res) { e.source.postMessage({ jt: "res", id: id, res: res }, APP_ORIGIN); };
    if (msg.type === "JT_PING") return reply({ ok: true, alive: true, href: location.href.split("?")[0] });
    if (msg.type === "JT_GOTO") { gotoWeek(String(msg.mondayStr || "")).then(reply).catch(function (err) { reply({ ok: false, error: String(err) }); }); return; }
    if (msg.type === "JT_READ" || msg.type === "JT_EXECUTE") { runOp(msg.type, msg.payload || {}).then(reply); return; }
    if (typeof msg.type !== "string" || msg.type.indexOf("TIMESHEET_") !== 0) return reply({ ok: false, error: "Not allowed" });
    var answered = false;
    var once = function (r) { if (!answered) { answered = true; reply(r); } };
    handlers.forEach(function (h) { try { h(msg, {}, once); } catch (err) { once({ ok: false, error: String(err) }); } });
  });
  window.__JT_SHOWPANEL = function () { showPanel("Manual mode: copy the request in JiraTime, then press “Read clipboard”."); };
  announce(true);
})();
