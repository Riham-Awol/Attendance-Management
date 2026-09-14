"use strict";

const Joi = require("joi");

const dateKey = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).message("Dates must look like 2026-09-08");
const clock = Joi.string().pattern(/^([01]\d|2[0-3]):[0-5]\d$/).message("Times must look like 09:30");
const objectId = Joi.string().hex().length(24);

// Passwords protect payroll-relevant data; 8 characters is the floor.
const password = Joi.string().min(8).max(128);

const coordinates = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  accuracy: Joi.number().min(0).max(100000).default(0),
  note: Joi.string().trim().max(280).allow("", null),
});

const login = Joi.object({
  email: Joi.string().email().lowercase().required(),
  password: Joi.string().max(128).required(),
});

const changePassword = Joi.object({
  currentPassword: Joi.string().max(128).required(),
  newPassword: password.required(),
});

// Hours for one employee, layered over whichever shift they are on. Every
// field is optional: set only what differs.
const workingHours = Joi.object({
  startTime: clock.allow(null),
  endTime: clock.allow(null),
  workDays: Joi.array().items(Joi.number().integer().min(0).max(6)).min(1).max(7).allow(null),
  graceMinutes: Joi.number().integer().min(0).max(240).allow(null),
  breakMinutes: Joi.number().integer().min(0).max(480).allow(null),
}).allow(null);

const employeeCreate = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  email: Joi.string().email().lowercase().required(),
  password: password.required(),
  role: Joi.string().valid("admin", "employee").default("employee"),
  employeeCode: Joi.string().trim().max(40).allow("", null),
  department: Joi.string().trim().max(80).allow("", null),
  position: Joi.string().trim().max(80).allow("", null),
  phone: Joi.string().trim().max(40).allow("", null),
  shiftId: objectId.allow(null),
  officeId: objectId.allow(null),
  workingHours,
  joinedAt: dateKey.allow(null),
  mustChangePassword: Joi.boolean().default(true),
});

const employeeUpdate = Joi.object({
  name: Joi.string().trim().min(2).max(120),
  email: Joi.string().email().lowercase(),
  role: Joi.string().valid("admin", "employee"),
  employeeCode: Joi.string().trim().max(40).allow("", null),
  department: Joi.string().trim().max(80).allow("", null),
  position: Joi.string().trim().max(80).allow("", null),
  phone: Joi.string().trim().max(40).allow("", null),
  shiftId: objectId.allow(null),
  officeId: objectId.allow(null),
  workingHours,
  joinedAt: dateKey.allow(null),
  status: Joi.string().valid("active", "inactive"),
}).min(1);

const resetPassword = Joi.object({
  newPassword: password.required(),
  mustChangePassword: Joi.boolean().default(true),
});

const leaveCreate = Joi.object({
  type: Joi.string().valid("annual", "sick", "unpaid", "permission", "remote").required(),
  scope: Joi.string().valid("full_day", "partial").default("full_day"),
  fromDate: dateKey.required(),
  toDate: dateKey.required(),
  fromTime: clock.when("scope", { is: "partial", then: Joi.required(), otherwise: Joi.optional().allow(null) }),
  toTime: clock.when("scope", { is: "partial", then: Joi.required(), otherwise: Joi.optional().allow(null) }),
  reason: Joi.string().trim().min(3).max(500).required(),
});

const leaveDecision = Joi.object({
  status: Joi.string().valid("approved", "rejected").required(),
  note: Joi.string().trim().max(500).allow("", null),
});

const officeCreate = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
  radiusMeters: Joi.number().integer().min(20).max(5000).default(100),
  address: Joi.string().trim().max(240).allow("", null),
  active: Joi.boolean().default(true),
});

const officeUpdate = officeCreate.fork(["name", "lat", "lng"], (s) => s.optional()).min(1);

const shiftBody = Joi.object({
  name: Joi.string().trim().min(2).max(80).required(),
  startTime: clock.required(),
  endTime: clock.required(),
  workDays: Joi.array().items(Joi.number().integer().min(0).max(6)).min(1).max(7).required(),
  graceMinutes: Joi.number().integer().min(0).max(240).default(10),
  earlyLeaveGraceMinutes: Joi.number().integer().min(0).max(240).default(10),
  breakMinutes: Joi.number().integer().min(0).max(480).default(0),
  minFullDayMinutes: Joi.number().integer().min(0).max(1440).allow(null),
  minHalfDayMinutes: Joi.number().integer().min(0).max(1440).allow(null),
  countOvertime: Joi.boolean().default(true),
  overtimeThresholdMinutes: Joi.number().integer().min(0).max(240).default(15),
  isDefault: Joi.boolean().default(false),
});

const shiftUpdate = shiftBody.fork(["name", "startTime", "endTime", "workDays"], (s) => s.optional()).min(1);

const holidayCreate = Joi.object({
  date: dateKey.required(),
  name: Joi.string().trim().min(2).max(120).required(),
});

const settingsUpdate = Joi.object({
  companyName: Joi.string().trim().min(1).max(120),
  timeZone: Joi.string().trim().max(64),
  geo: Joi.object({
    accuracySlackMeters: Joi.number().integer().min(0).max(500),
    maxAccuracyMeters: Joi.number().integer().min(20).max(5000),
  }),
  alerts: Joi.object({
    adminEmails: Joi.array().items(Joi.string().email()).max(10),
    noShowAlertTime: clock,
    sendNoShowAlert: Joi.boolean(),
    sendMonthlyReport: Joi.boolean(),
  }),
  policy: Joi.object({
    maxLateDaysPerMonth: Joi.number().integer().min(0).max(31),
    maxAbsentDaysPerMonth: Joi.number().integer().min(0).max(31),
    maxPermissionsPerMonth: Joi.number().integer().min(0).max(31),
    absentDeductionPerDay: Joi.number().min(0).max(1000000),
    currency: Joi.string().trim().max(8),
  }),
}).min(1);

const rangeQuery = Joi.object({
  from: dateKey.required(),
  to: dateKey.required(),
  userId: objectId,
  department: Joi.string().trim().max(80),
  status: Joi.string().max(40),
  includeInactive: Joi.boolean().default(false),
});

// Employee-facing history endpoints default to the current month, so both
// bounds are optional here.
const optionalRangeQuery = Joi.object({
  from: dateKey,
  to: dateKey,
});

const exportQuery = rangeQuery.keys({
  format: Joi.string().valid("xlsx", "csv").default("xlsx"),
  sheet: Joi.string().valid("summary", "detail").default("summary"),
});

const attendanceEdit = Joi.object({
  checkInTime: clock.allow(null),
  checkOutTime: clock.allow(null),
  note: Joi.string().trim().max(280).allow("", null),
}).or("checkInTime", "checkOutTime");

const attendanceCreate = Joi.object({
  userId: objectId.required(),
  date: dateKey.required(),
  checkInTime: clock.allow(null),
  checkOutTime: clock.allow(null),
  note: Joi.string().trim().max(280).allow("", null),
});

const idParam = Joi.object({ id: objectId.required() });

module.exports = {
  dateKey,
  clock,
  objectId,
  coordinates,
  login,
  changePassword,
  workingHours,
  employeeCreate,
  employeeUpdate,
  resetPassword,
  leaveCreate,
  leaveDecision,
  officeCreate,
  officeUpdate,
  shiftBody,
  shiftUpdate,
  holidayCreate,
  settingsUpdate,
  rangeQuery,
  optionalRangeQuery,
  exportQuery,
  attendanceEdit,
  attendanceCreate,
  idParam,
};
