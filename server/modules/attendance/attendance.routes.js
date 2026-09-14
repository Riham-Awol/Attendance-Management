"use strict";

const express = require("express");
const rateLimit = require("express-rate-limit");

const { asyncHandler, ApiError } = require("../../helpers/errors");
const { validate } = require("../../helpers/validate");
const schemas = require("../../helpers/schemas");
const { requireAuth, requireAdmin, audit, assertCanAccessUser } = require("../../helpers/auth");
const service = require("./attendance.service");
const employeesService = require("../employees/employees.service");
const { dateKey, addDays, monthRange } = require("../../domain/time");
const settingsService = require("../settings/settings.service");
const { summarizeDays } = require("../../domain/reports");

const router = express.Router();

// A punch is cheap but a stuck retry loop on a phone is not.
const punchLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });

router.use(requireAuth);

router.post(
  "/check-in",
  punchLimiter,
  validate(schemas.coordinates),
  asyncHandler(async (req, res) => {
    const result = await service.checkIn(req.user, req.body, req);
    res.status(201).json({
      ok: true,
      message: `Checked in at ${result.office.name}`,
      record: result.record,
      distance: result.distance,
    });
  })
);

router.post(
  "/check-out",
  punchLimiter,
  validate(schemas.coordinates),
  asyncHandler(async (req, res) => {
    const result = await service.checkOut(req.user, req.body, req);
    res.json({
      ok: true,
      message: `Checked out from ${result.office.name}`,
      record: result.record,
      distance: result.distance,
    });
  })
);

router.get(
  "/today",
  asyncHandler(async (req, res) => {
    res.json(await service.todayFor(req.user));
  })
);

/** An employee's own history, defaulting to the current month. */
router.get(
  "/me",
  validate(schemas.optionalRangeQuery, "query"),
  asyncHandler(async (req, res) => {
    const timeZone = await settingsService.timeZone();
    const today = dateKey(new Date(), timeZone);
    const month = monthRange(today);
    const from = req.validatedQuery.from || month.from;
    const to = req.validatedQuery.to || month.to;

    const [row] = await service.buildDays({ users: [req.user], from, to });
    const days = row ? row.days : [];
    res.json({ range: { from, to }, days, summary: summarizeDays(days) });
  })
);

router.get(
  "/employee/:id",
  validate(schemas.idParam, "params"),
  validate(schemas.optionalRangeQuery, "query"),
  asyncHandler(async (req, res) => {
    assertCanAccessUser(req, req.params.id);
    const user = await employeesService.getById(req.params.id);
    const timeZone = await settingsService.timeZone();
    const today = dateKey(new Date(), timeZone);
    const from = req.validatedQuery.from || addDays(today, -30);
    const to = req.validatedQuery.to || today;

    const [row] = await service.buildDays({ users: [user], from, to });
    const days = row ? row.days : [];
    res.json({
      employee: employeesService.publicUser(user),
      range: { from, to },
      days,
      summary: summarizeDays(days),
    });
  })
);

/* ── Admin corrections ───────────────────────────────────────────────── */

router.get(
  "/records",
  requireAdmin,
  validate(schemas.rangeQuery, "query"),
  asyncHandler(async (req, res) => {
    const { from, to, userId, status } = req.validatedQuery;
    const records = await service.listRecords({ from, to, userId, status });
    const users = await employeesService.list({});
    const byId = new Map(users.map((u) => [String(u._id), u]));
    res.json({
      records: records.map((r) => ({
        ...r,
        employee: byId.get(String(r.userId)) || { name: "Unknown" },
      })),
    });
  })
);

router.post(
  "/records",
  requireAdmin,
  validate(schemas.attendanceCreate),
  asyncHandler(async (req, res) => {
    if (!req.body.checkInTime && !req.body.checkOutTime) {
      throw ApiError.badRequest("Give at least a check-in or a check-out time");
    }
    const record = await service.adminCreateRecord(req.body, req.user);
    await audit(req, "attendance.create", "attendance", record._id, req.body);
    res.status(201).json({ record });
  })
);

router.patch(
  "/records/:id",
  requireAdmin,
  validate(schemas.idParam, "params"),
  validate(schemas.attendanceEdit),
  asyncHandler(async (req, res) => {
    const before = await service.findRecordById(req.params.id);
    const record = await service.adminSetTimes(req.params.id, req.body, req.user);
    await audit(req, "attendance.edit", "attendance", record._id, {
      before: { checkIn: before?.checkIn?.minutes ?? null, checkOut: before?.checkOut?.minutes ?? null },
      after: { checkIn: record?.checkIn?.minutes ?? null, checkOut: record?.checkOut?.minutes ?? null },
      note: req.body.note || null,
    });
    res.json({ record });
  })
);

module.exports = router;
