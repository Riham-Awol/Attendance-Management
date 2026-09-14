"use strict";

const express = require("express");

const { asyncHandler } = require("../../helpers/errors");
const { validate } = require("../../helpers/validate");
const schemas = require("../../helpers/schemas");
const { requireAuth, requireAdmin, audit } = require("../../helpers/auth");
const service = require("./settings.service");

const router = express.Router();

router.use(requireAuth);

/** Employees need the office list to see how far away they are. */
router.get(
  "/offices",
  asyncHandler(async (_req, res) => {
    res.json({ offices: await service.listActiveOffices() });
  })
);

router.get(
  "/shifts",
  asyncHandler(async (_req, res) => {
    res.json({ shifts: await service.listShifts() });
  })
);

router.get(
  "/holidays",
  asyncHandler(async (req, res) => {
    res.json({ holidays: await service.listHolidays(req.query.from, req.query.to) });
  })
);

router.get(
  "/",
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json({ settings: await service.getSettings() });
  })
);

router.put(
  "/",
  requireAdmin,
  validate(schemas.settingsUpdate),
  asyncHandler(async (req, res) => {
    const settings = await service.updateSettings(req.body);
    await audit(req, "settings.update", "settings", service.SETTINGS_ID, req.body);
    res.json({ settings });
  })
);

router.post(
  "/offices",
  requireAdmin,
  validate(schemas.officeCreate),
  asyncHandler(async (req, res) => {
    const office = await service.createOffice(req.body);
    await audit(req, "office.create", "office", office._id, req.body);
    res.status(201).json({ office });
  })
);

router.patch(
  "/offices/:id",
  requireAdmin,
  validate(schemas.idParam, "params"),
  validate(schemas.officeUpdate),
  asyncHandler(async (req, res) => {
    const office = await service.updateOffice(req.params.id, req.body);
    await audit(req, "office.update", "office", req.params.id, req.body);
    res.json({ office });
  })
);

router.delete(
  "/offices/:id",
  requireAdmin,
  validate(schemas.idParam, "params"),
  asyncHandler(async (req, res) => {
    await service.deleteOffice(req.params.id);
    await audit(req, "office.delete", "office", req.params.id, {});
    res.json({ ok: true });
  })
);

router.post(
  "/shifts",
  requireAdmin,
  validate(schemas.shiftBody),
  asyncHandler(async (req, res) => {
    const shift = await service.createShift(req.body);
    await audit(req, "shift.create", "shift", shift._id, req.body);
    res.status(201).json({ shift });
  })
);

router.patch(
  "/shifts/:id",
  requireAdmin,
  validate(schemas.idParam, "params"),
  validate(schemas.shiftUpdate),
  asyncHandler(async (req, res) => {
    const shift = await service.updateShift(req.params.id, req.body);
    await audit(req, "shift.update", "shift", req.params.id, req.body);
    res.json({ shift });
  })
);

router.delete(
  "/shifts/:id",
  requireAdmin,
  validate(schemas.idParam, "params"),
  asyncHandler(async (req, res) => {
    await service.deleteShift(req.params.id);
    await audit(req, "shift.delete", "shift", req.params.id, {});
    res.json({ ok: true });
  })
);

router.post(
  "/holidays",
  requireAdmin,
  validate(schemas.holidayCreate),
  asyncHandler(async (req, res) => {
    const holiday = await service.createHoliday(req.body);
    await audit(req, "holiday.create", "holiday", holiday._id, req.body);
    res.status(201).json({ holiday });
  })
);

router.delete(
  "/holidays/:id",
  requireAdmin,
  validate(schemas.idParam, "params"),
  asyncHandler(async (req, res) => {
    await service.deleteHoliday(req.params.id);
    await audit(req, "holiday.delete", "holiday", req.params.id, {});
    res.json({ ok: true });
  })
);

module.exports = router;
