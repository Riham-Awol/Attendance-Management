"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-that-is-long-enough-to-pass";
process.env.CRON_ENABLED = "false";

const db = require("../config/db");
const { MemoryDb } = require("./helpers/memory-mongo");

const settingsService = require("../modules/settings/settings.service");
const employeesService = require("../modules/employees/employees.service");
const attendanceService = require("../modules/attendance/attendance.service");
const leaveService = require("../modules/leave/leave.service");
const reportsService = require("../modules/reports/reports.service");
const dashboardService = require("../modules/dashboard/dashboard.service");
const cronJobs = require("../cron/jobs");

const OFFICE_POINT = { lat: 9.005401, lng: 38.763611 };
const TZ = "Africa/Addis_Ababa"; // UTC+3, no DST — easy to reason about in tests.

/** A request-shaped object, since the punch path records IP and user agent. */
const fakeReq = () => ({ ip: "10.0.0.1", headers: { "user-agent": "node-test" } });

/** 2026-09-08 is a Tuesday; this builds an instant at a given office-local time. */
const at = (clock, date = "2026-09-08") => {
  const [h, m] = clock.split(":").map(Number);
  return new Date(Date.UTC(...date.split("-").map(Number).map((v, i) => (i === 1 ? v - 1 : v)), h - 3, m));
};

async function freshWorld() {
  const memory = new MemoryDb();
  db.__setDbForTests(memory);
  await db.ensureIndexes(memory);

  await settingsService.updateSettings({ companyName: "Test Co", timeZone: TZ });
  const office = await settingsService.createOffice({
    name: "HQ",
    ...OFFICE_POINT,
    radiusMeters: 100,
    active: true,
  });
  const shift = await settingsService.createShift({
    name: "Standard",
    startTime: "09:00",
    endTime: "17:00",
    workDays: [1, 2, 3, 4, 5],
    graceMinutes: 10,
    earlyLeaveGraceMinutes: 10,
    breakMinutes: 60,
    isDefault: true,
  });

  const admin = await employeesService.create({
    name: "Ada Admin",
    email: "admin@test.co",
    password: "password123",
    role: "admin",
    department: "Management",
  });
  const employee = await employeesService.create({
    name: "Sam Staff",
    email: "sam@test.co",
    password: "password123",
    department: "Sales",
    shiftId: String(shift._id),
  });

  const adminDoc = await employeesService.getById(admin._id);
  const employeeDoc = await employeesService.getById(employee._id);
  return { memory, office, shift, admin: adminDoc, employee: employeeDoc };
}

/**
 * Freeze the office clock. Report building asks "what day is it?" to decide
 * which days are due, so tests that assert on absences must pin the date.
 */
function freeze(clock, date = "2026-09-08") {
  const RealDate = global.Date;
  const instant = at(clock, date);
  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) return new RealDate(instant.getTime());
      return new RealDate(...args);
    }
    static now() {
      return instant.getTime();
    }
  };
  return () => {
    global.Date = RealDate;
  };
}

/** Punch at a given office-local time by freezing the clock for one call. */
async function punch(kind, user, point, clock, date) {
  const realNow = Date.now;
  const instant = at(clock, date);
  Date.now = () => instant.getTime();
  const OriginalDate = global.Date;
  global.Date = class extends OriginalDate {
    constructor(...args) {
      if (args.length === 0) return new OriginalDate(instant.getTime());
      return new OriginalDate(...args);
    }
    static now() {
      return instant.getTime();
    }
  };
  try {
    return await attendanceService[kind](user, point, fakeReq());
  } finally {
    global.Date = OriginalDate;
    Date.now = realNow;
  }
}

const insideOffice = { ...OFFICE_POINT, accuracy: 8 };
const farAway = { lat: 9.02, lng: 38.79, accuracy: 8 };

test("check-in inside the geofence is recorded with the office and distance", async () => {
  const world = await freshWorld();
  const result = await punch("checkIn", world.employee, insideOffice, "08:55");

  assert.equal(result.office.name, "HQ");
  assert.equal(result.record.date, "2026-09-08");
  assert.equal(result.record.checkIn.minutes, 535);
  assert.equal(result.record.checkIn.officeName, "HQ");
  assert.equal(result.record.status, "missing_checkout"); // no check-out yet
  assert.equal(result.record.lateMinutes, 0);
});

test("check-in outside the geofence is refused with a distance the employee can act on", async () => {
  const world = await freshWorld();
  await assert.rejects(
    () => punch("checkIn", world.employee, farAway, "08:55"),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, "geo_outside_geofence");
      assert.match(err.message, /You're about \d+ m from HQ/);
      assert.equal(err.details.allowedRadius, 100);
      return true;
    }
  );
  const record = await attendanceService.findRecord(world.employee._id, "2026-09-08");
  assert.equal(record, null, "a refused punch must not leave a record behind");
});

test("a hopeless GPS fix is refused rather than trusted", async () => {
  const world = await freshWorld();
  await assert.rejects(
    () => punch("checkIn", world.employee, { ...OFFICE_POINT, accuracy: 5000 }, "08:55"),
    (err) => err.code === "geo_poor_accuracy"
  );
});

test("checking in twice is rejected by the unique index, not just the read", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "08:55");
  await assert.rejects(
    () => punch("checkIn", world.employee, insideOffice, "09:05"),
    (err) => err.status === 409 && /already checked in/i.test(err.message)
  );
  const count = await world.memory.collection("attendance").countDocuments({});
  assert.equal(count, 1);
});

test("check-out computes worked time, and check-out before check-in is refused", async () => {
  const world = await freshWorld();
  await assert.rejects(
    () => punch("checkOut", world.employee, insideOffice, "17:00"),
    (err) => err.status === 409 && /haven't checked in/i.test(err.message)
  );

  await punch("checkIn", world.employee, insideOffice, "09:00");
  const out = await punch("checkOut", world.employee, insideOffice, "17:30");

  assert.equal(out.record.workedMinutes, 450); // 8.5h minus the 60m break
  assert.equal(out.record.overtimeMinutes, 30);
  assert.equal(out.record.status, "present");

  await assert.rejects(
    () => punch("checkOut", world.employee, insideOffice, "17:45"),
    (err) => err.status === 409 && /already checked out/i.test(err.message)
  );
});

test("a late arrival is flagged with the minutes owed", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "09:35");
  const out = await punch("checkOut", world.employee, insideOffice, "17:00");
  assert.equal(out.record.lateMinutes, 35);
  assert.equal(out.record.status, "late");
});

test("today's status tells the employee what they can do next", async () => {
  const world = await freshWorld();
  // todayFor reads the real clock, while punches are frozen to a fixed day.
  // Without freezing here too, the punch lands on one date and the status is
  // read for another, and the test only passes on the day it was written.
  const restore = freeze("09:30");
  try {
    const before = await attendanceService.todayFor(world.employee);
    assert.equal(before.canCheckIn, true);
    assert.equal(before.canCheckOut, false);
    assert.equal(before.shift.startTime, "09:00");
    assert.equal(before.date, "2026-09-08");

    await punch("checkIn", world.employee, insideOffice, "09:00");
    const after = await attendanceService.todayFor(world.employee);
    assert.equal(after.canCheckIn, false);
    assert.equal(after.canCheckOut, true);
  } finally {
    restore();
  }
});

test("a working day with no punch becomes an absence in the report", async () => {
  const world = await freshWorld();
  const restore = freeze("23:00", "2026-09-11"); // the whole week is now behind us
  try {
    const report = await reportsService.buildReport({ from: "2026-09-07", to: "2026-09-11" });
    const sam = report.employees.find((r) => r.employee.name === "Sam Staff");

    assert.equal(sam.summary.expectedDays, 5);
    assert.equal(sam.summary.absentDays, 5);
    assert.equal(sam.summary.attendanceRate, 0);
    // Saturday and Sunday are outside the range, so nothing is miscounted.
    assert.equal(sam.summary.weekendDays, 0);
  } finally {
    restore();
  }
});

test("weekends are never counted as absences", async () => {
  const world = await freshWorld();
  const report = await reportsService.buildReport({ from: "2026-09-12", to: "2026-09-13" });
  const sam = report.employees.find((r) => r.employee.name === "Sam Staff");
  assert.equal(sam.summary.weekendDays, 2);
  assert.equal(sam.summary.absentDays, 0);
  assert.equal(sam.summary.expectedDays, 0);
});

test("a declared holiday clears the absence for everyone", async () => {
  const world = await freshWorld();
  await settingsService.createHoliday({ date: "2026-09-08", name: "New Year" });
  const report = await reportsService.buildReport({ from: "2026-09-08", to: "2026-09-08" });
  for (const row of report.employees) {
    assert.equal(row.summary.holidayDays, 1);
    assert.equal(row.summary.absentDays, 0);
  }
});

test("approved full-day leave replaces the absence; a pending one does not", async () => {
  const world = await freshWorld();
  const leave = await leaveService.createRequest(world.employee, {
    type: "annual",
    scope: "full_day",
    fromDate: "2026-09-08",
    toDate: "2026-09-09",
    reason: "Family event",
  });

  const restore = freeze("23:00", "2026-09-09");
  try {
    const pending = await reportsService.buildReport({ from: "2026-09-08", to: "2026-09-09" });
    const samPending = pending.employees.find((r) => r.employee.name === "Sam Staff");
    assert.equal(samPending.summary.absentDays, 2, "a pending request must not excuse anything");

    await leaveService.decide(leave._id, world.admin, "approved", "Enjoy");

    const approved = await reportsService.buildReport({ from: "2026-09-08", to: "2026-09-09" });
    const sam = approved.employees.find((r) => r.employee.name === "Sam Staff");
    assert.equal(sam.summary.leaveDays, 2);
    assert.equal(sam.summary.absentDays, 0);
  } finally {
    restore();
  }
});

test("overlapping leave requests are refused", async () => {
  const world = await freshWorld();
  await leaveService.createRequest(world.employee, {
    type: "annual",
    scope: "full_day",
    fromDate: "2026-09-08",
    toDate: "2026-09-10",
    reason: "Trip",
  });
  await assert.rejects(
    () =>
      leaveService.createRequest(world.employee, {
        type: "sick",
        scope: "full_day",
        fromDate: "2026-09-10",
        toDate: "2026-09-12",
        reason: "Flu",
      }),
    (err) => err.status === 409
  );
});

test("two hourly permissions on one day are allowed unless the hours collide", async () => {
  const world = await freshWorld();
  const base = { type: "permission", scope: "partial", fromDate: "2026-09-08", toDate: "2026-09-08", reason: "Clinic" };
  await leaveService.createRequest(world.employee, { ...base, fromTime: "09:00", toTime: "10:00" });
  await leaveService.createRequest(world.employee, { ...base, fromTime: "15:00", toTime: "16:00" });
  await assert.rejects(
    () => leaveService.createRequest(world.employee, { ...base, fromTime: "09:30", toTime: "11:00" }),
    (err) => err.status === 409
  );
});

test("approving a permission retroactively clears the lateness already recorded", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "10:00");
  await punch("checkOut", world.employee, insideOffice, "17:00");

  const before = await attendanceService.findRecord(world.employee._id, "2026-09-08");
  assert.equal(before.lateMinutes, 60);
  assert.equal(before.status, "late");

  const permission = await leaveService.createRequest(world.employee, {
    type: "permission",
    scope: "partial",
    fromDate: "2026-09-08",
    toDate: "2026-09-08",
    fromTime: "09:00",
    toTime: "10:00",
    reason: "Bank",
  });
  await leaveService.decide(permission._id, world.admin, "approved");

  // The route calls recalculate for affected days; do the same here.
  await attendanceService.recalculate(before._id);
  const after = await attendanceService.findRecord(world.employee._id, "2026-09-08");
  assert.equal(after.lateMinutes, 0);
  assert.equal(after.excusedMinutes, 60);
  assert.equal(after.status, "present");
});

test("a decided request cannot be decided twice", async () => {
  const world = await freshWorld();
  const leave = await leaveService.createRequest(world.employee, {
    type: "sick",
    scope: "full_day",
    fromDate: "2026-09-08",
    toDate: "2026-09-08",
    reason: "Flu",
  });
  await leaveService.decide(leave._id, world.admin, "approved");
  await assert.rejects(
    () => leaveService.decide(leave._id, world.admin, "rejected"),
    (err) => err.status === 409
  );
});

test("an admin correction rewrites the punch and the derived numbers together", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "10:30");
  const record = await attendanceService.findRecord(world.employee._id, "2026-09-08");
  assert.equal(record.lateMinutes, 90);

  const fixed = await attendanceService.adminSetTimes(
    record._id,
    { checkInTime: "09:00", checkOutTime: "17:00", note: "Phone was dead" },
    world.admin
  );
  assert.equal(fixed.lateMinutes, 0);
  assert.equal(fixed.workedMinutes, 420);
  assert.equal(fixed.status, "present");
  assert.equal(fixed.manual.byName, "Ada Admin");
  // The stored instant must match the office-local time it was set to.
  assert.equal(fixed.checkIn.at.toISOString(), "2026-09-08T06:00:00.000Z");
});

test("auto-checkout closes a forgotten shift at the scheduled end, and flags it", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "09:00");

  // 20:00 local is well past the 17:00 end plus the two-hour grace.
  const closed = await cronJobs.autoCheckout(at("20:00"));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].at, "17:00");

  const record = await attendanceService.findRecord(world.employee._id, "2026-09-08");
  assert.equal(record.autoCheckout, true);
  assert.equal(record.checkOut.minutes, 1020);
  assert.equal(record.workedMinutes, 420);
  assert.equal(record.status, "present");
});

test("auto-checkout leaves a shift alone while the grace period is still running", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "09:00");
  const closed = await cronJobs.autoCheckout(at("17:30"));
  assert.equal(closed.length, 0);
  const record = await attendanceService.findRecord(world.employee._id, "2026-09-08");
  assert.equal(record.checkOut, null);
});

test("the dashboard separates who is on site from who never arrived", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "09:20");

  const realDate = global.Date;
  global.Date = class extends realDate {
    constructor(...args) {
      if (args.length === 0) return new realDate(at("11:00").getTime());
      return new realDate(...args);
    }
    static now() {
      return at("11:00").getTime();
    }
  };
  try {
    const overview = await dashboardService.overview();
    assert.equal(overview.date, "2026-09-08");
    assert.equal(overview.headcount, 2);
    assert.equal(overview.onSite.length, 1);
    assert.equal(overview.onSite[0].name, "Sam Staff");
    assert.equal(overview.onSite[0].lateMinutes, 20);
    // The admin never checked in, so they show as not-in.
    assert.equal(overview.notIn.some((r) => r.name === "Ada Admin"), true);
    assert.equal(overview.trend.length, 14);
    assert.equal(overview.trend[overview.trend.length - 1].date, "2026-09-08");
  } finally {
    global.Date = realDate;
  }
});

test("the Excel export contains a row per employee and per working day", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "09:30");
  await punch("checkOut", world.employee, insideOffice, "17:00");

  const restore = freeze("23:00", "2026-09-11");
  const report = await reportsService.buildReport({ from: "2026-09-07", to: "2026-09-11" });
  restore();
  const buffer = reportsService.toXlsx(report);
  assert.ok(buffer.length > 1000, "a real workbook should not be tiny");
  // XLSX files are zip archives: check the magic bytes rather than trusting length.
  assert.equal(buffer.subarray(0, 2).toString("utf8"), "PK");

  const csv = reportsService.toCsv(report, "detail");
  const lines = csv.split("\r\n");
  assert.match(lines[0], /^Employee,Employee ID,Department,Type,Date,Status/);
  assert.equal(lines.length, 1 + 2 * 5, "2 employees x 5 working days");
  assert.ok(csv.includes("09:30"), "the check-in time should appear in the detail export");
});

test("CSV export neutralises formula injection in a name", async () => {
  const world = await freshWorld();
  await employeesService.create({
    name: "=cmd|'/c calc'!A1",
    email: "sneaky@test.co",
    password: "password123",
    department: "Sales",
  });
  const report = await reportsService.buildReport({ from: "2026-09-08", to: "2026-09-08" });
  const csv = reportsService.toCsv(report, "summary");
  const row = csv.split("\r\n").find((line) => line.includes("cmd|"));
  // Excel executes a cell starting with "="; the leading apostrophe stops it.
  assert.ok(row.startsWith("'=cmd|"), `formula was not neutralised: ${row}`);
  assert.ok(!row.startsWith("=cmd|"));
});

test("an employee cannot be created twice on the same email", async () => {
  const world = await freshWorld();
  await assert.rejects(
    () => employeesService.create({ name: "Copy", email: "sam@test.co", password: "password123" }),
    (err) => err.status === 409
  );
});

test("the last active admin cannot be demoted or deactivated", async () => {
  const world = await freshWorld();
  const other = await employeesService.create({
    name: "Second Admin",
    email: "admin2@test.co",
    password: "password123",
    role: "admin",
  });

  // With two admins, demoting one is fine.
  await employeesService.update(other._id, { role: "employee" }, world.admin);

  // Now Ada is the only admin left, and someone else tries to deactivate her.
  const otherDoc = await employeesService.getById(other._id);
  await assert.rejects(
    () => employeesService.deactivate(world.admin._id, otherDoc),
    (err) => err.status === 409 && /only active admin/i.test(err.message)
  );
});

test("an admin cannot deactivate or demote themselves", async () => {
  const world = await freshWorld();
  await assert.rejects(
    () => employeesService.deactivate(world.admin._id, world.admin),
    (err) => err.status === 400
  );
  await assert.rejects(
    () => employeesService.update(world.admin._id, { role: "employee" }, world.admin),
    (err) => err.status === 400
  );
});

test("employee listings never leak a password hash", async () => {
  const world = await freshWorld();
  const list = await employeesService.list({});
  assert.equal(list.length, 2);
  for (const employee of list) {
    assert.equal(employee.password, undefined);
  }
});

test("a shift still in use cannot be deleted", async () => {
  const world = await freshWorld();
  await assert.rejects(
    () => settingsService.deleteShift(world.shift._id),
    (err) => err.status === 409 && /still on this shift/i.test(err.message)
  );
});

test("an unknown timezone is rejected before it can corrupt every date", async () => {
  await freshWorld();
  await assert.rejects(
    () => settingsService.updateSettings({ timeZone: "Mars/Olympus" }),
    (err) => err.status === 400
  );
});

test("a report range longer than the cap is refused", async () => {
  await freshWorld();
  await assert.rejects(
    () => reportsService.buildReport({ from: "2020-01-01", to: "2026-01-01" }),
    (err) => err.status === 400 && /days or fewer/.test(err.message)
  );
});

test("the no-show alert names who is missing and who was late", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "09:40");

  const mailer = require("../helpers/mailer");
  const originalSend = mailer.send;
  const sent = [];
  mailer.send = async (message) => {
    sent.push(message);
    return { messageId: "test" };
  };
  try {
    await cronJobs.noShowAlert(at("10:30"));
  } finally {
    mailer.send = originalSend;
  }

  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /1 absent, 1 late/);
  assert.match(sent[0].text, /Absent: Ada Admin/);
  assert.match(sent[0].text, /Late: Sam Staff \(40m\)/);
  // Falls back to the admin's own address when no alert emails are configured.
  assert.deepEqual(sent[0].to, ["admin@test.co"]);
});

test("report totals are summed even when the day rows are not returned", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "09:40");
  await punch("checkOut", world.employee, insideOffice, "17:00");

  // includeDays:false is what the summary screen asks for; the totals must
  // still be real numbers, not zeros from an emptied array.
  const restore = freeze("23:00", "2026-09-11");
  const report = await reportsService.buildReport({
    from: "2026-09-07",
    to: "2026-09-11",
    includeDays: false,
  });

  assert.equal(report.employees[0].days, undefined, "day rows should be stripped");
  assert.equal(report.totals.lateDays, 1);
  assert.equal(report.totals.lateMinutes, 40);
  assert.equal(report.totals.presentDays, 1);
  assert.equal(report.totals.absentDays, 9); // 2 employees x 5 days, minus the one present
  assert.ok(report.totals.workedHours > 0);

  // And they must match the same report asked for with days included.
  const withDays = await reportsService.buildReport({ from: "2026-09-07", to: "2026-09-11" });
  restore();
  assert.deepEqual(report.totals, withDays.totals);
});

test("the dashboard marks an open shift as working, not as a missing checkout", async () => {
  const world = await freshWorld();
  await punch("checkIn", world.employee, insideOffice, "09:00");

  const realDate = global.Date;
  global.Date = class extends realDate {
    constructor(...args) {
      if (args.length === 0) return new realDate(at("13:00").getTime());
      return new realDate(...args);
    }
    static now() {
      return at("13:00").getTime();
    }
  };
  try {
    const overview = await dashboardService.overview();
    const sam = overview.onSite.find((row) => row.name === "Sam Staff");
    assert.equal(sam.status, "working");

    // The stored record keeps the honest domain status for reporting.
    const record = await attendanceService.findRecord(world.employee._id, "2026-09-08");
    assert.equal(record.status, "missing_checkout");
  } finally {
    global.Date = realDate;
  }
});

test("a report covering the rest of the month does not invent future absences", async () => {
  const world = await freshWorld();

  const realDate = global.Date;
  global.Date = class extends realDate {
    constructor(...args) {
      if (args.length === 0) return new realDate(at("12:00").getTime());
      return new realDate(...args);
    }
    static now() {
      return at("12:00").getTime();
    }
  };
  try {
    // 2026-09-08 is a Tuesday; the range runs a week past it.
    const report = await reportsService.buildReport({ from: "2026-09-07", to: "2026-09-15" });
    const sam = report.employees.find((r) => r.employee.name === "Sam Staff");

    // Monday and Tuesday are due and unattended; Wed-Tue ahead are not.
    assert.equal(sam.summary.absentDays, 2);
    assert.equal(sam.summary.upcomingDays, 5);
    assert.equal(sam.summary.weekendDays, 2);
    assert.equal(sam.summary.expectedDays, 2);

    const future = sam.days.find((d) => d.date === "2026-09-14");
    assert.equal(future.status, "upcoming");
  } finally {
    global.Date = realDate;
  }
});

test("this morning is not an absence until the grace period has run out", async () => {
  const world = await freshWorld();

  // 08:30, before the 09:00 start: nobody is late, let alone absent.
  let restore = freeze("08:30");
  try {
    const early = await reportsService.buildReport({ from: "2026-09-08", to: "2026-09-08" });
    assert.equal(early.employees[0].days[0].status, "upcoming");
    assert.equal(early.totals.absentDays, 0);
  } finally {
    restore();
  }

  // 09:30, past the 10-minute grace: now it counts.
  restore = freeze("09:30");
  try {
    const later = await reportsService.buildReport({ from: "2026-09-08", to: "2026-09-08" });
    assert.equal(later.employees[0].days[0].status, "absent");
    assert.equal(later.totals.absentDays, 2);
  } finally {
    restore();
  }
});

test("buildDays honours the instant it is given instead of the real clock", async () => {
  const world = await freshWorld();

  // Asked about a day that, from the given instant, is still ahead.
  const ahead = await attendanceService.buildDays({
    users: [world.employee],
    from: "2026-09-10",
    to: "2026-09-10",
    now: at("12:00", "2026-09-08"),
  });
  assert.equal(ahead[0].days[0].status, "upcoming");

  // The same day, asked from an instant after it: now it is an absence.
  const behind = await attendanceService.buildDays({
    users: [world.employee],
    from: "2026-09-10",
    to: "2026-09-10",
    now: at("12:00", "2026-09-11"),
  });
  assert.equal(behind[0].days[0].status, "absent");
});
