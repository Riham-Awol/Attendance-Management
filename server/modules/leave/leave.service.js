"use strict";

const { collection, COLLECTIONS } = require("../../config/db");
const { ApiError } = require("../../helpers/errors");
const { eachDate, parseClock } = require("../../domain/time");
const { toId } = require("../settings/settings.service");

const LEAVE_TYPES = ["annual", "sick", "unpaid", "permission", "remote"];
const LEAVE_STATUS = { PENDING: "pending", APPROVED: "approved", REJECTED: "rejected", CANCELLED: "cancelled" };

/** A "permission" is an hours-long absence within one day; everything else is whole days. */
const isPartial = (leave) => leave.scope === "partial";

async function createRequest(user, input) {
  if (input.toDate < input.fromDate) {
    throw ApiError.badRequest("The end date cannot be before the start date");
  }
  if (isPartial(input)) {
    if (input.fromDate !== input.toDate) {
      throw ApiError.badRequest("An hourly permission must start and end on the same day");
    }
    if (parseClock(input.toTime) <= parseClock(input.fromTime)) {
      throw ApiError.badRequest("The end time must be after the start time");
    }
  }

  await assertNoOverlap(user._id, input);

  const doc = {
    userId: user._id,
    type: input.type,
    scope: input.scope,
    fromDate: input.fromDate,
    toDate: input.toDate,
    fromTime: isPartial(input) ? input.fromTime : null,
    toTime: isPartial(input) ? input.toTime : null,
    reason: input.reason,
    status: LEAVE_STATUS.PENDING,
    createdAt: new Date(),
  };
  const { insertedId } = await collection(COLLECTIONS.leaves).insertOne(doc);
  return { ...doc, _id: insertedId };
}

/**
 * Reject a request that overlaps one already pending or approved. Without this
 * an employee could stack three approvals over the same day and no report
 * would ever add up.
 */
async function assertNoOverlap(userId, input) {
  const clashes = await collection(COLLECTIONS.leaves)
    .find({
      userId: toId(userId),
      status: { $in: [LEAVE_STATUS.PENDING, LEAVE_STATUS.APPROVED] },
      fromDate: { $lte: input.toDate },
      toDate: { $gte: input.fromDate },
    })
    .toArray();

  if (clashes.length === 0) return;

  // Two partial permissions on the same day are fine as long as the hours
  // themselves don't collide.
  if (isPartial(input)) {
    const start = parseClock(input.fromTime);
    const end = parseClock(input.toTime);
    const realClash = clashes.find((c) => {
      if (!isPartial(c)) return true;
      return start < parseClock(c.toTime) && end > parseClock(c.fromTime);
    });
    if (!realClash) return;
  }

  throw ApiError.conflict("You already have a request covering those dates");
}

async function decide(leaveId, admin, status, note) {
  const leave = await collection(COLLECTIONS.leaves).findOne({ _id: toId(leaveId) });
  if (!leave) throw ApiError.notFound("Request not found");
  if (leave.status !== LEAVE_STATUS.PENDING) {
    throw ApiError.conflict(`This request was already ${leave.status}`);
  }

  const updated = await collection(COLLECTIONS.leaves).findOneAndUpdate(
    { _id: leave._id, status: LEAVE_STATUS.PENDING },
    {
      $set: {
        status,
        decisionNote: note || null,
        decidedBy: admin._id,
        decidedByName: admin.name,
        decidedAt: new Date(),
      },
    },
    { returnDocument: "after" }
  );
  if (!updated) throw ApiError.conflict("This request was just decided by someone else");
  return updated;
}

async function cancelOwn(leaveId, user) {
  const leave = await collection(COLLECTIONS.leaves).findOne({ _id: toId(leaveId) });
  if (!leave) throw ApiError.notFound("Request not found");
  if (String(leave.userId) !== String(user._id)) throw ApiError.forbidden();
  if (leave.status !== LEAVE_STATUS.PENDING) {
    throw ApiError.conflict("Only a pending request can be withdrawn");
  }
  await collection(COLLECTIONS.leaves).updateOne(
    { _id: leave._id },
    { $set: { status: LEAVE_STATUS.CANCELLED, cancelledAt: new Date() } }
  );
  return { ...leave, status: LEAVE_STATUS.CANCELLED };
}

function buildQuery({ userId, status, type, from, to }) {
  const query = {};
  if (userId) query.userId = toId(userId);
  if (status) query.status = status;
  if (type) query.type = type;
  if (from) query.toDate = { $gte: from };
  if (to) query.fromDate = { ...(query.fromDate || {}), $lte: to };
  return query;
}

const list = (filters, { limit = 200, skip = 0 } = {}) =>
  collection(COLLECTIONS.leaves)
    .find(buildQuery(filters))
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

const count = (filters) => collection(COLLECTIONS.leaves).countDocuments(buildQuery(filters));

/**
 * Approved leave for a set of employees over a date range, indexed for the
 * report builder as: userId -> dateKey -> { fullDay, windows }.
 *
 * `windows` are minute offsets from local midnight, which is exactly what
 * `evaluateDay` wants for excusing lateness.
 */
async function approvedLeaveIndex(userIds, from, to) {
  const rows = await collection(COLLECTIONS.leaves)
    .find({
      userId: { $in: userIds.map(toId) },
      status: LEAVE_STATUS.APPROVED,
      fromDate: { $lte: to },
      toDate: { $gte: from },
    })
    .toArray();

  const index = new Map();
  for (const leave of rows) {
    const byDate = index.get(String(leave.userId)) || new Map();
    for (const date of eachDate(leave.fromDate, leave.toDate)) {
      if (date < from || date > to) continue;
      const entry = byDate.get(date) || { fullDay: null, windows: [] };
      if (isPartial(leave)) {
        entry.windows.push({
          start: parseClock(leave.fromTime),
          end: parseClock(leave.toTime),
          type: leave.type,
        });
      } else {
        entry.fullDay = leave;
      }
      byDate.set(date, entry);
    }
    index.set(String(leave.userId), byDate);
  }
  return index;
}

/** The same lookup for a single employee on a single day. */
async function approvedLeaveForDay(userId, date) {
  const index = await approvedLeaveIndex([userId], date, date);
  return (index.get(String(userId)) || new Map()).get(date) || { fullDay: null, windows: [] };
}

module.exports = {
  LEAVE_TYPES,
  LEAVE_STATUS,
  createRequest,
  decide,
  cancelOwn,
  list,
  count,
  approvedLeaveIndex,
  approvedLeaveForDay,
  isPartial,
};
