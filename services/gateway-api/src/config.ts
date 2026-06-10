// 12-factor config — all runtime configuration comes from the environment.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.GATEWAY_PORT ?? 8080),
  host: process.env.GATEWAY_HOST ?? '0.0.0.0',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',

  jwt: {
    secret: process.env.JWT_SECRET ?? 'dev-only-change-me',
    issuer: process.env.JWT_ISSUER ?? 'conductor',
    expiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  },

  crypto: {
    // base64-encoded 32-byte master key (KEK). Dev key from env; KMS in prod.
    masterKeyB64: process.env.CONDUCTOR_MASTER_KEY ?? '',
    masterKeyId: process.env.CONDUCTOR_MASTER_KEY_ID ?? 'dev-local-v1',
  },

  // SSRF egress allow-list: hostnames or CIDRs an Admin has approved.
  ssrfAllowlist: (process.env.SSRF_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export function assertConfig(): void {
  required('DATABASE_URL');
  if (!config.crypto.masterKeyB64) {
    throw new Error('CONDUCTOR_MASTER_KEY is not set (32-byte base64 master key)');
  }
  if (Buffer.from(config.crypto.masterKeyB64, 'base64').length !== 32) {
    throw new Error('CONDUCTOR_MASTER_KEY must decode to exactly 32 bytes (AES-256)');
  }
}
