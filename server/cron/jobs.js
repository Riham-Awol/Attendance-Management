"use strict";

const cron = require("node-cron");

const env = require("../config/env");
const { collection, COLLECTIONS } = require("../config/db");
const { dateKey, minutesOfDay, addDays, monthRange, formatClock, formatDuration, zonedTimeToInstant } = require("../domain/time");
const { shiftWindow, isWorkDay, STATUS } = require("../domain/attendance-rules");
const settingsService = require("../modules/settings/settings.service");
const employeesService = require("../modules/employees/employees.service");
const attendanceService = require("../modules/attendance/attendance.service");
const reportsService = require("../modules/reports/reports.service");
const mailer = require("../helpers/mailer");

/**
 * Close out shifts that were never checked out of.
 *
 * The check-out is capped at the scheduled end — someone who forgot to tap out
 * should not be paid until midnight — and flagged `autoCheckout` so a manager
 * can see it was the system, not the employee.
 */
async function autoCheckout(now = new Date()) {
  const settings = await settingsService.getSettings();
  const timeZone = settings.timeZone;
  const users = await employeesService.listActive();
  const shiftMap = await settingsService.getShiftMap(users);

  const today = dateKey(now, timeZone);
  const nowMinutes = minutesOfDay(now, timeZone);
  const closed = [];

  for (const user of users) {
    const shift = shiftMap.get(String(user._id));
    const window = shiftWindow(shift);

    // Look at today and yesterday so an overnight shift is caught too.
    for (const date of [today, addDays(today, -1)]) {
      const record = await attendanceService.findRecord(user._id, date);
      if (!record || !record.checkIn || record.checkOut) continue;

      // Minutes elapsed since that shift's scheduled end, on a continuous axis.
      const elapsedSinceEnd =
        date === today ? nowMinutes - window.end : nowMinutes + 1440 - window.end;
      if (elapsedSinceEnd < env.cron.autoCheckoutGraceMinutes) continue;

      const endMinutes = window.end % 1440;
      await collection(COLLECTIONS.attendance).updateOne(
        { _id: record._id, checkOut: null },
        {
          $set: {
            checkOut: {
              at: zonedTimeToInstant(date, window.end, timeZone),
              minutes: endMinutes,
              auto: true,
              officeName: record.checkIn.officeName || null,
            },
            autoCheckout: true,
            updatedAt: new Date(),
          },
        }
      );
      await attendanceService.recalculate(record._id);
      closed.push({ name: user.name, date, at: formatClock(endMinutes) });
    }
  }

  if (closed.length) {
    console.log(`[attendance] auto-closed ${closed.length} open shift(s)`);
  }
  return closed;
}

/**
 * Tell the admins who has not turned up, once, at a configured time of day —
 * early enough to act on, late enough that the grace period has passed.
 */
async function noShowAlert(now = new Date()) {
  const settings = await settingsService.getSettings();
  if (!settings.alerts.sendNoShowAlert) return { skipped: "disabled" };

  const timeZone = settings.timeZone;
  const today = dateKey(now, timeZone);
  const users = await employeesService.listActive();
  const rows = await attendanceService.buildDays({ users, from: today, to: today, now });

  const missing = rows
    .map(({ employee, days }) => ({ employee, day: days[0] }))
    .filter(({ day }) => day.status === STATUS.ABSENT);

  const late = rows
    .map(({ employee, days }) => ({ employee, day: days[0] }))
    .filter(({ day }) => day.lateMinutes > 0);

  if (missing.length === 0 && late.length === 0) return { skipped: "everyone_accounted_for" };

  const recipients = await alertRecipients(settings);
  const body = [
    `<p style="font-size:14px">Attendance check for <strong>${mailer.escapeHtml(today)}</strong>.</p>`,
    missing.length
      ? `<h2 style="font-size:15px;margin:20px 0 8px">Not checked in (${missing.length})</h2>` +
        mailer.table(
          ["Employee", "Department", "Shift"],
          missing.map(({ employee }) => [employee.name, employee.department || "—", employee.position || "—"])
        )
      : `<p style="font-size:14px;color:#16a34a">Everyone has checked in.</p>`,
    late.length
      ? `<h2 style="font-size:15px;margin:20px 0 8px">Late today (${late.length})</h2>` +
        mailer.table(
          ["Employee", "Checked in", "Late by"],
          late.map(({ employee, day }) => [employee.name, day.checkInTime || "—", formatDuration(day.lateMinutes)])
        )
      : "",
  ].join("");

  return mailer.send({
    to: recipients,
    subject: `Attendance alert — ${missing.length} absent, ${late.length} late (${today})`,
    html: mailer.layout(`${settings.companyName} attendance`, body),
    text: `Absent: ${missing.map((m) => m.employee.name).join(", ") || "none"}\nLate: ${late
      .map((l) => `${l.employee.name} (${formatDuration(l.day.lateMinutes)})`)
      .join(", ") || "none"}`,
  });
}

/** Full previous-month report, as an attached spreadsheet, on the 1st. */
async function monthlyReport(now = new Date()) {
  const settings = await settingsService.getSettings();
  if (!settings.alerts.sendMonthlyReport) return { skipped: "disabled" };

  const timeZone = settings.timeZone;
  const today = dateKey(now, timeZone);
  const lastMonth = monthRange(addDays(`${today.slice(0, 8)}01`, -1));

  const report = await reportsService.buildReport({ from: lastMonth.from, to: lastMonth.to });
  const recipients = await alertRecipients(settings);

  const rows = report.employees
    .slice()
    .sort((a, b) => b.summary.lateMinutes - a.summary.lateMinutes)
    .slice(0, 15)
    .map((r) => [
      r.employee.name,
      String(r.summary.presentDays),
      String(r.summary.absentDays),
      String(r.summary.lateDays),
      formatDuration(r.summary.lateMinutes),
      `${r.summary.attendanceRate}%`,
    ]);

  const body = `
    <p style="font-size:14px">Attendance for <strong>${lastMonth.from}</strong> to <strong>${lastMonth.to}</strong>.</p>
    <p style="font-size:14px">${report.totals.presentDays} days present, ${report.totals.absentDays} absences,
    ${report.totals.lateDays} late arrivals (${formatDuration(report.totals.lateMinutes)} in total).</p>
    <h2 style="font-size:15px;margin:20px 0 8px">Most lateness</h2>
    ${mailer.table(["Employee", "Present", "Absent", "Late days", "Late time", "Attendance"], rows)}
    <p style="font-size:13px;color:#6b7280;margin-top:16px">The attached spreadsheet has every employee and every day.</p>`;

  return mailer.send({
    to: recipients,
    subject: `Monthly attendance report — ${lastMonth.from.slice(0, 7)}`,
    html: mailer.layout(`${settings.companyName} monthly report`, body),
    attachments: [
      {
        filename: `attendance_${lastMonth.from.slice(0, 7)}.xlsx`,
        content: reportsService.toXlsx(report),
      },
    ],
  });
}

/** Configured alert addresses, falling back to every active admin. */
async function alertRecipients(settings) {
  if (settings.alerts.adminEmails && settings.alerts.adminEmails.length) {
    return settings.alerts.adminEmails;
  }
  const admins = await collection(COLLECTIONS.users)
    .find({ role: "admin", status: "active" })
    .project({ email: 1 })
    .toArray();
  return admins.map((a) => a.email);
}

const guard = (name, fn) => async () => {
  try {
    await fn();
  } catch (err) {
    // A thrown error inside a cron tick would otherwise be an unhandled
    // rejection and could take the process down.
    console.error(`[attendance] cron "${name}" failed:`, err.message);
  }
};

function start() {
  if (!env.cron.enabled) {
    console.log("[attendance] cron jobs disabled");
    return [];
  }

  const jobs = [
    // Hourly, so it catches shifts that end at any time of day, including
    // overnight ones.
    cron.schedule("5 * * * *", guard("auto-checkout", autoCheckout)),
    // Every 15 minutes; the job itself checks whether it is the configured
    // alert time in the office's timezone.
    cron.schedule("*/15 * * * *", guard("no-show-alert", noShowAlertIfDue)),
    cron.schedule("0 6 1 * *", guard("monthly-report", monthlyReport)),
  ];
  console.log(`[attendance] ${jobs.length} cron jobs scheduled`);
  return jobs;
}

/** Nobody is missing on a day nobody was due in. */
async function isWorkingDay(now) {
  const settings = await settingsService.getSettings();
  const shift = await settingsService.getDefaultShift();
  const today = dateKey(now, settings.timeZone);

  if (!isWorkDay(shift, today)) return { working: false, reason: "not_a_work_day" };
  const holidays = await settingsService.holidaySet(today, today);
  if (holidays.has(today)) return { working: false, reason: "holiday" };
  return { working: true };
}

/**
 * Fire the no-show alert in the quarter-hour that matches the configured local
 * time. Used by the in-process scheduler, which ticks every 15 minutes.
 */
async function noShowAlertIfDue(now = new Date()) {
  const settings = await settingsService.getSettings();
  const nowMinutes = minutesOfDay(now, settings.timeZone);
  const [h, m] = (settings.alerts.noShowAlertTime || "10:30").split(":").map(Number);
  const target = h * 60 + m;
  if (nowMinutes < target || nowMinutes >= target + 15) return { skipped: "not_due" };

  const { working, reason } = await isWorkingDay(now);
  if (!working) return { skipped: reason };

  return noShowAlert(now);
}

/**
 * The morning job, for a scheduler that fires once at a set time (Vercel Cron)
 * rather than polling. The caller has already decided it is the right hour, so
 * there is no time-window check here — only the working-day one.
 */
async function runMorningJobs(now = new Date()) {
  const { working, reason } = await isWorkingDay(now);
  if (!working) return { skipped: reason };
  return { noShowAlert: await noShowAlert(now) };
}

/**
 * The end-of-day job: close shifts nobody checked out of, and on the first of
 * the month send the report for the month just gone.
 */
async function runEveningJobs(now = new Date()) {
  const settings = await settingsService.getSettings();
  const today = dateKey(now, settings.timeZone);
  const result = { autoCheckout: await autoCheckout(now) };

  if (today.endsWith("-01")) {
    result.monthlyReport = await monthlyReport(now);
  }
  return result;
}

module.exports = {
  start,
  autoCheckout,
  noShowAlert,
  noShowAlertIfDue,
  monthlyReport,
  alertRecipients,
  isWorkingDay,
  runMorningJobs,
  runEveningJobs,
};
