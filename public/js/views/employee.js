import { api } from "../api.js";
import {
  el, mount, field, toast, modal, confirmAction, empty, statusPill, formatDuration,
  formatDate, formatDateLong, monthRange, todayKey, initials,
  LEAVE_LABELS, STATUS_LABELS, icon, withBusy, scene, tiltOnPointer, celebrate,
} from "../ui.js";
import { bestPosition, currentPosition, nearestOffice, supported as geoSupported } from "../geo.js";

/* ── Home: the check-in screen ───────────────────────────────────────── */

export async function homeView(state) {
  const container = el("div", { class: "stack" });
  const [today, officesResponse] = await Promise.all([api.today(), api.offices()]);
  const offices = officesResponse.offices || [];

  const clock = el("div", { class: "clock mono" }, "--:--");
  const geoDot = el("span", { class: "geo-dot pending" });
  const geoText = el("span", {}, geoSupported() ? "Finding your location…" : "Location not available on this device");
  const geoLine = el("div", { class: "geo-line" }, [geoDot, geoText]);

  const tickClock = () => {
    clock.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: today.timeZone,
    }).format(new Date());
  };
  tickClock();
  const timer = setInterval(tickClock, 20000);
  state.onLeaveView(() => clearInterval(timer));

  const punchButton = el("button", { class: "punch", type: "button" });
  const hero = el("div", { class: "card hero" }, [
    scene(3),
    clock,
    el("div", { class: "date" }, formatDateLong(today.date)),
    punchButton,
    geoLine,
  ]);

  // The button tilts towards the pointer across the whole hero, so it reads as
  // an object sitting in the card rather than a flat circle.
  state.onLeaveView(tiltOnPointer(punchButton, { scope: hero, max: 10 }));

  const renderPunch = () => {
    punchButton.className = `punch${today.canCheckOut ? " out" : ""}`;
    punchButton.disabled = !today.canCheckIn && !today.canCheckOut;
    punchButton.innerHTML = "";

    if (today.canCheckIn) {
      punchButton.append(icon("clockIn"), el("span", {}, "Check in"), el("span", { class: "sub" }, `Shift starts ${today.shift.startTime}`));
    } else if (today.canCheckOut) {
      punchButton.append(icon("clockIn"), el("span", {}, "Check out"), el("span", { class: "sub" }, `Since ${formatMinutes(today.record.checkIn.minutes)}`));
    } else {
      punchButton.append(icon("check"), el("span", {}, "All done"), el("span", { class: "sub" }, "See you tomorrow"));
    }
  };
  renderPunch();

  /* Ambient distance so nobody taps the button from the car park and guesses. */
  let lastPoint = null;
  const refreshDistance = async () => {
    if (!geoSupported()) {
      geoDot.className = "geo-dot bad";
      return;
    }
    try {
      lastPoint = await currentPosition();
      const nearest = nearestOffice(lastPoint, offices);
      if (!nearest) {
        geoDot.className = "geo-dot";
        geoText.textContent = "No office location has been set up yet";
        return;
      }
      const inside = nearest.distance <= (nearest.office.radiusMeters || 100);
      geoDot.className = `geo-dot ${inside ? "ok" : "bad"}`;
      geoText.textContent = inside
        ? `At ${nearest.office.name} · ±${lastPoint.accuracy} m`
        : `${nearest.distance} m from ${nearest.office.name} · ±${lastPoint.accuracy} m`;
    } catch (error) {
      geoDot.className = "geo-dot bad";
      geoText.textContent = error.message;
    }
  };
  refreshDistance();

  punchButton.addEventListener("click", async () => {
    const isCheckIn = today.canCheckIn;
    try {
      await withBusy(punchButton, "Locating…", async () => {
        const point = await bestPosition({
          onProgress: (fix) => {
            geoText.textContent = `Improving accuracy… ±${fix.accuracy} m`;
          },
        });
        const response = isCheckIn
          ? await api.checkIn({ lat: point.lat, lng: point.lng, accuracy: point.accuracy })
          : await api.checkOut({ lat: point.lat, lng: point.lng, accuracy: point.accuracy });

        Object.assign(today, await api.today());
        celebrate(punchButton);
        toast(response.message, "ok");
      });
    } catch (error) {
      // A geofence rejection is the common case and deserves the full detail.
      toast(error.message, "error");
    } finally {
      renderPunch();
      renderStatus();
      refreshDistance();
    }
  });

  const statusCard = el("div", { class: "card" });
  const renderStatus = () => {
    const rows = [];
    const record = today.record;

    rows.push(
      el("div", { class: "row spread" }, [
        el("div", {}, [
          el("div", { class: "small muted" }, "Shift"),
          el("strong", {}, `${today.shift.name} · ${today.shift.startTime}–${today.shift.endTime}`),
        ]),
        today.isHoliday
          ? statusPill("holiday")
          : today.onLeave
          ? statusPill("on_leave")
          : !today.shift.workDay
          ? statusPill("weekend")
          : record
          ? statusPill(today.canCheckOut ? "working" : record.status)
          : null,
      ])
    );

    if (today.office) {
      rows.push(el("p", { class: "small muted" }, `You check in at ${today.office}.`));
    }
    if (today.holidayName) rows.push(el("p", { class: "small muted" }, `Today is ${today.holidayName}.`));
    if (today.onLeave) rows.push(el("p", { class: "small muted" }, `You are on approved ${LEAVE_LABELS[today.leaveType] || "leave"} today.`));
    for (const permission of today.permissions) {
      rows.push(el("p", { class: "small muted" }, `Approved permission ${permission.from}–${permission.to}.`));
    }

    if (record) {
      rows.push(
        el("div", { class: "grid stats", style: "margin-top:12px" }, [
          statTile("Checked in", record.checkIn ? formatMinutes(record.checkIn.minutes) : "—"),
          statTile("Checked out", record.checkOut ? formatMinutes(record.checkOut.minutes) : "—"),
          statTile("Worked", formatDuration(record.workedMinutes)),
          record.lateMinutes > 0 ? statTile("Late by", formatDuration(record.lateMinutes)) : null,
          record.overtimeMinutes > 0 ? statTile("Overtime", formatDuration(record.overtimeMinutes)) : null,
        ])
      );
      if (record.checkIn && record.checkIn.officeName) {
        rows.push(el("p", { class: "small muted", style: "margin-top:10px" }, `Checked in at ${record.checkIn.officeName}.`));
      }
    } else if (today.shift.workDay && !today.isHoliday && !today.onLeave) {
      rows.push(el("p", { class: "small muted", style: "margin-top:8px" }, "You haven't checked in yet today."));
    }

    mount(statusCard, ...rows.filter(Boolean));
  };
  renderStatus();

  const summaryCard = el("div", { class: "card" }, el("div", { class: "skeleton" }));
  container.append(hero, statusCard, summaryCard);

  api.myAttendance({}).then((data) => {
    const s = data.summary;
    mount(
      summaryCard,
      el("div", { class: "card-head" }, [el("h2", {}, "This month"), el("span", { class: "small muted" }, `${data.range.from} → ${data.range.to}`)]),
      el("div", { class: "grid stats" }, [
        statTile("Days present", s.presentDays),
        statTile("Late arrivals", s.lateDays),
        statTile("Absences", s.absentDays),
        statTile("Hours worked", `${s.workedHours}h`),
      ])
    );
  });

  return container;
}

const statTile = (label, value) =>
  el("div", { class: "stat" }, [el("div", { class: "value mono" }, String(value)), el("div", { class: "label" }, label)]);

const formatMinutes = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

/* ── My attendance ───────────────────────────────────────────────────── */

export async function myAttendanceView(state) {
  const container = el("div", { class: "stack" });
  let month = todayKey(state.settings.timeZone).slice(0, 7);

  const header = el("div", { class: "card-head" });
  const body = el("div", {});
  const card = el("div", { class: "card" }, [header, body]);
  container.append(card);

  const load = async () => {
    mount(body, el("div", { class: "skeleton" }));
    const range = monthRange(`${month}-01`);
    const data = await api.myAttendance(range);

    mount(
      header,
      el("h2", {}, new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })),
      el("div", { class: "row" }, [
        el("button", { class: "btn-sm", type: "button", onclick: () => shift(-1) }, "‹"),
        el("button", { class: "btn-sm", type: "button", onclick: () => shift(1) }, "›"),
      ])
    );

    mount(
      body,
      el("div", { class: "grid stats", style: "margin-bottom:16px" }, [
        statTile("Present", data.summary.presentDays),
        statTile("Late", data.summary.lateDays),
        statTile("Absent", data.summary.absentDays),
        statTile("Leave", data.summary.leaveDays),
        statTile("Hours", `${data.summary.workedHours}h`),
        statTile("Late time", formatDuration(data.summary.lateMinutes)),
      ]),
      calendar(data.days, state.settings.timeZone),
      legend(),
      dayList(data.days)
    );
  };

  const shift = (delta) => {
    const [y, m] = month.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1 + delta, 1));
    month = date.toISOString().slice(0, 7);
    load();
  };

  await load();
  return container;
}

function calendar(days, timeZone) {
  const grid = el("div", { class: "calendar" });
  for (const name of ["S", "M", "T", "W", "T", "F", "S"]) {
    grid.append(el("div", { class: "dow" }, name));
  }
  if (days.length === 0) return grid;

  const today = todayKey(timeZone);
  const firstWeekday = new Date(`${days[0].date}T00:00:00Z`).getUTCDay();
  for (let i = 0; i < firstWeekday; i += 1) grid.append(el("div", { class: "day blank" }));

  for (const day of days) {
    const number = Number(day.date.slice(-2));
    grid.append(
      el(
        "button",
        {
          class: `day ${day.status}${day.date === today ? " today" : ""}`,
          type: "button",
          title: `${formatDate(day.date)} — ${STATUS_LABELS[day.status] || day.status}`,
          onclick: () => showDay(day),
        },
        [el("span", {}, String(number))]
      )
    );
  }
  return grid;
}

const legend = () =>
  el("div", { class: "legend" }, [
    legendItem("var(--ok)", "Present"),
    legendItem("var(--warn)", "Late / short"),
    legendItem("var(--bad)", "Absent"),
    legendItem("var(--info)", "Leave / holiday"),
  ]);

const legendItem = (color, label) =>
  el("span", {}, [el("i", { class: "swatch", style: `background:${color}` }), label]);

const showDay = (day) =>
  modal({
    title: formatDateLong(day.date),
    body: el("div", { class: "stack" }, [
      el("div", { class: "row spread" }, [el("span", { class: "muted" }, "Status"), statusPill(day.status)]),
      detailRow("Checked in", day.checkInTime || "—"),
      detailRow("Checked out", day.checkOutTime || "—"),
      detailRow("Worked", formatDuration(day.workedMinutes)),
      day.lateMinutes > 0 ? detailRow("Late by", formatDuration(day.lateMinutes)) : null,
      day.earlyLeaveMinutes > 0 ? detailRow("Left early by", formatDuration(day.earlyLeaveMinutes)) : null,
      day.overtimeMinutes > 0 ? detailRow("Overtime", formatDuration(day.overtimeMinutes)) : null,
      day.excusedMinutes > 0 ? detailRow("Excused (permission)", formatDuration(day.excusedMinutes)) : null,
      day.officeName ? detailRow("Office", day.officeName) : null,
      day.holidayName ? detailRow("Holiday", day.holidayName) : null,
      day.leaveType ? detailRow("Leave", LEAVE_LABELS[day.leaveType] || day.leaveType) : null,
      day.autoCheckout ? el("p", { class: "small muted" }, "Checked out automatically at the end of the shift.") : null,
      day.edited ? el("p", { class: "small muted" }, "This record was corrected by an admin.") : null,
    ]),
  });

const detailRow = (label, value) =>
  el("div", { class: "row spread" }, [el("span", { class: "muted" }, label), el("strong", { class: "mono" }, String(value))]);

function dayList(days) {
  const notable = days.filter((day) => !["weekend", "holiday", "upcoming"].includes(day.status));
  if (notable.length === 0) return empty("Nothing recorded this month yet.");

  const wrap = el("div", { style: "margin-top:16px" });
  for (const day of [...notable].reverse()) {
    wrap.append(
      el("div", { class: "list-item", onclick: () => showDay(day) }, [
        el("div", { class: "grow" }, [
          el("strong", {}, formatDate(day.date)),
          el("div", { class: "small muted" }, day.checkInTime ? `${day.checkInTime} – ${day.checkOutTime || "…"}` : "No check-in"),
        ]),
        day.lateMinutes > 0 ? el("span", { class: "small muted" }, `+${formatDuration(day.lateMinutes)}`) : null,
        statusPill(day.status),
      ])
    );
  }
  return wrap;
}

/* ── Leave & permission ──────────────────────────────────────────────── */

export async function myLeaveView(state) {
  const container = el("div", { class: "stack" });
  const list = el("div", {});

  const allowanceLine = el("p", { class: "small muted" });

  const load = async () => {
    mount(list, el("div", { class: "skeleton" }));
    const { leaves, permissionAllowance } = await api.myLeaves();

    if (permissionAllowance) {
      const { used, limit, remaining, month } = permissionAllowance;
      allowanceLine.textContent =
        remaining > 0
          ? `Hourly permissions: ${used} of ${limit} used this month — ${remaining} left.`
          : `You have used all ${limit} hourly permissions for ${month}. The next one can be requested from the start of next month.`;
      allowanceLine.className = remaining > 0 ? "small muted" : "small";
      allowanceLine.style.color = remaining > 0 ? "" : "var(--bad)";
    }
    if (leaves.length === 0) {
      mount(list, empty("No requests yet.", "Ask for leave or a few hours' permission and it will appear here."));
      return;
    }
    mount(
      list,
      ...leaves.map((leave) =>
        el("div", { class: "list-item" }, [
          el("div", { class: "grow" }, [
            el("strong", {}, LEAVE_LABELS[leave.type] || leave.type),
            el("div", { class: "small muted" }, describeLeave(leave)),
            el("div", { class: "small muted" }, leave.reason),
            leave.decisionNote ? el("div", { class: "small muted" }, `Note: ${leave.decisionNote}`) : null,
          ]),
          el("div", { class: "stack", style: "gap:6px;align-items:flex-end" }, [
            statusPill(leave.status),
            leave.status === "pending"
              ? el("button", {
                  class: "btn-sm btn-ghost",
                  type: "button",
                  onclick: async () => {
                    if (!(await confirmAction("Withdraw request", "This request will be removed.", "Withdraw"))) return;
                    await api.cancelLeave(leave._id);
                    toast("Request withdrawn", "ok");
                    load();
                  },
                }, "Withdraw")
              : null,
          ]),
        ])
      )
    );
  };

  container.append(
    el("div", { class: "card" }, [
      el("div", { class: "card-head" }, [
        el("h2", {}, "My requests"),
        el("button", { class: "btn-primary btn-sm", type: "button", onclick: () => openLeaveForm(state, load) }, "New request"),
      ]),
      allowanceLine,
      list,
    ])
  );

  await load();
  return container;
}

export function describeLeave(leave) {
  const range = leave.fromDate === leave.toDate ? formatDate(leave.fromDate) : `${formatDate(leave.fromDate)} → ${formatDate(leave.toDate)}`;
  if (leave.scope === "partial") return `${range}, ${leave.fromTime}–${leave.toTime}`;
  const days = Math.round((Date.parse(`${leave.toDate}T00:00:00Z`) - Date.parse(`${leave.fromDate}T00:00:00Z`)) / 86400000) + 1;
  return `${range} · ${days} day${days === 1 ? "" : "s"}`;
}

async function openLeaveForm(state, onDone) {
  const today = todayKey(state.settings.timeZone);
  const form = el("form", { class: "stack", id: "leave-form" });

  const typeSelect = el("select", { name: "type", required: true },
    Object.entries(LEAVE_LABELS).map(([value, label]) => el("option", { value }, label)));
  const scopeSelect = el("select", { name: "scope" }, [
    el("option", { value: "full_day" }, "Whole day(s)"),
    el("option", { value: "partial" }, "Part of one day (hours)"),
  ]);
  const fromDate = el("input", { type: "date", name: "fromDate", value: today, required: true });
  const toDate = el("input", { type: "date", name: "toDate", value: today, required: true });
  const fromTime = el("input", { type: "time", name: "fromTime", value: "09:00" });
  const toTime = el("input", { type: "time", name: "toTime", value: "11:00" });
  const reason = el("textarea", { name: "reason", required: true, maxLength: 500, placeholder: "Why do you need this time off?" });

  const hourFields = el("div", { class: "field-row hidden" }, [
    field("From", fromTime),
    field("To", toTime),
  ]);
  const toDateField = field("To date", toDate);

  const syncScope = () => {
    const partial = scopeSelect.value === "partial";
    hourFields.classList.toggle("hidden", !partial);
    toDateField.classList.toggle("hidden", partial);
    if (partial) toDate.value = fromDate.value;
  };
  scopeSelect.addEventListener("change", syncScope);
  fromDate.addEventListener("change", () => {
    // Keep the end date sane so the server never has to reject the obvious.
    if (scopeSelect.value === "partial" || toDate.value < fromDate.value) toDate.value = fromDate.value;
  });
  // Picking "permission" almost always means hours, so pre-select that.
  typeSelect.addEventListener("change", () => {
    if (typeSelect.value === "permission" && scopeSelect.value !== "partial") {
      scopeSelect.value = "partial";
      syncScope();
    }
  });

  form.append(
    field("Type", typeSelect),
    field("Duration", scopeSelect),
    el("div", { class: "field-row" }, [field("From date", fromDate), toDateField]),
    hourFields,
    field("Reason", reason)
  );

  const submitted = await modal({
    title: "Request time off",
    body: form,
    actions: [
      { label: "Cancel", onClick: (close) => close(null) },
      {
        label: "Send request",
        class: "btn-primary",
        onClick: async (close) => {
          if (!form.reportValidity()) return;
          const data = Object.fromEntries(new FormData(form).entries());
          if (data.scope === "partial") data.toDate = data.fromDate;
          else {
            delete data.fromTime;
            delete data.toTime;
          }
          try {
            await api.requestLeave(data);
            close(true);
          } catch (error) {
            toast(error.message, "error");
          }
        },
      },
    ],
  });

  if (submitted) {
    toast("Request sent for approval", "ok");
    onDone();
  }
}

/* ── Department scoreboard ───────────────────────────────────────────── */

/**
 * What an employee can see of the rest of the company: how each department is
 * doing. Never an individual — the server does not send colleague data here,
 * and this screen has none to show.
 */
export async function scoreboardView() {
  const container = el("div", { class: "stack" });
  const board = await api.departmentScores();

  const card = el("div", { class: "card" }, [
    el("div", { class: "card-head" }, [
      el("h2", {}, "Department scores"),
      el("span", { class: "small muted" }, board.month),
    ]),
    el("p", { class: "small muted" },
      "Out of 100: attendance 60%, punctuality 30%, staying inside the monthly allowances 10%."),
  ]);

  if (!board.departments.length) {
    card.append(empty("No scores yet this month."));
    container.append(card);
    return container;
  }

  const best = Math.max(...board.departments.map((d) => d.score ?? 0), 1);
  for (const row of board.departments) {
    card.append(
      el("div", { style: "padding:12px 0;border-bottom:1px solid var(--border)" }, [
        el("div", { class: "row spread" }, [
          el("div", {}, [
            el("strong", {}, row.department),
            el("div", { class: "small muted" }, `${row.employees} ${row.employees === 1 ? "person" : "people"}`),
          ]),
          el("div", { class: "score" }, [
            el("b", {}, row.score === null ? "—" : String(row.score)),
            el("span", { class: `pill ${(row.band || "no-data").replace(/ /g, "-")}` }, row.band),
          ]),
        ]),
        el("div", { class: "bar", style: "margin-top:8px" },
          el("i", { style: `width:${Math.round(((row.score ?? 0) / best) * 100)}%` })),
      ])
    );
  }

  container.append(
    card,
    el("div", { class: "card" }, [
      el("h3", {}, "How the score works"),
      el("p", { class: "small muted" },
        "Attendance is the share of working days you were present for. Punctuality is the share of those days you arrived on time. Compliance is whether the department stayed inside its monthly allowances for lateness, absence and permissions."),
      el("p", { class: "small muted" },
        "Only department totals are shown here. Individual attendance is visible to you and your administrators only."),
    ])
  );
  return container;
}

/* ── Profile ─────────────────────────────────────────────────────────── */

export async function profileView(state) {
  const user = state.user;
  const card = el("div", { class: "card stack" }, [
    el("div", { class: "row" }, [
      el("div", { class: "avatar", style: "width:52px;height:52px;font-size:1.05rem" }, initials(user.name)),
      el("div", {}, [el("h2", {}, user.name), el("div", { class: "small muted" }, user.email)]),
    ]),
    detailRow("Employee ID", user.employeeCode || "—"),
    detailRow("Department", user.department || "—"),
    detailRow("Position", user.position || "—"),
    detailRow("Role", user.role === "admin" ? "Administrator" : "Employee"),
    el("button", { class: "btn-block", type: "button", onclick: () => openPasswordForm() }, "Change password"),
    el("button", { class: "btn-block btn-danger", type: "button", onclick: () => state.logout() }, "Sign out"),
  ]);
  return el("div", { class: "stack" }, card);
}

export async function openPasswordForm({ forced = false } = {}) {
  const form = el("form", { class: "stack" });
  const current = el("input", { type: "password", name: "currentPassword", required: true, autocomplete: "current-password" });
  const next = el("input", { type: "password", name: "newPassword", required: true, minLength: 8, autocomplete: "new-password" });
  const confirm = el("input", { type: "password", name: "confirm", required: true, minLength: 8, autocomplete: "new-password" });
  form.append(
    forced ? el("p", { class: "muted" }, "Please choose your own password before continuing.") : null,
    field("Current password", current),
    field("New password", next),
    field("Confirm new password", confirm)
  );

  const done = await modal({
    title: "Change password",
    body: form,
    actions: [
      forced ? null : { label: "Cancel", onClick: (close) => close(null) },
      {
        label: "Save",
        class: "btn-primary",
        onClick: async (close) => {
          if (!form.reportValidity()) return;
          if (next.value !== confirm.value) {
            toast("The two new passwords do not match", "error");
            return;
          }
          try {
            await api.changePassword(current.value, next.value);
            close(true);
          } catch (error) {
            toast(error.message, "error");
          }
        },
      },
    ].filter(Boolean),
  });

  if (done) toast("Password changed", "ok");
  return done;
}
