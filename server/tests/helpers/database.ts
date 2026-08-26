/**
 * Integration tests need a real Postgres. Until DATABASE_URL points at a
 * reachable test database they are skipped rather than failing, so a fresh
 * clone can still run the unit suite with `npm test`.
 */
const configured = Boolean(process.env.DATABASE_URL) && !process.env.DATABASE_URL?.includes('localhost:5432/medisense_test');

export const hasDatabase = configured;

/** Use as `describeDb('...', () => { ... })` for suites that need Postgres. */
export const dbTestNote =
  'skipped: set DATABASE_URL in .env and run `npm run prisma:migrate` to enable database tests';
