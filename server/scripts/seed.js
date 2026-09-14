"use strict";

/**
 * Fill a fresh database with a month of believable demo data so the dashboard,
 * reports and exports can be seen working before any real employee exists.
 *
 * Safe to re-run: it clears the demo employees it created and their records,
 * and never touches accounts it did not create.
 */

const env = require("../config/env");
const { connect, close, collection, COLLECTIONS } = require("../config/db");
const { hashPassword, ROLES } = require("../helpers/auth");
const settingsService = require("../modules/settings/settings.service");
const attendanceService = require("../modules/attendance/attendance.service");
const { dateKey, addDays, eachDate, zonedTimeToInstant } = require("../domain/time");
const { isWorkDay, evaluateDay } = require("../domain/attendance-rules");

const SEED_TAG = "demo-seed";
const PASSWORD = "password123";

const OFFICE = {
  name: "Head Office",
  lat: 9.005401,
  lng: 38.763611,
  radiusMeters: 150,
  address: "Bole Road, Addis Ababa",
};

const PEOPLE = [
  { name: "Ada Bekele", department: "Engineering", position: "Backend Developer", punctuality: 0.95 },
  { name: "Samuel Tesfaye", department: "Engineering", position: "Frontend Developer", punctuality: 0.8 },
  { name: "Hanna Girma", department: "Sales", position: "Account Manager", punctuality: 0.6 },
  { name: "Yonas Alemu", department: "Sales", position: "Sales Representative", punctuality: 0.75 },
  { name: "Marta Haile", department: "Finance", position: "Accountant", punctuality: 0.98 },
  { name: "Dawit Mekonnen", department: "Operations", position: "Logistics Officer", punctuality: 0.7 },
  { name: "Selam Tadesse", department: "Operations", position: "Office Manager", punctuality: 0.88 },
  { name: "Kalkidan Assefa", department: "Finance", position: "Payroll Officer", punctuality: 0.9 },
];

// A fixed seed keeps the demo data identical on every run, which makes it
// possible to talk about "Hanna's 12 late days" and have it still be true.
let seed = 42;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

const slug = (name) => name.toLowerCase().split(" ")[0];

async function run() {
  await connect();
  console.log(`[seed] connected to ${env.dbName}`);

  await collection(COLLECTIONS.attendance).deleteMany({ seeded: SEED_TAG });
  await collection(COLLECTIONS.leaves).deleteMany({ seeded: SEED_TAG });
  await collection(COLLECTIONS.users).deleteMany({ seeded: SEED_TAG });

  const settings = await settingsService.updateSettings({
    companyName: "Demo Company",
    timeZone: env.defaultTimeZone,
  });
  const timeZone = settings.timeZone;

  const offices = await settingsService.listOffices({ name: OFFICE.name });
  const office = offices[0] || (await settingsService.createOffice(OFFICE));

  const shifts = await settingsService.listShifts();
  let standard = shifts.find((s) => s.name === "Standard (9–5)") || shifts.find((s) => s.isDefault);
  if (!standard) {
    standard = await settingsService.createShift({
      name: "Standard (9–5)",
      startTime: "09:00",
      endTime: "17:00",
      workDays: [1, 2, 3, 4, 5],
      graceMinutes: 10,
      breakMinutes: 60,
      isDefault: true,
    });
  }
  let earlyShift = shifts.find((s) => s.name === "Early (7–3)");
  if (!earlyShift) {
    earlyShift = await settingsService.createShift({
      name: "Early (7–3)",
      startTime: "07:00",
      endTime: "15:00",
      workDays: [1, 2, 3, 4, 5],
      graceMinutes: 10,
      breakMinutes: 45,
    });
  }

  const password = await hashPassword(PASSWORD);
  const employees = [];
  for (const [i, person] of PEOPLE.entries()) {
    const doc = {
      name: person.name,
      email: `${slug(person.name)}@demo.co`,
      password,
      role: ROLES.EMPLOYEE,
      employeeCode: `EMP-${String(i + 1).padStart(3, "0")}`,
      department: person.department,
      position: person.position,
      phone: `+2519${String(10000000 + i * 137).slice(0, 8)}`,
      shiftId: person.department === "Operations" ? earlyShift._id : standard._id,
      status: "active",
      mustChangePassword: false,
      seeded: SEED_TAG,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { insertedId } = await collection(COLLECTIONS.users).insertOne(doc);
    employees.push({ ...doc, _id: insertedId, punctuality: person.punctuality });
  }
  console.log(`[seed] created ${employees.length} demo employees (password: ${PASSWORD})`);

  const today = dateKey(new Date(), timeZone);
  const from = addDays(today, -45);
  const holiday = addDays(today, -12);
  await collection(COLLECTIONS.holidays).deleteOne({ date: holiday });
  await settingsService.createHoliday({ date: holiday, name: "Public Holiday" });

  const shiftById = new Map([
    [String(standard._id), standard],
    [String(earlyShift._id), earlyShift],
  ]);

  let records = 0;
  for (const employee of employees) {
    const shift = shiftById.get(String(employee.shiftId));
    for (const date of eachDate(from, today)) {
      if (!isWorkDay(shift, date) || date === holiday) continue;

      const roll = random();
      if (roll > 0.97) continue; // an unexplained absence

      const [startH, startM] = shift.startTime.split(":").map(Number);
      const [endH, endM] = shift.endTime.split(":").map(Number);
      const scheduledStart = startH * 60 + startM;
      const scheduledEnd = endH * 60 + endM;

      const onTime = random() < employee.punctuality;
      const checkInMinutes = onTime
        ? scheduledStart - Math.floor(random() * 20)
        : scheduledStart + 12 + Math.floor(random() * 50);
      const checkOutMinutes = scheduledEnd + Math.floor(random() * 40) - 12;

      const metrics = evaluateDay({
        shift,
        checkInMinutes,
        checkOutMinutes,
        workDay: true,
      });

      await collection(COLLECTIONS.attendance).insertOne({
        userId: employee._id,
        date,
        timeZone,
        shiftId: shift._id,
        shiftName: shift.name,
        checkIn: {
          at: zonedTimeToInstant(date, checkInMinutes, timeZone),
          minutes: checkInMinutes,
          lat: office.lat + (random() - 0.5) * 0.0004,
          lng: office.lng + (random() - 0.5) * 0.0004,
          accuracy: 5 + Math.floor(random() * 20),
          distance: Math.floor(random() * 40),
          officeId: office._id,
          officeName: office.name,
          ip: "10.0.0.1",
        },
        checkOut: {
          at: zonedTimeToInstant(date, checkOutMinutes, timeZone),
          minutes: checkOutMinutes,
          officeId: office._id,
          officeName: office.name,
        },
        ...metrics,
        seeded: SEED_TAG,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      records += 1;
    }
  }
  console.log(`[seed] created ${records} attendance records from ${from} to ${today}`);

  const leaveRequests = [
    { employee: employees[2], type: "annual", scope: "full_day", fromDate: addDays(today, 3), toDate: addDays(today, 5), reason: "Family wedding out of town", status: "pending" },
    { employee: employees[4], type: "sick", scope: "full_day", fromDate: addDays(today, -6), toDate: addDays(today, -5), reason: "Fever, doctor advised rest", status: "approved" },
    { employee: employees[1], type: "permission", scope: "partial", fromDate: addDays(today, 1), toDate: addDays(today, 1), fromTime: "09:00", toTime: "11:30", reason: "Bank appointment", status: "pending" },
    { employee: employees[5], type: "unpaid", scope: "full_day", fromDate: addDays(today, -20), toDate: addDays(today, -20), reason: "Personal errand", status: "rejected" },
    { employee: employees[0], type: "remote", scope: "full_day", fromDate: addDays(today, 2), toDate: addDays(today, 2), reason: "Deep work on the release", status: "pending" },
  ];

  for (const request of leaveRequests) {
    const { employee, status, ...rest } = request;
    await collection(COLLECTIONS.leaves).insertOne({
      userId: employee._id,
      ...rest,
      fromTime: rest.fromTime || null,
      toTime: rest.toTime || null,
      status,
      decidedAt: status === "pending" ? null : new Date(),
      decidedByName: status === "pending" ? null : "System Admin",
      seeded: SEED_TAG,
      createdAt: new Date(),
    });
  }
  console.log(`[seed] created ${leaveRequests.length} leave requests`);

  // Approved leave can excuse days that already have records, so replay them.
  const approved = await collection(COLLECTIONS.leaves).find({ seeded: SEED_TAG, status: "approved" }).toArray();
  for (const leave of approved) {
    const affected = await collection(COLLECTIONS.attendance)
      .find({ userId: leave.userId, date: { $in: eachDate(leave.fromDate, leave.toDate) } })
      .toArray();
    for (const record of affected) await attendanceService.recalculate(record._id);
  }

  console.log("\n[seed] done. Sign in as an employee with:");
  console.log(`  ${employees[0].email} / ${PASSWORD}`);
  console.log(`  admin: ${env.bootstrapAdmin.email} (start the server once to create it)\n`);
  await close();
}

run().catch(async (err) => {
  console.error("[seed] failed:", err);
  await close();
  process.exit(1);
});
