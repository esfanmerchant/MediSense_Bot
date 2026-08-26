-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'DOCTOR', 'PATIENT', 'NURSE');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('REQUESTED', 'CONFIRMED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PAID', 'VOID', 'REFUNDED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('PRESCRIPTION', 'LAB_REPORT', 'BLOOD_TEST', 'MEDICAL_CERTIFICATE', 'REFERRAL_LETTER', 'DISCHARGE_SUMMARY', 'IMAGING', 'PROFILE_IMAGE', 'OTHER');

-- CreateEnum
CREATE TYPE "OcrStatus" AS ENUM ('PENDING', 'PROCESSING', 'EXTRACTED', 'CONFIRMED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "OcrEngine" AS ENUM ('TESSERACT', 'GEMINI_VISION', 'MANUAL');

-- CreateEnum
CREATE TYPE "VitalType" AS ENUM ('HEART_RATE', 'SYSTOLIC_BP', 'DIASTOLIC_BP', 'OXYGEN_SATURATION', 'TEMPERATURE', 'RESPIRATORY_RATE');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATED');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('PHYSICIAN', 'PATIENT_REPORTED', 'AI_ASSISTED', 'OCR_EXTRACTED', 'DEVICE');

-- CreateEnum
CREATE TYPE "InputType" AS ENUM ('TEXT', 'VOICE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('APPOINTMENT_BOOKED', 'APPOINTMENT_REMINDER', 'APPOINTMENT_CANCELLED', 'APPOINTMENT_RESCHEDULED', 'MEDICATION_REMINDER', 'INVOICE_ISSUED', 'REPORT_UPLOADED', 'VITAL_ALERT', 'EMERGENCY_ACCESS', 'ACCOUNT_SECURITY');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ');

-- CreateEnum
CREATE TYPE "EmergencyAccessStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'SESSION_EXPIRED', 'PASSWORD_RESET_REQUESTED', 'PASSWORD_CHANGED', 'USER_CREATED', 'USER_UPDATED', 'USER_STATUS_CHANGED', 'PATIENT_RECORD_VIEW', 'PATIENT_RECORD_CREATE', 'PATIENT_RECORD_UPDATE', 'PRESCRIPTION_CREATED', 'PRESCRIPTION_UPDATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_VIEWED', 'DOCUMENT_DELETED', 'APPOINTMENT_CREATED', 'APPOINTMENT_UPDATED', 'APPOINTMENT_CANCELLED', 'CONSULTATION_COMPLETED', 'INVOICE_CREATED', 'INVOICE_UPDATED', 'AI_INTERACTION', 'OCR_PROCESSED', 'OCR_CONFIRMED', 'VITAL_RECORDED', 'VITAL_ALERT', 'EMERGENCY_ACCESS_GRANTED', 'EMERGENCY_ACCESS_USED', 'EMERGENCY_ACCESS_REVOKED', 'ACCESS_DENIED', 'CONFIG_CHANGED');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('INFO', 'NOTICE', 'WARNING', 'BREAK_GLASS', 'SECURITY');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "phone" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "emailVerifiedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "deviceClass" TEXT NOT NULL DEFAULT 'PERSONAL',
    "userAgent" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usedAt" TIMESTAMP(3),
    "replacedById" TEXT,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "location" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctors" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "specialization" TEXT NOT NULL,
    "licenseNumber" TEXT NOT NULL,
    "departmentId" TEXT,
    "qualifications" TEXT,
    "yearsExperience" INTEGER,
    "consultationFee" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "availability" JSONB NOT NULL DEFAULT '[]',
    "acceptingPatients" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "doctors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_time_off" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,

    CONSTRAINT "doctor_time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "patients" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "medicalRecordNumber" TEXT NOT NULL,
    "dateOfBirth" TIMESTAMP(3),
    "gender" "Gender" NOT NULL DEFAULT 'UNDISCLOSED',
    "bloodGroup" TEXT,
    "address" TEXT,
    "emergencyContactName" TEXT,
    "emergencyContactPhone" TEXT,
    "allergies" TEXT,
    "chronicConditions" TEXT,
    "aiConsentGrantedAt" TIMESTAMP(3),
    "aiConsentWithdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "patients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "doctor_patient_assignments" (
    "id" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "assignedBy" TEXT,

    CONSTRAINT "doctor_patient_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointments" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "appointmentDate" TIMESTAMP(3) NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" TEXT,
    "notes" TEXT,
    "slotKey" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelReason" TEXT,
    "rescheduledFromId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_records" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "symptoms" TEXT,
    "diagnosis" TEXT,
    "treatmentPlan" TEXT,
    "notes" TEXT,
    "followUpDate" TIMESTAMP(3),
    "followUpNotes" TEXT,
    "source" "DataSource" NOT NULL DEFAULT 'PHYSICIAN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medical_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prescriptions" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "doctorId" TEXT NOT NULL,
    "medicalRecordId" TEXT,
    "medication" TEXT NOT NULL,
    "dosage" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "duration" TEXT NOT NULL,
    "instructions" TEXT,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "prescriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reported_symptoms" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "symptom" TEXT NOT NULL,
    "severity" TEXT,
    "durationText" TEXT,
    "rawText" TEXT,
    "source" "DataSource" NOT NULL DEFAULT 'PATIENT_REPORTED',
    "inputType" "InputType" NOT NULL DEFAULT 'TEXT',
    "confidence" DOUBLE PRECISION,
    "aiInteractionId" TEXT,
    "promotedToRecordId" TEXT,
    "promotedById" TEXT,
    "promotedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reported_symptoms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "medical_documents" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "uploadedById" TEXT NOT NULL,
    "medicalRecordId" TEXT,
    "documentType" "DocumentType" NOT NULL DEFAULT 'OTHER',
    "title" TEXT,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "checksumSha256" TEXT,
    "storageBucket" TEXT NOT NULL DEFAULT 'medical-documents',
    "storagePath" TEXT NOT NULL,
    "ocrStatus" "OcrStatus" NOT NULL DEFAULT 'PENDING',
    "ocrEngine" "OcrEngine",
    "ocrConfidence" DOUBLE PRECISION,
    "extractedText" TEXT,
    "structuredData" JSONB,
    "confirmedById" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "ocrError" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "medical_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vitals" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "recordedById" TEXT,
    "source" "DataSource" NOT NULL DEFAULT 'DEVICE',
    "deviceId" TEXT,
    "heartRate" INTEGER,
    "systolicBp" INTEGER,
    "diastolicBp" INTEGER,
    "oxygenSaturation" DOUBLE PRECISION,
    "temperature" DOUBLE PRECISION,
    "respiratoryRate" INTEGER,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vitals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vital_thresholds" (
    "id" TEXT NOT NULL,
    "vitalType" "VitalType" NOT NULL,
    "patientId" TEXT,
    "minValue" DOUBLE PRECISION,
    "maxValue" DOUBLE PRECISION,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'WARNING',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sustainedReadings" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vital_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "vitalId" TEXT,
    "doctorId" TEXT,
    "vitalType" "VitalType" NOT NULL,
    "measuredValue" DOUBLE PRECISION NOT NULL,
    "thresholdMin" DOUBLE PRECISION,
    "thresholdMax" DOUBLE PRECISION,
    "severity" "AlertSeverity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "message" TEXT NOT NULL,
    "acknowledgedById" TEXT,
    "acknowledgedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "escalationLevel" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "invoiceNumber" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "lineItems" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "issuedAt" TIMESTAMP(3),
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "amendsInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_interactions" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "input" TEXT NOT NULL,
    "inputType" "InputType" NOT NULL DEFAULT 'TEXT',
    "extractedSymptoms" JSONB NOT NULL DEFAULT '[]',
    "response" TEXT NOT NULL,
    "emergencyFlagged" BOOLEAN NOT NULL DEFAULT false,
    "recommendedDepartment" TEXT,
    "urgencyLevel" TEXT,
    "modelName" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_interactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "channel" "NotificationChannel" NOT NULL DEFAULT 'IN_APP',
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "metadata" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emergency_access" (
    "id" TEXT NOT NULL,
    "requesterId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "EmergencyAccessStatus" NOT NULL DEFAULT 'ACTIVE',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "reviewNotes" TEXT,
    "accessCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "emergency_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "actorRole" "Role",
    "action" "AuditAction" NOT NULL,
    "severity" "AuditSeverity" NOT NULL DEFAULT 'INFO',
    "entityType" TEXT,
    "entityId" TEXT,
    "patientId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "metadata" JSONB,
    "emergencyAccessId" TEXT,
    "previousHash" TEXT,
    "entryHash" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_config" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_config_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE INDEX "sessions_userId_revokedAt_idx" ON "sessions"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_tokenHash_key" ON "refresh_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "refresh_tokens_sessionId_idx" ON "refresh_tokens"("sessionId");

-- CreateIndex
CREATE INDEX "refresh_tokens_userId_idx" ON "refresh_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_idx" ON "password_reset_tokens"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "departments_name_key" ON "departments"("name");

-- CreateIndex
CREATE UNIQUE INDEX "departments_code_key" ON "departments"("code");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_userId_key" ON "doctors"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "doctors_licenseNumber_key" ON "doctors"("licenseNumber");

-- CreateIndex
CREATE INDEX "doctors_departmentId_idx" ON "doctors"("departmentId");

-- CreateIndex
CREATE INDEX "doctors_specialization_idx" ON "doctors"("specialization");

-- CreateIndex
CREATE INDEX "doctor_time_off_doctorId_startsAt_idx" ON "doctor_time_off"("doctorId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "patients_userId_key" ON "patients"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "patients_medicalRecordNumber_key" ON "patients"("medicalRecordNumber");

-- CreateIndex
CREATE INDEX "doctor_patient_assignments_patientId_endedAt_idx" ON "doctor_patient_assignments"("patientId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "doctor_patient_assignments_doctorId_patientId_key" ON "doctor_patient_assignments"("doctorId", "patientId");

-- CreateIndex
CREATE INDEX "appointments_doctorId_startTime_idx" ON "appointments"("doctorId", "startTime");

-- CreateIndex
CREATE INDEX "appointments_patientId_startTime_idx" ON "appointments"("patientId", "startTime");

-- CreateIndex
CREATE INDEX "appointments_status_idx" ON "appointments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_slotKey_key" ON "appointments"("slotKey");

-- CreateIndex
CREATE UNIQUE INDEX "medical_records_appointmentId_key" ON "medical_records"("appointmentId");

-- CreateIndex
CREATE INDEX "medical_records_patientId_createdAt_idx" ON "medical_records"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "medical_records_doctorId_idx" ON "medical_records"("doctorId");

-- CreateIndex
CREATE INDEX "prescriptions_patientId_active_idx" ON "prescriptions"("patientId", "active");

-- CreateIndex
CREATE INDEX "prescriptions_medicalRecordId_idx" ON "prescriptions"("medicalRecordId");

-- CreateIndex
CREATE INDEX "reported_symptoms_patientId_createdAt_idx" ON "reported_symptoms"("patientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "medical_documents_storagePath_key" ON "medical_documents"("storagePath");

-- CreateIndex
CREATE INDEX "medical_documents_patientId_createdAt_idx" ON "medical_documents"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "medical_documents_documentType_idx" ON "medical_documents"("documentType");

-- CreateIndex
CREATE INDEX "medical_documents_ocrStatus_idx" ON "medical_documents"("ocrStatus");

-- CreateIndex
CREATE INDEX "vitals_patientId_recordedAt_idx" ON "vitals"("patientId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "vital_thresholds_vitalType_patientId_key" ON "vital_thresholds"("vitalType", "patientId");

-- CreateIndex
CREATE INDEX "alerts_patientId_status_idx" ON "alerts"("patientId", "status");

-- CreateIndex
CREATE INDEX "alerts_doctorId_status_idx" ON "alerts"("doctorId", "status");

-- CreateIndex
CREATE INDEX "alerts_status_createdAt_idx" ON "alerts"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_appointmentId_key" ON "invoices"("appointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON "invoices"("invoiceNumber");

-- CreateIndex
CREATE INDEX "invoices_patientId_status_idx" ON "invoices"("patientId", "status");

-- CreateIndex
CREATE INDEX "ai_interactions_patientId_createdAt_idx" ON "ai_interactions"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_interactions_sessionId_idx" ON "ai_interactions"("sessionId");

-- CreateIndex
CREATE INDEX "notifications_userId_status_idx" ON "notifications"("userId", "status");

-- CreateIndex
CREATE INDEX "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt");

-- CreateIndex
CREATE INDEX "emergency_access_patientId_status_idx" ON "emergency_access"("patientId", "status");

-- CreateIndex
CREATE INDEX "emergency_access_requesterId_idx" ON "emergency_access"("requesterId");

-- CreateIndex
CREATE INDEX "emergency_access_status_expiresAt_idx" ON "emergency_access"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "audit_logs_userId_timestamp_idx" ON "audit_logs"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_patientId_timestamp_idx" ON "audit_logs"("patientId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_action_timestamp_idx" ON "audit_logs"("action", "timestamp");

-- CreateIndex
CREATE INDEX "audit_logs_severity_timestamp_idx" ON "audit_logs"("severity", "timestamp");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_time_off" ADD CONSTRAINT "doctor_time_off_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_patient_assignments" ADD CONSTRAINT "doctor_patient_assignments_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "doctor_patient_assignments" ADD CONSTRAINT "doctor_patient_assignments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_records" ADD CONSTRAINT "medical_records_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_medicalRecordId_fkey" FOREIGN KEY ("medicalRecordId") REFERENCES "medical_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reported_symptoms" ADD CONSTRAINT "reported_symptoms_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reported_symptoms" ADD CONSTRAINT "reported_symptoms_aiInteractionId_fkey" FOREIGN KEY ("aiInteractionId") REFERENCES "ai_interactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reported_symptoms" ADD CONSTRAINT "reported_symptoms_promotedToRecordId_fkey" FOREIGN KEY ("promotedToRecordId") REFERENCES "medical_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_documents" ADD CONSTRAINT "medical_documents_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_documents" ADD CONSTRAINT "medical_documents_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "medical_documents" ADD CONSTRAINT "medical_documents_medicalRecordId_fkey" FOREIGN KEY ("medicalRecordId") REFERENCES "medical_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vitals" ADD CONSTRAINT "vitals_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vital_thresholds" ADD CONSTRAINT "vital_thresholds_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_vitalId_fkey" FOREIGN KEY ("vitalId") REFERENCES "vitals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_doctorId_fkey" FOREIGN KEY ("doctorId") REFERENCES "doctors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_interactions" ADD CONSTRAINT "ai_interactions_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_access" ADD CONSTRAINT "emergency_access_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_access" ADD CONSTRAINT "emergency_access_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "patients"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
