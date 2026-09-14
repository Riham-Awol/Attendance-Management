"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const policy = require("../domain/policy");

/** A month's summary, with only the fields the policy cares about. */
const summary = (over = {}) => ({
  expectedDays: 20,
  presentDays: 20,
  lateDays: 0,
  absentDays: 0,
  permissionsUsed: 0,
  ...over,
});

test("an absence costs the configured amount per day", () => {
  const result = policy.deduction(summary({ presentDays: 17, absentDays: 3 }));
  assert.equal(result.absentDays, 3);
  assert.equal(result.perDay, 500);
  assert.equal(result.amount, 1500);
  assert.equal(result.currency, "ETB");
});

test("a perfect attendance record costs nothing", () => {
  assert.equal(policy.deduction(summary()).amount, 0);
});

test("the deduction rate is configurable without touching the rule", () => {
  const result = policy.deduction(summary({ absentDays: 2 }), {
    absentDeductionPerDay: 750,
    currency: "USD",
  });
  assert.equal(result.amount, 1500);
  assert.equal(result.currency, "USD");
});

test("only unexcused absences are counted, never leave or holidays", () => {
  const days = [
    { status: "absent" },
    { status: "absent" },
    { status: "on_leave" },
    { status: "holiday" },
    { status: "weekend" },
    { status: "upcoming" },
    { status: "present" },
    { status: "late" },
  ];
  assert.equal(policy.countAbsences(days), 2);
});

test("allowances report what is left, not just whether a rule was broken", () => {
  const use = policy.allowanceUse(summary({ lateDays: 2, permissionsUsed: 1 }));
  assert.equal(use.late.used, 2);
  assert.equal(use.late.limit, 3);
  assert.equal(use.late.remaining, 1);
  assert.equal(use.late.exceeded, false);
  assert.equal(use.permission.remaining, 1);
  assert.equal(use.anyExceeded, false);
});

test("an allowance is exceeded only past the limit, not at it", () => {
  assert.equal(policy.allowanceUse(summary({ lateDays: 3 })).late.exceeded, false);
  assert.equal(policy.allowanceUse(summary({ lateDays: 4 })).late.exceeded, true);
  assert.equal(policy.allowanceUse(summary({ lateDays: 4 })).anyExceeded, true);
});

test("a flawless month scores 100", () => {
  const result = policy.scoreFor(summary());
  assert.equal(result.score, 100);
  assert.equal(result.attendance, 100);
  assert.equal(result.punctuality, 100);
  assert.equal(policy.band(result.score), "excellent");
});

test("absence weighs more heavily than lateness", () => {
  const absent = policy.scoreFor(summary({ presentDays: 18, absentDays: 2 })).score;
  const late = policy.scoreFor(summary({ lateDays: 2 })).score;
  assert.ok(absent < late, `two absences (${absent}) should score below two late days (${late})`);
});

test("a month nobody was expected in scores nothing rather than zero or full marks", () => {
  const result = policy.scoreFor(summary({ expectedDays: 0, presentDays: 0 }));
  assert.equal(result.score, null);
  assert.equal(policy.band(result.score), "no data");
});

test("breaking an allowance costs compliance but does not wipe out the score", () => {
  const within = policy.scoreFor(summary({ presentDays: 17, absentDays: 3, lateDays: 1 }));
  // Three absences exceeds the limit of two, so compliance drops by a third.
  assert.equal(within.compliance, 66.7);
  assert.ok(within.score > 0 && within.score < 100);
});

test("a department is the mean of its people, not of their pooled days", () => {
  // One person absent for a whole month alongside two perfect records.
  const department = policy.scoreDepartment([
    summary(),
    summary(),
    summary({ presentDays: 0, absentDays: 20 }),
  ]);
  assert.equal(department.scoredEmployees, 3);
  // A pooled-days average would read ~67%; the mean of the people is lower
  // because that one record scores near zero on every component.
  assert.ok(department.score < 70, `expected the outlier to show, got ${department.score}`);
  assert.equal(department.band, "poor");

  // The same three people with the absentee merely often late scores far
  // better, which is the ordering a manager needs the number to have.
  const milder = policy.scoreDepartment([summary(), summary(), summary({ lateDays: 5 })]);
  assert.ok(milder.score > department.score + 20);
});

test("employees with nothing expected of them do not drag a department down", () => {
  const department = policy.scoreDepartment([
    summary(),
    summary({ expectedDays: 0, presentDays: 0 }), // joined at the end of the month
  ]);
  assert.equal(department.scoredEmployees, 1);
  assert.equal(department.score, 100);
});

test("a department with nobody to score reports no data", () => {
  const department = policy.scoreDepartment([summary({ expectedDays: 0, presentDays: 0 })]);
  assert.equal(department.score, null);
  assert.equal(department.scoredEmployees, 0);
});

test("the score bands read the way a manager would describe them", () => {
  assert.equal(policy.band(100), "excellent");
  assert.equal(policy.band(95), "excellent");
  assert.equal(policy.band(86), "good");
  assert.equal(policy.band(72), "needs attention");
  assert.equal(policy.band(40), "poor");
});

test("two departments of very different sizes stay comparable", () => {
  const small = policy.scoreDepartment([summary({ lateDays: 1 })]);
  const large = policy.scoreDepartment(Array.from({ length: 30 }, () => summary({ lateDays: 1 })));
  assert.equal(small.score, large.score);
});
