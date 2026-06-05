import { randomUUID } from "node:crypto";

export function createId(prefix: string): string {
  const compactUuid = randomUUID().replaceAll("-", "");
  return `${prefix}_${compactUuid.slice(0, 20)}`;
}
