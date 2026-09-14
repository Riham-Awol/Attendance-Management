"use strict";

const { parseClock, weekdayOf } = require("./time");

/**
 * Day outcomes, most significant first. `resolveDayStatus` picks the first one
 * that applies, so the order here *is* the business rule: a public holiday
 * outranks approved leave, approved leave outranks an absence, and so on.
 */
const STATUS = {
  HOLIDAY: "holiday",
  WEEKEND: "weekend",
  ON_LEAVE: "on_leave",
  // A working day that has not come round yet — or today, before anyone is
  // due in. Absence is a judgement about the past; it cannot be passed on a
  // day nobody has had the chance to attend.
  UPCOMING: "upcoming",
  ABSENT: "absent",
  MISSING_CHECKOUT: "missing_checkout",
  SHORT_DAY: "short_day",
  HALF_DAY: "half_day",
  LATE: "late",
  PRESENT: "present",
};

const DEFAULT_SHIFT = {
  name: "Default",
  startTime: "09:00",
  endTime: "17:00",
  workDays: [1, 2, 3, 4, 5],
  graceMinutes: 10,
  earlyLeaveGraceMinutes: 10,
  breakMinutes: 0,
  // Left null on purpose: an absolute "420 minutes is a full day" would
  // mislabel every shift that isn't 9-to-5, so unset thresholds derive from
  // the shift's own scheduled length instead.
  minFullDayMinutes: null,
  minHalfDayMinutes: null,
  countOvertime: true,
  overtimeThresholdMinutes: 15,
};

function withShiftDefaults(shift) {
  return { ...DEFAULT_SHIFT, ...(shift || {}) };
}

/**
 * The scheduled window for one day, on a minutes-since-local-midnight axis.
 * An overnight shift (22:00-06:00) keeps a monotonic axis by pushing its end
 * past 1440, so every later comparison is plain arithmetic.
 */
function shiftWindow(shift) {
  const s = withShiftDefaults(shift);
  const start = parseClock(s.startTime);
  let end = parseClock(s.endTime);
  const crossesMidnight = end <= start;
  if (crossesMidnight) end += 1440;
  return {
    start,
    end,
    crossesMidnight,
    scheduledMinutes: Math.max(0, end - start - (s.breakMinutes || 0)),
  };
}

/**
 * How much of the day must be worked to count as a full or half day.
 *
 * Explicit per-shift values win. The defaults are deliberately generous —
 * 75% and 40% of the shift's scheduled minutes — because these thresholds
 * decide a *pay* category, not punctuality. Someone an hour late on a 7-hour
 * shift is a late arrival, and the report says so in minutes; calling that a
 * "half day" would overstate it. Only a genuinely part-worked day should land
 * in the half-day band, and a barely-there day in the short-day one.
 */
function dayThresholds(shift, window) {
  const s = withShiftDefaults(shift);
  const scheduled = window.scheduledMinutes;
  return {
    minFullDayMinutes: Number.isFinite(s.minFullDayMinutes)
      ? s.minFullDayMinutes
      : Math.round(scheduled * 0.75),
    minHalfDayMinutes: Number.isFinite(s.minHalfDayMinutes)
      ? s.minHalfDayMinutes
      : Math.round(scheduled * 0.4),
  };
}

function isWorkDay(shift, dateKey) {
  const s = withShiftDefaults(shift);
  return (s.workDays || []).includes(weekdayOf(dateKey));
}

/**
 * Which shift-day a punch belongs to. For a normal daytime shift that is just
 * "today". For an overnight shift, a 01:00 punch belongs to the shift that
 * started the previous evening, so the whole night lands on one record.
 */
function shiftDateFor(dateKeyLocal, minutesLocal, shift) {
  const window = shiftWindow(shift);
  if (!window.crossesMidnight) return dateKeyLocal;
  // Still inside the tail of yesterday's shift (plus an hour of slack for a
  // late checkout) -> attribute to yesterday.
  const tailEnd = window.end - 1440 + 60;
  if (minutesLocal < tailEnd) {
    const d = new Date(`${dateKeyLocal}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  return dateKeyLocal;
}

/** Minutes of overlap between two [start,end) intervals. */
function overlapMinutes(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

/**
 * Normalise a punch onto the shift's monotonic axis. A checkout at 00:30 on an
 * overnight shift reads as 1470, not 30.
 */
function onShiftAxis(minutes, window) {
  if (!window.crossesMidnight) return minutes;
  return minutes < window.start - 240 ? minutes + 1440 : minutes;
}

/**
 * Evaluate one attendance day and return every metric the reports need.
 *
 * `excusedWindows` are approved permission slots ({start,end} in local
 * minutes): time the employee was authorised to be away, so it neither counts
 * as lateness nor as a short day.
 */
function evaluateDay(input) {
  const {
    shift,
    checkInMinutes = null,
    checkOutMinutes = null,
    excusedWindows = [],
    isHoliday = false,
    onFullDayLeave = false,
    leaveType = null,
    workDay = true,
    notYetDue = false,
  } = input;

  const s = withShiftDefaults(shift);
  const window = shiftWindow(s);
  const thresholds = dayThresholds(s, window);

  const metrics = {
    scheduledMinutes: window.scheduledMinutes,
    workedMinutes: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    overtimeMinutes: 0,
    excusedMinutes: 0,
    scheduledStart: window.start,
    scheduledEnd: window.end,
  };

  if (checkInMinutes === null) {
    metrics.status = resolveDayStatus({
      isHoliday,
      workDay,
      onFullDayLeave,
      leaveType,
      hasCheckIn: false,
      hasCheckOut: false,
      notYetDue,
      metrics,
      thresholds,
    });
    return metrics;
  }

  const inAt = onShiftAxis(checkInMinutes, window);
  const outAt = checkOutMinutes === null ? null : onShiftAxis(checkOutMinutes, window);

  const excused = (excusedWindows || []).map((w) => ({
    start: onShiftAxis(w.start, window),
    end: onShiftAxis(w.end, window),
  }));

  // Lateness: measured from the scheduled start, but only counted at all once
  // the grace period is exhausted. Arriving 5 minutes late on a 10-minute
  // grace is simply on time; arriving 25 minutes late is 25 minutes late.
  const rawLate = Math.max(0, inAt - window.start);
  const excusedLate = excused.reduce(
    (sum, w) => sum + overlapMinutes(w, { start: window.start, end: inAt }),
    0
  );
  const netLate = Math.max(0, rawLate - excusedLate);
  metrics.lateMinutes = netLate > (s.graceMinutes || 0) ? netLate : 0;

  if (outAt === null) {
    metrics.excusedMinutes = excusedLate;
    applyLeaveDayCredit(metrics, window, onFullDayLeave);
    metrics.status = resolveDayStatus({
      isHoliday,
      workDay,
      onFullDayLeave,
      leaveType,
      hasCheckIn: true,
      hasCheckOut: false,
      metrics,
      thresholds,
    });
    return metrics;
  }

  const rawWorked = Math.max(0, outAt - inAt);
  metrics.workedMinutes = Math.max(0, rawWorked - (s.breakMinutes || 0));

  const rawEarly = Math.max(0, window.end - outAt);
  const excusedEarly = excused.reduce(
    (sum, w) => sum + overlapMinutes(w, { start: outAt, end: window.end }),
    0
  );
  const netEarly = Math.max(0, rawEarly - excusedEarly);
  metrics.earlyLeaveMinutes = netEarly > (s.earlyLeaveGraceMinutes || 0) ? netEarly : 0;

  metrics.excusedMinutes = excusedLate + excusedEarly;

  if (s.countOvertime) {
    const over = Math.max(0, outAt - window.end);
    metrics.overtimeMinutes = over >= (s.overtimeThresholdMinutes || 0) ? over : 0;
  }

  applyLeaveDayCredit(metrics, window, onFullDayLeave);

  metrics.status = resolveDayStatus({
    isHoliday,
    workDay,
    onFullDayLeave,
    leaveType,
    hasCheckIn: true,
    hasCheckOut: true,
    metrics,
    thresholds,
  });

  return metrics;
}

/**
 * Someone who works on a day they had approved leave for.
 *
 * They were not expected in at all, so no part of the day can be held against
 * them: no lateness, no early departure, and the hours they did not work are
 * credited rather than counted as a short day. What they did work still counts
 * — erasing it would cost them hours they actually put in.
 */
function applyLeaveDayCredit(metrics, window, onFullDayLeave) {
  if (!onFullDayLeave) return;
  metrics.lateMinutes = 0;
  metrics.earlyLeaveMinutes = 0;
  metrics.excusedMinutes = Math.max(
    metrics.excusedMinutes,
    Math.max(0, window.scheduledMinutes - metrics.workedMinutes)
  );
}

function resolveDayStatus(ctx) {
  const {
    isHoliday, workDay, onFullDayLeave, hasCheckIn, hasCheckOut, notYetDue, metrics, thresholds = {},
  } = ctx;

  if (isHoliday) return STATUS.HOLIDAY;
  if (!workDay) return STATUS.WEEKEND;
  // Approved leave explains an empty day — but if they turned up and worked
  // anyway, the punches are the truth and the day is evaluated normally.
  if (onFullDayLeave && !hasCheckIn) return STATUS.ON_LEAVE;
  if (!hasCheckIn) return notYetDue ? STATUS.UPCOMING : STATUS.ABSENT;
  if (!hasCheckOut) return STATUS.MISSING_CHECKOUT;

  // Credit excused (approved permission) time towards the day's hours so an
  // authorised absence never reads as a short day.
  const credited = metrics.workedMinutes + metrics.excusedMinutes;
  if (credited < (thresholds.minHalfDayMinutes || 0)) return STATUS.SHORT_DAY;
  if (credited < (thresholds.minFullDayMinutes || 0)) return STATUS.HALF_DAY;
  if (metrics.lateMinutes > 0) return STATUS.LATE;
  return STATUS.PRESENT;
}

/** Statuses that mean "this person owed work today and did not deliver it". */
const ABSENCE_STATUSES = [STATUS.ABSENT];
/** Days still ahead: counted in no rate, held against nobody. */
const PENDING_STATUSES = [STATUS.UPCOMING];

/** Statuses that count as a day the employee was expected at work. */
const EXPECTED_STATUSES = [
  STATUS.ABSENT,
  STATUS.MISSING_CHECKOUT,
  STATUS.SHORT_DAY,
  STATUS.HALF_DAY,
  STATUS.LATE,
  STATUS.PRESENT,
];

module.exports = {
  STATUS,
  DEFAULT_SHIFT,
  withShiftDefaults,
  shiftWindow,
  dayThresholds,
  isWorkDay,
  shiftDateFor,
  evaluateDay,
  resolveDayStatus,
  overlapMinutes,
  applyLeaveDayCredit,
  ABSENCE_STATUSES,
  EXPECTED_STATUSES,
  PENDING_STATUSES,
};
