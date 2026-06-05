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
  objectStorage: ObjectStorageConfig;
}

export type ObjectStorageProvider = "disabled" | "minio";

export interface ObjectStorageConfig {
  provider: ObjectStorageProvider;
  bucket: string;
  region: string;
  objectPrefix: string;
  minio: MinioConfig;
}

export interface MinioConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
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
    redisUrlConfigured: hasNonEmptyString(env.REDIS_URL),
    objectStorage: readObjectStorageConfig(env)
  };
}

function readObjectStorageConfig(env: NodeJS.ProcessEnv): ObjectStorageConfig {
  return {
    provider: readObjectStorageProvider(env, "OBJECT_STORAGE_PROVIDER", "disabled"),
    bucket: readString(env, "OBJECT_STORAGE_BUCKET", "lingua-bridge-dev"),
    region: readString(env, "OBJECT_STORAGE_REGION", "us-east-1"),
    objectPrefix: normalizeObjectPrefix(
      readString(env, "OBJECT_STORAGE_PREFIX", "")
    ),
    minio: {
      endPoint: readString(env, "MINIO_ENDPOINT", "127.0.0.1"),
      port: readInteger(env, "MINIO_PORT", 9000),
      useSSL: readBoolean(env, "MINIO_USE_SSL", false),
      accessKey: readString(env, "MINIO_ACCESS_KEY", "lingua_bridge_minio"),
      secretKey: readString(env, "MINIO_SECRET_KEY", "lingua_bridge_minio_dev")
    }
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

function readBoolean(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: boolean
): boolean {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  if (raw === "true" || raw === "1") {
    return true;
  }

  if (raw === "false" || raw === "0") {
    return false;
  }

  return fallback;
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

function readObjectStorageProvider(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: ObjectStorageProvider
): ObjectStorageProvider {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  return raw === "minio" || raw === "disabled" ? raw : fallback;
}

function normalizeObjectPrefix(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed.length === 0 ? "" : `${trimmed}/`;
}

function hasNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
