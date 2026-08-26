process.env.NODE_ENV = 'test';

// Deterministic secrets for the test run. Never reuse these anywhere else.
process.env.JWT_SECRET ??= 'test-jwt-secret-value-that-is-long-enough-32';
process.env.SESSION_SECRET ??= 'test-session-secret-value-long-enough-32ch';
process.env.SESSION_IDLE_TIMEOUT_SECONDS ??= '120';
process.env.EMAIL_ENABLED = 'false';
process.env.AI_ENABLED = 'false';
