import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodTypeAny, z } from 'zod';

import { validationFailed } from './errors.js';

export interface SuccessBody<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

/** Every successful response has the same envelope, so clients parse one shape. */
export const ok = <T>(res: Response, data: T, meta?: Record<string, unknown>): Response =>
  res.status(200).json(buildSuccess(data, meta));

export const created = <T>(res: Response, data: T): Response =>
  res.status(201).json(buildSuccess(data));

export const noContent = (res: Response): Response => res.status(204).send();

const buildSuccess = <T>(data: T, meta?: Record<string, unknown>): SuccessBody<T> =>
  meta ? { success: true, data, meta } : { success: true, data };

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 * Express 4 does not do this on its own; without it a thrown auth error would
 * hang the request instead of returning 401.
 */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };

type Source = 'body' | 'query' | 'params';

/** Parses one part of the request against a schema, or throws VALIDATION_ERROR. */
export const parseOrThrow = <S extends ZodTypeAny>(
  schema: S,
  value: unknown,
): z.infer<S> => {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw validationFailed(
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || undefined,
      message: issue.message,
    })),
  );
};

/** Validation middleware. Replaces the raw input with the parsed, typed value. */
export const validate =
  <S extends ZodTypeAny>(schema: S, source: Source = 'body'): RequestHandler =>
  (req, _res, next) => {
    try {
      const parsed = parseOrThrow(schema, req[source]);
      if (source === 'body') {
        req.body = parsed;
      } else {
        // req.query and req.params are getter-only in some Express versions.
        Object.defineProperty(req, source, { value: parsed, writable: true, configurable: true });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
