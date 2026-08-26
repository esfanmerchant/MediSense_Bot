/**
 * Typed client for the MediSense API.
 *
 * Every request sends credentials, because the session lives in httpOnly
 * cookies that page script cannot read — which is the point. There is no token
 * in memory or localStorage to steal.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

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
  | "RATE_LIMITED"
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

export interface Paginated<T> {
  data: T[];
  meta: { total: number; limit: number; offset: number; hasMore: boolean };
}

/**
 * Fires when the API reports the session has ended, so the app can redirect
 * once from a single place instead of every caller handling it.
 */
export const SESSION_ENDED_EVENT = "medisense:session-ended";

function announceSessionEnded(code: ErrorCode) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { code } }));
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
    response = await fetch(buildUrl(path, query), {
      method,
      credentials: "include",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal,
      cache: "no-store",
    });
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
    throw apiError;
  }

  return payload.data as T;
}

/** Same as apiRequest but keeps the pagination metadata. */
export async function apiList<T>(
  path: string,
  query?: RequestOptions["query"],
): Promise<Paginated<T>> {
  const response = await fetch(buildUrl(path, query), {
    credentials: "include",
    cache: "no-store",
  });
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

export const auth = {
  login: (email: string, password: string, deviceClass: DeviceClass) =>
    apiRequest<{ user: AuthUser; session: SessionInfo }>("/auth/login", {
      method: "POST",
      body: { email, password, deviceClass },
    }),

  register: (input: {
    name: string;
    email: string;
    password: string;
    phone?: string;
    dateOfBirth?: string;
  }) => apiRequest<{ user: AuthUser }>("/auth/register", { method: "POST", body: input }),

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

export const doctors = {
  myPatients: (query?: { limit?: number; offset?: number }) =>
    apiList<PatientSummary>("/doctors/me/patients", query),
  directory: (query?: { search?: string; departmentId?: string; limit?: number }) =>
    apiList<{
      id: string;
      name: string;
      specialization: string;
      consultationFee: number;
      acceptingPatients: boolean;
      department: { id: string; name: string; code: string } | null;
    }>("/doctors", query),
};

export const patients = {
  me: () => apiRequest<Record<string, unknown>>("/patients/me"),
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

export const departments = {
  list: () =>
    apiList<{
      id: string;
      name: string;
      code: string;
      location: string | null;
      doctorCount: number;
    }>("/departments"),
};
