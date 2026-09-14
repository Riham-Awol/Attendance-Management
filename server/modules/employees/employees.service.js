"use strict";

const { collection, COLLECTIONS } = require("../../config/db");
const { ApiError } = require("../../helpers/errors");
const { hashPassword, ROLES } = require("../../helpers/auth");
const { toId } = require("../settings/settings.service");

/** Never let a password hash leave the service layer. */
const publicUser = (user) => {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
};

async function list({ search, department, status, role } = {}) {
  const query = {};
  if (status) query.status = status;
  if (department) query.department = department;
  if (role) query.role = role;
  if (search) {
    const safe = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { name: { $regex: safe, $options: "i" } },
      { email: { $regex: safe, $options: "i" } },
      { employeeCode: { $regex: safe, $options: "i" } },
    ];
  }
  const users = await collection(COLLECTIONS.users).find(query).sort({ name: 1 }).toArray();
  return users.map(publicUser);
}

const listActive = () =>
  collection(COLLECTIONS.users).find({ status: "active" }).sort({ name: 1 }).toArray();

async function getById(id) {
  const user = await collection(COLLECTIONS.users).findOne({ _id: toId(id) });
  if (!user) throw ApiError.notFound("Employee not found");
  return user;
}

async function create(input) {
  const email = input.email.toLowerCase();
  const existing = await collection(COLLECTIONS.users).findOne({ email });
  if (existing) throw ApiError.conflict("An account with that email already exists");

  if (input.employeeCode) {
    const codeTaken = await collection(COLLECTIONS.users).findOne({ employeeCode: input.employeeCode });
    if (codeTaken) throw ApiError.conflict("That employee ID is already in use");
  }

  const doc = {
    name: input.name,
    email,
    password: await hashPassword(input.password),
    role: input.role || ROLES.EMPLOYEE,
    employeeCode: input.employeeCode || null,
    department: input.department || null,
    position: input.position || null,
    phone: input.phone || null,
    shiftId: input.shiftId ? toId(input.shiftId) : null,
    officeId: input.officeId ? toId(input.officeId) : null,
    workingHours: input.workingHours || null,
    status: "active",
    mustChangePassword: input.mustChangePassword !== false,
    joinedAt: input.joinedAt || null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  try {
    const { insertedId } = await collection(COLLECTIONS.users).insertOne(doc);
    return publicUser({ ...doc, _id: insertedId });
  } catch (err) {
    if (err.code === 11000) throw ApiError.conflict("An account with that email already exists");
    throw err;
  }
}

async function update(id, patch, actor) {
  const user = await getById(id);

  // An admin locking themselves out of their own system is a support call
  // nobody wants, so block the two ways to do it by accident.
  if (String(user._id) === String(actor._id)) {
    if (patch.role && patch.role !== user.role) {
      throw ApiError.badRequest("You cannot change your own role");
    }
    if (patch.status && patch.status !== "active") {
      throw ApiError.badRequest("You cannot deactivate your own account");
    }
  }
  if (user.role === ROLES.ADMIN && (patch.role === ROLES.EMPLOYEE || patch.status === "inactive")) {
    await assertNotLastAdmin(user._id);
  }

  const set = { ...patch, updatedAt: new Date() };
  if (set.email) set.email = set.email.toLowerCase();
  // An explicit null clears the assignment; an absent key leaves it alone.
  if (set.shiftId) set.shiftId = toId(set.shiftId);
  if (set.officeId) set.officeId = toId(set.officeId);
  delete set.password;

  const updated = await collection(COLLECTIONS.users).findOneAndUpdate(
    { _id: user._id },
    { $set: set },
    { returnDocument: "after" }
  );
  return publicUser(updated);
}

async function setPassword(id, plain, { mustChangePassword = true } = {}) {
  const user = await getById(id);
  await collection(COLLECTIONS.users).updateOne(
    { _id: user._id },
    { $set: { password: await hashPassword(plain), mustChangePassword, updatedAt: new Date() } }
  );
}

async function deactivate(id, actor) {
  const user = await getById(id);
  if (String(user._id) === String(actor._id)) {
    throw ApiError.badRequest("You cannot deactivate your own account");
  }
  if (user.role === ROLES.ADMIN) await assertNotLastAdmin(user._id);

  await collection(COLLECTIONS.users).updateOne(
    { _id: user._id },
    { $set: { status: "inactive", deactivatedAt: new Date(), updatedAt: new Date() } }
  );
  return publicUser({ ...user, status: "inactive" });
}

async function assertNotLastAdmin(excludeId) {
  const others = await collection(COLLECTIONS.users).countDocuments({
    role: ROLES.ADMIN,
    status: "active",
    _id: { $ne: toId(excludeId) },
  });
  if (others === 0) {
    throw ApiError.conflict("This is the only active admin — promote someone else first");
  }
}

const departments = () =>
  collection(COLLECTIONS.users).distinct("department", { department: { $nin: [null, ""] } });

module.exports = {
  publicUser,
  list,
  listActive,
  getById,
  create,
  update,
  setPassword,
  deactivate,
  departments,
};
