"use strict";

const express = require("express");

const { asyncHandler } = require("../../helpers/errors");
const { requireAuth, requireAdmin } = require("../../helpers/auth");
const service = require("./dashboard.service");

const router = express.Router();

router.get(
  "/overview",
  requireAuth,
  requireAdmin,
  asyncHandler(async (_req, res) => {
    res.json(await service.overview());
  })
);

module.exports = router;
