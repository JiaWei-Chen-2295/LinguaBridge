import type { TermEntry } from "@lingua-bridge/protocol";

export interface TermMatch {
  entry: TermEntry;
  matchedText: string;
  replacement: string;
}

export const BUILT_IN_TERM_ENTRIES: TermEntry[] = [
  keepSourceTerm("builtin_kubernetes", "Kubernetes"),
  keepSourceTerm("builtin_sidecar_proxy", "sidecar proxy", ["side car proxy"]),
  keepSourceTerm("builtin_realtime_gateway", "Realtime Gateway", ["gateway"]),
  keepSourceTerm("builtin_api", "API"),
  keepSourceTerm("builtin_react", "React"),
  keepSourceTerm("builtin_typescript", "TypeScript"),
  keepSourceTerm("builtin_rust", "Rust"),
  keepSourceTerm("builtin_websocket", "WebSocket", ["web socket"]),
  keepSourceTerm("builtin_postgresql", "PostgreSQL", ["Postgres"]),
  keepSourceTerm("builtin_redis", "Redis"),
  keepSourceTerm("builtin_docker", "Docker"),
  keepSourceTerm("builtin_tauri", "Tauri"),
  keepSourceTerm("builtin_qwen", "Qwen"),
  keepSourceTerm("builtin_qwen_mt", "Qwen-MT", ["Qwen MT"]),
  keepSourceTerm("builtin_transcript", "transcript")
];

export function mergeTermEntries(userEntries: TermEntry[]): TermEntry[] {
  const entriesBySource = new Map<string, TermEntry>();
  for (const entry of [...BUILT_IN_TERM_ENTRIES, ...userEntries]) {
    entriesBySource.set(normalizeTermKey(entry.source), cloneTermEntry(entry));
  }

  return Array.from(entriesBySource.values());
}

export function findTermMatches(
  sourceText: string,
  entries: TermEntry[]
): TermMatch[] {
  const matches: TermMatch[] = [];
  for (const entry of entries) {
    const matchedText = findMatchedVariant(sourceText, entry);
    if (matchedText === undefined) {
      continue;
    }

    const replacement =
      entry.mode === "fixed_translation" ? entry.target ?? entry.source : entry.source;
    matches.push({
      entry,
      matchedText,
      replacement
    });
  }

  return matches;
}

export function termNames(matches: TermMatch[]): string[] {
  return Array.from(new Set(matches.map((match) => match.entry.source)));
}

export function applyTermPolicy(
  sourceText: string,
  targetText: string,
  entries: TermEntry[]
): { targetText: string; termsHit: string[] } {
  const matches = findTermMatches(sourceText, entries);
  let constrainedTarget = targetText.trim();

  for (const match of matches) {
    if (match.entry.mode === "keep_source") {
      constrainedTarget = ensureRequiredTerm(
        constrainedTarget,
        match.entry.source,
        termVariants(match.entry)
      );
      continue;
    }

    if (match.entry.target !== undefined) {
      constrainedTarget = ensureRequiredTerm(constrainedTarget, match.entry.target, [
        match.entry.target
      ]);
    }
  }

  return {
    targetText: constrainedTarget,
    termsHit: termNames(matches)
  };
}

export function buildTermPrompt(matches: TermMatch[]): string {
  if (matches.length === 0) {
    return "No glossary hits.";
  }

  return matches
    .map((match) => {
      if (match.entry.mode === "keep_source") {
        return `- Keep "${match.entry.source}" in English.`;
      }

      return `- Translate "${match.entry.source}" as "${match.entry.target ?? match.entry.source}".`;
    })
    .join("\n");
}

function keepSourceTerm(
  id: string,
  source: string,
  aliases: string[] = []
): TermEntry {
  return {
    id,
    source,
    mode: "keep_source",
    aliases
  };
}

function cloneTermEntry(entry: TermEntry): TermEntry {
  const cloned: TermEntry = {
    id: entry.id,
    source: entry.source,
    mode: entry.mode,
    aliases: [...entry.aliases]
  };
  if (entry.userId !== undefined) {
    cloned.userId = entry.userId;
  }
  if (entry.target !== undefined) {
    cloned.target = entry.target;
  }
  return cloned;
}

function findMatchedVariant(
  sourceText: string,
  entry: TermEntry
): string | undefined {
  const lowerSource = sourceText.toLowerCase();
  return termVariants(entry).find((variant) =>
    lowerSource.includes(variant.toLowerCase())
  );
}

function termVariants(entry: TermEntry): string[] {
  return Array.from(new Set([entry.source, ...entry.aliases].filter(isNonEmpty)));
}

function ensureRequiredTerm(
  targetText: string,
  requiredTerm: string,
  acceptableTerms: string[]
): string {
  const lowerTarget = targetText.toLowerCase();
  if (
    acceptableTerms.some((term) => lowerTarget.includes(term.toLowerCase())) ||
    lowerTarget.includes(requiredTerm.toLowerCase())
  ) {
    return targetText;
  }

  return `${targetText} (${requiredTerm})`;
}

function normalizeTermKey(value: string): string {
  return value.trim().toLowerCase();
}

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}
