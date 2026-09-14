"use strict";

/**
 * All attendance is reckoned in the office's own timezone, never the server's.
 * A server in UTC and an office in Africa/Addis_Ababa must agree on which
 * calendar day a 08:55 check-in belongs to, so every date/time conversion in
 * the app goes through this module.
 */

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const partsFormatterCache = new Map();

function formatterFor(timeZone) {
  let fmt = partsFormatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsFormatterCache.set(timeZone, fmt);
  }
  return fmt;
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Break an instant into calendar parts as seen in `timeZone`. */
function zonedParts(date, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  // Intl renders midnight as "24" in some ICU versions; normalise it to 0.
  const hour = Number(get("hour")) % 24;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: WEEKDAY_INDEX[get("weekday")],
  };
}

/** "YYYY-MM-DD" for the given instant, in the office timezone. */
function dateKey(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Minutes elapsed since local midnight, in the office timezone. */
function minutesOfDay(date, timeZone) {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

function isDateKey(value) {
  return typeof value === "string" && DATE_KEY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isClockTime(value) {
  return typeof value === "string" && HHMM.test(value);
}

/** "09:30" -> 570 */
function parseClock(value) {
  if (!isClockTime(value)) throw new Error(`Invalid time of day: ${value}`);
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}

/** 570 -> "09:30"; minutes past 24h wrap so overnight shifts render sanely. */
function formatClock(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** 135 -> "2h 15m" */
function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Day of week for a date key, 0 = Sunday. Timezone-free by construction. */
function weekdayOf(key) {
  if (!isDateKey(key)) throw new Error(`Invalid date key: ${key}`);
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}

function addDays(key, days) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Inclusive list of date keys from `from` to `to`. */
function eachDate(from, to) {
  if (!isDateKey(from) || !isDateKey(to)) throw new Error("Invalid range");
  const out = [];
  let cursor = from;
  // Guard against a reversed or absurd range rather than looping forever.
  for (let i = 0; cursor <= to && i < 3660; i += 1) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** First and last date key of the month containing `key`. */
function monthRange(key) {
  const [y, m] = key.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${key.slice(0, 7)}-01`, to: `${key.slice(0, 7)}-${String(last).padStart(2, "0")}` };
}

/**
 * The instant at which `minutes` past local midnight occurs on `key` in
 * `timeZone`. Used to turn a scheduled "17:00" into a real timestamp for
 * auto-checkout and overtime maths.
 *
 * We guess from UTC then correct by the zone's actual offset at that guess.
 * One correction pass is enough for every real timezone; a second pass settles
 * the rare case where the first guess lands on the other side of a DST jump.
 */
function zonedTimeToInstant(key, minutes, timeZone) {
  const base = Date.parse(`${key}T00:00:00Z`) + minutes * 60000;
  let instant = new Date(base);
  for (let i = 0; i < 2; i += 1) {
    const offset = zonedOffsetMs(instant, timeZone);
    const corrected = new Date(base - offset);
    if (corrected.getTime() === instant.getTime()) break;
    instant = corrected;
  }
  return instant;
}

/** Milliseconds that `timeZone` is ahead of UTC at the given instant. */
function zonedOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Compare against the instant truncated to the second to avoid a spurious
  // sub-second offset.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function isValidTimeZone(tz) {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  zonedParts,
  dateKey,
  minutesOfDay,
  isDateKey,
  isClockTime,
  parseClock,
  formatClock,
  formatDuration,
  weekdayOf,
  addDays,
  eachDate,
  monthRange,
  zonedTimeToInstant,
  zonedOffsetMs,
  isValidTimeZone,
};
