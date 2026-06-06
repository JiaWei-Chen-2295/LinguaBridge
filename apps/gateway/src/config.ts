import { existsSync, readFileSync } from "node:fs";
import type { InterpretationAudioSampleFormat } from "@lingua-bridge/protocol";
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
  subtitleRevisionIntervalMs: number;
  devInviteCode: string;
  devInviteQuotaMinutes: number;
  databaseUrl?: string;
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
export type AlibabaRevisionModel = "qwen-plus" | "qwen-turbo";

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
  revisionModel: AlibabaRevisionModel;
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
  voice: string;
  outputSampleFormat: InterpretationAudioSampleFormat;
  outputSampleRate: number;
}

export type ObjectStorageProvider = "disabled" | "minio" | "oss";

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
  const databaseUrl = readOptionalString(env, "DATABASE_URL");
  const config: GatewayConfig = {
    host: readString(env, "HOST", "0.0.0.0"),
    port: readInteger(env, "PORT", 4318),
    logLevel: readLogLevel(env, "LOG_LEVEL", "info"),
    websocketPath: readString(env, "WEBSOCKET_PATH", "/realtime/sessions"),
    wsMaxPayloadBytes: readInteger(env, "WS_MAX_PAYLOAD_BYTES", 1_048_576),
    mockSubtitleDelayMs: readInteger(env, "MOCK_SUBTITLE_DELAY_MS", 300),
    subtitleRevisionIntervalMs: readInteger(
      env,
      "SUBTITLE_REVISION_INTERVAL_MS",
      20_000
    ),
    devInviteCode: readString(env, "DEV_INVITE_CODE", "ALPHA-DEV-2026"),
    devInviteQuotaMinutes: readInteger(env, "DEV_INVITE_QUOTA_MINUTES", 180),
    databaseUrlConfigured: databaseUrl !== undefined,
    redisUrlConfigured: false,
    model: readModelConfig(env),
    objectStorage: readObjectStorageConfig(env)
  };

  if (databaseUrl !== undefined) {
    config.databaseUrl = databaseUrl;
  }

  return config;
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
    revisionModel: readAlibabaRevisionModel(
      env,
      "ALIBABA_REVISION_MODEL",
      "qwen-turbo"
    ),
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
    translateDrafts: readBoolean(env, "ALIBABA_TRANSLATE_DRAFTS", true),
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
      ),
      voice: readString(env, "LIVETRANSLATE_VOICE", "Tina"),
      outputSampleFormat: readInterpretationAudioSampleFormat(
        env,
        "LIVETRANSLATE_OUTPUT_SAMPLE_FORMAT",
        "pcm_s16le"
      ),
      outputSampleRate: readInteger(env, "LIVETRANSLATE_OUTPUT_SAMPLE_RATE", 24_000)
    }
  };
}

function readObjectStorageConfig(env: NodeJS.ProcessEnv): ObjectStorageConfig {
  const provider = readObjectStorageProvider(env, "OBJECT_STORAGE_PROVIDER", "disabled");
  const endpoint = readStorageEndpointConfig(env, provider);

  return {
    provider,
    bucket: readString(env, "OBJECT_STORAGE_BUCKET", "lingua-bridge-dev"),
    region: readString(env, "OBJECT_STORAGE_REGION", "us-east-1"),
    objectPrefix: normalizeObjectPrefix(
      readString(env, "OBJECT_STORAGE_PREFIX", "")
    ),
    minio: {
      endPoint: endpoint.endPoint,
      port: endpoint.port,
      useSSL: endpoint.useSSL,
      accessKey: readString(
        env,
        "OSS_ACCESS_KEY",
        readString(env, "MINIO_ACCESS_KEY", "admin")
      ),
      secretKey: readString(
        env,
        "OSS_SECRET_KEY",
        readString(env, "MINIO_SECRET_KEY", "password")
      )
    }
  };
}

function readStorageEndpointConfig(
  env: NodeJS.ProcessEnv,
  provider: ObjectStorageProvider
): {
  endPoint: string;
  port: number;
  useSSL: boolean;
} {
  const rawEndpoint = readString(
    env,
    "OSS_ENDPOINT",
    readString(env, "MINIO_ENDPOINT", "127.0.0.1:9000")
  );
  const parsed = parseStorageEndpoint(rawEndpoint);
  const useSSL = readBoolean(
    env,
    "OSS_USE_SSL",
    readBoolean(
      env,
      "MINIO_SECURE",
      readBoolean(env, "MINIO_USE_SSL", parsed.useSSL ?? provider === "oss")
    )
  );

  return {
    endPoint: parsed.endPoint,
    port: readInteger(
      env,
      "OSS_PORT",
      readInteger(env, "MINIO_PORT", parsed.port ?? (useSSL ? 443 : 9000))
    ),
    useSSL
  };
}

function parseStorageEndpoint(value: string): {
  endPoint: string;
  port?: number;
  useSSL?: boolean;
} {
  const trimmed = value.trim();
  const hasProtocol = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed);
  const withProtocol = hasProtocol ? trimmed : `http://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    const parsed: { endPoint: string; port?: number; useSSL?: boolean } = {
      endPoint: url.hostname
    };
    if (url.port.length > 0) {
      parsed.port = Number.parseInt(url.port, 10);
    }
    if (hasProtocol) {
      parsed.useSSL = url.protocol === "https:";
    }
    return parsed;
  } catch {
    return {
      endPoint: trimmed
    };
  }
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

function readAlibabaRevisionModel(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: AlibabaRevisionModel
): AlibabaRevisionModel {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  return raw === "qwen-plus" || raw === "qwen-turbo" ? raw : fallback;
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

function readInterpretationAudioSampleFormat(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: InterpretationAudioSampleFormat
): InterpretationAudioSampleFormat {
  const raw = env[key];
  if (!hasNonEmptyString(raw)) {
    return fallback;
  }

  return raw === "pcm_s16le" || raw === "pcm_s24le" ? raw : fallback;
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

  return raw === "minio" || raw === "oss" || raw === "disabled" ? raw : fallback;
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
