import type { Role } from '@prisma/client';

import type { PermissionValue } from '../modules/auth/rbac.js';

declare global {
  namespace Express {
    interface AuthContext {
      userId: string;
      role: Role;
      sessionId: string;
      permissions: readonly PermissionValue[];
      /** Patient row id, present only for PATIENT users. */
      patientId?: string;
      /** Doctor row id, present only for DOCTOR users. */
      doctorId?: string;
      /** Active break-glass grant id, when the request runs under one (R3). */
      emergencyAccessId?: string;
    }

    interface Request {
      /** Set by requireAuth. Absent on public routes. */
      auth?: AuthContext;
      /** Correlation id, echoed as the X-Request-Id header. */
      requestId: string;
    }
  }
}

export {};
