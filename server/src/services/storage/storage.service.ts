import { createHash, randomUUID } from 'node:crypto';
import { extname } from 'node:path';

import { type SupabaseClient, createClient } from '@supabase/supabase-js';

import { env } from '../../config/env.js';
import { AppError, ErrorCode, serviceUnavailable } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Supabase Storage, used for every medical document, report and scan.
 *
 * Two rules shape this module:
 *
 *  1. Buckets are PRIVATE. A stored object is never publicly readable, so a
 *     leaked link is not a leaked record. Callers get a short-lived signed URL
 *     minted only after the access check passes (conflict C8).
 *  2. Object paths carry no patient-identifying text. A path like
 *     `.../priya-sharma/hiv-result.pdf` discloses the diagnosis before the file
 *     is even opened, so paths are built from opaque ids only.
 *
 * The service role key is used server-side and bypasses row level security —
 * authorization is enforced by the API before anything here is called.
 */

let client: SupabaseClient | null = null;

const getClient = (): SupabaseClient => {
  if (!env.storageConfigured) {
    throw serviceUnavailable(
      'Document storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.',
    );
  }
  client ??= createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
};

/** Accepted upload types. Anything else is rejected before it reaches storage. */
export const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/tiff',
  'image/heic',
]);

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024; // 20 MB

const EXTENSION_BY_MIME: Record<string, string> = {
  'application/pdf': '.pdf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/tiff': '.tif',
  'image/heic': '.heic',
};

export interface UploadInput {
  patientId: string;
  buffer: Buffer;
  mimeType: string;
  /** The name the user's file had. Used for display only, never for the path. */
  originalFileName: string;
  bucket?: string;
}

export interface UploadResult {
  bucket: string;
  path: string;
  sizeBytes: number;
  checksumSha256: string;
}

/**
 * Builds an opaque object path.
 *
 * The patient id partitions the bucket for lifecycle and deletion; the rest is
 * a random id plus an extension derived from the *verified* MIME type, never
 * from the filename the client supplied.
 */
const buildObjectPath = (patientId: string, mimeType: string): string => {
  const extension = EXTENSION_BY_MIME[mimeType] ?? '.bin';
  return `${patientId}/${randomUUID()}${extension}`;
};

/** Characters that are unsafe in a path or a Content-Disposition header. */
const UNSAFE_FILENAME_CHARS = new Set(['<', '>', ':', '"', '|', '?', '*']);

/** Reduces a client-supplied filename to something safe to store and display. */
export const sanitizeFileName = (name: string): string => {
  const base = name.split('/').pop()?.split('\\').pop() ?? 'document';

  // Filter by code point rather than a regex class, so control characters never
  // have to appear literally in this source file.
  const cleaned = Array.from(base)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 32 && code !== 127 && !UNSAFE_FILENAME_CHARS.has(char);
    })
    .join('')
    .trim();

  const extension = extname(cleaned).slice(0, 10);
  const stem = cleaned.slice(0, cleaned.length - extension.length).slice(0, 100) || 'document';
  return `${stem}${extension}`;
};

export const uploadDocument = async (input: UploadInput): Promise<UploadResult> => {
  if (input.buffer.length === 0) {
    throw new AppError(400, ErrorCode.UNSUPPORTED_FILE, 'The uploaded file is empty.');
  }
  if (input.buffer.length > MAX_DOCUMENT_BYTES) {
    throw new AppError(
      413,
      ErrorCode.FILE_TOO_LARGE,
      `Files must be ${Math.floor(MAX_DOCUMENT_BYTES / 1024 / 1024)} MB or smaller.`,
    );
  }
  if (!ALLOWED_DOCUMENT_MIME_TYPES.has(input.mimeType)) {
    throw new AppError(
      415,
      ErrorCode.UNSUPPORTED_FILE,
      'Upload a PDF or an image (JPEG, PNG, WebP, TIFF, HEIC).',
    );
  }

  const bucket = input.bucket ?? env.SUPABASE_DOCUMENTS_BUCKET;
  const path = buildObjectPath(input.patientId, input.mimeType);

  const { error } = await getClient()
    .storage.from(bucket)
    .upload(path, input.buffer, {
      contentType: input.mimeType,
      // Never overwrite: a colliding path would silently replace a medical record.
      upsert: false,
      cacheControl: 'no-store',
    });

  if (error) {
    logger.error({ err: error, bucket }, 'storage upload failed');
    throw serviceUnavailable('The document could not be stored. Try again.');
  }

  return {
    bucket,
    path,
    sizeBytes: input.buffer.length,
    checksumSha256: createHash('sha256').update(input.buffer).digest('hex'),
  };
};

/**
 * Mints a short-lived signed URL.
 *
 * Call this only after the caller has passed the patient access check — the
 * mint is the moment the access becomes auditable, so the caller is also
 * responsible for writing the DOCUMENT_VIEWED entry.
 */
export const createSignedUrl = async (
  bucket: string,
  path: string,
  ttlSeconds = env.SUPABASE_SIGNED_URL_TTL_SECONDS,
): Promise<{ url: string; expiresAt: Date }> => {
  const { data, error } = await getClient().storage.from(bucket).createSignedUrl(path, ttlSeconds);

  if (error || !data?.signedUrl) {
    logger.error({ err: error, bucket }, 'signed url creation failed');
    throw serviceUnavailable('The document could not be opened. Try again.');
  }

  return { url: data.signedUrl, expiresAt: new Date(Date.now() + ttlSeconds * 1000) };
};

/** Downloads an object server-side, e.g. to run OCR over it. */
export const downloadDocument = async (bucket: string, path: string): Promise<Buffer> => {
  const { data, error } = await getClient().storage.from(bucket).download(path);
  if (error || !data) {
    logger.error({ err: error, bucket }, 'storage download failed');
    throw serviceUnavailable('The document could not be read.');
  }
  return Buffer.from(await data.arrayBuffer());
};

export const deleteDocument = async (bucket: string, path: string): Promise<void> => {
  const { error } = await getClient().storage.from(bucket).remove([path]);
  if (error) {
    logger.error({ err: error, bucket }, 'storage delete failed');
    throw serviceUnavailable('The document could not be removed.');
  }
};

/**
 * Creates the buckets the application expects, as private, with server-side
 * type and size limits mirroring the checks above. Safe to run repeatedly.
 */
export const ensureBuckets = async (): Promise<void> => {
  const supabase = getClient();
  for (const bucket of [env.SUPABASE_DOCUMENTS_BUCKET, env.SUPABASE_AVATARS_BUCKET]) {
    const { error } = await supabase.storage.createBucket(bucket, {
      public: false,
      fileSizeLimit: MAX_DOCUMENT_BYTES,
      allowedMimeTypes: [...ALLOWED_DOCUMENT_MIME_TYPES],
    });
    // "already exists" is the expected outcome on every run after the first.
    if (error && !/already exists/i.test(error.message)) {
      throw new AppError(500, ErrorCode.INTERNAL_ERROR, `Could not create bucket ${bucket}: ${error.message}`);
    }
  }
};
