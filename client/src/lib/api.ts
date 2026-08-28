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
export async function apiList<T, Extra = unknown>(
  path: string,
  query?: RequestOptions["query"],
): Promise<Paginated<T, Extra>> {
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

export interface TimeOff {
  id: string;
  startsAt: string;
  endsAt: string;
  reason: string | null;
}

export const doctors = {
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

    let response: Response;
    try {
      response = await fetch(`${API_URL}/documents`, {
        method: "POST",
        credentials: "include",
        body: form,
        cache: "no-store",
      });
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
      throw apiError;
    }
    return payload.data as MedicalDocument;
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
