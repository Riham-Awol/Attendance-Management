const TOKEN_KEY = "attendance.token";

export const getToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

export const setToken = (token) => {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private browsing — the session just won't survive a reload */
  }
};

/** Thrown for any non-2xx response, carrying the server's own message. */
export class ApiError extends Error {
  constructor(status, code, message, payload = {}) {
    super(message);
    this.status = status;
    this.code = code;
    // Field-level validation errors.
    this.details = payload.details;
    // Set by the deployment diagnostics: what went wrong underneath, and what
    // to do about it.
    this.detail = payload.detail;
    this.hint = payload.hint;
    this.problems = payload.problems;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

async function request(method, path, body, options = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "offline", "You appear to be offline. Check your connection and try again.");
  }

  if (response.status === 401) {
    onUnauthorized();
    const payload = await response.json().catch(() => ({}));
    throw new ApiError(401, "unauthorized", payload.error?.message || "Please sign in again");
  }

  if (options.raw) {
    if (!response.ok) throw new ApiError(response.status, "download_failed", "The download failed");
    return response.blob();
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.error || {};
    throw new ApiError(response.status, error.code || "error", error.message || "Something went wrong", error);
  }
  return payload;
}

const query = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, value);
  }
  const string = search.toString();
  return string ? `?${string}` : "";
};

export const api = {
  login: (email, password) => request("POST", "/auth/login", { email, password }),
  me: () => request("GET", "/auth/me"),
  changePassword: (currentPassword, newPassword) =>
    request("POST", "/auth/change-password", { currentPassword, newPassword }),

  today: () => request("GET", "/attendance/today"),
  checkIn: (point) => request("POST", "/attendance/check-in", point),
  checkOut: (point) => request("POST", "/attendance/check-out", point),
  myAttendance: (params) => request("GET", `/attendance/me${query(params)}`),
  employeeAttendance: (id, params) => request("GET", `/attendance/employee/${id}${query(params)}`),
  records: (params) => request("GET", `/attendance/records${query(params)}`),
  createRecord: (body) => request("POST", "/attendance/records", body),
  editRecord: (id, body) => request("PATCH", `/attendance/records/${id}`, body),

  myLeaves: () => request("GET", "/leaves/me"),
  requestLeave: (body) => request("POST", "/leaves", body),
  cancelLeave: (id) => request("DELETE", `/leaves/${id}`),
  leaves: (params) => request("GET", `/leaves${query(params)}`),
  decideLeave: (id, status, note) => request("PATCH", `/leaves/${id}/decision`, { status, note }),

  employees: (params) => request("GET", `/employees${query(params)}`),
  departments: () => request("GET", "/employees/departments"),
  createEmployee: (body) => request("POST", "/employees", body),
  updateEmployee: (id, body) => request("PATCH", `/employees/${id}`, body),
  resetPassword: (id, newPassword) => request("POST", `/employees/${id}/reset-password`, { newPassword }),
  deactivateEmployee: (id) => request("DELETE", `/employees/${id}`),

  settings: () => request("GET", "/settings"),
  updateSettings: (body) => request("PUT", "/settings", body),
  offices: () => request("GET", "/settings/offices"),
  createOffice: (body) => request("POST", "/settings/offices", body),
  updateOffice: (id, body) => request("PATCH", `/settings/offices/${id}`, body),
  deleteOffice: (id) => request("DELETE", `/settings/offices/${id}`),
  shifts: () => request("GET", "/settings/shifts"),
  createShift: (body) => request("POST", "/settings/shifts", body),
  updateShift: (id, body) => request("PATCH", `/settings/shifts/${id}`, body),
  deleteShift: (id) => request("DELETE", `/settings/shifts/${id}`),
  holidays: (params) => request("GET", `/settings/holidays${query(params)}`),
  createHoliday: (body) => request("POST", "/settings/holidays", body),
  deleteHoliday: (id) => request("DELETE", `/settings/holidays/${id}`),

  overview: () => request("GET", "/dashboard/overview"),
  departmentScores: () => request("GET", "/dashboard/departments"),
  reportSummary: (params) => request("GET", `/reports/summary${query(params)}`),
  dailyReport: (params) => request("GET", `/reports/daily${query(params)}`),
  board: (params) => request("GET", `/reports/board${query(params)}`),
  exportUrl: (params) => `/api/reports/export${query(params)}`,
  download: (params) => request("GET", `/reports/export${query(params)}`, undefined, { raw: true }),
};
