"use strict";

const express = require("express");

const { asyncHandler } = require("../../helpers/errors");
const { validate } = require("../../helpers/validate");
const schemas = require("../../helpers/schemas");
const { requireAuth, requireAdmin, audit } = require("../../helpers/auth");
const service = require("./employees.service");

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search, department, status, role } = req.query;
    res.json({ employees: await service.list({ search, department, status, role }) });
  })
);

router.get(
  "/departments",
  asyncHandler(async (_req, res) => {
    res.json({ departments: (await service.departments()).sort() });
  })
);

router.post(
  "/",
  validate(schemas.employeeCreate),
  asyncHandler(async (req, res) => {
    const employee = await service.create(req.body);
    await audit(req, "employee.create", "user", employee._id, { name: employee.name, role: employee.role });
    res.status(201).json({ employee });
  })
);

router.get(
  "/:id",
  validate(schemas.idParam, "params"),
  asyncHandler(async (req, res) => {
    res.json({ employee: service.publicUser(await service.getById(req.params.id)) });
  })
);

router.patch(
  "/:id",
  validate(schemas.idParam, "params"),
  validate(schemas.employeeUpdate),
  asyncHandler(async (req, res) => {
    const employee = await service.update(req.params.id, req.body, req.user);
    await audit(req, "employee.update", "user", req.params.id, req.body);
    res.json({ employee });
  })
);

router.post(
  "/:id/reset-password",
  validate(schemas.idParam, "params"),
  validate(schemas.resetPassword),
  asyncHandler(async (req, res) => {
    await service.setPassword(req.params.id, req.body.newPassword, {
      mustChangePassword: req.body.mustChangePassword,
    });
    // Never log the password itself — the audit trail is readable by any admin.
    await audit(req, "employee.reset_password", "user", req.params.id, {});
    res.json({ ok: true });
  })
);

router.delete(
  "/:id",
  validate(schemas.idParam, "params"),
  asyncHandler(async (req, res) => {
    const employee = await service.deactivate(req.params.id, req.user);
    await audit(req, "employee.deactivate", "user", req.params.id, {});
    res.json({ employee });
  })
);

module.exports = router;
