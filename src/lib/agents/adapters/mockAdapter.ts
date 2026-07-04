import type {
  AgentRunInput,
  AgentRuntimeAdapter,
  AgentRuntimeEvent,
  AgentTargetOption,
} from "../types";

export const MOCK_AGENT_TARGET_ID = "mock";

export function createMockAgentAdapter(): AgentRuntimeAdapter {
  return {
    id: "mock",
    label: "Mock agent adapter",
    async listTargets(): Promise<AgentTargetOption[]> {
      return [
        {
          id: MOCK_AGENT_TARGET_ID,
          name: "Mock local agent",
          provider: "mock",
          supported: true,
          models: ["mock"],
        },
      ];
    },
    run(input) {
      return runMockAgent(input);
    },
  };
}

async function* runMockAgent(
  input: AgentRunInput,
): AsyncGenerator<AgentRuntimeEvent> {
  if (input.signal?.aborted) {
    yield {
      type: "done",
      status: "canceled",
      reason: "cancelled",
    };
    return;
  }

  yield {
    type: "status",
    status: "running",
    message: "Mock local agent is processing the prompt.",
  };
  await delay(250, input.signal);
  if (input.signal?.aborted) {
    yield {
      type: "done",
      status: "canceled",
      reason: "cancelled",
    };
    return;
  }
  yield {
    type: "text_delta",
    text: `Mock result for prompt:\n\n${input.prompt.slice(0, 900)}`,
  };
  await delay(150, input.signal);
  if (input.signal?.aborted) {
    yield {
      type: "done",
      status: "canceled",
      reason: "cancelled",
    };
    return;
  }
  yield {
    type: "done",
    status: "completed",
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    let timeout: ReturnType<typeof setTimeout>;
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
