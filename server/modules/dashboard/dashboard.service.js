"use strict";

const { collection, COLLECTIONS } = require("../../config/db");
const { STATUS } = require("../../domain/attendance-rules");
const { summarizeDays, rankBy } = require("../../domain/reports");
const { dateKey, addDays, monthRange, eachDate } = require("../../domain/time");
const attendanceService = require("../attendance/attendance.service");
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
