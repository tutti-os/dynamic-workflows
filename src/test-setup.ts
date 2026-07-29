// Global vitest setup. Runtime-owned Script and Effect retries use a production
// backoff before another durable Attempt. That wall-clock wait would both slow
// the suite and risk flakiness, so tests use a tiny process-wide base backoff.
if (!process.env.WORKFLOW_TRANSIENT_RETRY_BACKOFF_MS) {
  process.env.WORKFLOW_TRANSIENT_RETRY_BACKOFF_MS = "5";
}
