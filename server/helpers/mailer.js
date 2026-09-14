"use strict";

const nodemailer = require("nodemailer");
const env = require("../config/env");

let transporter;

function getTransporter() {
  if (!env.mail.enabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.secure,
      auth: env.mail.user ? { user: env.mail.user, pass: env.mail.pass } : undefined,
    });
  }
  return transporter;
}

/**
 * Best-effort mail. An alert that cannot be delivered must never take the
 * cron job (or a request) down with it, so failures are logged, not thrown.
 */
async function send({ to, subject, html, text, attachments }) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (recipients.length === 0) return { skipped: "no_recipients" };

  const mail = getTransporter();
  if (!mail) {
    console.log(`[attendance] mail disabled, would have sent "${subject}" to ${recipients.join(", ")}`);
    return { skipped: "mail_disabled" };
  }

  try {
    const info = await mail.sendMail({
      from: env.mail.from,
      to: recipients.join(", "),
      subject,
      text,
      html,
      attachments,
    });
    return { messageId: info.messageId };
  } catch (err) {
    console.error(`[attendance] failed to send "${subject}"`, err.message);
    return { error: err.message };
  }
}

/** Minimal, mail-client-safe HTML — no external CSS, no web fonts. */
function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;background:#f4f6fb;padding:24px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;border:1px solid #e5e7eb">
    <h1 style="margin:0 0 16px;font-size:18px;color:#111827">${escapeHtml(title)}</h1>
    ${bodyHtml}
    <p style="margin-top:24px;font-size:12px;color:#6b7280">Sent automatically by your attendance system.</p>
  </div></body></html>`;
}

function table(headers, rows) {
  const th = headers
    .map((h) => `<th style="text-align:left;padding:8px;border-bottom:2px solid #e5e7eb;font-size:13px">${escapeHtml(h)}</th>`)
    .join("");
  const tr = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell) => `<td style="padding:8px;border-bottom:1px solid #f3f4f6;font-size:13px">${escapeHtml(cell)}</td>`)
          .join("")}</tr>`
    )
    .join("");
  return `<table style="width:100%;border-collapse:collapse"><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table>`;
}

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

module.exports = { send, layout, table, escapeHtml };
