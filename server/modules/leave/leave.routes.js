"use strict";

const express = require("express");

const { asyncHandler } = require("../../helpers/errors");
const { validate } = require("../../helpers/validate");
const schemas = require("../../helpers/schemas");
const { requireAuth, requireAdmin, audit } = require("../../helpers/auth");
const service = require("./leave.service");
const { decorateLeaves } = require("../dashboard/dashboard.service");
const attendanceService = require("../attendance/attendance.service");
const { eachDate, dateKey } = require("../../domain/time");
const settingsService = require("../settings/settings.service");
const { collection, COLLECTIONS } = require("../../config/db");

const router = express.Router();

router.use(requireAuth);

router.post(
  "/",
  validate(schemas.leaveCreate),
  asyncHandler(async (req, res) => {
    const leave = await service.createRequest(req.user, req.body);
    res.status(201).json({ leave });
  })
);

router.get(
  "/me",
  asyncHandler(async (req, res) => {
    const timeZone = await settingsService.timeZone();
    res.json({
      leaves: await service.list({ userId: req.user._id }),
      permissionAllowance: await service.permissionAllowance(
        req.user._id,
        dateKey(new Date(), timeZone)
      ),
    });
  })
);

router.delete(
  "/:id",
  validate(schemas.idParam, "params"),
  asyncHandler(async (req, res) => {
    res.json({ leave: await service.cancelOwn(req.params.id, req.user) });
  })
);

/* ── Admin ───────────────────────────────────────────────────────────── */

router.get(
  "/",
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status, type, from, to, userId } = req.query;
    const leaves = await service.list({ status, type, from, to, userId });
    res.json({ leaves: await decorateLeaves(leaves) });
  })
);

router.patch(
  "/:id/decision",
  requireAdmin,
  validate(schemas.idParam, "params"),
  validate(schemas.leaveDecision),
  asyncHandler(async (req, res) => {
    const leave = await service.decide(req.params.id, req.user, req.body.status, req.body.note);
    await audit(req, `leave.${req.body.status}`, "leave", leave._id, { note: req.body.note || null });

    // An approval can change days that already have attendance records (a late
    // arrival that is now excused), so replay the affected days.
    if (req.body.status === service.LEAVE_STATUS.APPROVED) {
      await recalculateAffectedDays(leave);
    }
    res.json({ leave });
  })
);

async function recalculateAffectedDays(leave) {
  const dates = eachDate(leave.fromDate, leave.toDate);
  const records = await collection(COLLECTIONS.attendance)
    .find({ userId: leave.userId, date: { $in: dates } })
    .project({ _id: 1 })
    .toArray();
  for (const record of records) {
    await attendanceService.recalculate(record._id);
  }
}

module.exports = router;
