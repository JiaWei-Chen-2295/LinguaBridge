import type { ReactElement } from "react";

interface StatusPillProps {
  label: string;
  tone: "idle" | "active" | "warning" | "error";
}

export function StatusPill({ label, tone }: StatusPillProps): ReactElement {
  return <span className={`status-pill status-pill--${tone}`}>{label}</span>;
}
