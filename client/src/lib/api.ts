/**
 * Typed client for the MediSense API.
 *
 * Every request sends credentials, because the session lives in httpOnly
 * cookies that page script cannot read — which is the point. There is no token
 * in memory or localStorage to steal.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

/**
 * Mirrors `ErrorCode` in api/app/core/errors.py, plus `NETWORK_ERROR`, which is
 * the one failure the client raises itself — the request never reached a server
 * that could name a code. Keep the two in step: a code missing here becomes a
 * comparison TypeScript rejects as impossible.
 */
export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "SESSION_EXPIRED"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_LOCKED"
  | "ACCOUNT_INACTIVE"
  | "UNAUTHORIZED"
  | "FORBIDDEN_RESOURCE"
  | "NOT_FOUND"
  | "CONFLICT"
  | "SLOT_UNAVAILABLE"
  | "DUPLICATE_INVOICE"
  | "UNSUPPORTED_FILE"
  | "FILE_TOO_LARGE"
  | "RATE_LIMITED"
  | "CONSENT_REQUIRED"
  // The account exists but has not proved it owns the address yet.
  | "EMAIL_NOT_VERIFIED"
  | "INVALID_CODE"
  | "CODE_EXPIRED"
  // A doctor whose application has not been approved. The message says which.
  | "PENDING_APPROVAL"
  | "APPLICATION_REJECTED"
  | "PROFILE_INCOMPLETE"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR";

export interface FieldError {
  field?: string;
  message: string;
}

/** A failure the UI can render: always a code, a message, and optional fields. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: FieldError[];

  constructor(code: ErrorCode, message: string, status: number, details: FieldError[] = []) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** True when the right response is to send the user back to sign in. */
  get isAuthFailure(): boolean {
    return this.code === "UNAUTHENTICATED" || this.code === "SESSION_EXPIRED";
  }

  /** The message for a specific form field, if the server named one. */
  fieldError(field: string): string | undefined {
    return this.details.find((detail) => detail.field === field)?.message;
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface RequestOptions {
  method?: Method;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
}

export interface PageMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * `Extra` carries the per-endpoint additions to `meta` — the notifications list
 * returns an unread count alongside the usual paging fields.
 */
export interface Paginated<T, Extra = unknown> {
  data: T[];
  meta: PageMeta & Extra;
}

/**
 * Fires when the API reports the session has ended, so the app can redirect
 * once from a single place instead of every caller handling it.
 */
export const SESSION_ENDED_EVENT = "medisense:session-ended";

/**
 * A doctor reached something their registration does not entitle them to yet.
 *
 * Raised here rather than handled per screen for the same reason as the
 * session event: it can arrive from any request on any page — a bookmark, a
 * refresh, a tab left open while an administrator rejects the application —
 * and every one of those should end up on the page that can actually do
 * something about it.
 */
export const DOCTOR_GATED_EVENT = "medisense:doctor-gated";

const DOCTOR_GATE_CODES: ReadonlySet<ErrorCode> = new Set([
  "PROFILE_INCOMPLETE",
  "PENDING_APPROVAL",
  "APPLICATION_REJECTED",
]);

function announceSessionEnded(code: ErrorCode) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { code } }));
}

function announceIfGated(error: ApiError) {
  if (typeof window === "undefined" || !DOCTOR_GATE_CODES.has(error.code)) return;
  window.dispatchEvent(new CustomEvent(DOCTOR_GATED_EVENT, { detail: { code: error.code } }));
}

/**
 * Endpoints that must never trigger a refresh-and-retry.
 *
 * Refreshing in response to a failure on one of these is either circular (the
 * refresh call itself) or wrong: a rejected sign-in is a rejected sign-in, and
 * silently minting a new token behind it would replay the attempt against a
 * session the person was just told they do not have.
 */
const NEVER_REFRESH: ReadonlySet<string> = new Set([
  "/auth/login",
  "/auth/refresh",
  "/auth/logout",
  "/auth/register",
  "/auth/verify-email",
  "/auth/2fa/verify",
]);

/**
 * The one refresh attempt every request shares.
 *
 * A dashboard fires several requests at once, so an expired token produces
 * several simultaneous 401s. Without this they would each start their own
 * refresh — a stampede against the endpoint that rotates the refresh token,
 * where the first to land invalidates the token the others are still holding,
 * and the session dies from the very mechanism meant to save it.
 */
let refreshInFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  const attempt = (async () => {
    try {
      const response = await fetch(`${API_URL}/auth/refresh`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
      });
      return response.ok;
    } catch {
      // Offline, or the server is unreachable. Not a dead session — the caller
      // reports the original failure and the next request tries again.
      return false;
    }
  })();

  refreshInFlight = attempt;
  void attempt.finally(() => {
    if (refreshInFlight === attempt) refreshInFlight = null;
  });
  return attempt;
}

/**
 * Run a request, and if the access token had expired, renew it once and repeat.
 *
 * **This is what stops an active session from dying on a wall clock.** The
 * access token's life is `min(idle window, 15 minutes)`, and nothing on the
 * client ever renewed it, so a person reading a record for a quarter of an hour
 * was thrown back to the landing page mid-task — not for being idle, but for
 * having been signed in too long.
 *
 * It does not weaken the idle policy, because the policy is not enforced here.
 * The server checks the session's own last-seen time on `/auth/refresh` and
 * revokes it with `IDLE_TIMEOUT` when the window has passed, so a genuinely
 * abandoned session still refuses to come back and the retry reports the
 * failure it was given.
 *
 * One retry, never a loop: if the second attempt still says the session is
 * gone, it is gone.
 */
async function withTokenRenewal(path: string, run: () => Promise<Response>): Promise<Response> {
  const response = await run();
  if (response.status !== 401 || NEVER_REFRESH.has(path)) return response;
  if (!(await refreshSession())) return response;
  return run();
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(`${API_URL}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, query, signal } = options;

  let response: Response;
  try {
    response = await withTokenRenewal(path, () =>
      fetch(buildUrl(path, query), {
        method,
        credentials: "include",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal,
        cache: "no-store",
      }),
    );
  } catch (cause) {
    if ((cause as Error)?.name === "AbortError") throw cause;
    throw new ApiError(
      "NETWORK_ERROR",
      "Could not reach the server. Check your connection and try again.",
      0,
    );
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.success === false) {
    const error = payload?.error ?? {};
    const apiError = new ApiError(
      (error.code as ErrorCode) ?? "INTERNAL_ERROR",
      error.message ?? "Something went wrong.",
      response.status,
      error.details ?? [],
    );
    if (apiError.isAuthFailure) announceSessionEnded(apiError.code);
    announceIfGated(apiError);
    throw apiError;
  }

  return payload.data as T;
}

/**
 * Multipart POST. Deliberately not routed through `apiRequest`, which sets a
 * JSON content type: the browser must set its own multipart boundary.
 */
export async function apiMultipart<T>(path: string, form: FormData): Promise<T> {
  let response: Response;
  try {
    response = await withTokenRenewal(path, () =>
      fetch(`${API_URL}${path}`, {
        method: "POST",
        credentials: "include",
        body: form,
        cache: "no-store",
      }),
    );
  } catch {
    throw new ApiError("NETWORK_ERROR", "Could not reach the server. Try again.", 0);
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    const error = payload?.error ?? {};
    const apiError = new ApiError(
      (error.code as ErrorCode) ?? "INTERNAL_ERROR",
      error.message ?? "The file could not be uploaded.",
      response.status,
      error.details ?? [],
    );
    if (apiError.isAuthFailure) announceSessionEnded(apiError.code);
    announceIfGated(apiError);
    throw apiError;
  }
  return payload.data as T;
}

/** Same as apiRequest but keeps the pagination metadata. */
export async function apiList<T, Extra = unknown>(
  path: string,
  query?: RequestOptions["query"],
): Promise<Paginated<T, Extra>> {
  const response = await withTokenRenewal(path, () =>
    fetch(buildUrl(path, query), {
      credentials: "include",
      cache: "no-store",
    }),
  );
  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.success === false) {
    const error = payload?.error ?? {};
    const apiError = new ApiError(
      (error.code as ErrorCode) ?? "INTERNAL_ERROR",
      error.message ?? "Something went wrong.",
      response.status,
      error.details ?? [],
    );
    if (apiError.isAuthFailure) announceSessionEnded(apiError.code);
    throw apiError;
  }

  return {
    data: payload.data as T[],
    meta: payload.meta ?? { total: payload.data.length, limit: 25, offset: 0, hasMore: false },
  };
}



// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type Role = "ADMIN" | "DOCTOR" | "PATIENT" | "NURSE";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  phone: string | null;
  status: string;
  patientId: string | null;
  doctorId: string | null;
  permissions: string[];
  /**
   * A short-lived signed link to the person's picture, or null.
   *
   * Minted with the session rather than stored as a URL: the bucket is private,
   * so there is no permanent address to keep, and a link that outlived the
   * session would be a way to read a face after signing out.
   */
  avatarUrl: string | null;
}

export interface SessionInfo {
  sessionId: string;
  /** Null means this device class is exempt from idle expiry. */
  idleTimeoutSeconds: number | null;
  accessTokenExpiresInSeconds: number;
}

/**
 * Device class decides the inactivity tier the server enforces (R8).
 * A browser on someone's own machine is PERSONAL; a shared ward workstation
 * declares SHARED_TERMINAL and gets the strict two-minute rule.
 */
export type DeviceClass = "SHARED_TERMINAL" | "PERSONAL" | "MONITOR";

/** What a sign-in produced: a session, or a challenge standing in its way. */
export type LoginResult =
  | {
      requires2FA: false;
      user: AuthUser;
      session: SessionInfo;
      /**
       * Where to go next, decided by the server because it depends on state
       * the client cannot see — for a doctor, how far their registration has
       * got. Navigation, not authorization: every destination guards itself,
       * so ignoring this lands somewhere that refuses you.
       */
      redirectTo: string;
    }
  | { requires2FA: true; challengeId: string; method: TwoFactorMethod; sentTo: string | null };

export type TwoFactorMethod = "EMAIL" | "TOTP";

export interface VerificationPending {
  pendingVerification: true;
  email: string;
  /** Seconds until another code may be requested. */
  resendAfterSeconds: number;
}

export const auth = {
  login: (email: string, password: string, deviceClass: DeviceClass) =>
    apiRequest<LoginResult>("/auth/login", {
      method: "POST",
      body: { email, password, deviceClass },
    }),

  register: (input: {
    name: string;
    email: string;
    password: string;
    phone?: string;
    dateOfBirth?: string;
    /** Patients by default. A doctor's account is gated until an admin approves it. */
    role?: "PATIENT" | "DOCTOR";
  }) => apiRequest<VerificationPending>("/auth/register", { method: "POST", body: input }),

  /** Exchanges the emailed code for a session. */
  verifyEmail: (input: { email: string; code: string }) =>
    apiRequest<{ user: AuthUser; session: SessionInfo; redirectTo: string }>(
      "/auth/verify-email",
      { method: "POST", body: input },
    ),

  /** Sends another code. Rate-limited server-side; the wait comes back here. */
  resendCode: (input: { email: string }) =>
    apiRequest<{ sent: boolean; resendAfterSeconds: number }>("/auth/resend-code", {
      method: "POST",
      body: input,
    }),

  /** Second step of a two-factor sign-in. */
  verifyTwoFactor: (input: {
    challengeId: string;
    code: string;
    /** Skips 2FA on this browser for 30 days. Never offered on a shared terminal. */
    rememberDevice?: boolean;
  }) =>
    apiRequest<{ user: AuthUser; session: SessionInfo; redirectTo: string }>("/auth/2fa/verify", {
      method: "POST",
      body: input,
    }),

  /** Sends the email code for a challenge again. */
  resendTwoFactor: (input: { challengeId: string }) =>
    apiRequest<{ sent: boolean; resendAfterSeconds: number }>("/auth/2fa/resend", {
      method: "POST",
      body: input,
    }),

  forgotPassword: (email: string) =>
    apiRequest<{ sent: boolean }>("/auth/forgot-password", { method: "POST", body: { email } }),

  resetPassword: (input: { token: string; password: string }) =>
    apiRequest<{ reset: boolean }>("/auth/reset-password", { method: "POST", body: input }),

  me: () => apiRequest<{ user: AuthUser }>("/auth/me"),

  refresh: () => apiRequest<{ session: SessionInfo }>("/auth/refresh", { method: "POST" }),

  logout: () => apiRequest<{ loggedOut: boolean }>("/auth/logout", { method: "POST" }),

  changePassword: (currentPassword: string, newPassword: string) =>
    apiRequest<{ message: string }>("/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword },
    }),
};

export interface DashboardCounts {
  [key: string]: number;
}

export const dashboard = {
  patient: () =>
    apiRequest<{
      counts: DashboardCounts;
      upcomingAppointments: Array<{
        id: string;
        startTime: string;
        status: string;
        reason: string | null;
        doctor: { id: string; name: string; specialization: string };
      }>;
      activePrescriptions: Array<{
        id: string;
        medication: string;
        dosage: string;
        frequency: string;
        duration: string;
        prescribedBy: string;
      }>;
    }>("/dashboard/patient"),

  doctor: () =>
    apiRequest<{
      counts: DashboardCounts;
      todaysAppointments: Array<{
        id: string;
        startTime: string;
        status: string;
        reason: string | null;
        patient: { id: string; name: string; medicalRecordNumber: string };
      }>;
      openAlerts: Array<{
        id: string;
        severity: string;
        vitalType: string;
        measuredValue: number;
        message: string;
        createdAt: string;
        patient: { id: string; name: string };
      }>;
    }>("/dashboard/doctor"),

  admin: () =>
    apiRequest<{
      counts: DashboardCounts;
      recentSecurityEvents: Array<{
        id: string;
        action: string;
        severity: string;
        timestamp: string;
        userId: string | null;
        ipAddress: string | null;
      }>;
    }>("/dashboard/admin"),
};

export interface PatientSummary {
  id: string;
  name: string;
  medicalRecordNumber: string;
  dateOfBirth: string | null;
  gender: string;
  bloodGroup: string | null;
  allergies: string | null;
  chronicConditions: string | null;
  isPrimary: boolean;
}

export interface TimeOff {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

/** One recurring weekly window — "Tuesdays 09:00–17:00, in 30-minute slots". */
export interface AvailabilityWindow {
  /** ISO weekday: Monday is 1, Sunday is 7. */
  dayOfWeek: number;
  /** "HH:MM", 24-hour, in the clinic's timezone. */
  startTime: string;
  endTime: string;
  slotMinutes: number;
}

/** The lengths the scheduler will divide a window into. */
export const SLOT_MINUTES = [10, 15, 20, 30, 45, 60] as const;

export interface DoctorProfile {
  id: string;
  name: string;
  /**
   * The doctor's own picture, if they have set one — a short-lived signed link
   * minted with the response, never a stored address.
   *
   * It belongs on the directory rather than only on the doctor's own session
   * because this is the card a patient chooses from, and a page of identical
   * grey initials is a page nobody can tell apart.
   */
  avatarUrl: string | null;
  specialization: string;
  qualifications: string | null;
  yearsExperience: number | null;
  consultationFee: number;
  acceptingPatients: boolean;
  /**
   * The weeks a patient books against. Empty means no slots are generated at
   * all — a doctor who has not set this is invisible to the booking screen.
   */
  availability: AvailabilityWindow[];
  department: { id: string; name: string; code: string } | null;
  /** Where they practise. See {@link PracticeLocation}. */
  clinicName: string | null;
  city: string | null;
  addressLine: string | null;
  latitude: number | null;
  longitude: number | null;
}

/** Where a doctor sits. Every field is null until they have been asked. */
export interface PracticeLocation {
  /** The hospital or practice by name — how people say where a doctor sits. */
  clinicName: string | null;
  city: string | null;
  addressLine: string | null;
  /** The pin. Null when nobody placed one; the address still stands alone. */
  latitude: number | null;
  longitude: number | null;
}

export const doctors = {
  /** The signed-in doctor's own professional record. */
  me: () => apiRequest<DoctorProfile>("/doctors/me"),

  /**
   * The cities that actually have a bookable doctor, commonest first.
   *
   * Built from the data rather than from a list of Pakistani cities: a filter
   * offering a city with nobody in it is a dead end a patient discovers by
   * trying it.
   */
  cities: () => apiRequest<Array<{ city: string; doctors: number }>>("/doctors/cities"),

  /**
   * Edits that record. Every field is optional; an omitted one is left alone.
   *
   * `availability` is validated server-side for overlaps, because two windows
   * covering the same minute produce the same slot twice and two patients then
   * collide on one appointment with nothing to say which booking was wrong.
   */
  updateMe: (input: {
    specialization?: string;
    qualifications?: string;
    yearsExperience?: number;
    acceptingPatients?: boolean;
    availability?: AvailabilityWindow[];
    // Self-service: moving clinic is an ordinary Tuesday, not a credentialing
    // event, so it does not wait on an administrator.
    clinicName?: string;
    city?: string;
    addressLine?: string;
    latitude?: number;
    longitude?: number;
  }) => apiRequest<DoctorProfile>("/doctors/me", { method: "PATCH", body: input }),

  myPatients: (query?: { limit?: number; offset?: number }) =>
    apiList<PatientSummary>("/doctors/me/patients", query),

  timeOff: () => apiRequest<TimeOff[]>("/doctors/me/time-off"),

  addTimeOff: (startsAt: string, endsAt: string, reason?: string) =>
    apiRequest<TimeOff>("/doctors/me/time-off", {
      method: "POST",
      body: { startsAt, endsAt, reason },
    }),

  removeTimeOff: (id: string) =>
    apiRequest<{ id: string; removed: boolean }>(`/doctors/me/time-off/${id}`, {
      method: "DELETE",
    }),

  directory: (query?: {
    search?: string;
    departmentId?: string;
    /** Exact city match — the value comes from `doctors.cities()`. */
    city?: string;
    limit?: number;
  }) =>
    apiList<{
      id: string;
      name: string;
      /** Short-lived signed link, or null when they have not set a picture. */
      avatarUrl: string | null;
      specialization: string;
      // The server has always returned these two; the directory simply never
      // asked for them, which left a patient choosing between doctors on name
      // and fee alone.
      qualifications: string | null;
      yearsExperience: number | null;
      consultationFee: number;
      acceptingPatients: boolean;
      department: { id: string; name: string; code: string } | null;
      clinicName: string | null;
      city: string | null;
      addressLine: string | null;
      latitude: number | null;
      longitude: number | null;
    }>("/doctors", query),
};

export interface PatientProfile {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  medicalRecordNumber: string;
  dateOfBirth: string | null;
  gender: string;
  bloodGroup: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  aiConsentGranted: boolean;
  /** Omitted for administrators — clinical fields sit behind a care relationship. */
  allergies?: string | null;
  chronicConditions?: string | null;
}

export const patients = {
  me: () => apiRequest<PatientProfile>("/patients/me"),
  get: (id: string) => apiRequest<PatientProfile>(`/patients/${id}`),
  list: (query?: { search?: string; limit?: number; offset?: number }) =>
    apiList<{
      id: string;
      name: string;
      email: string;
      phone: string | null;
      medicalRecordNumber: string;
      status: string;
    }>("/patients", query),
  setAiConsent: (granted: boolean) =>
    apiRequest<{ aiConsentGranted: boolean }>("/patients/me/ai-consent", {
      method: "PUT",
      body: { granted },
    }),
};

export const users = {
  list: (query?: { role?: Role; search?: string; limit?: number; offset?: number }) =>
    apiList<{
      id: string;
      name: string;
      email: string;
      role: Role;
      status: string;
      lastLoginAt: string | null;
      createdAt: string;
    }>("/users", query),

  setStatus: (userId: string, status: string, reason?: string) =>
    apiRequest(`/users/${userId}/status`, { method: "PATCH", body: { status, reason } }),
};

export interface Department {
  id: string;
  name: string;
  /** Short uppercase key, fixed once created — it identifies the department. */
  code: string;
  description: string | null;
  location: string | null;
  active: boolean;
  doctorCount: number;
}

export const departments = {
  list: () => apiList<Department>("/departments"),

  create: (input: { name: string; code: string; description?: string; location?: string }) =>
    apiRequest<Department>("/departments", { method: "POST", body: input }),

  /**
   * Edits a department. `code` is deliberately absent: it is the department's
   * identity, doctors are filed under it, and renaming it would silently move
   * everyone. A department that should no longer be chosen is deactivated.
   */
  update: (
    id: string,
    input: { name?: string; description?: string; location?: string; active?: boolean },
  ) => apiRequest<Department>(`/departments/${id}`, { method: "PATCH", body: input }),
};

// ---------------------------------------------------------------------------
// Appointments
// ---------------------------------------------------------------------------

export type AppointmentStatus =
  | "REQUESTED"
  | "CONFIRMED"
  | "CHECKED_IN"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "CANCELLED"
  | "NO_SHOW";

export interface Appointment {
  id: string;
  patientId: string;
  doctorId: string;
  status: AppointmentStatus;
  /** UTC, with an explicit Z — safe to pass straight to `new Date()`. */
  startTime: string;
  endTime: string;
  /** Pre-formatted in the clinic's time zone, for when local time is wrong. */
  localDate: string;
  localTime: string;
  durationMinutes: number;
  reason: string | null;
  notes: string | null;
  doctorName: string | null;
  specialization: string | null;
  patientName: string | null;
  medicalRecordNumber: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  rescheduledFromId: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface AvailabilitySlot {
  startTime: string;
  endTime: string;
  /** Clinic-local "HH:MM", already formatted by the server. */
  label: string;
  available: boolean;
}

export interface AvailabilityDay {
  date: string;
  slots: AvailabilitySlot[];
  availableCount: number;
}

export const appointments = {
  list: (query?: {
    status?: AppointmentStatus;
    from?: string;
    to?: string;
    doctorId?: string;
    patientId?: string;
    upcomingOnly?: boolean;
    limit?: number;
    offset?: number;
  }) => apiList<Appointment>("/appointments", query),

  get: (id: string) => apiRequest<Appointment>(`/appointments/${id}`),

  availability: (doctorId: string, from?: string, to?: string) =>
    apiRequest<{ doctorId: string; timezone: string; days: AvailabilityDay[] }>(
      "/appointments/availability",
      { query: { doctorId, from, to } },
    ),

  book: (input: { doctorId: string; startTime: string; reason?: string; patientId?: string }) =>
    apiRequest<Appointment>("/appointments", { method: "POST", body: input }),

  cancel: (id: string, reason?: string) =>
    apiRequest<Appointment>(`/appointments/${id}/cancel`, {
      method: "POST",
      body: { reason },
    }),

  /** Returns a *new* appointment; the original is cancelled and linked to it. */
  reschedule: (id: string, startTime: string, reason?: string) =>
    apiRequest<Appointment>(`/appointments/${id}/reschedule`, {
      method: "POST",
      body: { startTime, reason },
    }),

  setStatus: (id: string, status: AppointmentStatus, notes?: string) =>
    apiRequest<Appointment>(`/appointments/${id}/status`, {
      method: "POST",
      body: { status, notes },
    }),
};

// ---------------------------------------------------------------------------
// Clinical records
// ---------------------------------------------------------------------------

export interface Prescription {
  id: string;
  patientId: string;
  doctorId: string;
  doctorName: string | null;
  medicalRecordId: string | null;
  medication: string;
  dosage: string;
  frequency: string;
  duration: string;
  instructions: string | null;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MedicalRecord {
  id: string;
  patientId: string;
  doctorId: string;
  doctorName: string | null;
  specialization: string | null;
  appointmentId: string | null;
  symptoms: string | null;
  diagnosis: string | null;
  treatmentPlan: string | null;
  notes: string | null;
  followUpDate: string | null;
  followUpNotes: string | null;
  /** Always "PHYSICIAN" here — machine output never reaches this table. */
  source: string;
  createdAt: string;
  updatedAt: string;
  amended: boolean;
  /** Present when the record was requested with prescriptions included. */
  prescriptions?: Prescription[];
}

export const records = {
  list: (query?: {
    patientId?: string;
    includePrescriptions?: boolean;
    limit?: number;
    offset?: number;
  }) => apiList<MedicalRecord>("/records", query),

  get: (id: string) => apiRequest<MedicalRecord>(`/records/${id}`),

  create: (input: {
    patientId: string;
    appointmentId?: string;
    symptoms?: string;
    diagnosis?: string;
    treatmentPlan?: string;
    notes?: string;
    followUpDate?: string;
    followUpNotes?: string;
  }) => apiRequest<MedicalRecord>("/records", { method: "POST", body: input }),

  amend: (
    id: string,
    input: Partial<{
      symptoms: string;
      diagnosis: string;
      treatmentPlan: string;
      notes: string;
      followUpDate: string;
      followUpNotes: string;
    }>,
  ) => apiRequest<MedicalRecord>(`/records/${id}`, { method: "PATCH", body: input }),
};

export const prescriptions = {
  list: (query?: {
    patientId?: string;
    activeOnly?: boolean;
    limit?: number;
    offset?: number;
  }) => apiList<Prescription>("/prescriptions", query),

  create: (input: {
    patientId: string;
    medicalRecordId?: string;
    medication: string;
    dosage: string;
    frequency: string;
    duration: string;
    instructions?: string;
  }) => apiRequest<Prescription>("/prescriptions", { method: "POST", body: input }),

  update: (
    id: string,
    input: Partial<{ dosage: string; frequency: string; duration: string; instructions: string }>,
  ) => apiRequest<Prescription>(`/prescriptions/${id}`, { method: "PATCH", body: input }),

  discontinue: (id: string, reason?: string) =>
    apiRequest<Prescription>(`/prescriptions/${id}/discontinue`, {
      method: "POST",
      body: { reason },
    }),
};

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export type DocumentType =
  | "PRESCRIPTION"
  | "LAB_REPORT"
  | "BLOOD_TEST"
  | "MEDICAL_CERTIFICATE"
  | "REFERRAL_LETTER"
  | "DISCHARGE_SUMMARY"
  | "IMAGING"
  | "PROFILE_IMAGE"
  | "OTHER";

export interface MedicalDocument {
  id: string;
  patientId: string;
  medicalRecordId: string | null;
  documentType: DocumentType;
  title: string | null;
  fileName: string;
  mimeType: string;
  fileSize: number;
  checksumSha256: string | null;
  ocrStatus: string;
  uploadedById: string;
  uploadedBy: string | null;
  createdAt: string;
}

/** Types the API accepts, for the file picker. The server re-checks the bytes. */
export const ACCEPTED_UPLOAD_TYPES =
  "application/pdf,image/jpeg,image/png,image/webp,image/tiff,image/heic";

export const documents = {
  list: (query?: { patientId?: string; documentType?: DocumentType; limit?: number }) =>
    apiList<MedicalDocument>("/documents", query),

  get: (id: string) => apiRequest<MedicalDocument>(`/documents/${id}`),

  /**
   * Multipart upload — deliberately not routed through `apiRequest`, which sets
   * a JSON content type. The browser must set its own multipart boundary.
   */
  upload: async (input: {
    file: File;
    patientId: string;
    documentType?: DocumentType;
    title?: string;
    medicalRecordId?: string;
  }): Promise<MedicalDocument> => {
    const form = new FormData();
    form.append("file", input.file);
    form.append("patientId", input.patientId);
    if (input.documentType) form.append("documentType", input.documentType);
    if (input.title) form.append("title", input.title);
    if (input.medicalRecordId) form.append("medicalRecordId", input.medicalRecordId);
    return apiMultipart<MedicalDocument>("/documents", form);
  },

  /**
   * Asks for a short-lived signed link. There is no permanent URL: the link is
   * minted only after the server re-checks access, and it expires in minutes.
   */
  downloadUrl: (id: string) =>
    apiRequest<{
      url: string;
      expiresInSeconds: number;
      fileName: string;
      mimeType: string;
    }>(`/documents/${id}/download`),

  remove: (id: string) =>
    apiRequest<{ id: string; removed: boolean }>(`/documents/${id}`, { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// OCR — proposals, never facts
// ---------------------------------------------------------------------------

export type OcrStatus =
  | "PENDING"
  | "PROCESSING"
  | "EXTRACTED"
  | "CONFIRMED"
  | "FAILED"
  | "SKIPPED";

/** One extracted value, with how much the engine trusts it. */
export interface OcrField {
  value: string | null;
  confidence: number;
  needs_review: boolean;
}

export interface OcrMedication {
  medication: OcrField;
  dosage: OcrField;
  frequency: OcrField;
  duration: OcrField;
  sourceText: string;
  lineConfidence: number;
  needsReview: boolean;
}

export interface OcrStructured {
  medications: OcrMedication[];
  needsReview: boolean;
  disclaimer: string;
}

export interface OcrState {
  documentId: string;
  status: OcrStatus;
  engine: string | null;
  confidence: number | null;
  extractedText: string | null;
  /**
   * After extraction this is an `OcrStructured`. After a clinician confirms it
   * becomes `{ proposed, confirmed }` — the machine's reading is kept beside
   * the corrected one so "what did OCR say, and what did the doctor change"
   * stays answerable.
   */
  structured: OcrStructured | Record<string, unknown> | null;
  confirmedAt: string | null;
  confirmedById: string | null;
  error: string | null;
  reviewThreshold: number;
}

export interface ConfirmedMedication {
  medication: string;
  dosage: string;
  frequency: string;
  duration?: string;
  instructions?: string;
}

export const ocr = {
  get: (documentId: string) => apiRequest<OcrState>(`/documents/${documentId}/ocr`),

  run: (documentId: string) =>
    apiRequest<OcrState>(`/documents/${documentId}/ocr`, { method: "POST" }),

  /** Records a clinician's checked reading. Does not prescribe anything. */
  confirm: (documentId: string, medications: ConfirmedMedication[]) =>
    apiRequest<OcrState>(`/documents/${documentId}/ocr/confirm`, {
      method: "POST",
      body: { medications },
    }),
};

// ---------------------------------------------------------------------------
// Health assistant — guidance, never diagnosis
// ---------------------------------------------------------------------------

export type Urgency = "EMERGENCY" | "URGENT" | "ROUTINE" | "INFORMATION";

export type InputType = "TEXT" | "VOICE";

/**
 * One answer from the assistant.
 *
 * `disclaimer` is never optional and never absent — the server sends it with
 * every answer precisely so that no client can render guidance without it
 * (spec §19). Treat it as part of the answer, not as decoration.
 */
export interface AssistantAnswer {
  sessionId: string;
  answer: string;
  urgency: Urgency;
  emergency: boolean;
  suggestedDepartment: string | null;
  extractedSymptoms: string[];
  disclaimer: string;
  /** What the safety layer had to correct in the model's reply. */
  safetyInterventions: string[];
}

/** A proposal for the patient to correct. Nothing has been stored yet. */
export interface SymptomProposal extends AssistantAnswer {
  saved: false;
  reviewPrompt: string;
}

export interface AssistantStatus {
  available: boolean;
  providerConfigured: boolean;
  consentGranted: boolean;
  reason: string | null;
  disclaimer: string;
}

export interface AssistantTurn {
  id: string;
  sessionId: string;
  input: string;
  inputType: InputType;
  response: string;
  urgency: Urgency;
  emergency: boolean;
  suggestedDepartment: string | null;
  extractedSymptoms: string[];
  createdAt: string;
}

export interface ConfirmedSymptom {
  symptom: string;
  severity?: string;
  duration?: string;
}

/** Image types the assistant reads. A PDF belongs on the documents page. */
export const ACCEPTED_ASSISTANT_IMAGE_TYPES = "image/jpeg,image/png,image/webp";

/** Matches the server's cap for an inline attachment. */
export const MAX_ASSISTANT_IMAGE_BYTES = 8 * 1024 * 1024;

export const assistant = {
  status: () => apiRequest<AssistantStatus>("/assistant/status"),

  chat: (body: { message: string; sessionId?: string; inputType?: InputType }) =>
    apiRequest<AssistantAnswer>("/assistant/chat", { method: "POST", body }),

  /**
   * `chat` with a photographed report or prescription attached. The server
   * reads the image for this one answer and never stores it.
   */
  chatWithImage: (input: {
    message: string;
    image: File;
    sessionId?: string;
    inputType?: InputType;
  }) => {
    const form = new FormData();
    form.append("message", input.message);
    form.append("image", input.image);
    if (input.sessionId) form.append("sessionId", input.sessionId);
    if (input.inputType) form.append("inputType", input.inputType);
    return apiMultipart<AssistantAnswer>("/assistant/chat/image", form);
  },

  history: (query?: { sessionId?: string; limit?: number }) =>
    apiRequest<AssistantTurn[]>("/assistant/history", { query }),

  /** Extracts symptoms for review. Writes nothing. */
  analyseSymptoms: (body: { text: string; inputType?: InputType }) =>
    apiRequest<SymptomProposal>("/assistant/symptoms", { method: "POST", body }),

  /** Stores the patient's *corrected* list as patient-reported information. */
  confirmSymptoms: (body: {
    symptoms: ConfirmedSymptom[];
    inputType?: InputType;
    rawText?: string;
  }) =>
    apiRequest<{ saved: number; source: string; note: string }>("/assistant/symptoms/confirm", {
      method: "POST",
      body,
    }),
};

export interface Notification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  priority: number;
  readAt: string | null;
  createdAt: string;
}

export const notifications = {
  list: (query?: { unreadOnly?: boolean; limit?: number }) =>
    apiList<Notification, { unread: number }>("/notifications", query),
  markRead: (id: string) =>
    apiRequest<{ id: string; read: boolean }>(`/notifications/${id}/read`, { method: "POST" }),
  markAllRead: () =>
    apiRequest<{ markedRead: number }>("/notifications/read-all", { method: "POST" }),
};

// ---------------------------------------------------------------------------
// Vitals, thresholds and alerts
// ---------------------------------------------------------------------------

export type VitalType =
  | "HEART_RATE"
  | "SYSTOLIC_BP"
  | "DIASTOLIC_BP"
  | "OXYGEN_SATURATION"
  | "TEMPERATURE"
  | "RESPIRATORY_RATE";

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export type AlertStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "ESCALATED";

export interface Vital {
  id: string;
  patientId: string;
  recordedById: string | null;
  source: string;
  deviceId: string | null;
  heartRate: number | null;
  systolicBp: number | null;
  diastolicBp: number | null;
  oxygenSaturation: number | null;
  temperature: number | null;
  respiratoryRate: number | null;
  recordedAt: string;
}

export interface Alert {
  id: string;
  patientId: string;
  vitalId: string | null;
  doctorId: string | null;
  vitalType: VitalType;
  measuredValue: number;
  thresholdMin: number | null;
  thresholdMax: number | null;
  severity: AlertSeverity;
  status: AlertStatus;
  message: string;
  acknowledgedById: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  escalationLevel: number;
  createdAt: string;
}

export interface VitalThreshold {
  id: string;
  vitalType: VitalType;
  patientId: string | null;
  /** HOSPITAL is the default; PATIENT is an override that beats it. */
  scope: "HOSPITAL" | "PATIENT";
  minValue: number | null;
  maxValue: number | null;
  severity: AlertSeverity;
  enabled: boolean;
  sustainedReadings: number;
  unit: string;
  label: string;
}

/** A reading with any alerts it raised, as returned by the record endpoint. */
export interface RecordedVital extends Vital {
  alerts: Alert[];
}

export const vitals = {
  record: (body: {
    patientId: string;
    heartRate?: number;
    systolicBp?: number;
    diastolicBp?: number;
    oxygenSaturation?: number;
    temperature?: number;
    respiratoryRate?: number;
    recordedAt?: string;
    source?: string;
    deviceId?: string;
  }) => apiRequest<RecordedVital>("/vitals", { method: "POST", body }),

  list: (patientId: string, query?: { limit?: number; offset?: number }) =>
    apiList<Vital>(`/vitals/${patientId}`, query),

  /** The rules that actually govern this patient, and where each came from. */
  thresholds: (patientId: string) =>
    apiRequest<{ thresholds: VitalThreshold[]; unconfigured: VitalType[] }>(
      `/vitals/${patientId}/thresholds`,
    ),

  setThreshold: (body: {
    vitalType: VitalType;
    patientId?: string | null;
    minValue?: number | null;
    maxValue?: number | null;
    severity?: AlertSeverity;
    enabled?: boolean;
    sustainedReadings?: number;
  }) => apiRequest<VitalThreshold>("/vitals/thresholds", { method: "PUT", body }),
};

export const alerts = {
  list: (query?: {
    status?: AlertStatus;
    severity?: AlertSeverity;
    patientId?: string;
    limit?: number;
    offset?: number;
  }) => apiList<Alert>("/alerts", query),

  acknowledge: (id: string) =>
    apiRequest<Alert>(`/alerts/${id}/acknowledge`, { method: "POST" }),

  resolve: (id: string) => apiRequest<Alert>(`/alerts/${id}/resolve`, { method: "POST" }),

  /**
   * Live feed URL for `EventSource` (spec §16: not a frontend timer).
   *
   * `EventSource` sends cookies only with `withCredentials`, and the API is on
   * a different origin in development — so the caller must pass that option.
   */
  streamUrl: () => `${API_URL}/alerts/stream`,
};

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export type InvoiceStatus = "DRAFT" | "ISSUED" | "PAID" | "VOID" | "REFUNDED" | "OVERDUE";

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: string;
  amount: string;
}

export interface Invoice {
  id: string;
  patientId: string;
  appointmentId: string | null;
  invoiceNumber: string;
  /**
   * Money arrives as a string, deliberately. 0.1 + 0.2 is not 0.3 in binary
   * floating point, so a currency amount parsed into a JS number is a rounding
   * error waiting for a total. Format it; do not do arithmetic on it.
   */
  amount: string;
  /** The platform fee this bill charged, as it stood when it was issued. */
  platformFee: string;
  /** The rate applied, kept so an old invoice can explain its own tax. */
  taxPercent: string;
  taxAmount: string;
  /**
   * What the invoice was issued for. This never changes — not even once the
   * bill is late. See `amountDue` for what actually settles it today.
   */
  totalAmount: string;
  /** What a late payment will cost. Present before it is charged, so the
      consequence is visible in advance rather than as a surprise. */
  lateFee: string;
  /** The late fee currently being charged: "0.00" until the due date passes. */
  lateFeeCharged: string;
  /** Total plus any late fee — the figure a payment is taken for. */
  amountDue: string;
  currency: string;
  status: InvoiceStatus;
  lineItems: InvoiceLine[];
  notes: string | null;
  issuedAt: string | null;
  dueAt: string | null;
  paidAt: string | null;
  voidedAt: string | null;
  /** Set on a credit note: the invoice this one corrects. */
  amendsInvoiceId: string | null;
  createdAt: string;
}

/** Whether a figure is a flat amount or a share of the bill. */
export type FeeMode = "FIXED" | "PERCENT";

/** The wallets a patient can transfer from. */
export type PaymentWallet = "NAYAPAY" | "EASYPAISA";

export type PaymentClaimStatus = "SUBMITTED" | "SUCCEEDED" | "FAILED";

export interface PaymentInstructions {
  amountDue: string;
  currency: string;
  invoiceNumber: string;
  payeeName: string | null;
  nayapayNumber: string | null;
  easypaisaNumber: string | null;
  note: string | null;
  /** False when no account has been set: the screen says so rather than
      showing an empty one to transfer into. */
  configured: boolean;
}

/**
 * A claim that a bill has been paid — evidence, not settlement.
 *
 * `SUBMITTED` means the patient has transferred and shown a screenshot;
 * `SUCCEEDED` means somebody at the hospital opened the receiving account and
 * found it. Only the second pays the invoice.
 */
export interface PaymentClaim {
  id: string;
  invoiceId: string;
  amount: string;
  currency: string;
  method: string;
  status: PaymentClaimStatus;
  reference: string | null;
  hasProof: boolean;
  /** Short-lived signed link, present only where the endpoint minted one. */
  proofUrl: string | null;
  /** Why it was refused. The patient reads this. */
  rejectionReason: string | null;
  createdAt: string | null;
  reviewedAt: string | null;
}

/** A claim in the administrator's queue, with who and what it is against. */
export interface PendingPayment extends PaymentClaim {
  invoiceNumber: string;
  patientName: string;
  invoiceTotal: string;
}

export const paymentReview = {
  /** Oldest first: this is a work queue, not a feed. */
  pending: (query?: { limit?: number; offset?: number }) =>
    apiList<PendingPayment>("/payments/pending", query),

  /** Confirms the money arrived. This is what marks the invoice paid. */
  confirm: (id: string) =>
    apiRequest<PaymentClaim>(`/payments/${id}/confirm`, { method: "POST" }),

  /** Refuses it, with a reason the patient will be shown. */
  reject: (id: string, reason: string) =>
    apiRequest<PaymentClaim>(`/payments/${id}/reject`, {
      method: "POST",
      body: { reason },
    }),

  /** A fresh link to one screenshot, for a tab left open past the last one. */
  proof: (id: string) =>
    apiRequest<{ url: string; expiresInSeconds: number }>(`/payments/${id}/proof`),
};

export interface BillingSettings {
  /**
   * Each value is read through the mode beside it: rupees under `FIXED`,
   * percent under `PERCENT`. One mechanism for all three rather than assuming
   * tax is always a percentage and a fee always flat — clinics exist that do it
   * the other way round.
   */
  taxPercent: string;
  taxMode: FeeMode;
  platformFee: string;
  platformFeeMode: FeeMode;
  /** Charged once when a bill passes its due date, never per day. */
  lateFee: string;
  lateFeeMode: FeeMode;
  /** How many days a patient has before that happens. */
  paymentTermsDays: number;
  currency: string;
  /** The account patients are told to transfer into. */
  payeeName: string | null;
  nayapayNumber: string | null;
  easypaisaNumber: string | null;
  paymentNote: string | null;
  updatedAt: string | null;
}

export const billingSettings = {
  read: () => apiRequest<BillingSettings>("/invoices/settings/billing"),

  /**
   * Changes the rates. Only invoices issued afterwards take them: every invoice
   * stores what it charged, so a bill already sent to a patient never changes
   * because somebody corrected a percentage this morning.
   */
  update: (input: {
    taxPercent?: string;
    taxMode?: FeeMode;
    platformFee?: string;
    platformFeeMode?: FeeMode;
    lateFee?: string;
    lateFeeMode?: FeeMode;
    payeeName?: string;
    nayapayNumber?: string;
    easypaisaNumber?: string;
    paymentNote?: string;
  }) =>
    apiRequest<BillingSettings>("/invoices/settings/billing", {
      method: "PATCH",
      body: input,
    }),
};

export const invoices = {
  list: (query?: {
    status?: InvoiceStatus;
    patientId?: string;
    limit?: number;
    offset?: number;
  }) => apiList<Invoice, { outstanding: string }>("/invoices", query),

  get: (id: string) => apiRequest<Invoice>(`/invoices/${id}`),

  /** Records money taken at the billing desk. Administrators only. */
  pay: (id: string) => apiRequest<Invoice>(`/invoices/${id}/pay`, { method: "POST" }),

  /** Where to send the money for this bill, and how much. */
  paymentInstructions: (id: string) =>
    apiRequest<PaymentInstructions>(`/invoices/${id}/payment-instructions`),

  /**
   * Tells the hospital a transfer was made, with a screenshot.
   *
   * **This does not pay the invoice.** It records a claim; an administrator who
   * has checked the receiving account is what settles the bill. The amount is
   * taken from the invoice server-side, so nothing here can declare a bill
   * smaller than it is.
   */
  submitPaymentProof: (
    id: string,
    input: { method: PaymentWallet; reference: string; file: File },
  ) => {
    const form = new FormData();
    form.append("method", input.method);
    form.append("reference", input.reference);
    form.append("file", input.file);
    return apiMultipart<PaymentClaim>(`/invoices/${id}/payment-proof`, form);
  },

  /** Every claim made against one invoice, newest first. */
  payments: (id: string) => apiRequest<PaymentClaim[]>(`/invoices/${id}/payments`),

  void: (id: string, reason: string) =>
    apiRequest<Invoice>(`/invoices/${id}/void`, { method: "POST", body: { reason } }),

  creditNote: (id: string, reason: string) =>
    apiRequest<{ creditNote: Invoice; original: Invoice }>(`/invoices/${id}/credit-note`, {
      method: "POST",
      body: { reason },
    }),
};

// ---------------------------------------------------------------------------
// Break-glass emergency access
// ---------------------------------------------------------------------------

export type EmergencyStatus = "ACTIVE" | "EXPIRED" | "REVOKED";

export interface EmergencyGrant {
  id: string;
  requesterId: string;
  requesterName: string | null;
  patientId: string;
  reason: string;
  status: EmergencyStatus;
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** How much was actually read under the grant — the reviewer's first signal. */
  accessCount: number;
  reviewedAt: string | null;
  reviewedById: string | null;
  reviewNotes: string | null;
  /** Whether it would authorise a read right now: status *and* the clock. */
  live: boolean;
}

export interface GrantedAccess extends EmergencyGrant {
  /** False when an existing live grant was reused rather than a new one made. */
  created: boolean;
  expiresInMinutes: number;
  notice: string;
}

export const emergency = {
  /**
   * Opens one patient's chart immediately — there is no approval step.
   *
   * The response re-mints the session's access cookie with the grant attached,
   * so subsequent requests carry it without the client storing anything.
   */
  request: (body: { patientId: string; reason: string }) =>
    apiRequest<GrantedAccess>("/emergency/request", { method: "POST", body }),

  active: () => apiRequest<EmergencyGrant[]>("/emergency/active"),

  revoke: (id: string) =>
    apiRequest<EmergencyGrant>(`/emergency/${id}/revoke`, { method: "POST" }),

  /** The compliance review queue. Administrators only. */
  list: (query?: { unreviewedOnly?: boolean; limit?: number; offset?: number }) =>
    apiList<EmergencyGrant, { unreviewed: number }>("/emergency", query),

  review: (id: string, notes: string) =>
    apiRequest<EmergencyGrant>(`/emergency/${id}/review`, {
      method: "POST",
      body: { notes },
    }),
};

// ---------------------------------------------------------------------------
// Audit trail — read-only by design
// ---------------------------------------------------------------------------

export type AuditSeverity = "INFO" | "NOTICE" | "WARNING" | "BREAK_GLASS" | "SECURITY";

export interface AuditEntry {
  id: string;
  action: string;
  severity: AuditSeverity;
  userId: string | null;
  /** Null when the account has since been deleted — the trail outlives it. */
  actorName: string | null;
  actorRole: string | null;
  entityType: string | null;
  entityId: string | null;
  patientId: string | null;
  ipAddress: string | null;
  requestId: string | null;
  emergencyAccessId: string | null;
  /** References only — field names, ids, counts. Never clinical values. */
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  brokenAt: string | null;
  detail: string;
}

/**
 * There is no `create`, `update` or `remove` here, and that is the requirement
 * rather than an omission: audit records must be append-only and unreachable
 * for modification through ordinary APIs (R6).
 */
export const audit = {
  list: (query?: {
    action?: string;
    severity?: AuditSeverity;
    userId?: string;
    patientId?: string;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }) => apiList<AuditEntry, { securityEvents: number }>("/audit-logs", query),

  verify: (limit?: number) =>
    apiRequest<ChainVerification>("/audit-logs/verify", { query: { limit } }),
};

// ---------------------------------------------------------------------------
// Account — the settings a person manages for themselves
// ---------------------------------------------------------------------------

export interface TwoFactorStatus {
  enabled: boolean;
  method: TwoFactorMethod | null;
  /** How many single-use codes are still unspent. */
  backupCodesRemaining: number;
  /** Devices that currently skip the second step. */
  trustedDevices: number;
}

export interface ActiveSession {
  id: string;
  deviceClass: DeviceClass;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  /** The session making this request. It cannot be revoked from here. */
  current: boolean;
}

export const account = {
  /**
   * Replaces the signed-in person's picture.
   *
   * Multipart, because the browser has to send bytes. The server inspects them
   * the way it inspects a medical document — size, sniffed type, declared-type
   * agreement — and stores it in a private bucket; the URL that comes back is
   * short-lived and minted per request.
   */
  setAvatar: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return apiMultipart<{ avatarUrl: string; expiresInSeconds: number }>("/account/avatar", form);
  },

  removeAvatar: () => apiRequest<{ removed: boolean }>("/account/avatar", { method: "DELETE" }),

  /** A fresh signed link for the current picture, or null if there is none. */
  avatar: () =>
    apiRequest<{ avatarUrl: string | null; expiresInSeconds: number | null }>("/account/avatar"),

  twoFactor: () => apiRequest<TwoFactorStatus>("/account/2fa"),

  /**
   * Begins enrolment. `EMAIL` sends a code; `TOTP` returns the secret and a
   * ready-to-scan QR — neither takes effect until `confirmTwoFactor`.
   */
  startTwoFactor: (input: { method: TwoFactorMethod }) =>
    apiRequest<{
      challengeId: string;
      method: TwoFactorMethod;
      /** TOTP only: the shared secret, and an inline SVG of its QR code. */
      secret: string | null;
      qrSvg: string | null;
      sentTo: string | null;
    }>("/account/2fa/start", { method: "POST", body: input }),

  /** Proves the method works, and only then turns it on. */
  confirmTwoFactor: (input: { challengeId: string; code: string }) =>
    apiRequest<{ enabled: true; method: TwoFactorMethod; backupCodes: string[] }>(
      "/account/2fa/confirm",
      { method: "POST", body: input },
    ),

  /** Turning it off needs the password *and* a live code. */
  disableTwoFactor: (input: { password: string; code: string }) =>
    apiRequest<{ enabled: false }>("/account/2fa/disable", { method: "POST", body: input }),

  regenerateBackupCodes: (input: { password: string }) =>
    apiRequest<{ backupCodes: string[] }>("/account/2fa/backup-codes", {
      method: "POST",
      body: input,
    }),

  sessions: () => apiRequest<ActiveSession[]>("/account/sessions"),

  revokeSession: (id: string) =>
    apiRequest<{ id: string; revoked: boolean }>(`/account/sessions/${id}`, { method: "DELETE" }),

  /** Forgets every remembered device, so 2FA is asked for everywhere again. */
  forgetDevices: () =>
    apiRequest<{ forgotten: number }>("/account/2fa/trusted-devices", { method: "DELETE" }),
};

// ---------------------------------------------------------------------------
// Doctor applications — self-registration, reviewed by an administrator
// ---------------------------------------------------------------------------

export type ApplicationStatus = "DRAFT" | "SUBMITTED" | "APPROVED" | "REJECTED";

export type ApplicationDocumentKind =
  | "REGISTRATION_CERTIFICATE"
  | "DEGREE"
  | "NATIONAL_ID"
  | "PHOTO";

export interface ApplicationDocument {
  id: string;
  kind: ApplicationDocumentKind;
  fileName: string;
  mimeType: string;
  fileSize: number;
  uploadedAt: string;
  /** Ticked by the reviewing administrator, never by the applicant. */
  verified: boolean;
}

/**
 * One line of a doctor's education, with the years it ran.
 *
 * The years are as optional as everything else in a draft: somebody types the
 * degree before they remember the dates, and an autosave must never be refused
 * for it. So a year that has not been typed travels as `null`, exactly like a
 * blank text field, and never as `0` or an empty string.
 */
export interface QualificationEntry {
  title: string;
  startYear: number | null;
  endYear: number | null;
}

/**
 * What a stored qualification may look like on the way *in*.
 *
 * Qualifications used to be bare strings. The backend migration rewrites them
 * into objects, but a page that was open across the deploy will read one shape
 * while it was written the other, so reading stays tolerant of both. Writing is
 * not: what the form sends is always an object.
 */
export type StoredQualification = QualificationEntry | string;

/**
 * Everything a doctor fills in, all optional until they submit.
 *
 * `null` is meaningful and distinct from omission: an omitted key leaves the
 * stored value alone, an explicit null clears it. An empty string is neither —
 * the server's own rule is "two characters or more, or nothing", so a cleared
 * field must travel as null.
 */
export interface DoctorApplicationDraft {
  fullName?: string | null;
  phone?: string | null;
  nationalId?: string | null;
  address?: string | null;
  registrationNumber?: string | null;
  specialization?: string | null;
  departmentId?: string | null;
  qualifications?: QualificationEntry[];
  yearsExperience?: number | null;
  previousHospital?: string | null;
  /**
   * Where they will see patients — distinct from `address`, which is the
   * applicant's own contact address. Copied onto the doctor at approval, so an
   * administrator reviews the address that will actually be published.
   */
  clinicName?: string | null;
  city?: string | null;
  addressLine?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  consultationFee?: number | null;
  availability?: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    slotMinutes: number;
  }>;
}

/**
 * The same draft as it comes back from the server — tolerant where the write
 * side is strict, because only reading has to cope with the old shape.
 */
export interface StoredApplicationDraft extends Omit<DoctorApplicationDraft, "qualifications"> {
  qualifications?: StoredQualification[];
}

export interface DoctorApplication extends StoredApplicationDraft {
  id: string;
  status: ApplicationStatus;
  submittedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rejectionReason: string | null;
  reviewNotes: string | null;
  documents: ApplicationDocument[];
  updatedAt: string;
  /** Present on the administrator's view only. */
  applicant?: { id: string; name: string; email: string; emailVerified: boolean };
}

export const doctorApplication = {
  /** The signed-in doctor's own application, created on first read. */
  mine: () => apiRequest<DoctorApplication>("/doctor/application"),

  /** Saves a draft. Called on a debounce, so it must stay idempotent. */
  save: (draft: DoctorApplicationDraft) =>
    apiRequest<DoctorApplication>("/doctor/application", { method: "PUT", body: draft }),

  submit: () => apiRequest<DoctorApplication>("/doctor/application/submit", { method: "POST" }),

  uploadDocument: (input: { file: File; kind: ApplicationDocumentKind }) => {
    const form = new FormData();
    form.append("file", input.file);
    form.append("kind", input.kind);
    return apiMultipart<ApplicationDocument>("/doctor/application/documents", form);
  },

  removeDocument: (id: string) =>
    apiRequest<{ id: string; removed: boolean }>(`/doctor/application/documents/${id}`, {
      method: "DELETE",
    }),

  /** A short-lived link to view one uploaded document. */
  documentUrl: (id: string) =>
    apiRequest<{ url: string; expiresInSeconds: number; fileName: string; mimeType: string }>(
      `/doctor/application/documents/${id}/download`,
    ),
};

export const doctorRequests = {
  list: (query?: { status?: ApplicationStatus; limit?: number }) =>
    apiList<DoctorApplication, { pending: number }>("/admin/doctor-applications", query),

  get: (id: string) => apiRequest<DoctorApplication>(`/admin/doctor-applications/${id}`),

  /** Same signed-link shape as the applicant's own view. */
  documentUrl: (applicationId: string, documentId: string) =>
    apiRequest<{ url: string; expiresInSeconds: number; fileName: string; mimeType: string }>(
      `/admin/doctor-applications/${applicationId}/documents/${documentId}/download`,
    ),

  setDocumentVerified: (applicationId: string, documentId: string, verified: boolean) =>
    apiRequest<ApplicationDocument>(
      `/admin/doctor-applications/${applicationId}/documents/${documentId}`,
      { method: "PATCH", body: { verified } },
    ),

  approve: (id: string, input?: { notes?: string }) =>
    apiRequest<DoctorApplication>(`/admin/doctor-applications/${id}/approve`, {
      method: "POST",
      body: input ?? {},
    }),

  reject: (id: string, input: { reason: string; notes?: string }) =>
    apiRequest<DoctorApplication>(`/admin/doctor-applications/${id}/reject`, {
      method: "POST",
      body: input,
    }),
};


// ---------------------------------------------------------------------------
// A doctor's money
// ---------------------------------------------------------------------------

export type WithdrawalMethod = "BANK" | "EASYPAISA" | "JAZZCASH" | "NAYAPAY";
export type WithdrawalStatus = "REQUESTED" | "PAID" | "REJECTED";

/**
 * One movement in a doctor's balance.
 *
 * `amount` is signed: credits positive, debits negative, and the balance is
 * their sum. Format it, never do arithmetic on it — it is a decimal string for
 * the same reason every other amount here is.
 */
export interface LedgerEntry {
  id: string;
  amount: string;
  currency: string;
  kind: "EARNING" | "WITHDRAWAL" | "WITHDRAWAL_REVERSAL";
  description: string | null;
  invoiceId: string | null;
  withdrawalId: string | null;
  createdAt: string | null;
}

export interface Withdrawal {
  id: string;
  amount: string;
  currency: string;
  method: WithdrawalMethod;
  accountName: string;
  accountNumber: string;
  bankName: string | null;
  status: WithdrawalStatus;
  /** The administrator's transfer reference, once it has been paid. */
  reference: string | null;
  hasProof: boolean;
  proofUrl: string | null;
  rejectionReason: string | null;
  createdAt: string | null;
  reviewedAt: string | null;
}

/** A request in the administrator's queue, with whose it is. */
export interface PendingWithdrawal extends Withdrawal {
  doctorName: string;
}

export interface DoctorEarnings {
  /** What can be withdrawn now — money held against a pending request is
      already excluded. */
  balance: string;
  /** Everything ever credited, before anything was taken out. The difference
      between the two is what tells a doctor whether they have earned little or
      simply withdrawn a lot. */
  lifetimeEarned: string;
  currency: string;
  minimumWithdrawal: string;
  canWithdraw: boolean;
  entries: LedgerEntry[];
  withdrawals: Withdrawal[];
}

export const earnings = {
  /** Balance, statement and requests together: a balance with no statement
      behind it is a number to be argued with. */
  me: (query?: { limit?: number; offset?: number }) =>
    apiRequest<DoctorEarnings>("/withdrawals/me", { query }),

  /** Asks for a payout. The amount is held against the balance immediately. */
  request: (input: {
    amount: string;
    method: WithdrawalMethod;
    accountName: string;
    accountNumber: string;
    bankName?: string;
  }) => apiRequest<Withdrawal>("/withdrawals", { method: "POST", body: input }),
};

export const withdrawalReview = {
  pending: (query?: { limit?: number; offset?: number }) =>
    apiList<PendingWithdrawal>("/withdrawals/pending", query),

  /**
   * Records that the money has been sent, with the receipt.
   *
   * Multipart because of the screenshot. The receipt is optional in the schema
   * and expected in practice — its absence is visible on the record rather
   * than blocking an administrator who paid by a route that produces none.
   */
  markPaid: (id: string, input: { reference?: string; file?: File }) => {
    const form = new FormData();
    form.append("reference", input.reference ?? "");
    if (input.file) form.append("file", input.file);
    return apiMultipart<Withdrawal>(`/withdrawals/${id}/paid`, form);
  },

  /** Refuses it and hands the money back to the doctor's balance. */
  reject: (id: string, reason: string) =>
    apiRequest<Withdrawal>(`/withdrawals/${id}/reject`, {
      method: "POST",
      body: { reason },
    }),
};
