import clsx from "clsx";
import { Badge, WarningLinedIcon } from "@tutti-os/ui-system";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";
import { formatWorkflowDiagnosticLocation } from "@/lib/workflow/validation";

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
          <span>
            {props.message}
            {primaryDiagnostic?.hint ? (
              <small>{primaryDiagnostic.hint}</small>
            ) : null}
          </span>
          {primaryDiagnostic ? (
            <Badge variant="default">{primaryDiagnostic.severity}</Badge>
          ) : null}
          {primaryDiagnostic ? (
            <DiagnosticLocationBadge diagnostic={primaryDiagnostic} />
          ) : null}
        </div>
      ) : null}
      {visibleDiagnostics.map((diagnostic, index) => (
        <div
          className={clsx("diagnostic", diagnostic.severity)}
          key={`${diagnostic.message}-${index}`}
        >
          <WarningLinedIcon size={14} />
          <span>
            {diagnostic.message}
            {diagnostic.hint ? <small>{diagnostic.hint}</small> : null}
          </span>
          <Badge variant="default">{diagnostic.severity}</Badge>
          <DiagnosticLocationBadge diagnostic={diagnostic} />
        </div>
      ))}
    </div>
  );
}

function DiagnosticLocationBadge(props: { diagnostic: WorkflowDiagnostic }) {
  const location = formatWorkflowDiagnosticLocation(props.diagnostic);
  if (!location) {
    return null;
  }
  return <Badge variant="muted">{location}</Badge>;
}
