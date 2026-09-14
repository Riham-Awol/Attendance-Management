"use strict";

const express = require("express");

const { asyncHandler } = require("../../helpers/errors");
const { validate } = require("../../helpers/validate");
const schemas = require("../../helpers/schemas");
const { requireAuth, requireAdmin } = require("../../helpers/auth");
const service = require("./reports.service");
const settingsService = require("../settings/settings.service");
const { dateKey } = require("../../domain/time");

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get(
  "/summary",
  validate(schemas.rangeQuery, "query"),
  asyncHandler(async (req, res) => {
    const { from, to, userId, department, includeInactive } = req.validatedQuery;
    // The summary screen only draws totals, so skip shipping every day row.
    const report = await service.buildReport({
      from,
      to,
      userId,
      department,
      includeInactive,
      includeDays: !!userId,
    });
    res.json(report);
  })
);

router.get(
  "/daily",
  asyncHandler(async (req, res) => {
    const timeZone = await settingsService.timeZone();
    const date = req.query.date || dateKey(new Date(), timeZone);
    res.json(await service.dailyReport(date, { department: req.query.department }));
  })
);

router.get(
  "/export",
  validate(schemas.exportQuery, "query"),
  asyncHandler(async (req, res) => {
    const { from, to, userId, department, includeInactive, format, sheet } = req.validatedQuery;
    const report = await service.buildReport({ from, to, userId, department, includeInactive });
    const stamp = `${from}_to_${to}`;

    if (format === "csv") {
      const csv = service.toCsv(report, sheet);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="attendance_${sheet}_${stamp}.csv"`);
      // A BOM makes Excel open UTF-8 names correctly instead of as mojibake.
      return res.send(`﻿${csv}`);
    }

    const buffer = service.toXlsx(report);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="attendance_${stamp}.xlsx"`);
    return res.send(buffer);
  })
);

module.exports = router;
