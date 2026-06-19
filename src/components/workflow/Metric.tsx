import { StatusDot } from "@tutti-os/ui-system";

type MetricProps = {
  label: string;
  value: number;
  tone?: "blue" | "green" | "red" | "neutral";
};

export function Metric(props: MetricProps) {
  return (
    <div className="metric">
      <div>
        <strong>{props.value}</strong>
        <span>{props.label}</span>
      </div>
      <StatusDot tone={props.tone ?? "neutral"} />
    </div>
  );
}
