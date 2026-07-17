/**
 * Shared realistic mock for the `@/lib/agents/runtime` boundary used by the
 * behavioral executor tests. Behavioral tests mock `runAgent` so the REAL
 * executor/run-jobs machinery runs end to end while the agent process is faked.
 *
 * Historically each test file copy-pasted its own `runAgent` mock at varying
 * fidelity. Most never emitted a `session_ref`, so `nodeSessions` stayed empty
 * in tests and the crash-recovery "attach to old session" path had ZERO
 * coverage — production could attach a downstream node to a stale session while
 * tests stayed green (fixed in commit 4db35ee). This helper centralizes a mock
 * that mirrors the real adapter's event stream:
 *
 *   session_ref  ->  text_delta(s)  ->  done(completed)
 *
 * honoring `input.attachSessionId ?? input.resumeSessionId ?? sessionId ??
 * fresh-id` for the session ref (attach/resume semantics), and supporting
 * scripted failures (error event, done failed, done canceled) plus signal-aware
 * cancellation, all through the reply callback.
 *
 * This module is imported ONLY by *.test.ts files, so it never ships into a
 * production bundle.
 */
import type {
  AgentRunInput,
  AgentRuntimeEvent,
  AgentSessionStatus,
} from "@/lib/agents/types";

export type MockAgentReply = {
  /** Streamed assistant text, emitted as a single `text_delta`. */
  text?: string;
  /** Multiple `text_delta` chunks. Overrides `text` when provided. */
  textDeltas?: string[];
  /**
   * Base agent session id used when the run is neither attaching nor resuming.
   * `input.attachSessionId` / `input.resumeSessionId` always take precedence,
   * mirroring the real adapter's attach/resume semantics.
   */
  sessionId?: string;
  /**
   * Legacy scripted failure: emit an `error` event and stop with no terminal
   * `done`, exactly like the per-file helpers this replaces. Combine with
   * `done` to also emit a terminal event after the error.
   */
  fail?: boolean;
  /** Explicit `error` event shape. Defaults its message from `text`. */
  error?: { code?: string; message?: string; retryable?: boolean };
  /**
   * Terminal `done` status. Defaults to "completed". Use "failed" / "canceled"
   * to exercise the executor's done-failed / done-canceled handling.
   */
  done?: "completed" | "failed" | "canceled";
};

export type MockAgentRuntimeOptions = {
  /**
   * When to emit the `session_ref` event.
   * - "always" (default): every run emits one, honoring attach/resume/sessionId
   *   or a fresh id. Mirrors the real adapter and map-retry.test.ts, and is what
   *   populates `nodeSessions` so the stale-attach regression stays covered.
   * - "when-provided": only when the reply returns a `sessionId`. Preserves
   *   sessionless-agent semantics for tests that assert on promptMode.
   * - "never": never emit a `session_ref`.
   */
  sessionRef?: "always" | "when-provided" | "never";
  /** Prefix for generated fresh session ids (default "mock-session"). */
  sessionIdPrefix?: string;
};

/** Structural view of the `vi.fn()` the test file owns and hoists. */
type RunAgentMock = {
  mockImplementation: (
    implementation: (
      input: AgentRunInput,
    ) => AsyncGenerator<AgentRuntimeEvent>,
  ) => unknown;
};

/**
 * Install a realistic `runAgent` implementation onto the provided hoisted mock
 * and return the captured input array (for prompt/session assertions). The
 * `vi.hoisted` mock and `vi.mock("@/lib/agents/runtime", ...)` declaration must
 * stay in the test file so Vitest can hoist them.
 */
export function installMockAgentRuntime(
  mock: RunAgentMock,
  reply: (input: AgentRunInput) => MockAgentReply,
  options: MockAgentRuntimeOptions = {},
): AgentRunInput[] {
  const calls: AgentRunInput[] = [];
  const policy = options.sessionRef ?? "always";
  const prefix = options.sessionIdPrefix ?? "mock-session";
  let sessionCounter = 0;

  mock.mockImplementation(async function* (
    input: AgentRunInput,
  ): AsyncGenerator<AgentRuntimeEvent> {
    calls.push(input);

    // Mirror the real/mock adapter: a run whose signal is already aborted
    // terminates as canceled without doing any work.
    if (input.signal?.aborted) {
      yield { type: "done", status: "canceled", reason: "cancelled" };
      return;
    }

    const result = reply(input);

    const shouldEmitSession =
      policy === "always" ||
      (policy === "when-provided" && result.sessionId != null);
    if (shouldEmitSession) {
      sessionCounter += 1;
      const agentSessionId =
        input.attachSessionId ??
        input.resumeSessionId ??
        result.sessionId ??
        `${prefix}-${sessionCounter}`;
      const status: AgentSessionStatus = "running";
      yield {
        type: "session_ref",
        session: {
          agentSessionId,
          agent: input.agent,
          status,
        },
      };
    }

    // Scripted error event (legacy `fail` and/or an explicit `error` shape).
    if (result.fail || result.error) {
      yield {
        type: "error",
        code: result.error?.code ?? "mock_error",
        message:
          result.error?.message ?? result.text ?? "Mock agent run failed.",
        ...(result.error?.retryable != null
          ? { retryable: result.error.retryable }
          : {}),
      };
      // The legacy `fail` shape stops here with no terminal `done`, matching the
      // per-file helpers it replaces. An explicit `done` still terminates below.
      if (result.fail && result.done == null) {
        return;
      }
    }

    if (result.done === "canceled") {
      yield { type: "done", status: "canceled", reason: "cancelled" };
      return;
    }

    const deltas =
      result.textDeltas ?? (result.text != null ? [result.text] : []);
    for (const delta of deltas) {
      yield { type: "text_delta", text: delta };
    }

    if (result.done === "failed") {
      yield { type: "done", status: "failed", reason: "error" };
      return;
    }

    yield { type: "done", status: "completed", reason: "completed" };
  });

  return calls;
}
