/**
 * Development seed data.
 *
 * Every person here is fictional (spec §42). Never point this at a database
 * holding real patient data — it upserts by email and would overwrite accounts.
 *
 * Run with:  npm run seed
 */
import { Gender, PrismaClient, Role, UserStatus, VitalType } from '@prisma/client';

import { hashPassword } from '../src/utils/password.js';

const prisma = new PrismaClient();

/** Shared demo password. Obvious, weak on purpose, and dev-only. */
const DEMO_PASSWORD = 'Demo@Pass123';

const DEPARTMENTS = [
  { name: 'General Medicine', code: 'GEN', location: 'Block A, Level 1' },
  { name: 'Cardiology', code: 'CARD', location: 'Block B, Level 3' },
  { name: 'Pulmonology', code: 'PULM', location: 'Block B, Level 2' },
  { name: 'Paediatrics', code: 'PAED', location: 'Block C, Level 1' },
];

/**
 * Hospital-wide default thresholds (R1, R17). Deliberately conservative adult
 * ranges — a clinician is expected to review these and to set per-patient
 * overrides, which is what keeps a COPD patient's normal saturation from
 * firing a hospital alarm every reading (conflict C9).
 */
const DEFAULT_THRESHOLDS = [
  { vitalType: VitalType.HEART_RATE, minValue: 50, maxValue: 120, severity: 'WARNING' as const, sustainedReadings: 2 },
  { vitalType: VitalType.SYSTOLIC_BP, minValue: 90, maxValue: 160, severity: 'WARNING' as const, sustainedReadings: 2 },
  { vitalType: VitalType.DIASTOLIC_BP, minValue: 55, maxValue: 100, severity: 'WARNING' as const, sustainedReadings: 2 },
  { vitalType: VitalType.OXYGEN_SATURATION, minValue: 92, maxValue: null, severity: 'CRITICAL' as const, sustainedReadings: 2 },
  { vitalType: VitalType.TEMPERATURE, minValue: 35.5, maxValue: 38.0, severity: 'WARNING' as const, sustainedReadings: 1 },
  { vitalType: VitalType.RESPIRATORY_RATE, minValue: 10, maxValue: 24, severity: 'WARNING' as const, sustainedReadings: 2 },
];

const seedDepartments = async () => {
  const results = [];
  for (const department of DEPARTMENTS) {
    results.push(
      await prisma.department.upsert({
        where: { code: department.code },
        update: {},
        create: department,
      }),
    );
  }
  return results;
};

const createUser = async (
  input: { name: string; email: string; role: Role; phone?: string },
  passwordHash: string,
) =>
  prisma.user.upsert({
    where: { email: input.email },
    update: { name: input.name, role: input.role },
    create: {
      name: input.name,
      email: input.email,
      role: input.role,
      phone: input.phone ?? null,
      passwordHash,
      status: UserStatus.ACTIVE,
      emailVerifiedAt: new Date(),
    },
  });

const main = async () => {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  const departments = await seedDepartments();
  const [general, cardiology, pulmonology] = departments;

  // --- Admin ---------------------------------------------------------------
  await createUser(
    { name: 'Asha Menon', email: 'admin@example.com', role: Role.ADMIN, phone: '+91 98200 00001' },
    passwordHash,
  );

  // --- Nurse (no dashboard yet; exists so break-glass has a principal) ------
  await createUser(
    { name: 'Fatima Qureshi', email: 'nurse@example.com', role: Role.NURSE, phone: '+91 98200 00002' },
    passwordHash,
  );

  // --- Doctors -------------------------------------------------------------
  const doctorSeeds = [
    {
      name: 'Dr. Rajesh Iyer',
      email: 'doctor@example.com',
      specialization: 'Cardiology',
      licenseNumber: 'DEMO-MC-10001',
      departmentId: cardiology?.id ?? null,
      consultationFee: 800,
      yearsExperience: 14,
    },
    {
      name: 'Dr. Neha Kulkarni',
      email: 'doctor2@example.com',
      specialization: 'Pulmonology',
      licenseNumber: 'DEMO-MC-10002',
      departmentId: pulmonology?.id ?? null,
      consultationFee: 650,
      yearsExperience: 9,
    },
    {
      name: 'Dr. Samuel Fernandes',
      email: 'doctor3@example.com',
      specialization: 'General Medicine',
      licenseNumber: 'DEMO-MC-10003',
      departmentId: general?.id ?? null,
      consultationFee: 500,
      yearsExperience: 6,
    },
  ];

  const doctors = [];
  for (const seed of doctorSeeds) {
    const user = await createUser({ name: seed.name, email: seed.email, role: Role.DOCTOR }, passwordHash);
    doctors.push(
      await prisma.doctor.upsert({
        where: { userId: user.id },
        update: { specialization: seed.specialization, departmentId: seed.departmentId },
        create: {
          userId: user.id,
          specialization: seed.specialization,
          licenseNumber: seed.licenseNumber,
          departmentId: seed.departmentId,
          consultationFee: seed.consultationFee,
          yearsExperience: seed.yearsExperience,
          // Mon–Fri clinic, 30-minute slots.
          availability: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
            dayOfWeek,
            startTime: '09:00',
            endTime: '17:00',
            slotMinutes: 30,
          })),
        },
      }),
    );
  }

  // --- Patients ------------------------------------------------------------
  const patientSeeds = [
    {
      name: 'Priya Sharma',
      email: 'patient@example.com',
      mrn: 'MRN-DEMO-000001',
      dateOfBirth: new Date('1991-04-17'),
      gender: Gender.FEMALE,
      bloodGroup: 'O+',
      allergies: 'Penicillin',
      chronicConditions: null,
    },
    {
      name: 'Vikram Desai',
      email: 'patient2@example.com',
      mrn: 'MRN-DEMO-000002',
      dateOfBirth: new Date('1958-11-02'),
      gender: Gender.MALE,
      bloodGroup: 'B+',
      allergies: null,
      chronicConditions: 'COPD, Type 2 diabetes',
    },
    {
      name: 'Meera Nair',
      email: 'patient3@example.com',
      mrn: 'MRN-DEMO-000003',
      dateOfBirth: new Date('2016-06-30'),
      gender: Gender.FEMALE,
      bloodGroup: 'A+',
      allergies: 'Peanuts',
      chronicConditions: 'Asthma',
    },
  ];

  const patients = [];
  for (const seed of patientSeeds) {
    const user = await createUser({ name: seed.name, email: seed.email, role: Role.PATIENT }, passwordHash);
    patients.push(
      await prisma.patient.upsert({
        where: { userId: user.id },
        update: {},
        create: {
          userId: user.id,
          medicalRecordNumber: seed.mrn,
          dateOfBirth: seed.dateOfBirth,
          gender: seed.gender,
          bloodGroup: seed.bloodGroup,
          address: 'Demo address, Mumbai 400001',
          emergencyContactName: 'Demo Contact',
          emergencyContactPhone: '+91 98200 99999',
          allergies: seed.allergies,
          chronicConditions: seed.chronicConditions,
          // Demo patients have consented to AI features so the chatbot is testable.
          aiConsentGrantedAt: new Date(),
        },
      }),
    );
  }

  // --- Care relationships (what doctor authorization is checked against) ----
  const assignments: Array<[number, number, boolean]> = [
    [0, 0, true], // Dr. Iyer  -> Priya
    [1, 1, true], // Dr. Kulkarni -> Vikram
    [2, 2, true], // Dr. Fernandes -> Meera
    [0, 1, false], // Dr. Iyer also follows Vikram (cardiac history)
  ];

  for (const [doctorIndex, patientIndex, isPrimary] of assignments) {
    const doctor = doctors[doctorIndex];
    const patient = patients[patientIndex];
    if (!doctor || !patient) continue;
    await prisma.doctorPatientAssignment.upsert({
      where: { doctorId_patientId: { doctorId: doctor.id, patientId: patient.id } },
      update: { isPrimary },
      create: { doctorId: doctor.id, patientId: patient.id, isPrimary },
    });
  }

  // --- Hospital default thresholds -----------------------------------------
  // Hospital defaults have patientId = NULL, which Prisma cannot express in a
  // compound-unique `where`, so these are looked up before insert.
  for (const threshold of DEFAULT_THRESHOLDS) {
    const existing = await prisma.vitalThreshold.findFirst({
      where: { vitalType: threshold.vitalType, patientId: null },
      select: { id: true },
    });
    if (!existing) await prisma.vitalThreshold.create({ data: threshold });
  }

  // Per-patient override for the COPD patient, so his baseline saturation does
  // not trip the hospital-wide alarm.
  const copdPatient = patients[1];
  if (copdPatient) {
    await prisma.vitalThreshold.upsert({
      where: { vitalType_patientId: { vitalType: VitalType.OXYGEN_SATURATION, patientId: copdPatient.id } },
      update: {},
      create: {
        vitalType: VitalType.OXYGEN_SATURATION,
        patientId: copdPatient.id,
        minValue: 88,
        maxValue: null,
        severity: 'CRITICAL',
        sustainedReadings: 2,
      },
    });
  }

  process.stdout.write(
    [
      '',
      'Seed complete.',
      `  departments: ${departments.length}   doctors: ${doctors.length}   patients: ${patients.length}`,
      '',
      '  Demo accounts (all share the same password):',
      '    admin@example.com    ADMIN',
      '    doctor@example.com   DOCTOR   (Cardiology)',
      '    patient@example.com  PATIENT',
      '    nurse@example.com    NURSE    (emergency access only)',
      `    password: ${DEMO_PASSWORD}`,
      '',
    ].join('\n'),
  );
};

main()
  .catch((err: unknown) => {
    process.exitCode = 1;
    process.stderr.write(`Seed failed: ${err instanceof Error ? err.message : String(err)}\n`);
  })
  .finally(() => prisma.$disconnect());
