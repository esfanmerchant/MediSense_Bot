import { z } from 'zod';

import { DEVICE_CLASSES } from './session.policy.js';

const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('Enter a valid email address.')
  .max(254);

const password = z.string().min(1, 'Enter your password.').max(200);

/** Indian-style or international phone, kept permissive but bounded. */
const phone = z
  .string()
  .trim()
  .regex(/^[+]?[\d\s-]{7,20}$/, 'Enter a valid phone number.')
  .optional();

export const registerSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(120),
  email,
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
  phone,
  dateOfBirth: z.coerce.date().max(new Date(), 'Date of birth cannot be in the future.').optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'UNDISCLOSED']).optional(),
  bloodGroup: z
    .enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])
    .optional(),
  address: z.string().trim().max(500).optional(),
  emergencyContactName: z.string().trim().max(120).optional(),
  emergencyContactPhone: phone,
});

export const loginSchema = z.object({
  email,
  password,
  /** Drives the idle-timeout tier (R8 / C3). Defaults to the strictest class. */
  deviceClass: z.enum(DEVICE_CLASSES).default('SHARED_TERMINAL'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10).optional(),
});

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z.object({
  token: z.string().min(10, 'This reset link is not valid.'),
  password: z.string().min(10, 'Use at least 10 characters.').max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: password,
  newPassword: z.string().min(10, 'Use at least 10 characters.').max(200),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
