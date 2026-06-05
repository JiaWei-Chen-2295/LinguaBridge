export type LogLevel =
  | "fatal"
  | "error"
  | "warn"
  | "info"
  | "debug"
  | "trace"
  | "silent";

export interface GatewayConfig {
  host: string;
  port: number;
  logLevel: LogLevel;
  websocketPath: string;
  wsMaxPayloadBytes: number;
  mockSubtitleDelayMs: number;
  devInviteCode: string;
  devInviteQuotaMinutes: number;
  databaseUrlConfigured: boolean;
  redisUrlConfigured: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    host: readString(env, "HOST", "0.0.0.0"),
    port: readInteger(env, "PORT", 4318),
    logLevel: readLogLevel(env, "LOG_LEVEL", "info"),
    websocketPath: readString(env, "WEBSOCKET_PATH", "/realtime/sessions"),
    wsMaxPayloadBytes: readInteger(env, "WS_MAX_PAYLOAD_BYTES", 1_048_576),
    mockSubtitleDelayMs: readInteger(env, "MOCK_SUBTITLE_DELAY_MS", 300),
    devInviteCode: readString(env, "DEV_INVITE_CODE", "ALPHA-DEV-2026"),
    devInviteQuotaMinutes: readInteger(env, "DEV_INVITE_QUOTA_MINUTES", 180),
    databaseUrlConfigured: hasNonEmptyString(env.DATABASE_URL),
    redisUrlConfigured: hasNonEmptyString(env.REDIS_URL)
  };
}

function readString(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: string
): string {
  const value = env[key];
  return hasNonEmptyString(value) ? value : fallback;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number
): number {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readLogLevel(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: LogLevel
): LogLevel {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  return isLogLevel(raw) ? raw : fallback;
}

function isLogLevel(value: string): value is LogLevel {
  return (
    value === "fatal" ||
    value === "error" ||
    value === "warn" ||
    value === "info" ||
    value === "debug" ||
    value === "trace" ||
    value === "silent"
  );
}

function hasNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
