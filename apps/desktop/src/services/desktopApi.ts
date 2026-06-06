import type { TermEntry } from "@lingua-bridge/protocol";

const DEFAULT_GATEWAY_HTTP_URL = "http://127.0.0.1:4318";

export interface DesktopUsageSummary {
  userId: string;
  quotaMinutes: number;
  usedRealtimeMs: number;
  usedAsrMs: number;
  storageBytes: number;
  mtInputTokens: number;
  mtOutputTokens: number;
  revisionTokens: number;
  interpretationAudioMs: number;
  interruptions: number;
  remainingMinutes: number;
}

export interface DesktopSessionSummary {
  id: string;
  userId: string;
  sourceLang: string;
  targetLang: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationMs: number;
  deviceLabel?: string;
  segmentCount: number;
  storageBytes: number;
}

export type DesktopTermEntry = TermEntry;

export type DesktopDataIdentity =
  | string
  | {
      userId?: string;
      inviteCode?: string;
    };

export interface DesktopApiOptions {
  env?: GatewayEnv;
  fetcher?: typeof fetch;
}

type GatewayEnv = Partial<Record<"VITE_GATEWAY_HTTP_URL" | "VITE_GATEWAY_WS_URL", string>>;

export function getGatewayHttpBaseUrl(env: GatewayEnv = readImportMetaEnv()): string {
  const explicitHttpUrl = env.VITE_GATEWAY_HTTP_URL?.trim();
  if (explicitHttpUrl) {
    return trimTrailingSlash(explicitHttpUrl);
  }

  const websocketUrl = env.VITE_GATEWAY_WS_URL?.trim();
  if (websocketUrl) {
    try {
      const url = new URL(websocketUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = "";
      url.search = "";
      url.hash = "";
      return trimTrailingSlash(url.toString());
    } catch {
      return DEFAULT_GATEWAY_HTTP_URL;
    }
  }

  return DEFAULT_GATEWAY_HTTP_URL;
}

export async function loadDesktopUsage(
  identity: DesktopDataIdentity,
  options: DesktopApiOptions = {}
): Promise<DesktopUsageSummary> {
  const resolvedIdentity = normalizeIdentity(identity);
  if ("userId" in resolvedIdentity) {
    return fetchJson<DesktopUsageSummary>(
      `${getGatewayHttpBaseUrl(options.env)}/usage/${encodeURIComponent(resolvedIdentity.userId)}`,
      options.fetcher
    );
  }

  return fetchJson<DesktopUsageSummary>(
    `${getGatewayHttpBaseUrl(options.env)}/usage?inviteCode=${encodeURIComponent(resolvedIdentity.inviteCode)}`,
    options.fetcher
  );
}

export async function loadDesktopHistory(
  identity: DesktopDataIdentity,
  options: DesktopApiOptions = {}
): Promise<DesktopSessionSummary[]> {
  const url = new URL(`${getGatewayHttpBaseUrl(options.env)}/sessions`);
  applyIdentityQuery(url, normalizeIdentity(identity));
  return fetchJson<DesktopSessionSummary[]>(url.toString(), options.fetcher);
}

export async function loadDesktopGlossary(
  identity?: DesktopDataIdentity,
  options: DesktopApiOptions = {}
): Promise<DesktopTermEntry[]> {
  const url = new URL(`${getGatewayHttpBaseUrl(options.env)}/terms`);
  if (identity !== undefined) {
    applyIdentityQuery(url, normalizeIdentity(identity));
  }
  return fetchJson<DesktopTermEntry[]>(url.toString(), options.fetcher);
}

async function fetchJson<T>(url: string, fetcher: typeof fetch = fetch): Promise<T> {
  const response = await fetcher(url);
  if (!response.ok) {
    throw new Error(`Gateway request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}

function readImportMetaEnv(): GatewayEnv {
  return ((import.meta as ImportMeta & { env?: GatewayEnv }).env ?? {});
}

function normalizeIdentity(identity: DesktopDataIdentity): { userId: string } | { inviteCode: string } {
  if (typeof identity === "string") {
    return { userId: identity };
  }

  const userId = identity.userId?.trim();
  if (userId !== undefined && userId.length > 0) {
    return { userId };
  }

  const inviteCode = identity.inviteCode?.trim();
  if (inviteCode !== undefined && inviteCode.length > 0) {
    return { inviteCode };
  }

  throw new Error("Gateway data identity requires a userId or inviteCode.");
}

function applyIdentityQuery(
  url: URL,
  identity: { userId: string } | { inviteCode: string }
): void {
  if ("userId" in identity) {
    url.searchParams.set("userId", identity.userId);
    return;
  }

  url.searchParams.set("inviteCode", identity.inviteCode);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
