"use strict";

const { collection, COLLECTIONS } = require("../../config/db");
const { ApiError } = require("../../helpers/errors");
const geo = require("../../domain/geo");
const {
  dateKey,
  minutesOfDay,
  eachDate,
  zonedTimeToInstant,
  formatClock,
} = require("../../domain/time");
const {
  STATUS,
  evaluateDay,
  isWorkDay,
  shiftDateFor,
  shiftWindow,
} = require("../../domain/attendance-rules");
const settingsService = require("../settings/settings.service");
const leaveService = require("../leave/leave.service");

const { toId } = settingsService;

const GEO_MESSAGES = {
  invalid_coordinates: "We couldn't read your location. Turn on GPS and try again.",
  poor_accuracy:
    "Your location is too imprecise to confirm you're at the office. Step outside or near a window and try again.",
  no_offices_configured: "No office location has been set up yet. Ask your admin to add one.",
  outside_geofence: "You're not at the office yet.",
};

/** Everything about "now" that a punch needs, resolved in the office timezone. */
async function punchContext(user, at = new Date()) {
  const settings = await settingsService.getSettings();
  const shift = await settingsService.getShiftForUser(user);
  const timeZone = settings.timeZone;
  const localDate = dateKey(at, timeZone);
  const localMinutes = minutesOfDay(at, timeZone);
  const date = shiftDateFor(localDate, localMinutes, shift);
  return { settings, shift, timeZone, at, date, localMinutes };
}

/**
 * Confirm the punch is inside an office geofence, turning a failure into a
 * message the employee can act on ("you're 240 m away") rather than a bare 403.
 */
async function assertAtOffice(point, settings) {
  const offices = await settingsService.listActiveOffices();
  const result = geo.resolveOffice(point, offices, settings.geo);
  if (result.ok) return result;

  const detail =
    result.reason === "outside_geofence"
      ? `${GEO_MESSAGES.outside_geofence} You're about ${result.distance} m from ${result.nearestOffice.name}, and check-in is allowed within ${result.allowedRadius} m.`
      : GEO_MESSAGES[result.reason] || "We couldn't verify your location.";

  throw new ApiError(422, `geo_${result.reason}`, detail, {
    reason: result.reason,
    distance: result.distance,
    allowedRadius: result.allowedRadius,
    nearestOffice: result.nearestOffice ? result.nearestOffice.name : null,
  });
}

const punchPayload = (point, req, extra = {}) => ({
  lat: point.lat,
  lng: point.lng,
  accuracy: Math.round(point.accuracy || 0),
  ip: req.ip,
  userAgent: (req.headers["user-agent"] || "").slice(0, 200),
  ...extra,
});

async function checkIn(user, point, req) {
  const ctx = await punchContext(user);
  const existing = await findRecord(user._id, ctx.date);
  if (existing && existing.checkIn) {
    throw ApiError.conflict(
      `You already checked in today at ${formatClock(existing.checkIn.minutes)}.`
    );
  }

  const located = await assertAtOffice(point, ctx.settings);
  const leave = await leaveService.approvedLeaveForDay(user._id, ctx.date);
  const holidays = await settingsService.holidaySet(ctx.date, ctx.date);

  const base = {
    userId: user._id,
    date: ctx.date,
    timeZone: ctx.timeZone,
    shiftId: ctx.shift._id || null,
    shiftName: ctx.shift.name || "Default",
    checkIn: punchPayload(point, req, {
      at: ctx.at,
      minutes: ctx.localMinutes,
      officeId: located.office._id,
      officeName: located.office.name,
      distance: located.distance,
    }),
    checkOut: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const metrics = evaluateDay({
    shift: ctx.shift,
    checkInMinutes: ctx.localMinutes,
    checkOutMinutes: null,
    excusedWindows: leave.windows,
    isHoliday: holidays.has(ctx.date),
    onFullDayLeave: !!leave.fullDay,
    workDay: isWorkDay(ctx.shift, ctx.date),
  });

  const doc = { ...base, ...metrics };

  try {
    const { insertedId } = await collection(COLLECTIONS.attendance).insertOne(doc);
    return { record: { ...doc, _id: insertedId }, office: located.office, distance: located.distance };
  } catch (err) {
    // The unique (userId, date) index is the real guard against a double tap.
    if (err.code === 11000) throw ApiError.conflict("You already checked in today.");
    throw err;
  }
}

async function checkOut(user, point, req) {
  const ctx = await punchContext(user);
  const record = await findRecord(user._id, ctx.date);
  if (!record || !record.checkIn) {
    throw ApiError.conflict("You haven't checked in yet today.");
  }
  if (record.checkOut) {
    throw ApiError.conflict(`You already checked out at ${formatClock(record.checkOut.minutes)}.`);
  }

  const located = await assertAtOffice(point, ctx.settings);
  const leave = await leaveService.approvedLeaveForDay(user._id, ctx.date);
  const holidays = await settingsService.holidaySet(ctx.date, ctx.date);

  const metrics = evaluateDay({
    shift: ctx.shift,
    checkInMinutes: record.checkIn.minutes,
    checkOutMinutes: ctx.localMinutes,
    excusedWindows: leave.windows,
    isHoliday: holidays.has(ctx.date),
    onFullDayLeave: !!leave.fullDay,
    workDay: isWorkDay(ctx.shift, ctx.date),
  });

  const checkOutPunch = punchPayload(point, req, {
    at: ctx.at,
    minutes: ctx.localMinutes,
    officeId: located.office._id,
    officeName: located.office.name,
    distance: located.distance,
  });

  const updated = await collection(COLLECTIONS.attendance).findOneAndUpdate(
    { _id: record._id, checkOut: null },
    { $set: { checkOut: checkOutPunch, ...metrics, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!updated) throw ApiError.conflict("You already checked out.");
  return { record: updated, office: located.office, distance: located.distance };
}

const findRecord = (userId, date) =>
  collection(COLLECTIONS.attendance).findOne({ userId: toId(userId), date });

const findRecordById = (id) => collection(COLLECTIONS.attendance).findOne({ _id: toId(id) });

/** What the employee's home screen shows: today's punches and what's next. */
async function todayFor(user) {
  const ctx = await punchContext(user);
  const record = await findRecord(user._id, ctx.date);
  const leave = await leaveService.approvedLeaveForDay(user._id, ctx.date);
  const holidays = await settingsService.holidaySet(ctx.date, ctx.date);
  const window = shiftWindow(ctx.shift);

  return {
    date: ctx.date,
    timeZone: ctx.timeZone,
    nowMinutes: ctx.localMinutes,
    shift: {
      name: ctx.shift.name || "Default",
      startTime: formatClock(window.start),
      endTime: formatClock(window.end),
      graceMinutes: ctx.shift.graceMinutes ?? 0,
      workDay: isWorkDay(ctx.shift, ctx.date),
    },
    isHoliday: holidays.has(ctx.date),
    holidayName: holidays.get(ctx.date) || null,
    onLeave: !!leave.fullDay,
    leaveType: leave.fullDay ? leave.fullDay.type : null,
    permissions: leave.windows.map((w) => ({
      from: formatClock(w.start),
      to: formatClock(w.end),
      type: w.type,
    })),
    canCheckIn: !record || !record.checkIn,
    canCheckOut: !!(record && record.checkIn && !record.checkOut),
    record: record || null,
  };
}

/**
 * Build one evaluated row per employee per day in the range — including days
 * with no attendance record at all, which is how absences come into being.
 * Reports, exports and the dashboard all read from this one function so they
 * can never drift apart.
 */
async function buildDays({ users, from, to, now = new Date() }) {
  if (users.length === 0) return [];

  const userIds = users.map((u) => u._id);
  const [records, shiftMap, leaveIndex, holidays] = await Promise.all([
    collection(COLLECTIONS.attendance)
      .find({ userId: { $in: userIds.map(toId) }, date: { $gte: from, $lte: to } })
      .toArray(),
    settingsService.getShiftMap(users),
    leaveService.approvedLeaveIndex(userIds, from, to),
    settingsService.holidaySet(from, to),
  ]);

  const recordIndex = new Map();
  for (const rec of records) {
    recordIndex.set(`${String(rec.userId)}|${rec.date}`, rec);
  }

  const dates = eachDate(from, to);
  const rows = [];

  // `now` is a parameter rather than a read of the clock so a caller that was
  // handed an instant — a cron tick, a test — cannot end up disagreeing with
  // this function about what day it is.
  const timeZone = await settingsService.timeZone();
  const today = dateKey(now, timeZone);
  const nowMinutes = minutesOfDay(now, timeZone);

  for (const user of users) {
    const uid = String(user._id);
    const shift = shiftMap.get(uid);
    const startDue = shiftWindow(shift).start + (shift.graceMinutes || 0);
    const userLeave = leaveIndex.get(uid) || new Map();
    const days = [];

    for (const date of dates) {
      const record = recordIndex.get(`${uid}|${date}`);
      const leave = userLeave.get(date) || { fullDay: null, windows: [] };
      const metrics = evaluateDay({
        shift,
        checkInMinutes: record && record.checkIn ? record.checkIn.minutes : null,
        checkOutMinutes: record && record.checkOut ? record.checkOut.minutes : null,
        excusedWindows: leave.windows,
        isHoliday: holidays.has(date),
        onFullDayLeave: !!leave.fullDay,
        workDay: isWorkDay(shift, date),
        // Tomorrow has not happened, and this morning's grace period may not
        // have run out yet — neither is an absence.
        notYetDue: date > today || (date === today && nowMinutes < startDue),
      });

      days.push({
        date,
        ...metrics,
        leaveType: leave.fullDay ? leave.fullDay.type : null,
        holidayName: holidays.get(date) || null,
        checkInAt: record && record.checkIn ? record.checkIn.at : null,
        checkOutAt: record && record.checkOut ? record.checkOut.at : null,
        checkInTime: record && record.checkIn ? formatClock(record.checkIn.minutes) : null,
        checkOutTime: record && record.checkOut ? formatClock(record.checkOut.minutes) : null,
        officeName: record && record.checkIn ? record.checkIn.officeName : null,
        autoCheckout: !!(record && record.autoCheckout),
        edited: !!(record && record.manual),
        recordId: record ? record._id : null,
      });
    }

    rows.push({ employee: user, shift, days });
  }

  return rows;
}

/**
 * Recompute a stored record from its punches. Called after an admin edits a
 * time or a leave request is approved retroactively, so the derived numbers
 * never disagree with the raw punches.
 */
async function recalculate(recordId) {
  const record = await collection(COLLECTIONS.attendance).findOne({ _id: toId(recordId) });
  if (!record) throw ApiError.notFound("Attendance record not found");

  const user = await collection(COLLECTIONS.users).findOne({ _id: record.userId });
  const shift = await settingsService.getShiftForUser(user);
  const leave = await leaveService.approvedLeaveForDay(record.userId, record.date);
  const holidays = await settingsService.holidaySet(record.date, record.date);

  const metrics = evaluateDay({
    shift,
    checkInMinutes: record.checkIn ? record.checkIn.minutes : null,
    checkOutMinutes: record.checkOut ? record.checkOut.minutes : null,
    excusedWindows: leave.windows,
    isHoliday: holidays.has(record.date),
    onFullDayLeave: !!leave.fullDay,
    workDay: isWorkDay(shift, record.date),
  });

  const updated = await collection(COLLECTIONS.attendance).findOneAndUpdate(
    { _id: record._id },
    { $set: { ...metrics, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  return updated;
}

/**
 * Admin correction of a punch. Times arrive as "HH:MM" in the office timezone
 * and are stored as both a real instant and a minute offset, matching what a
 * genuine punch writes.
 */
async function adminSetTimes(recordId, { checkInTime, checkOutTime, note }, admin) {
  const record = await collection(COLLECTIONS.attendance).findOne({ _id: toId(recordId) });
  if (!record) throw ApiError.notFound("Attendance record not found");

  const timeZone = record.timeZone || (await settingsService.timeZone());
  const patch = { manual: { by: admin._id, byName: admin.name, at: new Date(), note: note || null } };

  if (checkInTime !== undefined) {
    patch.checkIn = checkInTime === null ? null : buildManualPunch(record.checkIn, checkInTime, record.date, timeZone);
  }
  if (checkOutTime !== undefined) {
    patch.checkOut = checkOutTime === null ? null : buildManualPunch(record.checkOut, checkOutTime, record.date, timeZone);
  }

  await collection(COLLECTIONS.attendance).updateOne({ _id: record._id }, { $set: patch });
  return recalculate(record._id);
}

function buildManualPunch(existing, clock, date, timeZone) {
  const [h, m] = clock.split(":").map(Number);
  const minutes = h * 60 + m;
  return {
    ...(existing || {}),
    at: zonedTimeToInstant(date, minutes, timeZone),
    minutes,
    manual: true,
  };
}

/** Admin-created record for someone who genuinely worked but couldn't punch. */
async function adminCreateRecord({ userId, date, checkInTime, checkOutTime, note }, admin) {
  const user = await collection(COLLECTIONS.users).findOne({ _id: toId(userId) });
  if (!user) throw ApiError.notFound("Employee not found");

  const existing = await findRecord(userId, date);
  if (existing) throw ApiError.conflict(`${user.name} already has a record for ${date}`);

  const shift = await settingsService.getShiftForUser(user);
  const timeZone = await settingsService.timeZone();

  const doc = {
    userId: user._id,
    date,
    timeZone,
    shiftId: shift._id || null,
    shiftName: shift.name || "Default",
    checkIn: checkInTime ? buildManualPunch(null, checkInTime, date, timeZone) : null,
    checkOut: checkOutTime ? buildManualPunch(null, checkOutTime, date, timeZone) : null,
    manual: { by: admin._id, byName: admin.name, at: new Date(), note: note || null },
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const { insertedId } = await collection(COLLECTIONS.attendance).insertOne(doc);
    return recalculate(insertedId);
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict(`${user.name} already has a record for ${date}`);
    throw err;
  }
}

/** Raw record listing for the admin records screen. */
async function listRecords({ from, to, userId, status }, { limit = 500 } = {}) {
  const query = { date: { $gte: from, $lte: to } };
  if (userId) query.userId = toId(userId);
  if (status) query.status = status;
  return collection(COLLECTIONS.attendance)
    .find(query)
    .sort({ date: -1, "checkIn.minutes": 1 })
    .limit(limit)
    .toArray();
}

module.exports = {
  STATUS,
  punchContext,
  checkIn,
  checkOut,
  todayFor,
  findRecord,
  findRecordById,
  buildDays,
  recalculate,
  adminSetTimes,
  adminCreateRecord,
  listRecords,
  assertAtOffice,
};
