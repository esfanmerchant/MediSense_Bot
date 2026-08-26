import { Prisma } from '@prisma/client';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';

import { env } from '../config/env.js';
import { AppError, ErrorCode, isAppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    success: false,
    error: {
      code: ErrorCode.NOT_FOUND,
      message: `No route matches ${req.method} ${req.path}.`,
    },
    requestId: req.requestId,
  });
};

/**
 * Single exit point for every failure.
 *
 * Clients get a stable `{ success, error: { code, message } }` shape and
 * nothing else — no stack traces, no Prisma messages, no provider payloads
 * (spec §37). The detail goes to the server log instead.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.requestId;
  const appError = toAppError(err);

  if (appError.statusCode >= 500) {
    logger.error({ err, requestId, path: req.path, method: req.method }, 'request failed');
  } else {
    logger.warn(
      { requestId, path: req.path, method: req.method, code: appError.code, status: appError.statusCode },
      'request rejected',
    );
  }

  res.status(appError.statusCode).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
    },
    requestId,
  });
};

const toAppError = (err: unknown): AppError => {
  if (isAppError(err)) return err;

  if (err instanceof ZodError) {
    return new AppError(
      422,
      ErrorCode.VALIDATION_ERROR,
      'The submitted data is invalid.',
      err.issues.map((issue) => ({
        field: issue.path.join('.') || undefined,
        message: issue.message,
      })),
    );
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return mapPrismaError(err);
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    return new AppError(
      503,
      ErrorCode.SERVICE_UNAVAILABLE,
      'The service is temporarily unavailable. Please try again shortly.',
    );
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return new AppError(400, ErrorCode.BAD_REQUEST, 'The request body is not valid JSON.');
  }

  // Anything unrecognised is treated as a bug: generic message out, detail in the log.
  return new AppError(
    500,
    ErrorCode.INTERNAL_ERROR,
    env.isProduction
      ? 'Something went wrong. The problem has been logged.'
      : `Unhandled error: ${err instanceof Error ? err.message : String(err)}`,
  );
};

const mapPrismaError = (err: Prisma.PrismaClientKnownRequestError): AppError => {
  switch (err.code) {
    case 'P2002': {
      const target = Array.isArray(err.meta?.target) ? (err.meta.target as string[]).join(', ') : undefined;
      // A unique-constraint hit on an appointment slot or an invoice is the
      // database enforcing double-booking / duplicate-invoice prevention.
      if (target?.includes('slotKey')) {
        return new AppError(409, ErrorCode.SLOT_UNAVAILABLE, 'That time slot has just been taken. Choose another.');
      }
      if (target?.includes('appointmentId')) {
        return new AppError(409, ErrorCode.DUPLICATE_INVOICE, 'An invoice already exists for this consultation.');
      }
      return new AppError(409, ErrorCode.CONFLICT, 'That record already exists.');
    }
    case 'P2025':
      return new AppError(404, ErrorCode.NOT_FOUND, 'The requested record was not found.');
    case 'P2003':
      return new AppError(400, ErrorCode.BAD_REQUEST, 'A referenced record does not exist.');
    default:
      return new AppError(500, ErrorCode.INTERNAL_ERROR, 'A database error occurred.');
  }
};
