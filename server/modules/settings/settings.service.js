"use strict";

const { ObjectId } = require("mongodb");

const env = require("../../config/env");
const { collection, COLLECTIONS } = require("../../config/db");
const { ApiError } = require("../../helpers/errors");
const { DEFAULT_SHIFT } = require("../../domain/attendance-rules");
const { DEFAULT_POLICY } = require("../../domain/policy");
const { isValidTimeZone } = require("../../domain/time");

const SETTINGS_ID = "org";

const DEFAULT_SETTINGS = {
  _id: SETTINGS_ID,
  companyName: "weTech",
  timeZone: env.defaultTimeZone,
  geo: { accuracySlackMeters: 75, maxAccuracyMeters: 200 },
  alerts: {
    adminEmails: [],
    noShowAlertTime: "10:30",
    sendNoShowAlert: true,
    sendMonthlyReport: true,
  },
  policy: { ...DEFAULT_POLICY },
};

/** The org settings document, created with sane defaults on first read. */
async function getSettings() {
  const found = await collection(COLLECTIONS.settings).findOne({ _id: SETTINGS_ID });
  if (found) {
    return {
      ...DEFAULT_SETTINGS,
      ...found,
      geo: { ...DEFAULT_SETTINGS.geo, ...(found.geo || {}) },
      alerts: { ...DEFAULT_SETTINGS.alerts, ...(found.alerts || {}) },
      // Merged rather than replaced so a settings document written before a
      // rule existed still answers for it.
      policy: { ...DEFAULT_SETTINGS.policy, ...(found.policy || {}) },
    };
  }
  await collection(COLLECTIONS.settings).updateOne(
    { _id: SETTINGS_ID },
    { $setOnInsert: { ...DEFAULT_SETTINGS, createdAt: new Date() } },
    { upsert: true }
  );
  return { ...DEFAULT_SETTINGS };
}

async function updateSettings(patch) {
  if (patch.timeZone && !isValidTimeZone(patch.timeZone)) {
    throw ApiError.badRequest(`Unknown timezone: ${patch.timeZone}`);
  }
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    geo: { ...current.geo, ...(patch.geo || {}) },
    alerts: { ...current.alerts, ...(patch.alerts || {}) },
    policy: { ...current.policy, ...(patch.policy || {}) },
    updatedAt: new Date(),
  };
  delete next._id;
  await collection(COLLECTIONS.settings).updateOne({ _id: SETTINGS_ID }, { $set: next }, { upsert: true });
  return getSettings();
}

const timeZone = async () => (await getSettings()).timeZone;

/* ── Offices ─────────────────────────────────────────────────────────── */

const listOffices = (filter = {}) =>
  collection(COLLECTIONS.offices).find(filter).sort({ name: 1 }).toArray();

const listActiveOffices = () => listOffices({ active: { $ne: false } });

async function createOffice(data) {
  const doc = { ...data, active: data.active !== false, createdAt: new Date() };
  const { insertedId } = await collection(COLLECTIONS.offices).insertOne(doc);
  return { ...doc, _id: insertedId };
}

async function updateOffice(id, patch) {
  const result = await collection(COLLECTIONS.offices).findOneAndUpdate(
    { _id: toId(id) },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) throw ApiError.notFound("Office not found");
  return result;
}

async function deleteOffice(id) {
  const { deletedCount } = await collection(COLLECTIONS.offices).deleteOne({ _id: toId(id) });
  if (!deletedCount) throw ApiError.notFound("Office not found");
}

/* ── Shifts ──────────────────────────────────────────────────────────── */

const listShifts = () => collection(COLLECTIONS.shifts).find().sort({ name: 1 }).toArray();

async function createShift(data) {
  const doc = { ...DEFAULT_SHIFT, staffType: "any", ...data, createdAt: new Date() };
  if (doc.isDefault) await clearDefaultShift(doc.staffType);
  const { insertedId } = await collection(COLLECTIONS.shifts).insertOne(doc);
  return { ...doc, _id: insertedId };
}

async function updateShift(id, patch) {
  if (patch.isDefault) {
    const existing = await collection(COLLECTIONS.shifts).findOne({ _id: toId(id) });
    await clearDefaultShift(patch.staffType || (existing && existing.staffType) || "any");
  }
  const result = await collection(COLLECTIONS.shifts).findOneAndUpdate(
    { _id: toId(id) },
    { $set: { ...patch, updatedAt: new Date() } },
    { returnDocument: "after" }
  );
  if (!result) throw ApiError.notFound("Shift not found");
  return result;
}

async function deleteShift(id) {
  const inUse = await collection(COLLECTIONS.users).countDocuments({ shiftId: toId(id) });
  if (inUse > 0) {
    throw ApiError.conflict(
      `${inUse} employee${inUse === 1 ? " is" : "s are"} still on this shift. Move them first.`
    );
  }
  const { deletedCount } = await collection(COLLECTIONS.shifts).deleteOne({ _id: toId(id) });
  if (!deletedCount) throw ApiError.notFound("Shift not found");
}

/** One default per staff type: marking an intern shift default leaves the
 *  employee default alone. */
const clearDefaultShift = (staffType = "any") =>
  collection(COLLECTIONS.shifts).updateMany(
    { isDefault: true, staffType: staffType === "any" ? { $in: ["any", null] } : staffType },
    { $set: { isDefault: false } }
  );

/**
 * The shift someone lands on when none is chosen for them.
 *
 * A shift marked for a staff type is the default for that type, which is what
 * puts a new intern on shorter hours without anyone remembering to set it.
 * Falling back through "any" and then the general default means an office
 * that never creates a typed shift behaves exactly as before.
 */
async function getDefaultShift(staffType) {
  const shifts = collection(COLLECTIONS.shifts);

  if (staffType) {
    const typed =
      (await shifts.findOne({ staffType, isDefault: true })) || (await shifts.findOne({ staffType }));
    if (typed) return typed;
  }

  const generalDefault = await shifts.findOne({ isDefault: true });
  return generalDefault || (await shifts.findOne()) || { ...DEFAULT_SHIFT };
}

/**
 * The shift an employee is scheduled on, falling back to the org default so a
 * newly created employee is never left without working hours.
 */
async function getShiftForUser(user) {
  let shift = null;
  if (user && user.shiftId) {
    shift = await collection(COLLECTIONS.shifts).findOne({ _id: toId(user.shiftId) });
  }
  if (!shift) shift = await getDefaultShift(user && user.staffType);
  return applyWorkingHours(shift, user);
}

/**
 * An employee's own hours, if an admin has set them, layered over the shift.
 *
 * Kept as a thin override rather than a private shift per person: everyone on
 * "Standard" still moves together when the standard changes, and only the
 * fields actually customised differ.
 */
function applyWorkingHours(shift, user) {
  const custom = user && user.workingHours;
  if (!custom) return shift;

  const overrides = {};
  for (const key of ["startTime", "endTime", "workDays", "graceMinutes", "breakMinutes"]) {
    if (custom[key] !== undefined && custom[key] !== null) overrides[key] = custom[key];
  }
  if (Object.keys(overrides).length === 0) return shift;

  return { ...shift, ...overrides, name: `${shift.name || "Default"} (adjusted)`, customised: true };
}

/** Shifts for many users at once, keyed by user id — avoids N+1 in reports. */
async function getShiftMap(users) {
  const ids = [...new Set(users.filter((u) => u.shiftId).map((u) => String(u.shiftId)))];
  const shifts = ids.length
    ? await collection(COLLECTIONS.shifts).find({ _id: { $in: ids.map(toId) } }).toArray()
    : [];
  const byId = new Map(shifts.map((s) => [String(s._id), s]));

  // One lookup per staff type present, rather than one per user.
  const fallbacks = new Map();
  for (const staffType of new Set(users.map((user) => user.staffType || "employee"))) {
    fallbacks.set(staffType, await getDefaultShift(staffType));
  }

  const map = new Map();
  for (const user of users) {
    const base = byId.get(String(user.shiftId)) || fallbacks.get(user.staffType || "employee");
    map.set(String(user._id), applyWorkingHours(base, user));
  }
  return map;
}

/* ── Holidays ────────────────────────────────────────────────────────── */

const listHolidays = (from, to) =>
  collection(COLLECTIONS.holidays)
    .find(from && to ? { date: { $gte: from, $lte: to } } : {})
    .sort({ date: 1 })
    .toArray();

async function createHoliday(data) {
  const existing = await collection(COLLECTIONS.holidays).findOne({ date: data.date });
  if (existing) throw ApiError.conflict(`${data.date} is already marked as "${existing.name}"`);
  const doc = { ...data, createdAt: new Date() };
  const { insertedId } = await collection(COLLECTIONS.holidays).insertOne(doc);
  return { ...doc, _id: insertedId };
}

async function deleteHoliday(id) {
  const { deletedCount } = await collection(COLLECTIONS.holidays).deleteOne({ _id: toId(id) });
  if (!deletedCount) throw ApiError.notFound("Holiday not found");
}

/** Set of holiday date keys in a range, for fast lookup while building reports. */
async function holidaySet(from, to) {
  const rows = await listHolidays(from, to);
  return new Map(rows.map((h) => [h.date, h.name]));
}

function toId(id) {
  if (id instanceof ObjectId) return id;
  if (!ObjectId.isValid(id)) throw ApiError.badRequest(`Invalid id: ${id}`);
  return new ObjectId(id);
}

module.exports = {
  SETTINGS_ID,
  DEFAULT_SETTINGS,
  getSettings,
  updateSettings,
  timeZone,
  listOffices,
  listActiveOffices,
  createOffice,
  updateOffice,
  deleteOffice,
  listShifts,
  createShift,
  updateShift,
  deleteShift,
  getDefaultShift,
  getShiftForUser,
  applyWorkingHours,
  getShiftMap,
  listHolidays,
  createHoliday,
  deleteHoliday,
  holidaySet,
  toId,
};
