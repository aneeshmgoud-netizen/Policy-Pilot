// Fail-fast validation of required environment variables at bootstrap.
//
// Without this, a missing REDIS_URL silently falls back to localhost inside
// IORedis and a missing DATABASE_URL surfaces only on the first query — both
// mask a misconfiguration in staging/production. Running this from
// ConfigModule.forRoot({ validate }) turns those into a loud startup failure.

const REQUIRED_ENV_VARS = ['DATABASE_URL', 'REDIS_URL'] as const;

export function validateEnv(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const missing = REQUIRED_ENV_VARS.filter((key) => {
    const value = config[key];
    return value === undefined || String(value).trim() === '';
  });

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'Copy backend/.env.example to backend/.env and fill them in.',
    );
  }

  return config;
}
