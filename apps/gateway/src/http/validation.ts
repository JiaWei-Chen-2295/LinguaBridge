export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function optionalString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function requiredString(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  return optionalString(record, key);
}

export function optionalNumber(
  record: Record<string, unknown>,
  key: string
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalBoolean(
  record: Record<string, unknown>,
  key: string
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}
