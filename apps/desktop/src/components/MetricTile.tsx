import type { ReactElement } from "react";

interface MetricTileProps {
  label: string;
  value: string;
  detail: string;
}

export function MetricTile({ label, value, detail }: MetricTileProps): ReactElement {
  return (
    <section className="metric-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </section>
  );
}
