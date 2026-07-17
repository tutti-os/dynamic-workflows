// Global vitest setup. The executor's transient-failure continuation waits a
// backoff (default ~10s in production) before its single in-session retry. In
// tests that wall-clock wait would both slow the suite and risk flakiness, so we
// default it to a tiny value process-wide. Individual tests still override via
// WorkflowRunRequest.transientRetryBackoffMs when they need an exact value.
if (!process.env.WORKFLOW_TRANSIENT_RETRY_BACKOFF_MS) {
  process.env.WORKFLOW_TRANSIENT_RETRY_BACKOFF_MS = "5";
}
