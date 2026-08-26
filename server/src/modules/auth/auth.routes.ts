import { Router } from 'express';

import { optionalAuth, requireAuth } from '../../middleware/auth.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { asyncHandler, validate } from '../../utils/http.js';
import * as controller from './auth.controller.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from './auth.schemas.js';

export const authRouter = Router();

authRouter.post('/register', authLimiter, validate(registerSchema), asyncHandler(controller.register));
authRouter.post('/login', authLimiter, validate(loginSchema), asyncHandler(controller.login));
authRouter.post('/refresh', authLimiter, validate(refreshSchema), asyncHandler(controller.refresh));

// Logout works even with an already-expired session so the client can always
// clear its cookies.
authRouter.post('/logout', optionalAuth, asyncHandler(controller.logout));

authRouter.get('/me', requireAuth, asyncHandler(controller.me));

authRouter.post(
  '/forgot-password',
  authLimiter,
  validate(forgotPasswordSchema),
  asyncHandler(controller.forgotPassword),
);
authRouter.post(
  '/reset-password',
  authLimiter,
  validate(resetPasswordSchema),
  asyncHandler(controller.resetPassword),
);
authRouter.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  asyncHandler(controller.changePassword),
);
