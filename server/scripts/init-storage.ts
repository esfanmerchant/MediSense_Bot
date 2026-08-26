/**
 * Creates the private Supabase Storage buckets the application expects.
 * Safe to run repeatedly — existing buckets are left alone.
 *
 *   npm run storage:init
 */
import { env } from '../src/config/env.js';
import { ensureBuckets } from '../src/services/storage/storage.service.js';

const main = async (): Promise<void> => {
  if (!env.storageConfigured) {
    process.stderr.write(
      'Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env first.\n',
    );
    process.exitCode = 1;
    return;
  }

  await ensureBuckets();
  process.stdout.write(
    [
      '',
      'Storage ready (private buckets):',
      `  ${env.SUPABASE_DOCUMENTS_BUCKET}  — reports, prescriptions, scans`,
      `  ${env.SUPABASE_AVATARS_BUCKET}  — profile images`,
      '',
      'Neither bucket is publicly readable. Access goes through the API, which',
      'checks authorization, mints a short-lived signed URL, and writes an audit entry.',
      '',
    ].join('\n'),
  );
};

main().catch((err: unknown) => {
  process.exitCode = 1;
  process.stderr.write(`Storage init failed: ${err instanceof Error ? err.message : String(err)}\n`);
});
