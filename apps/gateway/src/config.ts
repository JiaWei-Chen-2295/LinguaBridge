import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
  model: ModelConfig;
  objectStorage: ObjectStorageConfig;
}

export type ModelProvider = "mock" | "alibaba-cloud";
export type AlibabaAsrModel =
  | "qwen3-asr-flash-realtime"
  | "fun-asr-realtime"
  | "paraformer-realtime-v2";
export type AlibabaAsrInputAudioFormat = "pcm";
export type AlibabaMtModel = "qwen-mt-flash" | "qwen-mt-lite" | "qwen-mt-plus";

export interface ModelConfig {
  provider: ModelProvider;
  alibabaCloud: AlibabaCloudModelConfig;
  liveTranslateSpike: LiveTranslateSpikeConfig;
}

export interface AlibabaCloudModelConfig {
  apiKey?: string;
  asrWebsocketUrl: string;
  openAiBaseUrl: string;
  asrModel: AlibabaAsrModel;
  mtModel: AlibabaMtModel;
  inputAudioFormat: AlibabaAsrInputAudioFormat;
  asrVadThreshold: number;
  asrSilenceDurationMs: number;
  translateDrafts: boolean;
  requestTimeoutMs: number;
}

export interface LiveTranslateSpikeConfig {
  enabled: boolean;
  websocketUrl: string;
  model: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = loadGatewayEnv()): GatewayConfig {
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
    model: readModelConfig(env),
    objectStorage: readObjectStorageConfig(env)
  };
}

export function loadGatewayEnv(
  runtimeEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const packageRoot = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(packageRoot, "../..");
  const fileEnv = {
    ...readEnvFile(path.join(repoRoot, ".env")),
    ...readEnvFile(path.join(packageRoot, ".env"))
  };

  return {
    ...fileEnv,
    ...runtimeEnv
  };
}

function readEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) {
    return {};
  }

  const values: Record<string, string> = {};
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/u)) {
    const parsed = parseEnvLine(line);
    if (parsed !== undefined) {
      values[parsed.key] = parsed.value;
    }
  }

  return values;
}

function parseEnvLine(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    return undefined;
  }

  const normalized = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trimStart()
    : trimmed;
  const separatorIndex = normalized.indexOf("=");
  if (separatorIndex <= 0) {
    return undefined;
  }

  const key = normalized.slice(0, separatorIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
    return undefined;
  }

  const rawValue = normalized.slice(separatorIndex + 1).trim();
  return {
    key,
    value: unquoteEnvValue(rawValue)
  };
}

function unquoteEnvValue(value: string): string {
  if (value.length < 2) {
    return stripInlineComment(value).trim();
  }

  const quote = value[0];
  const endQuote = value[value.length - 1];
  if ((quote === '"' || quote === "'") && endQuote === quote) {
    const inner = value.slice(1, -1);
    return quote === '"' ? unescapeDoubleQuotedValue(inner) : inner;
  }

  return stripInlineComment(value).trim();
}

function stripInlineComment(value: string): string {
  const commentIndex = value.search(/\s#/u);
  return commentIndex === -1 ? value : value.slice(0, commentIndex);
}

function unescapeDoubleQuotedValue(value: string): string {
  return value
    .replaceAll("\\n", "\n")
    .replaceAll("\\r", "\r")
    .replaceAll("\\t", "\t")
    .replaceAll('\\"', '"')
    .replaceAll("\\\\", "\\");
}

function readModelConfig(env: NodeJS.ProcessEnv): ModelConfig {
  const apiKey = readOptionalString(
    env,
    "ALIBABA_MODEL_STUDIO_API_KEY",
    "DASHSCOPE_API_KEY",
    "ALIBABA_CLOUD_API_KEY"
  );
  const alibabaCloud: AlibabaCloudModelConfig = {
    asrWebsocketUrl: readString(
      env,
      "ALIBABA_ASR_REALTIME_URL",
      "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
    ),
    openAiBaseUrl: normalizeBaseUrl(
      readString(
          env,
          "ALIBABA_OPENAI_BASE_URL",
          "https://dashscope.aliyuncs.com/compatible-mode/v1"
      )
    ),
    asrModel: readAlibabaAsrModel(
      env,
      "ALIBABA_ASR_MODEL",
      "qwen3-asr-flash-realtime"
    ),
    mtModel: readAlibabaMtModel(env, "ALIBABA_MT_MODEL", "qwen-mt-flash"),
    inputAudioFormat: readAlibabaAsrInputAudioFormat(
      env,
      "ALIBABA_ASR_INPUT_AUDIO_FORMAT",
      "pcm"
    ),
    asrVadThreshold: readNumber(env, "ALIBABA_ASR_VAD_THRESHOLD", 0),
    asrSilenceDurationMs: readInteger(
      env,
      "ALIBABA_ASR_SILENCE_DURATION_MS",
      400
    ),
    translateDrafts: readBoolean(env, "ALIBABA_TRANSLATE_DRAFTS", false),
    requestTimeoutMs: readInteger(env, "ALIBABA_REQUEST_TIMEOUT_MS", 15_000)
  };

  if (apiKey !== undefined) {
    alibabaCloud.apiKey = apiKey;
  }

  return {
    provider: readModelProvider(env, "MODEL_PROVIDER", "mock"),
    alibabaCloud,
    liveTranslateSpike: {
      enabled: readBoolean(env, "LIVETRANSLATE_SPIKE_ENABLED", false),
      websocketUrl: readString(
        env,
        "LIVETRANSLATE_REALTIME_URL",
        "wss://dashscope.aliyuncs.com/api-ws/v1/realtime"
      ),
      model: readString(
        env,
        "LIVETRANSLATE_MODEL",
        "qwen3.5-livetranslate-flash-realtime"
      )
    }
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

function readOptionalString(
  env: NodeJS.ProcessEnv,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = env[key];
    if (hasNonEmptyString(value)) {
      return value;
    }
  }

  return undefined;
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

function readNumber(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number
): number {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function readModelProvider(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: ModelProvider
): ModelProvider {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  return raw === "mock" || raw === "alibaba-cloud" ? raw : fallback;
}

function readAlibabaAsrModel(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: AlibabaAsrModel
): AlibabaAsrModel {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  return raw === "qwen3-asr-flash-realtime" ||
    raw === "fun-asr-realtime" ||
    raw === "paraformer-realtime-v2"
    ? raw
    : fallback;
}

function readAlibabaMtModel(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: AlibabaMtModel
): AlibabaMtModel {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  return raw === "qwen-mt-flash" ||
    raw === "qwen-mt-lite" ||
    raw === "qwen-mt-plus"
    ? raw
    : fallback;
}

function readAlibabaAsrInputAudioFormat(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: AlibabaAsrInputAudioFormat
): AlibabaAsrInputAudioFormat {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  // The gateway always sends raw PCM16 16 kHz mono bytes. DashScope names that
  // websocket session format "pcm", while older local examples used "pcm16".
  return raw === "pcm" || raw === "pcm16" ? "pcm" : fallback;
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

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/g, "");
}

function hasNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
