import type { CookieOptions, Request, Response } from 'express';

import { env } from '../../config/env.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../middleware/auth.js';
import { clientIp } from '../../middleware/requestContext.js';
import { unauthenticated } from '../../utils/errors.js';
import { created, ok } from '../../utils/http.js';
import * as authService from './auth.service.js';
import type { SessionTokens } from './auth.service.js';

const ctxOf = (req: Request): authService.RequestContext => ({
  ipAddress: clientIp(req),
  userAgent: req.header('user-agent') ?? null,
  requestId: req.requestId,
});

/**
 * Tokens live in httpOnly cookies so that page JavaScript — and therefore any
 * injected script — cannot read them. The SPA sends credentials with each
 * request instead of holding a token in memory or localStorage.
 */
const cookieBase = (): CookieOptions => ({
  httpOnly: true,
  secure: env.isProduction,
  sameSite: 'lax',
  path: '/',
});

const setAuthCookies = (res: Response, tokens: SessionTokens): void => {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...cookieBase(),
    maxAge: tokens.accessTokenExpiresInSeconds * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...cookieBase(),
    path: '/api/auth',
    maxAge: tokens.refreshTokenExpiresInSeconds * 1000,
  });
};

const clearAuthCookies = (res: Response): void => {
  res.clearCookie(ACCESS_COOKIE, cookieBase());
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase(), path: '/api/auth' });
};

/** Session facts the client needs for its own inactivity countdown. */
const sessionInfo = (tokens: SessionTokens) => ({
  sessionId: tokens.sessionId,
  idleTimeoutSeconds: tokens.idleTimeoutSeconds,
  accessTokenExpiresInSeconds: tokens.accessTokenExpiresInSeconds,
});

export const register = async (req: Request, res: Response): Promise<void> => {
  const user = await authService.registerPatient(req.body, ctxOf(req));
  created(res, { user });
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { user, tokens } = await authService.login(req.body, ctxOf(req));
  setAuthCookies(res, tokens);
  ok(res, { user, session: sessionInfo(tokens) });
};

export const refresh = async (req: Request, res: Response): Promise<void> => {
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  const token = fromCookie ?? (req.body as { refreshToken?: string })?.refreshToken;
  if (!token) throw unauthenticated('Your session has ended. Sign in again.');

  const tokens = await authService.refreshSession(token, ctxOf(req));
  setAuthCookies(res, tokens);
  ok(res, { session: sessionInfo(tokens) });
};

export const logout = async (req: Request, res: Response): Promise<void> => {
  if (req.auth) {
    await authService.logout(req.auth.sessionId, req.auth.userId, req.auth.role, ctxOf(req));
  }
  clearAuthCookies(res);
  ok(res, { loggedOut: true });
};

export const me = async (req: Request, res: Response): Promise<void> => {
  if (!req.auth) throw unauthenticated();
  const user = await authService.getAuthenticatedUser(req.auth.userId);
  ok(res, { user });
};

export const forgotPassword = async (req: Request, res: Response): Promise<void> => {
  const result = await authService.requestPasswordReset(req.body.email, ctxOf(req));
  ok(res, {
    // Always the same message, whether or not the address has an account.
    message: 'If an account exists for that address, a reset link has been sent.',
    ...(result.token ? { devToken: result.token } : {}),
  });
};

export const resetPassword = async (req: Request, res: Response): Promise<void> => {
  await authService.resetPassword(req.body.token, req.body.password, ctxOf(req));
  clearAuthCookies(res);
  ok(res, { message: 'Your password has been changed. Sign in with your new password.' });
};

export const changePassword = async (req: Request, res: Response): Promise<void> => {
  if (!req.auth) throw unauthenticated();
  await authService.changePassword(
    req.auth.userId,
    req.body.currentPassword,
    req.body.newPassword,
    ctxOf(req),
  );
  ok(res, { message: 'Your password has been changed.' });
};
