"use strict";

/**
 * The policy rules as the API actually applies them: office assignment,
 * per-employee hours, the monthly permission ration, deductions, department
 * scores, and what an employee is allowed to see of anyone else.
 */

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

const HQ = { lat: 9.005401, lng: 38.763611 };
const BRANCH = { lat: 9.05, lng: 38.8 };
const TZ = "Africa/Addis_Ababa";

const fakeReq = () => ({ ip: "10.0.0.1", headers: { "user-agent": "node-test" } });

const at = (clock, date = "2026-09-08") => {
  const [h, m] = clock.split(":").map(Number);
  return new Date(Date.UTC(...date.split("-").map(Number).map((v, i) => (i === 1 ? v - 1 : v)), h - 3, m));
};

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

async function punch(kind, user, point, clock, date) {
  const restore = freeze(clock, date);
  try {
    return await attendanceService[kind](user, point, fakeReq());
  } finally {
    restore();
  }
}

async function world() {
  const memory = new MemoryDb();
  db.__setDbForTests(memory);
  await db.ensureIndexes(memory);

  await settingsService.updateSettings({ companyName: "weTech", timeZone: TZ });
  const hq = await settingsService.createOffice({ name: "Head Office", ...HQ, radiusMeters: 120, active: true });
  const branch = await settingsService.createOffice({ name: "Branch", ...BRANCH, radiusMeters: 120, active: true });
  const shift = await settingsService.createShift({
    name: "Standard",
    startTime: "09:00",
    endTime: "17:00",
    workDays: [0, 1, 2, 3, 4, 5, 6],
    graceMinutes: 10,
    breakMinutes: 60,
    isDefault: true,
  });

  const admin = await employeesService.create({
    name: "Ada Admin", email: "admin@wetech.co", password: "password123", role: "admin", department: "Management",
  });
  const sam = await employeesService.create({
    name: "Sam Staff", email: "sam@wetech.co", password: "password123", department: "Sales", shiftId: String(shift._id),
  });

  return {
    memory, hq, branch, shift,
    admin: await employeesService.getById(admin._id),
    sam: await employeesService.getById(sam._id),
  };
}

const inside = (point) => ({ ...point, accuracy: 8 });

/* ── Office assignment ───────────────────────────────────────────────── */

test("an employee posted to one office cannot check in at another", async () => {
  const w = await world();
  await employeesService.update(w.sam._id, { officeId: String(w.branch._id) }, w.admin);
  const sam = await employeesService.getById(w.sam._id);

  await assert.rejects(
    () => punch("checkIn", sam, inside(HQ), "09:00"),
    (err) => {
      assert.equal(err.status, 422);
      // The distance is measured to their own office, not the nearest one.
      assert.match(err.message, /Branch/);
      return true;
    }
  );

  const ok = await punch("checkIn", sam, inside(BRANCH), "09:00");
  assert.equal(ok.office.name, "Branch");
});

test("an unassigned employee may use any active office", async () => {
  const w = await world();
  const first = await punch("checkIn", w.sam, inside(BRANCH), "09:00");
  assert.equal(first.office.name, "Branch");
});

test("a deactivated office does not strand the people assigned to it", async () => {
  const w = await world();
  await employeesService.update(w.sam._id, { officeId: String(w.branch._id) }, w.admin);
  await settingsService.updateOffice(w.branch._id, { active: false });

  const sam = await employeesService.getById(w.sam._id);
  const result = await punch("checkIn", sam, inside(HQ), "09:00");
  assert.equal(result.office.name, "Head Office");
});

/* ── Per-employee hours ──────────────────────────────────────────────── */

test("an employee's own hours override the shift they are on", async () => {
  const w = await world();
  await employeesService.update(
    w.sam._id,
    { workingHours: { startTime: "07:00", endTime: "15:00" } },
    w.admin
  );
  const sam = await employeesService.getById(w.sam._id);

  const shift = await settingsService.getShiftForUser(sam);
  assert.equal(shift.startTime, "07:00");
  assert.equal(shift.endTime, "15:00");
  // Untouched fields still come from the shift.
  assert.equal(shift.breakMinutes, 60);
  assert.equal(shift.customised, true);

  // 08:00 is an hour late on their hours, though it would be early on Standard.
  await punch("checkIn", sam, inside(HQ), "08:00");
  const record = await attendanceService.findRecord(sam._id, "2026-09-08");
  assert.equal(record.lateMinutes, 60);
  assert.equal(record.status, "missing_checkout");
});

test("colleagues on the same shift are unaffected by one person's hours", async () => {
  const w = await world();
  await employeesService.update(w.sam._id, { workingHours: { startTime: "07:00" } }, w.admin);

  const other = await employeesService.create({
    name: "Other Person", email: "other@wetech.co", password: "password123",
    department: "Sales", shiftId: String(w.shift._id),
  });
  const shift = await settingsService.getShiftForUser(await employeesService.getById(other._id));
  assert.equal(shift.startTime, "09:00");
  assert.equal(shift.customised, undefined);
});

/* ── Permission ration ───────────────────────────────────────────────── */

const permissionFor = (date, from = "09:00", to = "10:00") => ({
  type: "permission",
  scope: "partial",
  fromDate: date,
  toDate: date,
  fromTime: from,
  toTime: to,
  reason: "Personal errand",
});

test("a third permission in one month is refused", async () => {
  const w = await world();
  await leaveService.createRequest(w.sam, permissionFor("2026-09-03"));
  await leaveService.createRequest(w.sam, permissionFor("2026-09-10"));

  await assert.rejects(
    () => leaveService.createRequest(w.sam, permissionFor("2026-09-17")),
    (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /already used 2 of 2 permission requests for 2026-09/);
      assert.equal(err.details.limit, 2);
      return true;
    }
  );

  // The allowance resets with the calendar month.
  const nextMonth = await leaveService.createRequest(w.sam, permissionFor("2026-10-01"));
  assert.equal(nextMonth.status, "pending");
});

test("a pending permission holds its slot, and a rejected one gives it back", async () => {
  const w = await world();
  const first = await leaveService.createRequest(w.sam, permissionFor("2026-09-03"));
  await leaveService.createRequest(w.sam, permissionFor("2026-09-10"));

  await assert.rejects(() => leaveService.createRequest(w.sam, permissionFor("2026-09-17")));

  await leaveService.decide(first._id, w.admin, "rejected", "Not this time");
  const allowed = await leaveService.createRequest(w.sam, permissionFor("2026-09-17"));
  assert.equal(allowed.status, "pending");
});

test("the limit is configurable and whole-day leave is never rationed by it", async () => {
  const w = await world();
  await settingsService.updateSettings({ policy: { maxPermissionsPerMonth: 1 } });

  await leaveService.createRequest(w.sam, permissionFor("2026-09-03"));
  await assert.rejects(() => leaveService.createRequest(w.sam, permissionFor("2026-09-10")));

  // Annual leave is a different thing and has its own rules.
  const annual = await leaveService.createRequest(w.sam, {
    type: "annual", scope: "full_day", fromDate: "2026-09-20", toDate: "2026-09-21", reason: "Trip",
  });
  assert.equal(annual.status, "pending");
});

test("an employee is told how many permissions they have left", async () => {
  const w = await world();
  const before = await leaveService.permissionAllowance(w.sam._id, "2026-09-08");
  assert.deepEqual(before, { used: 0, limit: 2, remaining: 2, month: "2026-09" });

  await leaveService.createRequest(w.sam, permissionFor("2026-09-03"));
  const after = await leaveService.permissionAllowance(w.sam._id, "2026-09-08");
  assert.equal(after.remaining, 1);
});

/* ── Deductions and scores ───────────────────────────────────────────── */

test("each unexcused absence deducts the configured amount", async () => {
  const w = await world();
  const restore = freeze("23:00", "2026-09-05");
  try {
    const report = await reportsService.buildReport({ from: "2026-09-01", to: "2026-09-05" });
    const sam = report.employees.find((r) => r.employee.name === "Sam Staff");

    assert.equal(sam.summary.absentDays, 5);
    assert.equal(sam.summary.deduction.perDay, 500);
    assert.equal(sam.summary.deduction.amount, 2500);
    assert.equal(report.currency, "ETB");
    // Two employees, both absent all week.
    assert.equal(report.deductionTotal, 5000);
  } finally {
    restore();
  }
});

test("approved leave is not an absence and costs nothing", async () => {
  const w = await world();
  const leave = await leaveService.createRequest(w.sam, {
    type: "annual", scope: "full_day", fromDate: "2026-09-01", toDate: "2026-09-05", reason: "Holiday",
  });
  await leaveService.decide(leave._id, w.admin, "approved");

  const restore = freeze("23:00", "2026-09-05");
  try {
    const report = await reportsService.buildReport({ from: "2026-09-01", to: "2026-09-05" });
    const sam = report.employees.find((r) => r.employee.name === "Sam Staff");
    assert.equal(sam.summary.absentDays, 0);
    assert.equal(sam.summary.deduction.amount, 0);
  } finally {
    restore();
  }
});

test("departments are scored and ordered best first", async () => {
  const w = await world();
  // Sales turns up; Management does not.
  for (const date of ["2026-09-01", "2026-09-02", "2026-09-03"]) {
    await punch("checkIn", w.sam, inside(HQ), "09:00", date);
    await punch("checkOut", w.sam, inside(HQ), "17:00", date);
  }

  const restore = freeze("23:00", "2026-09-03");
  try {
    const report = await reportsService.buildReport({ from: "2026-09-01", to: "2026-09-03" });
    const [best, worst] = report.departmentScores;

    assert.equal(best.department, "Sales");
    assert.equal(best.score, 100);
    assert.equal(best.band, "excellent");
    assert.equal(worst.department, "Management");
    assert.ok(worst.score < best.score);
    assert.equal(worst.absentDays, 3);
    assert.equal(worst.deduction, 1500);
  } finally {
    restore();
  }
});

test("the dashboard lists every person's lateness, absence, permissions and cost", async () => {
  const w = await world();
  await punch("checkIn", w.sam, inside(HQ), "09:40", "2026-09-08");
  await punch("checkOut", w.sam, inside(HQ), "17:00", "2026-09-08");

  const restore = freeze("18:00", "2026-09-08");
  try {
    const overview = await dashboardService.overview();
    const sam = overview.month.people.find((p) => p.name === "Sam Staff");

    assert.equal(sam.lateDays, 1);
    assert.equal(sam.department, "Sales");
    assert.ok(sam.score > 0 && sam.score <= 100);
    assert.equal(typeof sam.deduction, "number");
    assert.ok(Array.isArray(overview.month.departments));
    assert.equal(overview.month.currency, "ETB");

    // Worst score first, so the people needing attention are at the top.
    const scores = overview.month.people.map((p) => p.score ?? 101);
    assert.deepEqual(scores, [...scores].sort((a, b) => a - b));
  } finally {
    restore();
  }
});

/* ── What an employee may see ────────────────────────────────────────── */

test("the employee scoreboard carries departments and no individuals", async () => {
  const w = await world();
  await punch("checkIn", w.sam, inside(HQ), "09:00", "2026-09-08");

  const restore = freeze("18:00", "2026-09-08");
  try {
    const board = await dashboardService.departmentScoreboard();
    assert.ok(board.departments.length >= 2);

    const serialised = JSON.stringify(board);
    for (const name of ["Sam Staff", "Ada Admin", "sam@wetech.co", "admin@wetech.co"]) {
      assert.ok(!serialised.includes(name), `${name} must not appear in the employee scoreboard`);
    }
    // Only the department-level figures are present.
    assert.deepEqual(
      Object.keys(board.departments[0]).sort(),
      ["attendance", "band", "department", "employees", "punctuality", "score"]
    );
  } finally {
    restore();
  }
});
