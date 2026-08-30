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

/**
 * Multipart POST. Deliberately not routed through `apiRequest`, which sets a
 * JSON content type: the browser must set its own multipart boundary.
 */
export async function apiMultipart<T>(path: string, form: FormData): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
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

/** What a sign-in produced: a session, or a challenge standing in its way. */
export type LoginResult =
  | { requires2FA: false; user: AuthUser; session: SessionInfo }
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
  taxAmount: string;
  totalAmount: string;
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

export const invoices = {
  list: (query?: {
    status?: InvoiceStatus;
    patientId?: string;
    limit?: number;
    offset?: number;
  }) => apiList<Invoice, { outstanding: string }>("/invoices", query),

  get: (id: string) => apiRequest<Invoice>(`/invoices/${id}`),

  pay: (id: string) => apiRequest<Invoice>(`/invoices/${id}/pay`, { method: "POST" }),

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
  qualifications?: string[];
  yearsExperience?: number | null;
  previousHospital?: string | null;
  consultationFee?: number | null;
  availability?: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    slotMinutes: number;
  }>;
}

export interface DoctorApplication extends DoctorApplicationDraft {
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
