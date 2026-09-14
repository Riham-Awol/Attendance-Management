"use strict";

const XLSX = require("xlsx");

const { ApiError } = require("../../helpers/errors");
const { summarizeDays, groupByDepartment, rankBy } = require("../../domain/reports");
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
async function scopedEmployees({ userId, department, includeInactive }) {
  if (userId) {
    const user = await employeesService.getById(userId);
    return [user];
  }
  const users = await employeesService.list({
    department,
    status: includeInactive ? undefined : "active",
  });
  return users;
}

/**
 * The core report: one row per employee with their evaluated days and totals,
 * plus organisation-wide and per-department roll-ups.
 */
async function buildReport({ from, to, userId, department, includeInactive = false, includeDays = true }) {
  assertRange(from, to);

  const users = await scopedEmployees({ userId, department, includeInactive });
  const built = await attendanceService.buildDays({ users, from, to });

  const rows = built.map(({ employee, shift, days }) => ({
    employee: {
      _id: employee._id,
      name: employee.name,
      email: employee.email,
      employeeCode: employee.employeeCode || null,
      department: employee.department || null,
      position: employee.position || null,
      status: employee.status,
    },
    shift: { name: shift.name || "Default", startTime: shift.startTime, endTime: shift.endTime },
    summary: summarizeDays(days),
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
  };

  // The summary screen draws totals only; sending 30 days per employee would
  // be a much larger response for nothing.
  if (!includeDays) {
    for (const row of rows) delete row.days;
  }

  return report;
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
];

const DETAIL_COLUMNS = [
  ["Employee", (r, d) => r.employee.name],
  ["Employee ID", (r) => r.employee.employeeCode || ""],
  ["Department", (r) => r.employee.department || ""],
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
    ["Department", "Employees", "Days present", "Absent", "Late days", "Late minutes", "Hours worked", "Attendance %"],
    ...report.departments.map((d) => [
      d.department,
      d.employees,
      d.summary.presentDays,
      d.summary.absentDays,
      d.summary.lateDays,
      d.summary.lateMinutes,
      d.summary.workedHours,
      d.summary.attendanceRate,
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
