"use strict";

const express = require("express");

const { asyncHandler } = require("../../helpers/errors");
const { requireAuth, requireAdmin } = require("../../helpers/auth");
const service = require("./dashboard.service");

const router = express.Router();

/**
 * Open to every signed-in employee: department scores only. Deliberately not
 * behind requireAdmin — seeing how your own department is doing is the point —
 * and deliberately carrying no individual data.
 */
router.get(
  "/departments",
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json(await service.departmentScoreboard());
  })
);

router.get(
  "/overview",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await service.overview());
  })
);

module.exports = router;
