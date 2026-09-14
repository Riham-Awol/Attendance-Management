import { api, getToken, setToken, setUnauthorizedHandler } from "./api.js";
import { $, el, mount, field, toast, icon } from "./ui.js";
import { homeView, myAttendanceView, myLeaveView, profileView, openPasswordForm } from "./views/employee.js";
import {
  dashboardView, employeesView, approvalsView, recordsView, reportsView, settingsView,
} from "./views/admin.js";

const root = $("#app");

/** Shared app state, passed to every view instead of a global store. */
const state = {
  user: null,
  settings: { companyName: "Attendance", timeZone: "UTC" },
  pendingCount: 0,
  cleanups: [],
  onLeaveView(fn) {
    this.cleanups.push(fn);
  },
  setPendingCount(count) {
    this.pendingCount = count;
    renderTabs();
  },
  navigate(route) {
    location.hash = `#/${route}`;
  },
  logout() {
    setToken(null);
    state.user = null;
    location.hash = "";
    renderAuth();
  },
};

const EMPLOYEE_TABS = [
  { id: "home", label: "Check in", icon: "clockIn", view: homeView },
  { id: "attendance", label: "My days", icon: "calendar", view: myAttendanceView },
  { id: "leave", label: "Leave", icon: "leave", view: myLeaveView },
  { id: "profile", label: "Me", icon: "user", view: profileView },
];

const ADMIN_TABS = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard", view: dashboardView },
  { id: "records", label: "Records", icon: "calendar", view: recordsView },
  { id: "approvals", label: "Requests", icon: "inbox", view: approvalsView, badge: true },
  { id: "employees", label: "People", icon: "people", view: employeesView },
  { id: "reports", label: "Reports", icon: "report", view: reportsView },
  { id: "settings", label: "Settings", icon: "settings", view: settingsView },
  { id: "home", label: "Check in", icon: "clockIn", view: homeView },
  { id: "profile", label: "Me", icon: "user", view: profileView },
];

const tabsFor = (user) => (user.role === "admin" ? ADMIN_TABS : EMPLOYEE_TABS);

let tabbar;
let main;

/* ── Auth screen ─────────────────────────────────────────────────────── */

function renderAuth(message) {
  const email = el("input", { type: "email", name: "email", required: true, autocomplete: "username", placeholder: "you@company.com" });
  const password = el("input", { type: "password", name: "password", required: true, autocomplete: "current-password" });
  const button = el("button", { class: "btn-primary btn-block", type: "submit" }, "Sign in");

  const form = el("form", { class: "stack" }, [
    field("Email", email),
    field("Password", password),
    button,
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = "Signing in…";
    try {
      const response = await api.login(email.value.trim(), password.value);
      setToken(response.token);
      state.user = response.user;
      state.settings = response.settings;
      await renderApp();
      if (response.user.mustChangePassword) {
        await openPasswordForm({ forced: true });
      }
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Sign in";
    }
  });

  mount(
    root,
    el("div", { class: "auth" },
      el("div", { class: "card" }, [
        el("img", { class: "logo", src: "/icons/icon-192.png", alt: "" }),
        el("h1", { class: "center" }, "Attendance"),
        el("p", { class: "center muted small" }, message || "Sign in to check in and out."),
        form,
      ])
    )
  );
}

/* ── App shell ───────────────────────────────────────────────────────── */

function renderTabs() {
  if (!tabbar || !state.user) return;
  const current = currentRoute();
  mount(
    tabbar,
    ...tabsFor(state.user).map((tab) => {
      const button = el(
        "button",
        {
          type: "button",
          "aria-current": tab.id === current ? "page" : null,
          onclick: () => state.navigate(tab.id),
        },
        [icon(tab.icon), el("span", {}, tab.label)]
      );
      if (tab.badge && state.pendingCount > 0) {
        button.append(el("span", { class: "badge-dot" }, String(state.pendingCount)));
      }
      return button;
    })
  );
}

const currentRoute = () => {
  const route = location.hash.replace(/^#\/?/, "");
  const tabs = state.user ? tabsFor(state.user) : EMPLOYEE_TABS;
  return tabs.some((tab) => tab.id === route) ? route : tabs[0].id;
};

async function renderApp() {
  tabbar = el("nav", { class: "tabbar" });
  main = el("main", {});

  mount(
    root,
    el("header", { class: "topbar" }, [
      el("div", { class: "brand" }, [
        el("img", { src: "/icons/icon-192.png", alt: "" }),
        el("span", {}, state.settings.companyName || "Attendance"),
      ]),
      el("div", { class: "grow" }),
      el("span", { class: "small muted" }, state.user.name),
      el("button", { class: "btn-ghost btn-sm", type: "button", title: "Sign out", onclick: () => state.logout() }, [icon("logout")]),
    ]),
    tabbar,
    main
  );

  renderTabs();
  await renderRoute();
}

async function renderRoute() {
  if (!state.user) return;

  // Let the previous view stop its timers before it is detached.
  for (const cleanup of state.cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      /* a failing cleanup must not block navigation */
    }
  }

  const route = currentRoute();
  const tab = tabsFor(state.user).find((t) => t.id === route);
  renderTabs();
  mount(main, el("div", { class: "card" }, el("div", { class: "skeleton" })));

  try {
    mount(main, await tab.view(state));
    main.scrollIntoView({ block: "start" });
  } catch (error) {
    mount(
      main,
      el("div", { class: "card empty" }, [
        el("p", {}, error.message || "This screen could not be loaded."),
        el("button", { class: "btn-sm", type: "button", onclick: () => renderRoute() }, "Try again"),
      ])
    );
  }
}

window.addEventListener("hashchange", renderRoute);

setUnauthorizedHandler(() => {
  setToken(null);
  state.user = null;
  renderAuth("Your session expired. Please sign in again.");
});

/* ── Boot ────────────────────────────────────────────────────────────── */

async function boot() {
  if (!getToken()) {
    renderAuth();
    return;
  }
  try {
    const response = await api.me();
    state.user = response.user;
    state.settings = response.settings;
    await renderApp();
    if (response.user.mustChangePassword) await openPasswordForm({ forced: true });
  } catch {
    // The unauthorized handler already swapped in the login screen for a 401;
    // anything else (offline, server down) also lands the user there.
    if (state.user === null) renderAuth();
  }
}

boot();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/service-worker.js").catch(() => {
      /* the app works fine without offline support */
    });
  });
}
