"use strict";

const { ObjectId } = require("mongodb");

const env = require("../../config/env");
const { collection, COLLECTIONS } = require("../../config/db");
const { ApiError } = require("../../helpers/errors");
const { DEFAULT_SHIFT } = require("../../domain/attendance-rules");
const { isValidTimeZone } = require("../../domain/time");

const SETTINGS_ID = "org";

const DEFAULT_SETTINGS = {
  _id: SETTINGS_ID,
  companyName: "My Office",
  timeZone: env.defaultTimeZone,
  geo: { accuracySlackMeters: 75, maxAccuracyMeters: 200 },
  alerts: {
    adminEmails: [],
    noShowAlertTime: "10:30",
    sendNoShowAlert: true,
    sendMonthlyReport: true,
  },
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
  const doc = { ...DEFAULT_SHIFT, ...data, createdAt: new Date() };
  if (doc.isDefault) await clearDefaultShift();
  const { insertedId } = await collection(COLLECTIONS.shifts).insertOne(doc);
  return { ...doc, _id: insertedId };
}

async function updateShift(id, patch) {
  if (patch.isDefault) await clearDefaultShift();
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

const clearDefaultShift = () =>
  collection(COLLECTIONS.shifts).updateMany({ isDefault: true }, { $set: { isDefault: false } });

async function getDefaultShift() {
  const found = await collection(COLLECTIONS.shifts).findOne({ isDefault: true });
  return found || (await collection(COLLECTIONS.shifts).findOne()) || { ...DEFAULT_SHIFT };
}

/**
 * The shift an employee is scheduled on, falling back to the org default so a
 * newly created employee is never left without working hours.
 */
async function getShiftForUser(user) {
  if (user && user.shiftId) {
    const shift = await collection(COLLECTIONS.shifts).findOne({ _id: toId(user.shiftId) });
    if (shift) return shift;
  }
  return getDefaultShift();
}

/** Shifts for many users at once, keyed by user id — avoids N+1 in reports. */
async function getShiftMap(users) {
  const ids = [...new Set(users.filter((u) => u.shiftId).map((u) => String(u.shiftId)))];
  const shifts = ids.length
    ? await collection(COLLECTIONS.shifts).find({ _id: { $in: ids.map(toId) } }).toArray()
    : [];
  const byId = new Map(shifts.map((s) => [String(s._id), s]));
  const fallback = await getDefaultShift();

  const map = new Map();
  for (const user of users) {
    map.set(String(user._id), byId.get(String(user.shiftId)) || fallback);
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
  getShiftMap,
  listHolidays,
  createHoliday,
  deleteHoliday,
  holidaySet,
  toId,
};
