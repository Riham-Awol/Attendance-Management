/* Tiny DOM + formatting helpers. No framework: the whole app is small enough
   that plain elements are easier to follow than a build step. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Create an element. Children may be nodes or strings (always set as text). */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "html") node.innerHTML = value;
    else if (key in node && key !== "list") node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

let fieldSequence = 0;

/**
 * A labelled form field. The label is tied to the input with for/id — without
 * that, a screen reader announces an unnamed box and tapping the label does
 * nothing, so every field in the app goes through here.
 */
export function field(labelText, input, hint) {
  if (!input.id) input.id = `field-${(fieldSequence += 1)}`;
  return el("div", { class: "field" }, [
    el("label", { for: input.id }, labelText),
    input,
    hint ? el("p", { class: "small muted" }, hint) : null,
  ]);
}

export const clear = (node) => {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
};

export const mount = (node, ...children) => {
  clear(node).append(...children.filter(Boolean));
  return node;
};

/* ── Formatting ──────────────────────────────────────────────────────── */

export const initials = (name = "") =>
  name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

export function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes || 0));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export const STATUS_LABELS = {
  present: "Present",
  // A day still in progress: checked in, not yet checked out. Distinct from
  // missing_checkout, which is a finished day someone forgot to close.
  working: "Working",
  late: "Late",
  absent: "Absent",
  on_leave: "On leave",
  holiday: "Holiday",
  weekend: "Weekend",
  upcoming: "Upcoming",
  half_day: "Half day",
  short_day: "Short day",
  missing_checkout: "No check-out",
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Withdrawn",
};

export const LEAVE_LABELS = {
  annual: "Annual leave",
  sick: "Sick leave",
  unpaid: "Unpaid leave",
  permission: "Permission (hours)",
  remote: "Work from home",
};

export const statusPill = (status) =>
  el("span", { class: `pill ${status}` }, STATUS_LABELS[status] || status);

/** "2026-09-08" -> "Tue, 8 Sep". Parsed as UTC so it never shifts a day. */
export function formatDate(key, options = { weekday: "short", day: "numeric", month: "short" }) {
  if (!key) return "—";
  return new Date(`${key}T00:00:00Z`).toLocaleDateString(undefined, { ...options, timeZone: "UTC" });
}

export const formatDateLong = (key) =>
  formatDate(key, { weekday: "long", day: "numeric", month: "long", year: "numeric" });

export const todayKey = (timeZone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts;
};

export function monthRange(key) {
  const [y, m] = key.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${key.slice(0, 7)}-01`, to: `${key.slice(0, 7)}-${String(last).padStart(2, "0")}` };
}

export function addDays(key, days) {
  const date = new Date(`${key}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/* ── Feedback ────────────────────────────────────────────────────────── */

export function toast(message, kind = "") {
  const host = $("#toasts");
  const node = el("div", { class: `toast ${kind}` }, message);
  host.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity .3s";
    setTimeout(() => node.remove(), 320);
  }, kind === "error" ? 5200 : 3000);
}

/**
 * A bottom-sheet modal. Resolves with whatever `close(value)` is called with,
 * or null if dismissed — so callers can `await` a form.
 */
export function modal({ title, body, actions = [], onOpen }) {
  return new Promise((resolve) => {
    const close = (value) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(value ?? null);
    };
    const onKey = (event) => {
      if (event.key === "Escape") close(null);
    };

    const content = typeof body === "function" ? body(close) : body;
    const buttons = actions.map((action) =>
      el(
        "button",
        {
          class: action.class || "",
          type: "button",
          onclick: () => action.onClick(close),
        },
        action.label
      )
    );

    const dialog = el("div", { class: "modal", role: "dialog", "aria-modal": "true" }, [
      el("div", { class: "modal-head" }, [
        el("h2", {}, title),
        el("button", { class: "btn-ghost", type: "button", "aria-label": "Close", onclick: () => close(null) }, "✕"),
      ]),
      content,
      buttons.length ? el("div", { class: "modal-actions" }, buttons) : null,
    ]);

    const backdrop = el("div", {
      class: "modal-backdrop",
      onclick: (event) => {
        if (event.target === backdrop) close(null);
      },
    }, dialog);

    document.body.append(backdrop);
    document.addEventListener("keydown", onKey);
    const focusable = dialog.querySelector("input, select, textarea, button");
    if (focusable) focusable.focus();
    if (onOpen) onOpen(dialog, close);
  });
}

export const confirmAction = (title, message, confirmLabel = "Confirm") =>
  modal({
    title,
    body: el("p", { class: "muted" }, message),
    actions: [
      { label: "Cancel", onClick: (close) => close(false) },
      { label: confirmLabel, class: "btn-danger", onClick: (close) => close(true) },
    ],
  });

export const empty = (message, hint) =>
  el("div", { class: "empty" }, [el("p", {}, message), hint ? el("p", { class: "small" }, hint) : null]);

export const spinner = () => el("span", { class: "spinner" });

/** Disable a button and show a spinner while `task` runs. */
export async function withBusy(button, label, task) {
  const original = button.innerHTML;
  button.disabled = true;
  button.innerHTML = "";
  button.append(spinner(), document.createTextNode(` ${label}`));
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

/* ── Icons (inline so the app works fully offline) ───────────────────── */

const svg = (paths, extra = "") =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

export const ICONS = {
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>'),
  calendar: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>'),
  leave: svg('<path d="M4 5h16v14H4z"/><path d="M9 3v4M15 3v4M8 13h8M8 17h5"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>'),
  dashboard: svg('<rect x="3" y="3" width="8" height="9" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="14" width="8" height="7" rx="1.5"/>'),
  people: svg('<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20c0-3.3 2.9-5.2 6.5-5.2s6.5 1.9 6.5 5.2"/><path d="M17 5.5a3.4 3.4 0 0 1 0 6.6M18.5 14.6c2 .7 3.5 2.2 3.5 4.4"/>'),
  report: svg('<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h6"/>'),
  settings: svg('<circle cx="12" cy="12" r="3.2"/><path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V20a2 2 0 1 1-4 0v-.2A1.6 1.6 0 0 0 7.4 18l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 4 12.6H4a2 2 0 1 1 0-4h.2A1.6 1.6 0 0 0 5.6 6l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H10a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.2a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V8a1.6 1.6 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.2a1.6 1.6 0 0 0-1.4 1z"/>'),
  clockIn: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 'stroke-width="1.7"'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>'),
  check: svg('<path d="M4 12.5 9.5 18 20 6.5"/>', 'stroke-width="2.4"'),
  location: svg('<path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  inbox: svg('<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5 5h14l2 8v6H3v-6z"/>'),
};

export const icon = (name) => el("span", { html: ICONS[name] || "", class: "icon" });
