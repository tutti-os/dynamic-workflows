import clsx from "clsx";
import { Badge, WarningLinedIcon } from "@tutti-os/ui-system";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";

export function DiagnosticsPanel(props: {
  title?: string;
  message?: string;
  diagnostics?: WorkflowDiagnostic[];
}) {
  const diagnostics = props.diagnostics ?? [];
  const primaryDiagnostic = props.message
    ? diagnostics.find((diagnostic) => diagnostic.message === props.message)
    : undefined;
  const visibleDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.message !== props.message,
  );

  if (!props.message && visibleDiagnostics.length === 0) {
    return null;
  }

  return (
    <div className="diagnostics" role="alert">
      {props.title ? (
        <strong className="diagnostics-title">{props.title}</strong>
      ) : null}
      {props.message ? (
        <div className="diagnostic error">
          <WarningLinedIcon size={14} />
          <span>{props.message}</span>
          {primaryDiagnostic ? (
            <Badge variant="default">{primaryDiagnostic.severity}</Badge>
          ) : null}
          {primaryDiagnostic?.range ? (
            <Badge variant="muted">
              {primaryDiagnostic.range.start}-{primaryDiagnostic.range.end}
            </Badge>
          ) : null}
        </div>
      ) : null}
      {visibleDiagnostics.map((diagnostic, index) => (
        <div
          className={clsx("diagnostic", diagnostic.severity)}
          key={`${diagnostic.message}-${index}`}
        >
          <WarningLinedIcon size={14} />
          <span>{diagnostic.message}</span>
          <Badge variant="default">{diagnostic.severity}</Badge>
          {diagnostic.range ? (
            <Badge variant="muted">
              {diagnostic.range.start}-{diagnostic.range.end}
            </Badge>
          ) : null}
        </div>
      ))}
    </div>
  );
}
