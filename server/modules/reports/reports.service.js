"use strict";

const XLSX = require("xlsx");

const { ApiError } = require("../../helpers/errors");
const { summarizeDays, groupByDepartment, rankBy } = require("../../domain/reports");
const policyRules = require("../../domain/policy");
const settingsService = require("../settings/settings.service");
const leaveService = require("../leave/leave.service");
const { formatDuration, eachDate, isDateKey } = require("../../domain/time");
const attendanceService = require("../attendance/attendance.service");
const employeesService = require("../employees/employees.service");
const { publicUser } = require("../employees/employees.service");

const MAX_RANGE_DAYS = 400;

function assertRange(from, to) {
  if (!isDateKey(from) || !isDateKey(to)) throw ApiError.badRequest("Invalid date range");
  if (to < from) throw ApiError.badRequest("The end date cannot be before the start date");
  if (eachDate(from, to).length > MAX_RANGE_DAYS) {
    throw ApiError.badRequest(`Please pick a range of ${MAX_RANGE_DAYS} days or fewer`);
  }
}

/** Employees in scope for a report, honouring the admin's filters. */
async function scopedEmployees({ userId, department, staffType, includeInactive }) {
  if (userId) {
    const user = await employeesService.getById(userId);
    return [user];
  }
  return employeesService.list({
    department,
    staffType,
    status: includeInactive ? undefined : "active",
  });
}

/**
 * The core report: one row per employee with their evaluated days and totals,
 * plus organisation-wide and per-department roll-ups.
 */
async function buildReport({ from, to, userId, department, staffType, includeInactive = false, includeDays = true }) {
  assertRange(from, to);

  const users = await scopedEmployees({ userId, department, staffType, includeInactive });
  const built = await attendanceService.buildDays({ users, from, to });

  const { policy } = await settingsService.getSettings();
  // Permissions are rationed per calendar month, so they are counted from the
  // requests themselves rather than from the attendance days.
  const permissionCounts = await permissionsPerEmployee(users, from, to);

  const rows = built.map(({ employee, shift, days }) => ({
    employee: {
      _id: employee._id,
      name: employee.name,
      email: employee.email,
      employeeCode: employee.employeeCode || null,
      department: employee.department || null,
      position: employee.position || null,
      staffType: employee.staffType || "employee",
      status: employee.status,
    },
    shift: { name: shift.name || "Default", startTime: shift.startTime, endTime: shift.endTime },
    summary: withPolicy(summarizeDays(days), permissionCounts.get(String(employee._id)) || 0, policy),
    days,
  }));

  rows.sort((a, b) => a.employee.name.localeCompare(b.employee.name));

  const report = {
    range: { from, to, days: eachDate(from, to).length },
    generatedAt: new Date(),
    employees: rows,
    departments: groupByDepartment(rows),
    // Summed from every day in the range, before the day rows are dropped —
    // computing this from a stripped `days` array is how these totals silently
    // came back as zero.
    totals: summarizeDays(rows.flatMap((row) => row.days)),
    worstLateness: rankBy(rows, "lateMinutes").map(slim),
    mostAbsent: rankBy(rows, "absentDays").map(slim),
    policy,
    departmentScores: scoreDepartments(rows, policy),
    best: bestPerformers(rows, policy),
    staffCounts: countByStaffType(rows),
    deductionTotal: rows.reduce((sum, row) => sum + row.summary.deduction.amount, 0),
    currency: policy.currency,
  };

  // The summary screen draws totals only; sending 30 days per employee would
  // be a much larger response for nothing.
  if (!includeDays) {
    for (const row of rows) delete row.days;
  }

  return report;
}

/**
 * Attach the policy view of a summary: permissions used, allowances spent,
 * what the absences cost, and the score. Kept together in one place so the
 * screen, the export and the employee's own view cannot disagree.
 */
function withPolicy(summary, permissionsUsed, policy) {
  const enriched = { ...summary, permissionsUsed };
  enriched.allowances = policyRules.allowanceUse(enriched, policy);
  enriched.deduction = policyRules.deduction(enriched, policy);
  const scored = policyRules.scoreFor(enriched, policy);
  enriched.score = scored.score;
  enriched.scoreBand = policyRules.band(scored.score);
  enriched.scoreParts = scored;
  return enriched;
}

/** How many permission requests each employee made inside the range. */
async function permissionsPerEmployee(users, from, to) {
  const counts = new Map();
  if (users.length === 0) return counts;

  const leaves = await leaveService.list(
    { from, to, type: "permission", status: leaveService.LEAVE_STATUS.APPROVED },
    { limit: 5000 }
  );
  for (const leave of leaves) {
    const key = String(leave.userId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * The best employee, the best intern and the leading department.
 *
 * Employees and interns are ranked separately because comparing them directly
 * would be comparing different jobs — though the scores themselves are rates,
 * so an intern's shorter day neither helps nor hurts them.
 */
function bestPerformers(rows, policy) {
  const candidates = (staffType) =>
    rows
      .filter((row) => (row.employee.staffType || "employee") === staffType)
      .map((row) => ({
        _id: row.employee._id,
        name: row.employee.name,
        department: row.employee.department,
        staffType: row.employee.staffType || "employee",
        summary: row.summary,
      }));

  const departments = scoreDepartments(rows, policy)
    .filter((department) => department.score !== null)
    .sort((a, b) => b.score - a.score || b.employees - a.employees);

  const leading = departments[0] || null;
  const runnersUp = leading
    ? departments.filter((d) => d !== leading && d.score === leading.score).map((d) => d.department)
    : [];

  return {
    employee: policyRules.bestOf(candidates("employee"), policy),
    intern: policyRules.bestOf(candidates("intern"), policy),
    department: leading
      ? { ...leading, tied: runnersUp.length > 0, tiedWith: runnersUp }
      : null,
  };
}

const countByStaffType = (rows) =>
  rows.reduce(
    (counts, row) => {
      const type = row.employee.staffType || "employee";
      counts[type] = (counts[type] || 0) + 1;
      return counts;
    },
    { employee: 0, intern: 0 }
  );

/** One score per department, ordered best first. */
function scoreDepartments(rows, policy) {
  const byDepartment = new Map();
  for (const row of rows) {
    const key = row.employee.department || "Unassigned";
    if (!byDepartment.has(key)) byDepartment.set(key, []);
    byDepartment.get(key).push(row);
  }

  return [...byDepartment.entries()]
    .map(([department, members]) => ({
      department,
      employees: members.length,
      ...policyRules.scoreDepartment(members.map((m) => m.summary), policy),
      lateDays: members.reduce((sum, m) => sum + m.summary.lateDays, 0),
      absentDays: members.reduce((sum, m) => sum + m.summary.absentDays, 0),
      permissionsUsed: members.reduce((sum, m) => sum + m.summary.permissionsUsed, 0),
      deduction: members.reduce((sum, m) => sum + m.summary.deduction.amount, 0),
    }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

const slim = (row) => ({
  employee: { _id: row.employee._id, name: row.employee.name, department: row.employee.department },
  summary: row.summary,
});

/** One day across the whole office — the "who was in on Tuesday" view. */
async function dailyReport(date, { department } = {}) {
  assertRange(date, date);
  const users = await employeesService.list({ department, status: "active" });
  const built = await attendanceService.buildDays({ users, from: date, to: date });

  const entries = built.map(({ employee, shift, days }) => ({
    employee: publicUser(employee),
    shift: { name: shift.name || "Default", startTime: shift.startTime, endTime: shift.endTime },
    ...days[0],
  }));

  entries.sort((a, b) => {
    // People who turned up sort by arrival time; everyone else falls to the
    // bottom alphabetically, which is the order a manager scans in.
    if (a.checkInTime && b.checkInTime) return a.checkInTime.localeCompare(b.checkInTime);
    if (a.checkInTime) return -1;
    if (b.checkInTime) return 1;
    return a.employee.name.localeCompare(b.employee.name);
  });

  return { date, entries, summary: summarizeDays(entries) };
}

/* ── Exports ─────────────────────────────────────────────────────────── */

const SUMMARY_COLUMNS = [
  ["Employee", (r) => r.employee.name],
  ["Employee ID", (r) => r.employee.employeeCode || ""],
  ["Department", (r) => r.employee.department || ""],
  ["Type", (r) => (r.employee.staffType === "intern" ? "Intern" : "Employee")],
  ["Shift", (r) => r.shift.name],
  ["Days expected", (r) => r.summary.expectedDays],
  ["Days present", (r) => r.summary.presentDays],
  ["Absent", (r) => r.summary.absentDays],
  ["On leave", (r) => r.summary.leaveDays],
  ["Late days", (r) => r.summary.lateDays],
  ["Total late", (r) => formatDuration(r.summary.lateMinutes)],
  ["Late minutes", (r) => r.summary.lateMinutes],
  ["Early leaves", (r) => r.summary.earlyLeaveDays],
  ["Early leave minutes", (r) => r.summary.earlyLeaveMinutes],
  ["Half days", (r) => r.summary.halfDays],
  ["Missing checkouts", (r) => r.summary.missingCheckouts],
  ["Hours worked", (r) => r.summary.workedHours],
  ["Hours scheduled", (r) => r.summary.scheduledHours],
  ["Overtime hours", (r) => r.summary.overtimeHours],
  ["Attendance %", (r) => r.summary.attendanceRate],
  ["Punctuality %", (r) => r.summary.punctualityRate],
  ["Permissions used", (r) => r.summary.permissionsUsed],
  ["Allowance exceeded", (r) => (r.summary.allowances.anyExceeded ? "yes" : "")],
  ["Score", (r) => (r.summary.score === null ? "" : r.summary.score)],
  ["Rating", (r) => r.summary.scoreBand],
  ["Deduction", (r) => r.summary.deduction.amount],
];

const DETAIL_COLUMNS = [
  ["Employee", (r, d) => r.employee.name],
  ["Employee ID", (r) => r.employee.employeeCode || ""],
  ["Department", (r) => r.employee.department || ""],
  ["Type", (r) => (r.employee.staffType === "intern" ? "Intern" : "Employee")],
  ["Date", (r, d) => d.date],
  ["Status", (r, d) => d.status],
  ["Check in", (r, d) => d.checkInTime || ""],
  ["Check out", (r, d) => d.checkOutTime || ""],
  ["Office", (r, d) => d.officeName || ""],
  ["Late (min)", (r, d) => d.lateMinutes],
  ["Early leave (min)", (r, d) => d.earlyLeaveMinutes],
  ["Overtime (min)", (r, d) => d.overtimeMinutes],
  ["Worked (min)", (r, d) => d.workedMinutes],
  ["Excused (min)", (r, d) => d.excusedMinutes],
  ["Leave type", (r, d) => d.leaveType || ""],
  ["Holiday", (r, d) => d.holidayName || ""],
  ["Auto checkout", (r, d) => (d.autoCheckout ? "yes" : "")],
  ["Edited by admin", (r, d) => (d.edited ? "yes" : "")],
];

function toRows(report) {
  const summary = [
    SUMMARY_COLUMNS.map(([header]) => header),
    ...report.employees.map((r) => SUMMARY_COLUMNS.map(([, get]) => get(r))),
  ];
  const detail = [
    DETAIL_COLUMNS.map(([header]) => header),
    ...report.employees.flatMap((r) =>
      (r.days || [])
        // Weekends, holidays and days that have not happened yet would swell
        // the row count without telling a manager anything.
        .filter((d) => !["weekend", "holiday", "upcoming"].includes(d.status))
        .map((d) => DETAIL_COLUMNS.map(([, get]) => get(r, d)))
    ),
  ];
  return { summary, detail };
}

/** Excel workbook: a summary sheet, a day-by-day sheet and a department sheet. */
function toXlsx(report) {
  const { summary, detail } = toRows(report);
  const book = XLSX.utils.book_new();

  const summarySheet = XLSX.utils.aoa_to_sheet(summary);
  summarySheet["!cols"] = SUMMARY_COLUMNS.map(([header]) => ({ wch: Math.max(12, header.length + 2) }));
  XLSX.utils.book_append_sheet(book, summarySheet, "Summary");

  const detailSheet = XLSX.utils.aoa_to_sheet(detail);
  detailSheet["!cols"] = DETAIL_COLUMNS.map(([header]) => ({ wch: Math.max(11, header.length + 2) }));
  XLSX.utils.book_append_sheet(book, detailSheet, "Daily detail");

  const deptRows = [
    ["Department", "Employees", "Score", "Rating", "Late days", "Absent days", "Permissions", `Deduction (${report.currency})`],
    ...report.departmentScores.map((d) => [
      d.department,
      d.employees,
      d.score === null ? "" : d.score,
      d.band,
      d.lateDays,
      d.absentDays,
      d.permissionsUsed,
      d.deduction,
    ]),
  ];
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(deptRows), "By department");

  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

function toCsv(report, sheet = "summary") {
  const rows = toRows(report)[sheet === "detail" ? "detail" : "summary"];
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function csvCell(value) {
  const text = value === null || value === undefined ? "" : String(value);
  // Neutralise spreadsheet formula injection: a cell starting with =, +, - or
  // @ is executed by Excel when the export is opened.
  const guarded = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

module.exports = { buildReport, dailyReport, toXlsx, toCsv, assertRange, MAX_RANGE_DAYS };
