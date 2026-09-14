"use strict";

/**
 * The attendance board: who came in and who did not, laid out as a grid of
 * people against time.
 *
 * One period at a time — a day, a week, a month or a year — with each employee
 * on their own row in their own colour. A year is shown as twelve monthly
 * cells rather than 365 daily ones, because a 365-column grid tells nobody
 * anything.
 */

const { ApiError } = require("../../helpers/errors");
const { assignColors } = require("../../domain/colors");
const { summarizeDays } = require("../../domain/reports");
const { STATUS } = require("../../domain/attendance-rules");
const {
  dateKey, addDays, eachDate, monthRange, weekdayOf, isDateKey,
} = require("../../domain/time");
const attendanceService = require("../attendance/attendance.service");
const employeesService = require("../employees/employees.service");
const settingsService = require("../settings/settings.service");

const PERIODS = ["day", "week", "month", "year"];

/** The date range a period covers, anchored on any date inside it. */
function rangeFor(period, anchor) {
  if (!isDateKey(anchor)) throw ApiError.badRequest(`Invalid date: ${anchor}`);

  switch (period) {
    case "day":
      return { from: anchor, to: anchor };
    case "week": {
      // Weeks start on Sunday, matching the calendar the employee app draws.
      const start = addDays(anchor, -weekdayOf(anchor));
      return { from: start, to: addDays(start, 6) };
    }
    case "month":
      return monthRange(anchor);
    case "year":
      return { from: `${anchor.slice(0, 4)}-01-01`, to: `${anchor.slice(0, 4)}-12-31` };
    default:
      throw ApiError.badRequest(`Unknown period: ${period}`);
  }
}

/** Step to the previous or next period, for the board's arrows. */
function shiftAnchor(period, anchor, direction) {
  const step = direction < 0 ? -1 : 1;
  switch (period) {
    case "day":
      return addDays(anchor, step);
    case "week":
      return addDays(anchor, 7 * step);
    case "month": {
      const [y, m] = anchor.split("-").map(Number);
      const moved = new Date(Date.UTC(y, m - 1 + step, 1));
      return moved.toISOString().slice(0, 10);
    }
    case "year":
      return `${Number(anchor.slice(0, 4)) + step}-01-01`;
    default:
      throw ApiError.badRequest(`Unknown period: ${period}`);
  }
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"];

/** Statuses that mean the person was physically there. */
const ATTENDED = [STATUS.PRESENT, STATUS.LATE, STATUS.HALF_DAY, STATUS.SHORT_DAY, STATUS.MISSING_CHECKOUT];

async function buildBoard({ period = "month", anchor, department, staffType, includeInactive = false }) {
  if (!PERIODS.includes(period)) throw ApiError.badRequest(`Unknown period: ${period}`);

  const settings = await settingsService.getSettings();
  const today = dateKey(new Date(), settings.timeZone);
  const on = anchor || today;
  const range = rangeFor(period, on);

  const users = await employeesService.list({
    department,
    staffType,
    status: includeInactive ? undefined : "active",
  });

  const rows = await attendanceService.buildDays({ users, from: range.from, to: range.to });
  const colors = assignColors(users.map((user) => String(user._id)));

  const columns = period === "year" ? yearColumns(range) : dayColumns(range, today);

  const employees = rows
    .map(({ employee, days }) => {
      const byDate = new Map(days.map((day) => [day.date, day]));
      return {
        _id: employee._id,
        name: employee.name,
        department: employee.department || null,
        staffType: employee.staffType || "employee",
        color: colors.get(String(employee._id)).hex,
        colorName: colors.get(String(employee._id)).name,
        cells: period === "year" ? yearCells(columns, byDate) : dayCells(columns, byDate),
        summary: summarizeDays(days),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    period,
    anchor: on,
    range,
    today,
    label: labelFor(period, range),
    previous: shiftAnchor(period, on, -1),
    next: shiftAnchor(period, on, 1),
    columns,
    employees,
    totals: dailyTotals(columns, employees, period),
  };
}

function dayColumns(range, today) {
  return eachDate(range.from, range.to).map((date) => ({
    key: date,
    label: String(Number(date.slice(-2))),
    sublabel: DAY_INITIALS[weekdayOf(date)],
    isToday: date === today,
    future: date > today,
  }));
}

function yearColumns(range) {
  return MONTH_NAMES.map((name, index) => ({
    key: `${range.from.slice(0, 4)}-${String(index + 1).padStart(2, "0")}`,
    label: name,
    sublabel: null,
  }));
}

const dayCells = (columns, byDate) =>
  columns.map((column) => {
    const day = byDate.get(column.key);
    return {
      key: column.key,
      status: day ? day.status : STATUS.UPCOMING,
      checkInTime: day ? day.checkInTime : null,
      checkOutTime: day ? day.checkOutTime : null,
      lateMinutes: day ? day.lateMinutes : 0,
    };
  });

/**
 * A month's worth of days condensed into one cell: how much of what was owed
 * was actually attended, plus the counts behind it.
 */
function yearCells(columns, byDate) {
  return columns.map((column) => {
    const days = [...byDate.entries()]
      .filter(([date]) => date.startsWith(column.key))
      .map(([, day]) => day);

    const summary = summarizeDays(days);
    return {
      key: column.key,
      expectedDays: summary.expectedDays,
      presentDays: summary.presentDays,
      lateDays: summary.lateDays,
      absentDays: summary.absentDays,
      leaveDays: summary.leaveDays,
      // Null rather than 0 when nothing was expected, so an empty month reads
      // as "nothing to say" instead of "nobody turned up".
      rate: summary.expectedDays === 0 ? null : summary.attendanceRate,
    };
  });
}

/** The head-count in on each column, for the strip above the grid. */
function dailyTotals(columns, employees, period) {
  return columns.map((column, index) => {
    if (period === "year") {
      const rates = employees.map((e) => e.cells[index].rate).filter((rate) => rate !== null);
      return {
        key: column.key,
        in: null,
        expected: null,
        rate: rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10) / 10 : null,
      };
    }

    let attended = 0;
    let expected = 0;
    for (const employee of employees) {
      const cell = employee.cells[index];
      if (ATTENDED.includes(cell.status)) attended += 1;
      if (cell.status !== STATUS.WEEKEND && cell.status !== STATUS.HOLIDAY && cell.status !== STATUS.UPCOMING) {
        expected += 1;
      }
    }
    return { key: column.key, in: attended, expected, rate: expected ? Math.round((attended / expected) * 1000) / 10 : null };
  });
}

function labelFor(period, range) {
  const monthName = (key) => `${MONTH_NAMES[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
  switch (period) {
    case "day":
      return range.from;
    case "week":
      return `${range.from} → ${range.to}`;
    case "month":
      return monthName(range.from);
    case "year":
      return range.from.slice(0, 4);
    default:
      return `${range.from} → ${range.to}`;
  }
}

module.exports = { buildBoard, rangeFor, shiftAnchor, PERIODS, ATTENDED };
