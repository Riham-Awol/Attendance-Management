"use strict";

const { collection, COLLECTIONS } = require("../../config/db");
const { STATUS } = require("../../domain/attendance-rules");
const { summarizeDays, rankBy } = require("../../domain/reports");
const { dateKey, addDays, monthRange, eachDate } = require("../../domain/time");
const attendanceService = require("../attendance/attendance.service");
const reportsService = require("../reports/reports.service");
const { monthRange: monthRangeOf } = require("../../domain/time");
const employeesService = require("../employees/employees.service");
const leaveService = require("../leave/leave.service");
const settingsService = require("../settings/settings.service");

const TREND_DAYS = 14;

/** Everything the admin landing screen needs, in one round trip. */
async function overview() {
  const settings = await settingsService.getSettings();
  const today = dateKey(new Date(), settings.timeZone);
  const trendFrom = addDays(today, -(TREND_DAYS - 1));
  const month = monthRange(today);

  const users = await employeesService.listActive();

  const [todayRows, trendRows, monthRows, pendingLeaves] = await Promise.all([
    attendanceService.buildDays({ users, from: today, to: today }),
    attendanceService.buildDays({ users, from: trendFrom, to: today }),
    attendanceService.buildDays({ users, from: month.from, to: today }),
    leaveService.list({ status: leaveService.LEAVE_STATUS.PENDING }, { limit: 50 }),
  ]);

  const todayEntries = todayRows.map(({ employee, days }) => ({ employee, day: days[0] }));

  const onSite = todayEntries
    .filter((e) => e.day.checkInAt && !e.day.checkOutAt)
    .map(toPresenceRow)
    .sort((a, b) => (a.checkInTime || "").localeCompare(b.checkInTime || ""));

  const departed = todayEntries
    .filter((e) => e.day.checkOutAt)
    .map(toPresenceRow)
    .sort((a, b) => (b.checkOutTime || "").localeCompare(a.checkOutTime || ""));

  const notIn = todayEntries
    .filter((e) => !e.day.checkInAt)
    .map(toPresenceRow)
    .sort((a, b) => a.name.localeCompare(b.name));

  const trendByDate = new Map(eachDate(trendFrom, today).map((d) => [d, blankTrendDay(d)]));
  for (const { days } of trendRows) {
    for (const day of days) {
      const bucket = trendByDate.get(day.date);
      if (!bucket) continue;
      if (day.status === STATUS.PRESENT) bucket.onTime += 1;
      else if (day.status === STATUS.LATE) bucket.late += 1;
      else if (day.status === STATUS.ABSENT) bucket.absent += 1;
      else if (day.status === STATUS.ON_LEAVE) bucket.onLeave += 1;
      else if ([STATUS.HALF_DAY, STATUS.SHORT_DAY, STATUS.MISSING_CHECKOUT].includes(day.status)) {
        bucket.partial += 1;
      }
      bucket.lateMinutes += day.lateMinutes || 0;
    }
  }

  // The month's figures come from the report builder so the dashboard, the
  // reports screen and the spreadsheet are all reading the same numbers.
  const monthReport = await reportsService.buildReport({
    from: month.from,
    to: today,
    includeDays: false,
  });

  const monthSummaries = monthRows.map(({ employee, days }) => ({
    employee: { _id: employee._id, name: employee.name, department: employee.department },
    summary: summarizeDays(days),
  }));

  return {
    date: today,
    timeZone: settings.timeZone,
    companyName: settings.companyName,
    headcount: users.length,
    today: {
      ...summarizeDays(todayEntries.map((e) => e.day)),
      onSiteNow: onSite.length,
      checkedOut: departed.length,
      notCheckedIn: notIn.filter((r) => r.status === STATUS.ABSENT).length,
    },
    onSite,
    departed,
    notIn,
    trend: [...trendByDate.values()],
    month: {
      range: month,
      totals: summarizeDays(monthRows.flatMap((r) => r.days)),
      worstLateness: rankBy(monthSummaries, "lateMinutes"),
      mostAbsent: rankBy(monthSummaries, "absentDays"),
      // One row per person: late, absent, permissions, what it costs and how
      // they score — the breakdown a manager actually acts on.
      people: monthReport.employees
        .map((row) => ({
          _id: row.employee._id,
          name: row.employee.name,
          department: row.employee.department,
          lateDays: row.summary.lateDays,
          lateMinutes: row.summary.lateMinutes,
          absentDays: row.summary.absentDays,
          permissionsUsed: row.summary.permissionsUsed,
          leaveDays: row.summary.leaveDays,
          presentDays: row.summary.presentDays,
          attendanceRate: row.summary.attendanceRate,
          score: row.summary.score,
          scoreBand: row.summary.scoreBand,
          allowances: row.summary.allowances,
          deduction: row.summary.deduction.amount,
        }))
        .sort((a, b) => (a.score ?? 101) - (b.score ?? 101)),
      departments: monthReport.departmentScores,
      deductionTotal: monthReport.deductionTotal,
      currency: monthReport.currency,
      policy: monthReport.policy,
    },
    pendingLeaves: await decorateLeaves(pendingLeaves),
    pendingLeaveCount: pendingLeaves.length,
  };
}

const blankTrendDay = (date) => ({
  date,
  onTime: 0,
  late: 0,
  absent: 0,
  onLeave: 0,
  partial: 0,
  lateMinutes: 0,
});

const toPresenceRow = ({ employee, day }) => ({
  _id: employee._id,
  name: employee.name,
  department: employee.department || null,
  position: employee.position || null,
  // Today's shift is still open, so "missing checkout" would read as a fault
  // when the person is simply at their desk.
  status: day.checkInAt && !day.checkOutAt ? "working" : day.status,
  checkInTime: day.checkInTime,
  checkOutTime: day.checkOutTime,
  officeName: day.officeName,
  lateMinutes: day.lateMinutes,
  workedMinutes: day.workedMinutes,
  leaveType: day.leaveType,
});

/** Attach employee names to leave rows so the UI doesn't need a second call. */
async function decorateLeaves(leaves) {
  if (leaves.length === 0) return [];
  const ids = [...new Set(leaves.map((l) => String(l.userId)))].map(settingsService.toId);
  const users = await collection(COLLECTIONS.users)
    .find({ _id: { $in: ids } })
    .project({ name: 1, department: 1, employeeCode: 1 })
    .toArray();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return leaves.map((leave) => ({
    ...leave,
    employee: byId.get(String(leave.userId)) || { name: "Unknown" },
  }));
}

module.exports = { overview, decorateLeaves, TREND_DAYS };


/**
 * What an employee may see of everyone else: department scores, and nothing
 * that identifies a colleague.
 *
 * Built by stripping the report down to its department rows rather than by
 * filtering on the way out, so there is no individual data in the response to
 * leak by accident — no names, no counts small enough to single anyone out
 * beyond the department's own headcount.
 */
async function departmentScoreboard() {
  const settings = await settingsService.getSettings();
  const today = dateKey(new Date(), settings.timeZone);
  const month = monthRangeOf(today);

  const report = await reportsService.buildReport({
    from: month.from,
    to: today,
    includeDays: false,
  });

  return {
    month: month.from.slice(0, 7),
    range: { from: month.from, to: today },
    departments: report.departmentScores.map((row) => ({
      department: row.department,
      employees: row.employees,
      score: row.score,
      band: row.band,
      attendance: row.attendance,
      punctuality: row.punctuality,
    })),
  };
}

module.exports.departmentScoreboard = departmentScoreboard;
