import dotenv from "dotenv";
dotenv.config();

const required = (key: string, fallback?: string): string => {
  const v = process.env[key] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
};

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: parseInt(process.env.PORT ?? "4000", 10),
  apiPrefix: process.env.API_PREFIX ?? "/api/v1",
  corsOrigin: (process.env.CORS_ORIGIN ?? "http://localhost:3000").split(","),

  databaseUrl: required("DATABASE_URL"),

  jwt: {
    accessSecret: required("JWT_ACCESS_SECRET"),
    refreshSecret: required("JWT_REFRESH_SECRET"),
    accessExpires: process.env.JWT_ACCESS_EXPIRES ?? "15m",
    refreshExpires: process.env.JWT_REFRESH_EXPIRES ?? "7d",
  },

  appName: process.env.APP_NAME ?? "Diagnostic Management System",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",

  sms: {
    // "log" (record only — default in dev), "http" (generic POST — works for
    // SSL Wireless, Greenweb, Mim SMS, etc.), or "twilio".
    provider: (process.env.SMS_PROVIDER ?? "log").toLowerCase(),
    senderId: process.env.SMS_SENDER_ID ?? "DMS",
    // Generic HTTP provider — POSTs the body template with {to}, {body},
    // {sender} placeholders substituted. URL must be set when provider=http.
    httpUrl: process.env.SMS_HTTP_URL ?? "",
    httpToken: process.env.SMS_HTTP_TOKEN ?? "",
    httpBodyTemplate:
      process.env.SMS_HTTP_BODY_TEMPLATE ??
      `{"to":"{to}","message":"{body}","sender":"{sender}"}`,
    httpAuthHeader: process.env.SMS_HTTP_AUTH_HEADER ?? "Authorization",
    httpAuthScheme: process.env.SMS_HTTP_AUTH_SCHEME ?? "Bearer",
    // Twilio (used when provider=twilio)
    twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? "",
    twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? "",
    twilioFrom: process.env.TWILIO_FROM ?? "",
  },

  storageDir: process.env.STORAGE_DIR ?? "./storage",
};

export const isProd = env.nodeEnv === "production";

// ── Production safety checks ──────────────────────────────────────
// In production we refuse to start with the default placeholder secrets,
// short JWT secrets, or a CORS_ORIGIN of localhost. These are easy to miss
// during a rushed deploy and a leaked dev key would be catastrophic.
if (isProd) {
  const issues: string[] = [];

  const dangerousPatterns = [/change-?me/i, /please/i, /dev[-_]?(access|refresh)?[-_]?secret/i];
  const checkSecret = (label: string, value: string) => {
    if (value.length < 32) issues.push(`${label} is shorter than 32 chars`);
    if (dangerousPatterns.some((p) => p.test(value))) {
      issues.push(`${label} looks like a development placeholder`);
    }
  };
  checkSecret("JWT_ACCESS_SECRET", env.jwt.accessSecret);
  checkSecret("JWT_REFRESH_SECRET", env.jwt.refreshSecret);
  if (env.jwt.accessSecret === env.jwt.refreshSecret) {
    issues.push("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ");
  }

  if (env.corsOrigin.some((o) => /localhost|127\.0\.0\.1/.test(o))) {
    issues.push(`CORS_ORIGIN includes a localhost entry: ${env.corsOrigin.join(",")}`);
  }
  if (env.publicBaseUrl.startsWith("http://") && !/localhost|127\.0\.0\.1/.test(env.publicBaseUrl)) {
    issues.push(`PUBLIC_BASE_URL should be https:// in production`);
  }

  if (issues.length) {
    // Hard-fail rather than serve traffic with weak credentials.
    // eslint-disable-next-line no-console
    console.error("\n[env] Production safety check failed:\n  - " + issues.join("\n  - ") + "\n");
    process.exit(1);
  }
}
