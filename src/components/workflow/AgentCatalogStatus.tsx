import { Button, Spinner } from "@tutti-os/ui-system";

export function AgentCatalogStatus(props: {
  loading: boolean;
  error?: string;
  warning?: string;
  onRetry: () => Promise<void>;
}) {
  if (!props.loading && !props.error && !props.warning) {
    return null;
  }

  if (!props.error && !props.warning) {
    return (
      <div className="agent-catalog-status" role="status" aria-live="polite">
        <Spinner size={14} />
        <span>Loading available agents...</span>
      </div>
    );
  }

  const isError = Boolean(props.error);
  const message = props.error ?? props.warning;

  return (
    <div
      className={`agent-catalog-status ${
        isError
          ? "agent-catalog-status-error"
          : "agent-catalog-status-warning"
      }`}
      role={isError ? "alert" : "status"}
      aria-live={isError ? undefined : "polite"}
    >
      <div className="agent-catalog-status-copy">
        <strong>{isError ? "Agents unavailable" : "Using cached agents"}</strong>
        <span>{message} You can retry without reloading the page.</span>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={props.loading}
        onClick={() => void props.onRetry()}
      >
        {props.loading ? <Spinner size={14} /> : null}
        {props.loading ? "Retrying..." : "Retry"}
      </Button>
    </div>
  );
}
