"use strict";

const { STATUS, EXPECTED_STATUSES } = require("./attendance-rules");

const round1 = (n) => Math.round(n * 10) / 10;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/**
 * Roll a list of evaluated days into the numbers a manager actually reads.
 * Pure on purpose: the same function backs the on-screen report, the Excel
 * export and the monthly email, so they can never disagree.
 */
function summarizeDays(days) {
  const summary = {
    totalDays: days.length,
    expectedDays: 0,
    presentDays: 0,
    lateDays: 0,
    absentDays: 0,
    leaveDays: 0,
    holidayDays: 0,
    weekendDays: 0,
    upcomingDays: 0,
    halfDays: 0,
    shortDays: 0,
    missingCheckouts: 0,
    earlyLeaveDays: 0,
    permissionDays: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    workedMinutes: 0,
    scheduledMinutes: 0,
    excusedMinutes: 0,
  };

  for (const day of days) {
    if (EXPECTED_STATUSES.includes(day.status)) summary.expectedDays += 1;

    switch (day.status) {
      case STATUS.PRESENT:
        summary.presentDays += 1;
        break;
      case STATUS.LATE:
        summary.presentDays += 1;
        summary.lateDays += 1;
        break;
      case STATUS.HALF_DAY:
        summary.presentDays += 1;
        summary.halfDays += 1;
        break;
      case STATUS.SHORT_DAY:
        summary.presentDays += 1;
        summary.shortDays += 1;
        break;
      case STATUS.MISSING_CHECKOUT:
        summary.presentDays += 1;
        summary.missingCheckouts += 1;
        break;
      case STATUS.ABSENT:
        summary.absentDays += 1;
        break;
      case STATUS.ON_LEAVE:
        summary.leaveDays += 1;
        break;
      case STATUS.HOLIDAY:
        summary.holidayDays += 1;
        break;
      case STATUS.WEEKEND:
        summary.weekendDays += 1;
        break;
      case STATUS.UPCOMING:
        summary.upcomingDays += 1;
        break;
      default:
        break;
    }

    // The switch counts a "late" day; this catches lateness that happened on a
    // day whose headline status is half day, short day or missing checkout, so
    // a late arrival is never lost just because the day went wrong later too.
    if (day.status !== STATUS.LATE && (day.lateMinutes || 0) > 0) summary.lateDays += 1;
    if (day.earlyLeaveMinutes > 0) summary.earlyLeaveDays += 1;
    if (day.excusedMinutes > 0) summary.permissionDays += 1;

    summary.lateMinutes += day.lateMinutes || 0;
    summary.earlyLeaveMinutes += day.earlyLeaveMinutes || 0;
    summary.overtimeMinutes += day.overtimeMinutes || 0;
    summary.workedMinutes += day.workedMinutes || 0;
    summary.excusedMinutes += day.excusedMinutes || 0;
    if (EXPECTED_STATUSES.includes(day.status)) {
      summary.scheduledMinutes += day.scheduledMinutes || 0;
    }
  }

  summary.workedHours = round1(summary.workedMinutes / 60);
  summary.scheduledHours = round1(summary.scheduledMinutes / 60);
  summary.overtimeHours = round1(summary.overtimeMinutes / 60);
  summary.attendanceRate = pct(summary.presentDays, summary.expectedDays);
  summary.punctualityRate = pct(summary.presentDays - summary.lateDays, summary.presentDays);
  summary.avgLateMinutes = summary.lateDays > 0 ? round1(summary.lateMinutes / summary.lateDays) : 0;

  return summary;
}

/** Rank employees by a summary field, worst first — feeds the dashboard. */
function rankBy(rows, field, limit = 5) {
  return [...rows]
    .filter((r) => (r.summary[field] || 0) > 0)
    .sort((a, b) => (b.summary[field] || 0) - (a.summary[field] || 0))
    .slice(0, limit);
}

/** Aggregate per-employee rows into per-department rows. */
function groupByDepartment(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.employee.department || "Unassigned";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return [...map.entries()]
    .map(([department, members]) => ({
      department,
      employees: members.length,
      summary: mergeSummaries(members.map((m) => m.summary)),
    }))
    .sort((a, b) => a.department.localeCompare(b.department));
}

function mergeSummaries(summaries) {
  const merged = summaries.reduce((acc, s) => {
    for (const [key, value] of Object.entries(s)) {
      if (typeof value === "number") acc[key] = (acc[key] || 0) + value;
    }
    return acc;
  }, {});

  merged.workedHours = round1(merged.workedMinutes / 60);
  merged.scheduledHours = round1(merged.scheduledMinutes / 60);
  merged.overtimeHours = round1(merged.overtimeMinutes / 60);
  merged.attendanceRate = pct(merged.presentDays, merged.expectedDays);
  merged.punctualityRate = pct(merged.presentDays - merged.lateDays, merged.presentDays);
  merged.avgLateMinutes = merged.lateDays > 0 ? round1(merged.lateMinutes / merged.lateDays) : 0;
  return merged;
}

module.exports = { summarizeDays, rankBy, groupByDepartment, mergeSummaries };
