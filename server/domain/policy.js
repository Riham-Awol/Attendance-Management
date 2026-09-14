"use strict";

const { STATUS } = require("./attendance-rules");

/**
 * Attendance policy: what the office allows in a month, and what an absence
 * costs.
 *
 * These numbers reach people's pay, so everything here is a pure function of
 * a summary plus a policy — no database, no clock — and every figure it
 * produces can be traced back to the days it came from.
 */
const STAFF_TYPES = ["employee", "intern"];
const STAFF_LABELS = { employee: "Employee", intern: "Intern" };

const DEFAULT_POLICY = {
  // Per calendar month, per employee.
  maxLateDaysPerMonth: 3,
  maxAbsentDaysPerMonth: 2,
  maxPermissionsPerMonth: 2,
  // Deducted for each unexcused absent day.
  absentDeductionPerDay: 500,
  currency: "ETB",
  // A perfect week should not outrank a near-perfect month. Nobody is
  // eligible to be "best" until they were expected in on at least this many
  // days in the period being ranked.
  minimumDaysForRanking: 5,
};

const withPolicyDefaults = (policy) => ({ ...DEFAULT_POLICY, ...(policy || {}) });

/**
 * An absence is a working day the employee neither attended nor was excused
 * for. Approved leave, an approved permission covering the day, a public
 * holiday and a non-working day are all excluded before this point by
 * `evaluateDay`, so counting the ABSENT status is the whole rule.
 */
const countAbsences = (days) => days.filter((day) => day.status === STATUS.ABSENT).length;

/** What an employee's absences cost them this period. */
function deduction(summary, policy) {
  const rules = withPolicyDefaults(policy);
  const days = summary.absentDays || 0;
  return {
    absentDays: days,
    perDay: rules.absentDeductionPerDay,
    amount: days * rules.absentDeductionPerDay,
    currency: rules.currency,
  };
}

/**
 * Which allowances an employee has used up. Reported as counts against limits
 * rather than a bare pass/fail, so a manager can see someone at 2 of 3 before
 * it becomes a problem.
 */
function allowanceUse(summary, policy) {
  const rules = withPolicyDefaults(policy);
  const entries = [
    ["late", summary.lateDays || 0, rules.maxLateDaysPerMonth],
    ["absent", summary.absentDays || 0, rules.maxAbsentDaysPerMonth],
    ["permission", summary.permissionsUsed || 0, rules.maxPermissionsPerMonth],
  ];

  const used = {};
  for (const [name, count, limit] of entries) {
    used[name] = {
      used: count,
      limit,
      remaining: Math.max(0, limit - count),
      exceeded: count > limit,
    };
  }
  used.anyExceeded = entries.some(([, count, limit]) => count > limit);
  return used;
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * One employee's score out of 100.
 *
 * Deliberately a weighted average of three rates rather than a running total
 * of penalties: a department of thirty people and a department of three have
 * to be comparable, and a penalty total is not.
 *
 *   60%  attendance — did they come in on the days they owed
 *   30%  punctuality — were they on time when they did
 *   10%  compliance — did they stay inside the month's allowances
 */
const WEIGHTS = { attendance: 0.6, punctuality: 0.3, compliance: 0.1 };

function scoreFor(summary, policy) {
  const rules = withPolicyDefaults(policy);
  const expected = summary.expectedDays || 0;

  // Nobody was expected in, so there is nothing to score. Reported as null
  // rather than 0 or 100, either of which would be a claim we cannot make.
  if (expected === 0) return { score: null, attendance: null, punctuality: null, compliance: null };

  const attendance = clamp01((summary.presentDays || 0) / expected);
  const present = summary.presentDays || 0;
  const punctuality = present === 0 ? 0 : clamp01((present - (summary.lateDays || 0)) / present);

  const use = allowanceUse(summary, rules);
  const breaches = ["late", "absent", "permission"].filter((key) => use[key].exceeded).length;
  const compliance = clamp01(1 - breaches / 3);

  const score =
    WEIGHTS.attendance * attendance +
    WEIGHTS.punctuality * punctuality +
    WEIGHTS.compliance * compliance;

  return {
    score: Math.round(score * 1000) / 10,
    attendance: Math.round(attendance * 1000) / 10,
    punctuality: Math.round(punctuality * 1000) / 10,
    compliance: Math.round(compliance * 1000) / 10,
  };
}

/** Plain-language banding, so a number on a dashboard means something. */
function band(score) {
  if (score === null || score === undefined) return "no data";
  if (score >= 95) return "excellent";
  if (score >= 85) return "good";
  if (score >= 70) return "needs attention";
  return "poor";
}

/**
 * A department's score is the mean of its members' scores, counting only
 * those who were expected at work in the period. Averaging the people rather
 * than pooling their days stops one person's long absence from being diluted
 * by a large team.
 */
function scoreDepartment(memberSummaries, policy) {
  const scored = memberSummaries
    .map((summary) => scoreFor(summary, policy))
    .filter((result) => result.score !== null);

  if (scored.length === 0) {
    return { score: null, band: band(null), scoredEmployees: 0 };
  }

  const mean = (key) =>
    Math.round((scored.reduce((sum, result) => sum + result[key], 0) / scored.length) * 10) / 10;

  const score = mean("score");
  return {
    score,
    band: band(score),
    attendance: mean("attendance"),
    punctuality: mean("punctuality"),
    compliance: mean("compliance"),
    scoredEmployees: scored.length,
  };
}

/**
 * Pick the best of a set of scored people.
 *
 * Two rules keep this honest. Someone with almost no attendance expected of
 * them is not eligible at all — otherwise a new joiner with one perfect day
 * tops the list ahead of a colleague who was there every day for a month. And
 * ties are broken by who was expected in more, then by who lost less time to
 * lateness, so the winner is the one with more behind the number.
 *
 * Returns null when nobody qualifies, which the caller must say out loud
 * rather than presenting an arbitrary name as the winner.
 */
function bestOf(candidates, policy) {
  const rules = withPolicyDefaults(policy);
  const eligible = candidates.filter(
    (candidate) =>
      candidate.summary.score !== null &&
      candidate.summary.score !== undefined &&
      (candidate.summary.expectedDays || 0) >= rules.minimumDaysForRanking
  );

  if (eligible.length === 0) return null;

  const ranked = [...eligible].sort(
    (a, b) =>
      b.summary.score - a.summary.score ||
      (b.summary.expectedDays || 0) - (a.summary.expectedDays || 0) ||
      (a.summary.lateMinutes || 0) - (b.summary.lateMinutes || 0) ||
      String(a.name || "").localeCompare(String(b.name || ""))
  );

  const winner = ranked[0];
  // A shared first place is reported as such rather than silently picking one.
  const sharedWith = ranked.filter(
    (row) =>
      row !== winner &&
      row.summary.score === winner.summary.score &&
      (row.summary.expectedDays || 0) === (winner.summary.expectedDays || 0) &&
      (row.summary.lateMinutes || 0) === (winner.summary.lateMinutes || 0)
  );

  return {
    ...winner,
    tied: sharedWith.length > 0,
    tiedWith: sharedWith.map((row) => row.name).filter(Boolean),
    eligible: eligible.length,
    considered: candidates.length,
    minimumDays: rules.minimumDaysForRanking,
  };
}

module.exports = {
  STAFF_TYPES,
  STAFF_LABELS,
  bestOf,
  DEFAULT_POLICY,
  WEIGHTS,
  withPolicyDefaults,
  countAbsences,
  deduction,
  allowanceUse,
  scoreFor,
  scoreDepartment,
  band,
};
