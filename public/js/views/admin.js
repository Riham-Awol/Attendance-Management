import { api } from "../api.js";
import {
  el, mount, field, toast, modal, confirmAction, empty, statusPill, formatDuration,
  formatDate, formatDateLong, monthRange, todayKey, initials, LEAVE_LABELS, withBusy,
} from "../ui.js";
import { describeLeave } from "./employee.js";

const stat = (label, value, accent = false) =>
  el("div", { class: `stat${accent ? " accent" : ""}` }, [
    el("div", { class: "value mono" }, String(value)),
    el("div", { class: "label" }, label),
  ]);

/* ── Dashboard ───────────────────────────────────────────────────────── */

export async function dashboardView(state) {
  const container = el("div", { class: "stack" });
  const data = await api.overview();
  state.setPendingCount(data.pendingLeaveCount);

  container.append(
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", {}, "Today"),
        el("span", { class: "small muted" }, formatDateLong(data.date)),
      ]),
      el("div", { class: "grid stats" }, [
        stat("On site now", data.today.onSiteNow, true),
        stat("Checked out", data.today.checkedOut),
        stat("Late arrivals", data.today.lateDays),
        stat("Not checked in", data.today.notCheckedIn),
        stat("On leave", data.today.leaveDays),
        stat("Headcount", data.headcount),
      ]),
    ]),

    el("div", { class: "grid two" }, [
      presenceCard("On site now", data.onSite, "Nobody is checked in at the moment."),
      presenceCard("Not checked in", data.notIn, "Everyone has checked in."),
    ]),

    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", {}, "Last 14 days"),
        el("span", { class: "small muted" }, "Attendance by day"),
      ]),
      trendChart(data.trend),
      el("div", { class: "legend" }, [
        legendSwatch("var(--ok)", "On time"),
        legendSwatch("var(--warn)", "Late"),
        legendSwatch("var(--bad)", "Absent"),
        legendSwatch("var(--info)", "Leave"),
      ]),
    ]),

    el("div", { class: "grid two" }, [
      rankCard("Most lateness this month", data.month.worstLateness, (row) => formatDuration(row.summary.lateMinutes)),
      rankCard("Most absences this month", data.month.mostAbsent, (row) => `${row.summary.absentDays} day${row.summary.absentDays === 1 ? "" : "s"}`),
    ]),

    departmentCard(data.month),
    peopleCard(data.month),
    pendingCard(data.pendingLeaves, state)
  );

  return container;
}

const money = (amount, currency) =>
  `${Number(amount || 0).toLocaleString()} ${currency || ""}`.trim();

/** The band, not the number: the score already has its own column. */
const scorePill = (score, band) =>
  el("span", { class: `pill ${(band || "no data").replace(/ /g, "-")}` },
    score === null || score === undefined ? "no data" : band);

/** How each department compares this month. */
function departmentCard(month) {
  const rows = month.departments || [];
  const card = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h2", {}, "Department scores"),
      el("span", { class: "small muted" }, `${month.range.from} → today`),
    ]),
  ]);

  if (rows.length === 0) {
    card.append(empty("No departments to compare yet."));
    return card;
  }

  card.append(
    el("p", { class: "small muted" },
      "Out of 100: attendance 60%, punctuality 30%, staying inside the monthly allowances 10%."),
    el("div", { class: "table-wrap" },
      el("table", {}, [
        el("thead", {}, el("tr", {}, [
          el("th", {}, "Department"),
          el("th", { class: "num" }, "People"),
          el("th", { class: "num" }, "Score"),
          el("th", {}, "Rating"),
          el("th", { class: "num" }, "Late"),
          el("th", { class: "num" }, "Absent"),
          el("th", { class: "num" }, "Permissions"),
          el("th", { class: "num" }, "Deduction"),
        ])),
        el("tbody", {}, rows.map((row) =>
          el("tr", {}, [
            el("td", {}, el("strong", {}, row.department)),
            el("td", { class: "num" }, String(row.employees)),
            el("td", { class: "num mono" }, row.score === null ? "—" : String(row.score)),
            el("td", {}, scorePill(row.score, row.band)),
            el("td", { class: "num" }, String(row.lateDays)),
            el("td", { class: "num" }, String(row.absentDays)),
            el("td", { class: "num" }, String(row.permissionsUsed)),
            el("td", { class: `num money${row.deduction > 0 ? " owed" : ""}` }, money(row.deduction, month.currency)),
          ])
        )),
      ])
    )
  );
  return card;
}

/** Every person's month: lateness, absence, permissions, score and cost. */
function peopleCard(month) {
  const rows = month.people || [];
  const card = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h2", {}, "Everyone this month"),
      el("span", { class: "small muted" },
        month.deductionTotal > 0 ? `${money(month.deductionTotal, month.currency)} deducted` : "No deductions"),
    ]),
  ]);

  if (rows.length === 0) {
    card.append(empty("Nobody to show yet."));
    return card;
  }

  const allowance = (use) =>
    el("span", { class: `allowance${use && use.exceeded ? " over" : ""}` },
      use ? `${use.used}/${use.limit}` : "—");

  card.append(
    el("p", { class: "small muted" }, "Lowest score first, so whoever needs attention is at the top."),
    el("div", { class: "table-wrap" },
      el("table", {}, [
        el("thead", {}, el("tr", {}, [
          el("th", {}, "Employee"),
          el("th", { class: "num" }, "Present"),
          el("th", { class: "num" }, "Late"),
          el("th", { class: "num" }, "Absent"),
          el("th", { class: "num" }, "Permissions"),
          el("th", { class: "num" }, "Score"),
          el("th", {}, "Rating"),
          el("th", { class: "num" }, "Deduction"),
        ])),
        el("tbody", {}, rows.map((row) =>
          el("tr", {}, [
            el("td", {}, [
              el("strong", {}, row.name),
              el("div", { class: "small muted" }, row.department || "—"),
            ]),
            el("td", { class: "num" }, String(row.presentDays)),
            el("td", { class: "num" }, allowance(row.allowances && row.allowances.late)),
            el("td", { class: "num" }, allowance(row.allowances && row.allowances.absent)),
            el("td", { class: "num" }, allowance(row.allowances && row.allowances.permission)),
            el("td", { class: "num mono" }, row.score === null ? "—" : String(row.score)),
            el("td", {}, scorePill(row.score, row.scoreBand)),
            el("td", { class: `num money${row.deduction > 0 ? " owed" : ""}` }, money(row.deduction, month.currency)),
          ])
        )),
      ])
    )
  );
  return card;
}

const legendSwatch = (color, label) =>
  el("span", {}, [el("i", { class: "swatch", style: `background:${color}` }), label]);

function presenceCard(title, rows, emptyMessage) {
  const card = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h2", {}, title), el("span", { class: "pill" }, String(rows.length))]),
  ]);
  if (rows.length === 0) {
    card.append(empty(emptyMessage));
    return card;
  }
  for (const row of rows.slice(0, 12)) {
    card.append(
      el("div", { class: "list-item" }, [
        el("div", { class: "avatar" }, initials(row.name)),
        el("div", { class: "grow" }, [
          el("strong", {}, row.name),
          el("div", { class: "small muted" }, [row.department, row.officeName].filter(Boolean).join(" · ") || "—"),
        ]),
        row.checkInTime ? el("span", { class: "small mono muted" }, row.checkInTime) : null,
        statusPill(row.status),
      ])
    );
  }
  if (rows.length > 12) card.append(el("p", { class: "small muted center" }, `+${rows.length - 12} more`));
  return card;
}

function rankCard(title, rows, describe) {
  const card = el("div", { class: "card" }, el("div", { class: "card-head" }, el("h2", {}, title)));
  if (!rows || rows.length === 0) {
    card.append(empty("Nothing to flag."));
    return card;
  }
  const max = Math.max(...rows.map((row) => Number(describe(row).replace(/\D/g, "")) || 1), 1);
  for (const row of rows) {
    const measure = Number(describe(row).replace(/\D/g, "")) || 0;
    card.append(
      el("div", { style: "padding:9px 0;border-bottom:1px solid var(--border)" }, [
        el("div", { class: "row spread" }, [
          el("strong", {}, row.employee.name),
          el("span", { class: "small mono muted" }, describe(row)),
        ]),
        el("div", { class: "bar", style: "margin-top:6px" }, el("i", { style: `width:${Math.round((measure / max) * 100)}%` })),
      ])
    );
  }
  return card;
}

function pendingCard(leaves, state) {
  const card = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h2", {}, "Waiting for your approval"),
      el("span", { class: "pill" }, String(leaves.length)),
    ]),
  ]);
  if (leaves.length === 0) {
    card.append(empty("No pending requests."));
    return card;
  }
  for (const leave of leaves.slice(0, 6)) {
    card.append(leaveRow(leave, () => state.navigate("approvals")));
  }
  card.append(
    el("button", { class: "btn-block", type: "button", style: "margin-top:12px", onclick: () => state.navigate("approvals") }, "Review all requests")
  );
  return card;
}

function leaveRow(leave, onDecided) {
  const decide = async (status) => {
    const note = status === "rejected" ? await askNote() : null;
    if (status === "rejected" && note === null) return;
    try {
      await api.decideLeave(leave._id, status, note);
      toast(status === "approved" ? "Request approved" : "Request rejected", "ok");
      onDecided();
    } catch (error) {
      toast(error.message, "error");
    }
  };

  return el("div", { class: "list-item" }, [
    el("div", { class: "avatar" }, initials(leave.employee.name)),
    el("div", { class: "grow" }, [
      el("strong", {}, leave.employee.name),
      el("div", { class: "small muted" }, `${LEAVE_LABELS[leave.type] || leave.type} · ${describeLeave(leave)}`),
      el("div", { class: "small muted" }, leave.reason),
    ]),
    leave.status === "pending"
      ? el("div", { class: "row", style: "gap:6px" }, [
          el("button", { class: "btn-sm", type: "button", onclick: () => decide("rejected") }, "Reject"),
          el("button", { class: "btn-sm btn-primary", type: "button", onclick: () => decide("approved") }, "Approve"),
        ])
      : statusPill(leave.status),
  ]);
}

const askNote = () =>
  modal({
    title: "Reason for rejection",
    body: el("div", { class: "field" }, [
      el("label", { for: "reject-note" }, "The employee will see this note"),
      el("textarea", { id: "reject-note", maxLength: 500, placeholder: "Optional" }),
    ]),
    actions: [
      { label: "Cancel", onClick: (close) => close(null) },
      {
        label: "Reject request",
        class: "btn-danger",
        onClick: (close) => close(document.getElementById("reject-note").value || ""),
      },
    ],
  });

/**
 * A stacked bar chart drawn as inline SVG.
 *
 * Hand-drawn rather than pulled from a chart library so the PWA keeps working
 * with no network and no third-party script — which is also what the app's
 * content security policy allows.
 */
function trendChart(trend) {
  const width = 720;
  const height = 180;
  const padding = { top: 10, right: 8, bottom: 26, left: 26 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const max = Math.max(1, ...trend.map((d) => d.onTime + d.late + d.absent + d.onLeave + d.partial));
  const step = plotWidth / Math.max(1, trend.length);
  const barWidth = Math.min(30, step * 0.62);
  const scale = (value) => (value / max) * plotHeight;

  const parts = [];
  // Horizontal guides, so a bar can be read without counting pixels.
  for (let i = 0; i <= 2; i += 1) {
    const value = Math.round((max / 2) * i);
    const y = padding.top + plotHeight - scale(value);
    parts.push(
      `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`,
      `<text x="${padding.left - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${value}</text>`
    );
  }

  trend.forEach((day, index) => {
    const x = padding.left + index * step + (step - barWidth) / 2;
    let y = padding.top + plotHeight;
    const segments = [
      [day.onTime, "var(--ok)"],
      [day.late, "var(--warn)"],
      [day.partial, "var(--brand)"],
      [day.absent, "var(--bad)"],
      [day.onLeave, "var(--info)"],
    ];
    for (const [value, color] of segments) {
      if (value <= 0) continue;
      const barHeight = scale(value);
      y -= barHeight;
      parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" fill="${color}" rx="2"><title>${day.date}: ${value}</title></rect>`);
    }
    // Label every other column so the axis stays readable on a phone.
    if (index % 2 === trend.length % 2) {
      parts.push(
        `<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${day.date.slice(8)}</text>`
      );
    }
  });

  return el("div", { class: "table-wrap" }, [
    el("div", {
      style: "min-width:560px",
      html: `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Attendance over the last 14 days">${parts.join("")}</svg>`,
    }),
  ]);
}

/* ── Employees ───────────────────────────────────────────────────────── */

export async function employeesView(state) {
  const container = el("div", { class: "stack" });
  const list = el("div", {});
  const search = el("input", { type: "search", placeholder: "Search name, email or ID", style: "max-width:260px" });
  const statusFilter = el("select", { style: "max-width:150px" }, [
    el("option", { value: "active" }, "Active"),
    el("option", { value: "" }, "All"),
    el("option", { value: "inactive" }, "Inactive"),
  ]);

  const [shifts, offices] = await Promise.all([
    api.shifts().then((r) => r.shifts),
    api.offices().then((r) => r.offices),
  ]);

  const load = async () => {
    mount(list, el("div", { class: "skeleton" }));
    const { employees } = await api.employees({ search: search.value, status: statusFilter.value });
    if (employees.length === 0) {
      mount(list, empty("No employees match that.", "Try clearing the search."));
      return;
    }
    mount(
      list,
      ...employees.map((employee) =>
        el("div", { class: "list-item" }, [
          el("div", { class: "avatar" }, initials(employee.name)),
          el("div", { class: "grow" }, [
            el("strong", {}, employee.name),
            el("div", { class: "small muted" }, [employee.employeeCode, employee.department, employee.position].filter(Boolean).join(" · ") || employee.email),
          ]),
          employee.role === "admin" ? el("span", { class: "pill" }, "Admin") : null,
          employee.status === "inactive" ? el("span", { class: "pill absent" }, "Inactive") : null,
          el("button", { class: "btn-sm", type: "button", onclick: () => openEmployeeForm(state, shifts, offices, employee, load) }, "Edit"),
        ])
      )
    );
  };

  let debounce;
  search.addEventListener("input", () => {
    clearTimeout(debounce);
    debounce = setTimeout(load, 250);
  });
  statusFilter.addEventListener("change", load);

  container.append(
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", {}, "Employees"),
        el("button", { class: "btn-primary btn-sm", type: "button", onclick: () => openEmployeeForm(state, shifts, offices, null, load) }, "Add employee"),
      ]),
      el("div", { class: "row wrap", style: "margin-bottom:8px" }, [search, statusFilter]),
      list,
    ])
  );

  await load();
  return container;
}

async function openEmployeeForm(state, shifts, offices, employee, onDone) {
  const isEdit = !!employee;
  const form = el("form", { class: "stack" });

  const name = el("input", { name: "name", required: true, value: employee?.name || "" });
  const email = el("input", { name: "email", type: "email", required: true, value: employee?.email || "" });
  const password = el("input", { name: "password", type: "password", minLength: 8, placeholder: "At least 8 characters" });
  const code = el("input", { name: "employeeCode", value: employee?.employeeCode || "" });
  const department = el("input", { name: "department", value: employee?.department || "" });
  const position = el("input", { name: "position", value: employee?.position || "" });
  const phone = el("input", { name: "phone", value: employee?.phone || "" });
  const role = el("select", { name: "role" }, [
    el("option", { value: "employee" }, "Employee"),
    el("option", { value: "admin" }, "Administrator"),
  ]);
  role.value = employee?.role || "employee";
  const shiftSelect = el("select", { name: "shiftId" }, [
    el("option", { value: "" }, "Default shift"),
    ...shifts.map((shift) => el("option", { value: shift._id }, `${shift.name} (${shift.startTime}–${shift.endTime})`)),
  ]);
  shiftSelect.value = employee?.shiftId || "";

  const officeSelect = el("select", { name: "officeId" }, [
    el("option", { value: "" }, "Any office"),
    ...offices.map((office) => el("option", { value: office._id }, office.name)),
  ]);
  officeSelect.value = employee?.officeId || "";

  // The employee's own hours, layered over whichever shift they are on. Left
  // blank, they simply follow the shift.
  const hours = employee?.workingHours || {};
  const customStart = el("input", { type: "time", value: hours.startTime || "" });
  const customEnd = el("input", { type: "time", value: hours.endTime || "" });
  const customGrace = el("input", { type: "number", min: 0, max: 240, value: hours.graceMinutes ?? "" });
  const customDays = DAY_NAMES.map((label, index) => {
    const input = el("input", { type: "checkbox", checked: (hours.workDays || []).includes(index) });
    input.dataset.day = String(index);
    return el("label", { class: "checkbox" }, [input, label]);
  });

  form.append(
    field("Full name", name),
    field("Email", email),
    isEdit ? null : field("Temporary password", password),
    el("div", { class: "field-row" }, [field("Employee ID", code), field("Phone", phone)]),
    el("div", { class: "field-row" }, [field("Department", department), field("Position", position)]),
    el("div", { class: "field-row" }, [field("Role", role), field("Shift", shiftSelect)]),
    field("Office", officeSelect, "Check-in is only accepted at this office. Leave as \u201cAny office\u201d to allow all of them."),
    el("fieldset", {}, [
      el("legend", {}, "Their own hours (optional)"),
      el("p", { class: "small muted" }, "Leave blank to follow the shift. Anything set here applies to this person only."),
      el("div", { class: "field-row" }, [
        field("Starts", customStart),
        field("Ends", customEnd),
        field("Late grace (min)", customGrace),
      ]),
      el("p", { class: "small muted" }, "Working days — leave all unticked to keep the shift\u2019s days."),
      el("div", { class: "row wrap" }, customDays),
    ])
  );

  if (isEdit) {
    form.append(
      el("div", { class: "row wrap", style: "gap:8px" }, [
        el("button", {
          type: "button",
          class: "btn-sm",
          onclick: async () => {
            const newPassword = await askPassword();
            if (!newPassword) return;
            try {
              await api.resetPassword(employee._id, newPassword);
              toast(`Password reset. Give ${employee.name} the new password.`, "ok");
            } catch (error) {
              toast(error.message, "error");
            }
          },
        }, "Reset password"),
        employee.status === "active"
          ? el("button", {
              type: "button",
              class: "btn-sm btn-danger",
              onclick: async () => {
                if (!(await confirmAction("Deactivate employee", `${employee.name} will no longer be able to sign in. Their records are kept.`, "Deactivate"))) return;
                try {
                  await api.deactivateEmployee(employee._id);
                  toast("Employee deactivated", "ok");
                  onDone();
                  document.querySelector(".modal-backdrop")?.remove();
                } catch (error) {
                  toast(error.message, "error");
                }
              },
            }, "Deactivate")
          : el("button", {
              type: "button",
              class: "btn-sm",
              onclick: async () => {
                await api.updateEmployee(employee._id, { status: "active" });
                toast("Employee reactivated", "ok");
                onDone();
                document.querySelector(".modal-backdrop")?.remove();
              },
            }, "Reactivate"),
      ])
    );
  }

  const saved = await modal({
    title: isEdit ? "Edit employee" : "Add employee",
    body: form,
    actions: [
      { label: "Cancel", onClick: (close) => close(null) },
      {
        label: "Save",
        class: "btn-primary",
        onClick: async (close) => {
          if (!form.reportValidity()) return;
          const data = Object.fromEntries(new FormData(form).entries());
          if (!data.shiftId) data.shiftId = null;
          if (!data.officeId) data.officeId = null;

          const pickedDays = customDays
            .map((label) => label.querySelector("input"))
            .filter((input) => input.checked)
            .map((input) => Number(input.dataset.day));
          const custom = {};
          if (customStart.value) custom.startTime = customStart.value;
          if (customEnd.value) custom.endTime = customEnd.value;
          if (customGrace.value !== "") custom.graceMinutes = Number(customGrace.value);
          if (pickedDays.length) custom.workDays = pickedDays;
          if (custom.startTime && custom.endTime && custom.startTime === custom.endTime) {
            toast("Start and end time cannot be the same", "error");
            return;
          }
          data.workingHours = Object.keys(custom).length ? custom : null;
          try {
            if (isEdit) {
              delete data.password;
              await api.updateEmployee(employee._id, data);
            } else {
              if (!data.password || data.password.length < 8) {
                toast("Set a temporary password of at least 8 characters", "error");
                return;
              }
              await api.createEmployee(data);
            }
            close(true);
          } catch (error) {
            toast(error.message, "error");
          }
        },
      },
    ],
  });

  if (saved) {
    toast(isEdit ? "Employee updated" : "Employee added", "ok");
    onDone();
  }
}

const askPassword = () =>
  modal({
    title: "Set a new password",
    body: el("div", { class: "field" }, [
      el("label", { for: "new-pass" }, "New password (at least 8 characters)"),
      el("input", { id: "new-pass", type: "text", minLength: 8, autocomplete: "off" }),
      el("p", { class: "small muted", style: "margin-top:8px" }, "The employee will be asked to change it when they next sign in."),
    ]),
    actions: [
      { label: "Cancel", onClick: (close) => close(null) },
      {
        label: "Set password",
        class: "btn-primary",
        onClick: (close) => {
          const value = document.getElementById("new-pass").value;
          if (!value || value.length < 8) {
            toast("Use at least 8 characters", "error");
            return;
          }
          close(value);
        },
      },
    ],
  });

/* ── Approvals ───────────────────────────────────────────────────────── */

export async function approvalsView(state) {
  const container = el("div", { class: "stack" });
  const list = el("div", {});
  const filter = el("select", { style: "max-width:170px" }, [
    el("option", { value: "pending" }, "Pending"),
    el("option", { value: "approved" }, "Approved"),
    el("option", { value: "rejected" }, "Rejected"),
    el("option", { value: "" }, "All"),
  ]);

  const load = async () => {
    mount(list, el("div", { class: "skeleton" }));
    const { leaves } = await api.leaves({ status: filter.value });
    if (leaves.length === 0) {
      mount(list, empty("Nothing here.", filter.value === "pending" ? "Every request has been dealt with." : undefined));
      state.setPendingCount(0);
      return;
    }
    if (filter.value === "pending") state.setPendingCount(leaves.length);
    mount(list, ...leaves.map((leave) => leaveRow(leave, load)));
  };

  filter.addEventListener("change", load);

  container.append(
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", {}, "Leave & permission requests"), filter]),
      list,
    ])
  );

  await load();
  return container;
}

/* ── Records ─────────────────────────────────────────────────────────── */

export async function recordsView(state) {
  const container = el("div", { class: "stack" });
  const today = todayKey(state.settings.timeZone);
  const body = el("div", {});

  const dateInput = el("input", { type: "date", value: today, style: "max-width:180px" });
  const departmentSelect = el("select", { style: "max-width:180px" }, [el("option", { value: "" }, "All departments")]);
  api.departments().then(({ departments }) => {
    for (const department of departments) departmentSelect.append(el("option", { value: department }, department));
  });

  const load = async () => {
    mount(body, el("div", { class: "skeleton" }));
    const data = await api.dailyReport({ date: dateInput.value, department: departmentSelect.value });
    // On today's date a missing check-out means "still here", not "forgot".
    const isToday = dateInput.value === todayKey(state.settings.timeZone);
    const displayStatus = (entry) =>
      isToday && entry.checkInTime && !entry.checkOutTime ? "working" : entry.status;

    const table = el("table", {}, [
      el("thead", {}, el("tr", {}, [
        el("th", {}, "Employee"),
        el("th", {}, "Status"),
        el("th", {}, "In"),
        el("th", {}, "Out"),
        el("th", { class: "num" }, "Late"),
        el("th", { class: "num" }, "Worked"),
        el("th", {}, "Office"),
        el("th", {}, ""),
      ])),
      el("tbody", {}, data.entries.map((entry) =>
        el("tr", {}, [
          el("td", {}, [
            el("strong", {}, entry.employee.name),
            el("div", { class: "small muted" }, entry.employee.department || "—"),
          ]),
          el("td", {}, statusPill(displayStatus(entry))),
          el("td", { class: "mono" }, entry.checkInTime || "—"),
          el("td", { class: "mono" }, entry.checkOutTime || "—"),
          el("td", { class: "num mono" }, entry.lateMinutes ? formatDuration(entry.lateMinutes) : "—"),
          el("td", { class: "num mono" }, entry.workedMinutes ? formatDuration(entry.workedMinutes) : "—"),
          el("td", { class: "small muted" }, entry.officeName || "—"),
          el("td", {}, el("button", {
            class: "btn-sm",
            type: "button",
            onclick: () => openRecordForm(entry, dateInput.value, load),
          }, entry.recordId ? "Edit" : "Add")),
        ])
      )),
    ]);

    mount(
      body,
      el("div", { class: "grid stats", style: "margin-bottom:14px" }, [
        stat("Present", data.summary.presentDays),
        stat("Late", data.summary.lateDays),
        stat("Absent", data.summary.absentDays),
        stat("On leave", data.summary.leaveDays),
      ]),
      data.entries.length ? el("div", { class: "table-wrap" }, table) : empty("No employees to show.")
    );
  };

  dateInput.addEventListener("change", load);
  departmentSelect.addEventListener("change", load);

  container.append(
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", {}, "Daily records"),
        el("div", { class: "row wrap" }, [dateInput, departmentSelect]),
      ]),
      body,
    ])
  );

  await load();
  return container;
}

async function openRecordForm(entry, date, onDone) {
  const checkIn = el("input", { type: "time", value: entry.checkInTime || "" });
  const checkOut = el("input", { type: "time", value: entry.checkOutTime || "" });
  const note = el("input", { type: "text", maxLength: 280, placeholder: "Why is this being changed?" });

  const saved = await modal({
    title: `${entry.employee.name} — ${formatDate(date)}`,
    body: el("div", { class: "stack" }, [
      el("p", { class: "small muted" }, "Corrections are recorded in the audit trail with your name."),
      el("div", { class: "field-row" }, [
        field("Check in", checkIn),
        field("Check out", checkOut),
      ]),
      field("Note", note),
    ]),
    actions: [
      { label: "Cancel", onClick: (close) => close(null) },
      {
        label: "Save",
        class: "btn-primary",
        onClick: async (close) => {
          if (!checkIn.value && !checkOut.value) {
            toast("Enter at least one time", "error");
            return;
          }
          try {
            if (entry.recordId) {
              await api.editRecord(entry.recordId, {
                checkInTime: checkIn.value || null,
                checkOutTime: checkOut.value || null,
                note: note.value,
              });
            } else {
              await api.createRecord({
                userId: entry.employee._id,
                date,
                checkInTime: checkIn.value || null,
                checkOutTime: checkOut.value || null,
                note: note.value,
              });
            }
            close(true);
          } catch (error) {
            toast(error.message, "error");
          }
        },
      },
    ],
  });

  if (saved) {
    toast("Record updated", "ok");
    onDone();
  }
}

/* ── Reports ─────────────────────────────────────────────────────────── */

export async function reportsView(state) {
  const container = el("div", { class: "stack" });
  const today = todayKey(state.settings.timeZone);
  const month = monthRange(today);

  const fromInput = el("input", { type: "date", value: month.from, style: "max-width:170px" });
  const toInput = el("input", { type: "date", value: today, style: "max-width:170px" });
  const departmentSelect = el("select", { style: "max-width:180px" }, [el("option", { value: "" }, "All departments")]);
  api.departments().then(({ departments }) => {
    for (const department of departments) departmentSelect.append(el("option", { value: department }, department));
  });

  const body = el("div", {});
  const params = () => ({ from: fromInput.value, to: toInput.value, department: departmentSelect.value });

  const load = async () => {
    mount(body, el("div", { class: "skeleton" }));
    try {
      const report = await api.reportSummary(params());
      mount(body, reportTables(report));
    } catch (error) {
      mount(body, empty(error.message));
    }
  };

  const exportButton = el("button", { class: "btn-sm", type: "button" }, "Export Excel");
  exportButton.addEventListener("click", async () => {
    await withBusy(exportButton, "Preparing…", async () => {
      try {
        const blob = await api.download({ ...params(), format: "xlsx" });
        const url = URL.createObjectURL(blob);
        const link = el("a", { href: url, download: `attendance_${fromInput.value}_to_${toInput.value}.xlsx` });
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });

  const csvButton = el("button", { class: "btn-sm", type: "button" }, "Export CSV");
  csvButton.addEventListener("click", async () => {
    const blob = await api.download({ ...params(), format: "csv", sheet: "detail" });
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: `attendance_detail_${fromInput.value}_to_${toInput.value}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  for (const input of [fromInput, toInput, departmentSelect]) input.addEventListener("change", load);

  container.append(
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [el("h2", {}, "Reports"), el("div", { class: "row" }, [csvButton, exportButton])]),
      el("div", { class: "row wrap", style: "margin-bottom:12px" }, [
        field("From", fromInput),
        field("To", toInput),
        field("Department", departmentSelect),
      ]),
      body,
    ])
  );

  await load();
  return container;
}

function reportTables(report) {
  const wrap = el("div", { class: "stack" });
  const totals = report.totals;

  wrap.append(
    el("div", { class: "grid stats" }, [
      stat("Days present", totals.presentDays, true),
      stat("Absences", totals.absentDays),
      stat("Late arrivals", totals.lateDays),
      stat("Total lateness", formatDuration(totals.lateMinutes)),
      stat("Hours worked", `${totals.workedHours}h`),
      stat("Attendance", `${totals.attendanceRate}%`),
    ])
  );

  if (report.departments.length > 1) {
    wrap.append(
      el("h3", { style: "margin-top:8px" }, "By department"),
      el("div", { class: "table-wrap" },
        el("table", {}, [
          el("thead", {}, el("tr", {}, [
            el("th", {}, "Department"),
            el("th", { class: "num" }, "People"),
            el("th", { class: "num" }, "Present"),
            el("th", { class: "num" }, "Absent"),
            el("th", { class: "num" }, "Late"),
            el("th", { class: "num" }, "Attendance"),
          ])),
          el("tbody", {}, report.departments.map((row) =>
            el("tr", {}, [
              el("td", {}, row.department),
              el("td", { class: "num" }, String(row.employees)),
              el("td", { class: "num" }, String(row.summary.presentDays)),
              el("td", { class: "num" }, String(row.summary.absentDays)),
              el("td", { class: "num" }, String(row.summary.lateDays)),
              el("td", { class: "num" }, `${row.summary.attendanceRate}%`),
            ])
          )),
        ])
      )
    );
  }

  wrap.append(
    el("h3", { style: "margin-top:8px" }, "By employee"),
    el("div", { class: "table-wrap" },
      el("table", {}, [
        el("thead", {}, el("tr", {}, [
          el("th", {}, "Employee"),
          el("th", { class: "num" }, "Present"),
          el("th", { class: "num" }, "Absent"),
          el("th", { class: "num" }, "Leave"),
          el("th", { class: "num" }, "Late days"),
          el("th", { class: "num" }, "Late time"),
          el("th", { class: "num" }, "Hours"),
          el("th", { class: "num" }, "Overtime"),
          el("th", { class: "num" }, "Attendance"),
        ])),
        el("tbody", {}, report.employees.map((row) =>
          el("tr", {}, [
            el("td", {}, [
              el("strong", {}, row.employee.name),
              el("div", { class: "small muted" }, row.employee.department || "—"),
            ]),
            el("td", { class: "num" }, String(row.summary.presentDays)),
            el("td", { class: "num" }, String(row.summary.absentDays)),
            el("td", { class: "num" }, String(row.summary.leaveDays)),
            el("td", { class: "num" }, String(row.summary.lateDays)),
            el("td", { class: "num mono" }, formatDuration(row.summary.lateMinutes)),
            el("td", { class: "num mono" }, `${row.summary.workedHours}h`),
            el("td", { class: "num mono" }, `${row.summary.overtimeHours}h`),
            el("td", { class: "num" }, `${row.summary.attendanceRate}%`),
          ])
        )),
      ])
    )
  );

  return wrap;
}

/* ── Settings ────────────────────────────────────────────────────────── */

export async function settingsView(state) {
  const container = el("div", { class: "stack" });
  const [settingsResponse, officesResponse, shiftsResponse] = await Promise.all([
    api.settings(),
    api.offices(),
    api.shifts(),
  ]);

  container.append(
    organisationCard(settingsResponse.settings, state),
    policyCard(settingsResponse.settings, state),
    officesCard(officesResponse.offices, state),
    shiftsCard(shiftsResponse.shifts, state),
    await holidaysCard(state)
  );
  return container;
}

function organisationCard(settings, state) {
  const companyName = el("input", { value: settings.companyName });
  const timeZone = el("input", { value: settings.timeZone });
  const alertTime = el("input", { type: "time", value: settings.alerts.noShowAlertTime });
  const alertEmails = el("input", { value: (settings.alerts.adminEmails || []).join(", "), placeholder: "you@company.com, hr@company.com" });
  const noShow = el("input", { type: "checkbox", checked: settings.alerts.sendNoShowAlert });
  const monthly = el("input", { type: "checkbox", checked: settings.alerts.sendMonthlyReport });
  const radius = el("input", { type: "number", min: 20, max: 5000, value: settings.geo.maxAccuracyMeters });

  const save = el("button", { class: "btn-primary btn-sm", type: "button" }, "Save");
  save.addEventListener("click", async () => {
    await withBusy(save, "Saving", async () => {
      try {
        const { settings: updated } = await api.updateSettings({
          companyName: companyName.value,
          timeZone: timeZone.value,
          geo: { maxAccuracyMeters: Number(radius.value) },
          alerts: {
            noShowAlertTime: alertTime.value,
            sendNoShowAlert: noShow.checked,
            sendMonthlyReport: monthly.checked,
            adminEmails: alertEmails.value.split(",").map((s) => s.trim()).filter(Boolean),
          },
        });
        state.settings = { ...state.settings, ...updated };
        toast("Settings saved", "ok");
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });

  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h2", {}, "Organisation"), save]),
    el("div", { class: "field-row" }, [
      field("Company name", companyName),
      field("Timezone (IANA)", timeZone),
    ]),
    el("p", { class: "small muted" }, "Every date, shift time and report is calculated in this timezone."),
    el("fieldset", {}, [
      el("legend", {}, "Alerts"),
      field("Send alerts to", alertEmails),
      el("p", { class: "small muted" }, "Leave blank to email every administrator."),
      el("div", { class: "field-row" }, [
        field("Daily no-show alert at", alertTime),
        field("Reject GPS less accurate than (m)", radius),
      ]),
      el("label", { class: "checkbox" }, [noShow, "Email me who has not checked in"]),
      el("label", { class: "checkbox" }, [monthly, "Email the monthly report on the 1st"]),
    ]),
  ]);
}

/** The rules that decide allowances and what an absence costs. */
function policyCard(settings, state) {
  const policy = settings.policy || {};
  const lateLimit = el("input", { type: "number", min: 0, max: 31, value: policy.maxLateDaysPerMonth ?? 3 });
  const absentLimit = el("input", { type: "number", min: 0, max: 31, value: policy.maxAbsentDaysPerMonth ?? 2 });
  const permissionLimit = el("input", { type: "number", min: 0, max: 31, value: policy.maxPermissionsPerMonth ?? 2 });
  const deduction = el("input", { type: "number", min: 0, step: "1", value: policy.absentDeductionPerDay ?? 500 });
  const currency = el("input", { maxLength: 8, value: policy.currency || "ETB" });

  const save = el("button", { class: "btn-primary btn-sm", type: "button" }, "Save");
  save.addEventListener("click", async () => {
    await withBusy(save, "Saving", async () => {
      try {
        const { settings: updated } = await api.updateSettings({
          policy: {
            maxLateDaysPerMonth: Number(lateLimit.value),
            maxAbsentDaysPerMonth: Number(absentLimit.value),
            maxPermissionsPerMonth: Number(permissionLimit.value),
            absentDeductionPerDay: Number(deduction.value),
            currency: currency.value.trim() || "ETB",
          },
        });
        state.settings = { ...state.settings, ...updated };
        toast("Rules saved", "ok");
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });

  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h2", {}, "Rules"), save]),
    el("p", { class: "small muted" }, "Allowances are counted per employee per calendar month."),
    el("div", { class: "field-row" }, [
      field("Late days allowed", lateLimit),
      field("Absences allowed", absentLimit),
      field("Permissions allowed", permissionLimit),
    ]),
    el("p", { class: "small muted" }, "Once the permission allowance is used up, an employee cannot request another until the next month begins."),
    el("div", { class: "field-row" }, [
      field("Deduction per absent day", deduction),
      field("Currency", currency),
    ]),
    el("p", { class: "small muted" }, "An absent day is a working day with no check-in, no approved leave and no approved permission. Approved absences are never deducted."),
  ]);
}

function officesCard(offices, state) {
  const list = el("div", {});
  const render = (rows) => {
    if (rows.length === 0) {
      mount(list, empty("No office locations yet.", "Add one so employees can check in."));
      return;
    }
    mount(list, ...rows.map((office) =>
      el("div", { class: "list-item" }, [
        el("div", { class: "grow" }, [
          el("strong", {}, office.name),
          el("div", { class: "small muted mono" }, `${office.lat.toFixed(5)}, ${office.lng.toFixed(5)} · ${office.radiusMeters} m`),
          office.address ? el("div", { class: "small muted" }, office.address) : null,
        ]),
        office.active === false ? el("span", { class: "pill" }, "Off") : null,
        el("button", { class: "btn-sm", type: "button", onclick: () => openOfficeForm(office, reload) }, "Edit"),
      ])
    ));
  };
  const reload = async () => render((await api.offices()).offices);
  render(offices);

  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h2", {}, "Office locations"),
      el("button", { class: "btn-primary btn-sm", type: "button", onclick: () => openOfficeForm(null, reload) }, "Add office"),
    ]),
    el("p", { class: "small muted" }, "Employees can only check in inside one of these circles."),
    list,
  ]);
}

async function openOfficeForm(office, onDone) {
  const name = el("input", { required: true, value: office?.name || "" });
  const lat = el("input", { type: "number", step: "any", required: true, value: office?.lat ?? "" });
  const lng = el("input", { type: "number", step: "any", required: true, value: office?.lng ?? "" });
  const radius = el("input", { type: "number", min: 20, max: 5000, value: office?.radiusMeters ?? 100 });
  const address = el("input", { value: office?.address || "" });
  const active = el("input", { type: "checkbox", checked: office ? office.active !== false : true });

  const useHere = el("button", { class: "btn-sm", type: "button" }, "Use my current location");
  useHere.addEventListener("click", async () => {
    await withBusy(useHere, "Locating…", async () => {
      try {
        const { currentPosition } = await import("../geo.js");
        const point = await currentPosition();
        lat.value = point.lat.toFixed(6);
        lng.value = point.lng.toFixed(6);
        toast(`Location captured (±${point.accuracy} m)`, "ok");
      } catch (error) {
        toast(error.message, "error");
      }
    });
  });

  const body = el("div", { class: "stack" }, [
    field("Name", name),
    el("div", { class: "field-row" }, [
      field("Latitude", lat),
      field("Longitude", lng),
    ]),
    useHere,
    field("Allowed radius (metres)", radius),
    el("p", { class: "small muted" }, "100 m suits most buildings. Too small and phones indoors will be refused."),
    field("Address (optional)", address),
    el("label", { class: "checkbox" }, [active, "Active"]),
    office
      ? el("button", {
          class: "btn-sm btn-danger",
          type: "button",
          onclick: async () => {
            if (!(await confirmAction("Delete office", `${office.name} will be removed. Past records keep their history.`, "Delete"))) return;
            await api.deleteOffice(office._id);
            toast("Office deleted", "ok");
            onDone();
            document.querySelector(".modal-backdrop")?.remove();
          },
        }, "Delete this office")
      : null,
  ]);

  const saved = await modal({
    title: office ? "Edit office" : "Add office",
    body,
    actions: [
      { label: "Cancel", onClick: (close) => close(null) },
      {
        label: "Save",
        class: "btn-primary",
        onClick: async (close) => {
          const payload = {
            name: name.value,
            lat: Number(lat.value),
            lng: Number(lng.value),
            radiusMeters: Number(radius.value),
            address: address.value,
            active: active.checked,
          };
          if (!payload.name || Number.isNaN(payload.lat) || Number.isNaN(payload.lng)) {
            toast("Name and coordinates are required", "error");
            return;
          }
          try {
            if (office) await api.updateOffice(office._id, payload);
            else await api.createOffice(payload);
            close(true);
          } catch (error) {
            toast(error.message, "error");
          }
        },
      },
    ],
  });

  if (saved) {
    toast("Office saved", "ok");
    onDone();
  }
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function shiftsCard(shifts, state) {
  const list = el("div", {});
  const render = (rows) =>
    mount(list, ...rows.map((shift) =>
      el("div", { class: "list-item" }, [
        el("div", { class: "grow" }, [
          el("strong", {}, shift.name),
          el("div", { class: "small muted" }, `${shift.startTime}–${shift.endTime} · ${(shift.workDays || []).map((d) => DAY_NAMES[d]).join(", ")}`),
          el("div", { class: "small muted" }, `${shift.graceMinutes ?? 0} min grace · ${shift.breakMinutes ?? 0} min break`),
        ]),
        shift.isDefault ? el("span", { class: "pill" }, "Default") : null,
        el("button", { class: "btn-sm", type: "button", onclick: () => openShiftForm(shift, reload) }, "Edit"),
      ])
    ));
  const reload = async () => render((await api.shifts()).shifts);
  render(shifts);

  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h2", {}, "Shifts"),
      el("button", { class: "btn-primary btn-sm", type: "button", onclick: () => openShiftForm(null, reload) }, "Add shift"),
    ]),
    el("p", { class: "small muted" }, "Working hours decide who is late, who left early and who was absent."),
    list,
  ]);
}

async function openShiftForm(shift, onDone) {
  const name = el("input", { required: true, value: shift?.name || "" });
  const start = el("input", { type: "time", required: true, value: shift?.startTime || "09:00" });
  const end = el("input", { type: "time", required: true, value: shift?.endTime || "17:00" });
  const grace = el("input", { type: "number", min: 0, max: 240, value: shift?.graceMinutes ?? 10 });
  const earlyGrace = el("input", { type: "number", min: 0, max: 240, value: shift?.earlyLeaveGraceMinutes ?? 10 });
  const breakMinutes = el("input", { type: "number", min: 0, max: 480, value: shift?.breakMinutes ?? 0 });
  const overtime = el("input", { type: "checkbox", checked: shift ? shift.countOvertime !== false : true });
  const isDefault = el("input", { type: "checkbox", checked: !!shift?.isDefault });

  const selected = new Set(shift?.workDays || [1, 2, 3, 4, 5]);
  const dayToggles = DAY_NAMES.map((label, index) => {
    const input = el("input", { type: "checkbox", checked: selected.has(index) });
    input.dataset.day = String(index);
    return el("label", { class: "checkbox" }, [input, label]);
  });

  const body = el("div", { class: "stack" }, [
    field("Name", name),
    el("div", { class: "field-row" }, [
      field("Starts", start),
      field("Ends", end),
    ]),
    el("p", { class: "small muted" }, "An end time earlier than the start means an overnight shift."),
    el("fieldset", {}, [el("legend", {}, "Working days"), el("div", { class: "row wrap" }, dayToggles)]),
    el("div", { class: "field-row" }, [
      field("Late grace (min)", grace),
      field("Early-leave grace (min)", earlyGrace),
      field("Unpaid break (min)", breakMinutes),
    ]),
    el("label", { class: "checkbox" }, [overtime, "Count overtime after the shift ends"]),
    el("label", { class: "checkbox" }, [isDefault, "Use as the default shift for new employees"]),
    shift
      ? el("button", {
          class: "btn-sm btn-danger",
          type: "button",
          onclick: async () => {
            if (!(await confirmAction("Delete shift", `${shift.name} will be removed.`, "Delete"))) return;
            try {
              await api.deleteShift(shift._id);
              toast("Shift deleted", "ok");
              onDone();
              document.querySelector(".modal-backdrop")?.remove();
            } catch (error) {
              toast(error.message, "error");
            }
          },
        }, "Delete this shift")
      : null,
  ]);

  const saved = await modal({
    title: shift ? "Edit shift" : "Add shift",
    body,
    actions: [
      { label: "Cancel", onClick: (close) => close(null) },
      {
        label: "Save",
        class: "btn-primary",
        onClick: async (close) => {
          const workDays = dayToggles
            .map((label) => label.querySelector("input"))
            .filter((input) => input.checked)
            .map((input) => Number(input.dataset.day));
          if (workDays.length === 0) {
            toast("Pick at least one working day", "error");
            return;
          }
          const payload = {
            name: name.value,
            startTime: start.value,
            endTime: end.value,
            workDays,
            graceMinutes: Number(grace.value),
            earlyLeaveGraceMinutes: Number(earlyGrace.value),
            breakMinutes: Number(breakMinutes.value),
            countOvertime: overtime.checked,
            isDefault: isDefault.checked,
          };
          try {
            if (shift) await api.updateShift(shift._id, payload);
            else await api.createShift(payload);
            close(true);
          } catch (error) {
            toast(error.message, "error");
          }
        },
      },
    ],
  });

  if (saved) {
    toast("Shift saved", "ok");
    onDone();
  }
}

async function holidaysCard(state) {
  const list = el("div", {});
  const year = todayKey(state.settings.timeZone).slice(0, 4);

  const reload = async () => {
    const { holidays } = await api.holidays({ from: `${year}-01-01`, to: `${year}-12-31` });
    if (holidays.length === 0) {
      mount(list, empty("No holidays set for this year."));
      return;
    }
    mount(list, ...holidays.map((holiday) =>
      el("div", { class: "list-item" }, [
        el("div", { class: "grow" }, [
          el("strong", {}, holiday.name),
          el("div", { class: "small muted" }, formatDate(holiday.date, { weekday: "long", day: "numeric", month: "long" })),
        ]),
        el("button", {
          class: "btn-sm",
          type: "button",
          onclick: async () => {
            if (!(await confirmAction("Remove holiday", `${holiday.name} will count as a normal working day.`, "Remove"))) return;
            await api.deleteHoliday(holiday._id);
            toast("Holiday removed", "ok");
            reload();
          },
        }, "Remove"),
      ])
    ));
  };

  const add = el("button", { class: "btn-primary btn-sm", type: "button" }, "Add holiday");
  add.addEventListener("click", async () => {
    const date = el("input", { type: "date", required: true, value: todayKey(state.settings.timeZone) });
    const name = el("input", { required: true, placeholder: "e.g. National Day" });
    const saved = await modal({
      title: "Add public holiday",
      body: el("div", { class: "stack" }, [
        field("Date", date),
        field("Name", name),
        el("p", { class: "small muted" }, "Nobody is marked absent on a holiday."),
      ]),
      actions: [
        { label: "Cancel", onClick: (close) => close(null) },
        {
          label: "Add",
          class: "btn-primary",
          onClick: async (close) => {
            if (!date.value || !name.value) {
              toast("Both fields are required", "error");
              return;
            }
            try {
              await api.createHoliday({ date: date.value, name: name.value });
              close(true);
            } catch (error) {
              toast(error.message, "error");
            }
          },
        },
      ],
    });
    if (saved) {
      toast("Holiday added", "ok");
      reload();
    }
  });

  await reload();
  return el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [el("h2", {}, `Public holidays ${year}`), add]),
    list,
  ]);
}
