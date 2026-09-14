"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const geo = require("../domain/geo");
const time = require("../domain/time");
const rules = require("../domain/attendance-rules");
const reports = require("../domain/reports");

const OFFICE = { _id: "hq", name: "HQ", lat: 9.005401, lng: 38.763611, radiusMeters: 100, active: true };

test("distanceMeters is accurate at geofence scale", () => {
  assert.equal(Math.round(geo.distanceMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })), 0);
  // 0.001 degrees of latitude is ~111.2 m anywhere on Earth.
  const d = geo.distanceMeters({ lat: 9.0, lng: 38.0 }, { lat: 9.001, lng: 38.0 });
  assert.ok(Math.abs(d - 111.2) < 1, `expected ~111.2m, got ${d}`);
});

test("resolveOffice accepts a point inside the fence", () => {
  const res = geo.resolveOffice({ lat: 9.005401, lng: 38.763611, accuracy: 12 }, [OFFICE]);
  assert.equal(res.ok, true);
  assert.equal(res.office._id, "hq");
  assert.equal(res.distance, 0);
});

test("resolveOffice rejects a point outside the fence and reports the distance", () => {
  // ~333 m north of the office, well outside a 100 m fence.
  const res = geo.resolveOffice({ lat: 9.008401, lng: 38.763611, accuracy: 10 }, [OFFICE]);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "outside_geofence");
  assert.ok(res.distance > 300 && res.distance < 340, `got ${res.distance}`);
});

test("resolveOffice widens the fence by GPS accuracy but only up to the slack", () => {
  const point = { lat: 9.006, lng: 38.763611, accuracy: 60 }; // ~67 m out
  assert.equal(geo.resolveOffice(point, [OFFICE]).ok, true);
  // Same spot with a pinpoint fix stays outside a 60 m fence.
  const tight = { ...OFFICE, radiusMeters: 40 };
  assert.equal(geo.resolveOffice({ ...point, accuracy: 5 }, [tight]).ok, false);
});

test("resolveOffice refuses a hopeless GPS fix rather than guessing", () => {
  const res = geo.resolveOffice({ lat: 9.005401, lng: 38.763611, accuracy: 900 }, [OFFICE]);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "poor_accuracy");
});

test("resolveOffice picks the closest of several offices", () => {
  const branch = { _id: "branch", name: "Branch", lat: 9.05, lng: 38.8, radiusMeters: 150, active: true };
  const res = geo.resolveOffice({ lat: 9.0501, lng: 38.8, accuracy: 10 }, [OFFICE, branch]);
  assert.equal(res.ok, true);
  assert.equal(res.office._id, "branch");
});

test("resolveOffice ignores deactivated offices", () => {
  const res = geo.resolveOffice({ lat: 9.005401, lng: 38.763611, accuracy: 10 }, [{ ...OFFICE, active: false }]);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "no_offices_configured");
});

test("dateKey and minutesOfDay follow the office timezone, not the server", () => {
  // 2026-03-01T22:30:00Z is already the 2nd in Addis Ababa (UTC+3).
  const instant = new Date("2026-03-01T22:30:00Z");
  assert.equal(time.dateKey(instant, "Africa/Addis_Ababa"), "2026-03-02");
  assert.equal(time.minutesOfDay(instant, "Africa/Addis_Ababa"), 1 * 60 + 30);
  assert.equal(time.dateKey(instant, "UTC"), "2026-03-01");
});

test("zonedTimeToInstant round-trips through a DST boundary", () => {
  // New York moves to DST on 2026-03-08. 09:00 local is 14:00 UTC after it.
  const before = time.zonedTimeToInstant("2026-03-01", 540, "America/New_York");
  assert.equal(before.toISOString(), "2026-03-01T14:00:00.000Z");
  const after = time.zonedTimeToInstant("2026-03-10", 540, "America/New_York");
  assert.equal(after.toISOString(), "2026-03-10T13:00:00.000Z");
  assert.equal(time.dateKey(after, "America/New_York"), "2026-03-10");
  assert.equal(time.minutesOfDay(after, "America/New_York"), 540);
});

test("date key helpers handle month ends and ranges", () => {
  assert.equal(time.addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(time.addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(time.weekdayOf("2026-09-08"), 2);
  assert.deepEqual(time.eachDate("2026-09-01", "2026-09-03"), ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.deepEqual(time.eachDate("2026-09-03", "2026-09-01"), []);
  assert.deepEqual(time.monthRange("2026-02-15"), { from: "2026-02-01", to: "2026-02-28" });
});

test("formatting helpers render durations for humans", () => {
  assert.equal(time.formatClock(570), "09:30");
  assert.equal(time.formatClock(1470), "00:30");
  assert.equal(time.formatDuration(135), "2h 15m");
  assert.equal(time.formatDuration(120), "2h");
  assert.equal(time.formatDuration(45), "45m");
});

const SHIFT = {
  startTime: "09:00",
  endTime: "17:00",
  workDays: [1, 2, 3, 4, 5],
  graceMinutes: 10,
  earlyLeaveGraceMinutes: 10,
  breakMinutes: 60, // scheduled = 420 worked minutes
  minFullDayMinutes: 380,
  minHalfDayMinutes: 210,
  countOvertime: true,
  overtimeThresholdMinutes: 15,
};

test("a normal full day is present with no penalties", () => {
  const day = rules.evaluateDay({ shift: SHIFT, checkInMinutes: 535, checkOutMinutes: 1020 });
  assert.equal(day.status, "present");
  assert.equal(day.lateMinutes, 0);
  assert.equal(day.earlyLeaveMinutes, 0);
  assert.equal(day.overtimeMinutes, 0);
  assert.equal(day.workedMinutes, 425); // 08:55-17:00 minus a 60m break
});

test("arriving inside the grace period is not late", () => {
  const day = rules.evaluateDay({ shift: SHIFT, checkInMinutes: 548, checkOutMinutes: 1020 });
  assert.equal(day.lateMinutes, 0);
  assert.equal(day.status, "present");
});

test("arriving past the grace period counts from the scheduled start", () => {
  const day = rules.evaluateDay({ shift: SHIFT, checkInMinutes: 565, checkOutMinutes: 1020 });
  assert.equal(day.lateMinutes, 25);
  assert.equal(day.status, "late");
});

test("leaving early is measured against the scheduled end", () => {
  const day = rules.evaluateDay({ shift: SHIFT, checkInMinutes: 540, checkOutMinutes: 960 });
  assert.equal(day.earlyLeaveMinutes, 60);
  assert.equal(day.workedMinutes, 360);
  assert.equal(day.status, "half_day");
});

test("overtime is only counted past the threshold", () => {
  const short = rules.evaluateDay({ shift: SHIFT, checkInMinutes: 540, checkOutMinutes: 1030 });
  assert.equal(short.overtimeMinutes, 0);
  const real = rules.evaluateDay({ shift: SHIFT, checkInMinutes: 540, checkOutMinutes: 1110 });
  assert.equal(real.overtimeMinutes, 90);
});

test("an approved permission excuses the lateness it covers", () => {
  const day = rules.evaluateDay({
    shift: SHIFT,
    checkInMinutes: 600, // 10:00, an hour late
    checkOutMinutes: 1020,
    excusedWindows: [{ start: 540, end: 600 }], // approved 09:00-10:00
  });
  assert.equal(day.lateMinutes, 0);
  assert.equal(day.excusedMinutes, 60);
  // 4 worked hours + 1 excused hour clears the half-day threshold.
  assert.equal(day.status, "present");
});

test("a permission shorter than the absence still leaves net lateness", () => {
  const day = rules.evaluateDay({
    shift: SHIFT,
    checkInMinutes: 600,
    checkOutMinutes: 1020,
    excusedWindows: [{ start: 540, end: 570 }],
  });
  assert.equal(day.lateMinutes, 30);
  assert.equal(day.status, "late");
});

test("an approved permission excuses an early departure", () => {
  const day = rules.evaluateDay({
    shift: SHIFT,
    checkInMinutes: 540,
    checkOutMinutes: 960,
    excusedWindows: [{ start: 960, end: 1020 }],
  });
  assert.equal(day.earlyLeaveMinutes, 0);
  assert.equal(day.status, "present");
});

test("no check-in on a working day is an absence", () => {
  const day = rules.evaluateDay({ shift: SHIFT, checkInMinutes: null });
  assert.equal(day.status, "absent");
  assert.equal(day.workedMinutes, 0);
});

test("holidays, weekends and approved leave outrank an absence", () => {
  assert.equal(rules.evaluateDay({ shift: SHIFT, isHoliday: true }).status, "holiday");
  assert.equal(rules.evaluateDay({ shift: SHIFT, workDay: false }).status, "weekend");
  assert.equal(rules.evaluateDay({ shift: SHIFT, onFullDayLeave: true }).status, "on_leave");
  // A holiday wins even if the employee also had leave booked.
  assert.equal(
    rules.evaluateDay({ shift: SHIFT, isHoliday: true, onFullDayLeave: true }).status,
    "holiday"
  );
});

test("a check-in with no check-out is flagged, not silently paid", () => {
  const day = rules.evaluateDay({ shift: SHIFT, checkInMinutes: 540, checkOutMinutes: null });
  assert.equal(day.status, "missing_checkout");
  assert.equal(day.workedMinutes, 0);
});

test("an overnight shift keeps one record across midnight", () => {
  const night = { ...SHIFT, startTime: "22:00", endTime: "06:00", breakMinutes: 0, minFullDayMinutes: 440 };
  const window = rules.shiftWindow(night);
  assert.equal(window.crossesMidnight, true);
  assert.equal(window.scheduledMinutes, 480);

  const day = rules.evaluateDay({ shift: night, checkInMinutes: 1320, checkOutMinutes: 360 });
  assert.equal(day.workedMinutes, 480);
  assert.equal(day.status, "present");

  // A 01:00 punch belongs to the shift that started the previous evening.
  assert.equal(rules.shiftDateFor("2026-09-09", 60, night), "2026-09-08");
  assert.equal(rules.shiftDateFor("2026-09-08", 1320, night), "2026-09-08");
});

test("workDays drives the weekend rule", () => {
  assert.equal(rules.isWorkDay(SHIFT, "2026-09-08"), true); // Tuesday
  assert.equal(rules.isWorkDay(SHIFT, "2026-09-12"), false); // Saturday
  const satSun = { ...SHIFT, workDays: [0, 6] };
  assert.equal(rules.isWorkDay(satSun, "2026-09-12"), true);
});

test("summarizeDays rolls a month into manager-readable numbers", () => {
  const days = [
    { status: "present", lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, workedMinutes: 480, scheduledMinutes: 480, excusedMinutes: 0 },
    { status: "late", lateMinutes: 25, earlyLeaveMinutes: 0, overtimeMinutes: 0, workedMinutes: 455, scheduledMinutes: 480, excusedMinutes: 0 },
    { status: "absent", lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, workedMinutes: 0, scheduledMinutes: 480, excusedMinutes: 0 },
    { status: "on_leave", lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, workedMinutes: 0, scheduledMinutes: 480, excusedMinutes: 0 },
    { status: "weekend", lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, workedMinutes: 0, scheduledMinutes: 480, excusedMinutes: 0 },
    { status: "half_day", lateMinutes: 15, earlyLeaveMinutes: 120, overtimeMinutes: 0, workedMinutes: 240, scheduledMinutes: 480, excusedMinutes: 0 },
  ];
  const s = reports.summarizeDays(days);
  assert.equal(s.expectedDays, 4); // present, late, absent, half_day
  assert.equal(s.presentDays, 3);
  assert.equal(s.lateDays, 2); // the half day was also a late arrival
  assert.equal(s.absentDays, 1);
  assert.equal(s.leaveDays, 1);
  assert.equal(s.weekendDays, 1);
  assert.equal(s.lateMinutes, 40);
  assert.equal(s.earlyLeaveDays, 1);
  assert.equal(s.attendanceRate, 75);
  assert.equal(s.workedHours, 19.6);
  // Weekend and leave days are not "expected", so they don't dilute the target.
  assert.equal(s.scheduledMinutes, 1920);
});

test("summarizeDays of an empty range does not divide by zero", () => {
  const s = reports.summarizeDays([]);
  assert.equal(s.attendanceRate, 0);
  assert.equal(s.punctualityRate, 0);
  assert.equal(s.avgLateMinutes, 0);
});

test("groupByDepartment merges employee rows without losing minutes", () => {
  const mk = (department, lateMinutes) => ({
    employee: { department },
    summary: reports.summarizeDays([
      { status: "late", lateMinutes, earlyLeaveMinutes: 0, overtimeMinutes: 0, workedMinutes: 480, scheduledMinutes: 480, excusedMinutes: 0 },
    ]),
  });
  const grouped = reports.groupByDepartment([mk("Sales", 10), mk("Sales", 20), mk("Ops", 5)]);
  assert.equal(grouped.length, 2);
  const sales = grouped.find((g) => g.department === "Sales");
  assert.equal(sales.employees, 2);
  assert.equal(sales.summary.lateMinutes, 30);
  assert.equal(sales.summary.attendanceRate, 100);
});

test("unset hour thresholds scale to the shift's own length", () => {
  const halfShift = { startTime: "09:00", endTime: "13:00", workDays: [1], graceMinutes: 5 };
  const t = rules.dayThresholds(halfShift, rules.shiftWindow(halfShift));
  assert.equal(t.minFullDayMinutes, 180); // 75% of 240
  assert.equal(t.minHalfDayMinutes, 96); // 40% of 240

  // 09:00-11:00 is 120 minutes: half of a 4h shift.
  const day = rules.evaluateDay({ shift: halfShift, checkInMinutes: 540, checkOutMinutes: 660 });
  assert.equal(day.status, "half_day");
  // The same 120 minutes against an 8-hour shift is barely there at all.
  const long = { startTime: "09:00", endTime: "17:00", workDays: [1] };
  assert.equal(
    rules.evaluateDay({ shift: long, checkInMinutes: 540, checkOutMinutes: 660 }).status,
    "short_day"
  );
  // An hour late on a full 8-hour shift stays a late day, not a half day.
  assert.equal(
    rules.evaluateDay({ shift: long, checkInMinutes: 600, checkOutMinutes: 1020 }).status,
    "late"
  );
});

test("working on an approved leave day counts the hours and forgives the clock", () => {
  const onLeave = { shift: SHIFT, onFullDayLeave: true, workDay: true };

  // Nobody came in: the leave explains the empty day.
  assert.equal(rules.evaluateDay(onLeave).status, "on_leave");

  // They came in anyway, two hours late. The hours they worked count, and
  // being "late" for a day they were not expected on is meaningless.
  const worked = rules.evaluateDay({ ...onLeave, checkInMinutes: 660, checkOutMinutes: 1020 });
  assert.equal(worked.status, "present");
  assert.equal(worked.lateMinutes, 0);
  assert.equal(worked.earlyLeaveMinutes, 0);
  assert.equal(worked.workedMinutes, 300);
  // The rest of the shift is credited, so a part-worked leave day is not a
  // "half day" against them.
  assert.equal(worked.excusedMinutes, 120);

  // The same short day without leave is still judged on its hours.
  const noLeave = rules.evaluateDay({ shift: SHIFT, checkInMinutes: 660, checkOutMinutes: 1020 });
  assert.equal(noLeave.status, "half_day");
  assert.equal(noLeave.lateMinutes, 120);
});

test("a day nobody could have attended yet is upcoming, not absent", () => {
  const upcoming = rules.evaluateDay({ shift: SHIFT, checkInMinutes: null, notYetDue: true });
  assert.equal(upcoming.status, "upcoming");

  // Once the day is due, the same empty record is an absence.
  const due = rules.evaluateDay({ shift: SHIFT, checkInMinutes: null, notYetDue: false });
  assert.equal(due.status, "absent");

  // Upcoming days must not drag an attendance rate down.
  const summary = reports.summarizeDays([
    { status: "present", lateMinutes: 0, earlyLeaveMinutes: 0, overtimeMinutes: 0, workedMinutes: 420, scheduledMinutes: 420, excusedMinutes: 0 },
    upcoming,
    upcoming,
  ]);
  assert.equal(summary.expectedDays, 1);
  assert.equal(summary.absentDays, 0);
  assert.equal(summary.upcomingDays, 2);
  assert.equal(summary.attendanceRate, 100);
});
