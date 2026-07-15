import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunInput, AgentRuntimeEvent } from "@/lib/agents/types";
import type {
  WorkflowHumanTask,
  WorkflowHumanTaskRequest,
  WorkflowLoopRecoveryState,
} from "./types";

const runAgentMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/agents/runtime", () => ({
  runAgent: runAgentMock,
}));

import { runWorkflow } from "./executor";

function humanTask(
  request: WorkflowHumanTaskRequest,
  status: WorkflowHumanTask["status"],
  response?: WorkflowHumanTask["response"],
): WorkflowHumanTask {
  return {
    id: request.executionKey,
    runId: request.runId,
    nodeId: request.nodeId,
    ...(request.parentNodeId ? { parentNodeId: request.parentNodeId } : {}),
    ...(request.iteration !== undefined ? { iteration: request.iteration } : {}),
    executionKey: request.executionKey,
    status,
    spec: request.spec,
    ...(response ? { response } : {}),
    revision: status === "pending" ? 1 : 2,
    createdAt: new Date(0).toISOString(),
  };
}

describe("runWorkflow", () => {
  beforeEach(() => {
    runAgentMock.mockReset();
  });

  it("waits for a top-level human task and resumes with structured output", async () => {
    const requests: WorkflowHumanTaskRequest[] = [];
    const pendingEvents = [];
    const script = `
const decision = await human({
  id: "decision",
  description: "Choose the next step",
  context: [{ label: "Draft", value: "hello", display: "text" }],
  actions: [
    { id: "pass", label: "Pass", intent: "primary" },
    { id: "revise", label: "Revise", fields: [{ id: "comment", type: "textarea", label: "Comment", required: true }] },
  ],
})
const next = await agent({ id: "next", prompt: "action={{decision.action}} comment={{decision.values.comment}}" })
`;

    for await (const event of runWorkflow({
      script,
      cwd: process.cwd(),
      onHumanTask: (request) => {
        requests.push(request);
        return humanTask(request, "pending");
      },
    })) {
      pendingEvents.push(event);
    }

    expect(requests).toHaveLength(1);
    expect(pendingEvents.at(-1)).toEqual(expect.objectContaining({
      type: "run_waiting",
      pendingTaskIds: [requests[0].executionKey],
    }));
    expect(runAgentMock).not.toHaveBeenCalled();

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      yield { type: "text_delta", text: input.prompt };
      yield { type: "done", status: "completed", reason: "completed" };
    });
    const resumedEvents = [];
    for await (const event of runWorkflow({
      script,
      cwd: process.cwd(),
      onHumanTask: (request) => humanTask(request, "resolved", {
        action: "revise",
        values: { comment: "fix it" },
      }),
    })) {
      resumedEvents.push(event);
    }
    expect(runAgentMock.mock.calls[0][0].prompt).toBe(
      "action=revise comment=fix it",
    );
    expect(resumedEvents.at(-1)).toEqual(expect.objectContaining({
      type: "run_completed",
      status: "completed",
    }));
  });

  it("allows multiple independent human tasks to wait in one run", async () => {
    const events = [];
    for await (const event of runWorkflow({
      script: `
const first = await human({ id: "first", actions: [{ id: "submit", label: "Submit" }] })
const second = await human({ id: "second", actions: [{ id: "submit", label: "Submit" }] })
`,
      cwd: process.cwd(),
      onHumanTask: (request) => humanTask(request, "pending"),
    })) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "human_task_requested")).toHaveLength(2);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: "run_waiting",
      pendingTaskIds: expect.arrayContaining(["human:first", "human:second"]),
    }));
  });

  it("resumes a loop human task without rerunning checkpointed steps", async () => {
    let checkpoint: WorkflowLoopRecoveryState | undefined;
    const responses = new Map<string, { action: string; values: Record<string, string> }>();
    const prompts: string[] = [];
    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      prompts.push(input.prompt);
      yield { type: "text_delta", text: `draft ${prompts.length}` };
      yield { type: "done", status: "completed", reason: "completed" };
    });
    const script = `
const delivery = await loop({
  id: "delivery",
  maxIterations: 3,
  steps: [
    agent({ id: "draft", prompt: "iteration={{iteration}} feedback={{review.values.comment}}" }),
    human({ id: "review", actions: [
      { id: "pass", label: "Pass" },
      { id: "revise", label: "Revise", fields: [{ id: "comment", type: "textarea", label: "Comment", required: true }] },
    ] }),
  ],
  until: { source: "review.action", equals: "pass" },
})
`;
    const execute = async () => {
      const events = [];
      for await (const event of runWorkflow({
        script,
        cwd: process.cwd(),
        recovery: checkpoint ? { loopStates: { delivery: checkpoint } } : undefined,
        onCheckpoint: (saved) => {
          checkpoint = saved.state;
        },
        onHumanTask: (request) => {
          const response = responses.get(request.executionKey);
          return humanTask(
            request,
            response ? "resolved" : "pending",
            response,
          );
        },
      })) {
        events.push(event);
      }
      return events;
    };

    await execute();
    expect(prompts).toEqual(["iteration=1 feedback="]);
    responses.set("loop:delivery:1:human:review", {
      action: "revise",
      values: { comment: "fix it" },
    });
    await execute();
    expect(prompts).toEqual([
      "iteration=1 feedback=",
      "iteration=2 feedback=fix it",
    ]);
    responses.set("loop:delivery:2:human:review", {
      action: "pass",
      values: {},
    });
    const completed = await execute();
    expect(prompts).toHaveLength(2);
    expect(completed.at(-1)).toEqual(expect.objectContaining({
      type: "run_completed",
      status: "completed",
    }));
  });

  it("normalizes schema defaults for direct workflow execution", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield {
        type: "text_delta",
        text: input.prompt,
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    for await (const _event of runWorkflow({
      script: `
export const inputs = {
  maxRounds: { type: "number", default: 3 },
  dryRun: { type: "boolean", default: false },
}

const first = await agent({ id: "first", label: "Run rounds", prompt: "rounds={{maxRounds}} dryRun={{dryRun}}" })
`,
      agent: "local:codex",
      cwd: process.cwd(),
    })) {
      // drain
    }

    expect(calls[0].prompt).toBe("rounds=3 dryRun=false");
    expect(calls[0].title).toBe("Run rounds");
  });

  it("serializes nodes that share an agent session and resumes the session", async () => {
    const calls: AgentRunInput[] = [];
    let activeRuns = 0;
    let maxActiveRuns = 0;

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      yield {
        type: "session_ref",
        session: {
          agentSessionId: input.resumeSessionId ?? "session-1",
          agent: input.agent,
          model: input.model,
          status: "running",
        },
      };
      await delay(5);
      yield {
        type: "text_delta",
        text: `${input.prompt} done`,
      };
      activeRuns -= 1;
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const first = await agent({ id: "first", session: { mode: "inherit", key: "writer" }, prompt: "one" })
const second = await agent({ id: "second", session: { mode: "inherit", key: "writer" }, prompt: "two" })
`,
      agent: "local:codex",
      model: "gpt-5",
      cwd: process.cwd(),
    })) {
      events.push(event);
    }

    expect(maxActiveRuns).toBe(1);
    expect(calls.map((call) => call.prompt)).toEqual(["one", "two"]);
    expect(calls[0].resumeSessionId).toBeUndefined();
    expect(calls[1].resumeSessionId).toBe("session-1");
    expect(readStatusMessages(events)).toEqual([
      'Workflow session "writer" is starting a new agent session.',
      'Workflow session "writer" captured agent session session-1.',
      'Workflow session "writer" is reusing agent session session-1.',
    ]);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "completed",
        outputs: {
          first: "one done",
          second: "two done",
        },
      }),
    );
  });

  it("runs agent nodes from their configured cwd", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield {
        type: "text_delta",
        text: "done",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    for await (const _event of runWorkflow({
      script: `
const first = await agent({ id: "first", cwd: "lib", prompt: "one" })
const second = await agent({ id: "second", inputs: { first }, prompt: "two {{first}}" })
`,
      agent: "local:codex",
      cwd: "src",
    })) {
      // drain
    }

    expect(calls.map((call) => call.cwd)).toEqual([
      path.join(process.cwd(), "src", "lib"),
      path.join(process.cwd(), "src"),
    ]);
  });

  it("resumes from recovered outputs and attaches running node sessions", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield {
        type: "session_ref",
        session: {
          agentSessionId: input.attachSessionId ?? "session-2",
          agent: input.agent,
          model: input.model,
          status: "running",
        },
      };
      yield {
        type: "text_delta",
        text: "second done",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const first = await agent({ id: "first", session: { mode: "inherit", key: "writer" }, prompt: "one" })
const second = await agent({ id: "second", inputs: { first }, session: { mode: "inherit", key: "writer" }, prompt: "two {{first}}" })
`,
      agent: "local:codex",
      model: "gpt-5",
      cwd: process.cwd(),
      recovery: {
        outputs: {
          first: "first done",
        },
        completedNodeIds: ["first"],
        sessionIdsByKey: {
          writer: "session-1",
        },
        sessionCwdsByKey: {
          writer: process.cwd(),
        },
        attachSessionIdsByNodeId: {
          second: "session-2",
        },
      },
    })) {
      events.push(event);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.objectContaining({
        prompt: "two first done",
        resumeSessionId: "session-1",
        attachSessionId: "session-2",
      }),
    );
    expect(readStatusMessages(events)).toEqual(
      expect.arrayContaining([
        'Workflow session "writer" is attaching to agent session session-2.',
      ]),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "completed",
        outputs: {
          first: "first done",
          second: "second done",
        },
      }),
    );
  });

  it("renders the effective agent cwd into workflow cwd template refs", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield {
        type: "text_delta",
        text: "done",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    for await (const _event of runWorkflow({
      script: `
export const meta = { name: "cwd", description: "cwd", requiresCwd: true }
const first = await agent({ id: "first", cwd: "lib", prompt: "cwd {{workflow.cwd}}" })
`,
      agent: "local:codex",
      cwd: "src",
    })) {
      // drain
    }

    expect(calls[0]?.prompt).toBe(
      `cwd ${path.join(process.cwd(), "src", "lib")}`,
    );
  });

  it("fails required cwd workflows before running agents", async () => {
    await expect(async () => {
      for await (const _event of runWorkflow({
        script: `
export const meta = { name: "cwd", description: "cwd", requiresCwd: true }
const first = await agent({ id: "first", prompt: "one" })
`,
        agent: "local:codex",
      })) {
        // drain
      }
    }).rejects.toThrow("Workflow cwd is required.");

    expect(runAgentMock).not.toHaveBeenCalled();
  });

  it("lets loop step cwd override loop and run cwd", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield {
        type: "text_delta",
        text: input.prompt.startsWith("review") ? "PASS: ok" : "work",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    for await (const _event of runWorkflow({
      script: `
const delivery = await loop({
  id: "delivery",
  cwd: "src",
  maxIterations: 1,
  steps: [
    agent({ id: "rd", cwd: "lib", prompt: "work" }),
    agent({ id: "review", prompt: "review {{rd}}" }),
  ],
  until: { source: "review", finalStatus: "PASS: ok" },
})
`,
      agent: "local:codex",
      cwd: process.cwd(),
    })) {
      // drain
    }

    expect(calls.map((call) => call.cwd)).toEqual([
      path.join(process.cwd(), "src", "lib"),
      path.join(process.cwd(), "src"),
    ]);
  });

  it("lets loop steps override loop and run agent settings", async () => {
    const calls: AgentRunInput[] = [];
    const nodeStarts: Array<{
      nodeId: string;
      agent: string;
      model?: string;
    }> = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield {
        type: "text_delta",
        text: input.prompt.startsWith("review") ? "PASS: ok" : "work",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    for await (const event of runWorkflow({
      script: `
const delivery = await loop({
  id: "delivery",
  agent: "local:claude-code",
  model: "claude-sonnet-4",
  maxIterations: 1,
  steps: [
    agent({ id: "rd", label: "Implement", agent: "local:codex", model: "gpt-5.1", prompt: "work" }),
    agent({ id: "review", label: "Review", prompt: "review {{rd}}" }),
  ],
  until: { source: "review", finalStatus: "PASS: ok" },
})
`,
      agent: "mock",
      model: "mock",
      cwd: process.cwd(),
    })) {
      if (event.type === "node_started") {
        nodeStarts.push({
          nodeId: event.nodeId,
          agent: event.agent,
          model: event.model,
        });
      }
    }

    expect(nodeStarts).toContainEqual({
      nodeId: "delivery",
      agent: "local:claude-code",
      model: "claude-sonnet-4",
    });
    expect(calls.map((call) => [call.agent, call.model])).toEqual([
      ["local:codex", "gpt-5.1"],
      ["local:claude-code", "claude-sonnet-4"],
    ]);
    expect(calls.map((call) => call.title)).toEqual(["Implement", "Review"]);
  });

  it("resolves agent and model templates from workflow inputs with defaults", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield {
        type: "text_delta",
        text: input.prompt.startsWith("review") ? "PASS: ok" : "work",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    for await (const _event of runWorkflow({
      script: `
export const inputs = {
  first_agent: { type: "string", default: "local:codex" },
  first_model: { type: "string", default: "gpt-5" },
  loop_agent: { type: "string", default: "local:claude-code" },
  loop_model: { type: "string", default: "claude-sonnet-4" },
  coder_agent: { type: "string", required: true },
  coder_model: { type: "string", default: "gpt-5.1" },
  reviewer_model: { type: "string", required: true },
}

const first = await agent({
  id: "first",
  agent: "{{first_agent:local:codex}}",
  model: "{{first_model:gpt-5}}",
  prompt: "first",
})

const delivery = await loop({
  id: "delivery",
  inputs: { first },
  agent: "{{loop_agent:local:claude-code}}",
  model: "{{loop_model:claude-sonnet-4}}",
  maxIterations: 1,
  steps: [
    agent({
      id: "coder",
      agent: "{{coder_agent}}",
      model: "{{coder_model:gpt-5.1}}",
      prompt: "code {{first}}",
    }),
    agent({
      id: "reviewer",
      model: "{{reviewer_model}}",
      prompt: "review {{coder}}",
    }),
  ],
  until: { source: "reviewer", finalStatus: "PASS: ok" },
})
`,
      agent: "mock",
      model: "mock",
      cwd: process.cwd(),
      inputs: {
        first_model: "gpt-5.5",
        coder_agent: "local:codex",
        reviewer_model: "gpt-5-mini",
      },
    })) {
      // drain
    }

    expect(calls.map((call) => [call.agent, call.model])).toEqual([
      ["local:codex", "gpt-5.5"],
      ["local:codex", "gpt-5.1"],
      ["local:claude-code", "gpt-5-mini"],
    ]);
  });

  it("resumes a loop from a persisted step checkpoint", async () => {
    const calls: AgentRunInput[] = [];
    const checkpoints: unknown[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield {
        type: "text_delta",
        text: "PASS: accepted",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const delivery = await loop({
  id: "delivery",
  maxIterations: 2,
  steps: [
    agent({ id: "draft", prompt: "draft {{iteration}}" }),
    agent({ id: "review", prompt: "review {{draft}}" }),
  ],
  until: { source: "review", finalStatus: "PASS: accepted" },
})
`,
      agent: "mock",
      cwd: process.cwd(),
      recovery: {
        loopStates: {
          delivery: {
            nextIteration: 1,
            currentIteration: 1,
            currentStepOutputs: {
              draft: "draft from checkpoint",
            },
            previousStepOutputs: {
              draft: "draft from checkpoint",
            },
            iterations: [],
          },
        },
      },
      onCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint);
      },
    })) {
      events.push(event);
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe("review draft from checkpoint");
    expect(checkpoints).toEqual([
      expect.objectContaining({
        nodeId: "delivery",
        kind: "loop",
        state: expect.objectContaining({
          nextIteration: 1,
          currentIteration: 1,
          currentStepOutputs: {
            draft: "draft from checkpoint",
            review: "PASS: accepted",
          },
        }),
      }),
      expect.objectContaining({
        nodeId: "delivery",
        kind: "loop",
        state: expect.objectContaining({
          nextIteration: 2,
          previousStepOutputs: {
            draft: "draft from checkpoint",
            review: "PASS: accepted",
          },
          iterations: [
            expect.objectContaining({
              index: 1,
              untilMatched: true,
            }),
          ],
        }),
      }),
    ]);
    expect(readStatusMessages(events)).toEqual(
      expect.arrayContaining([
        "Loop step delivery[1].draft restored from checkpoint.",
      ]),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "completed",
      }),
    );
  });

  it("fails when one inherited session key crosses cwd boundaries", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield {
        type: "session_ref",
        session: {
          agentSessionId: input.resumeSessionId ?? "session-1",
          agent: input.agent,
          status: "running",
        },
      };
      yield {
        type: "text_delta",
        text: "done",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const first = await agent({ id: "first", cwd: "src", session: { mode: "inherit", key: "writer" }, prompt: "one" })
const second = await agent({ id: "second", cwd: "tools", session: { mode: "inherit", key: "writer" }, prompt: "two" })
`,
      agent: "local:codex",
      cwd: process.cwd(),
    })) {
      events.push(event);
    }

    expect(calls).toHaveLength(1);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "failed",
      }),
    );
    expect(readNodeFailures(events)).toEqual([
      expect.stringContaining(
        'Workflow session "writer" already started in',
      ),
    ]);
  });

  it("runs a bounded loop until the acceptance step passes", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      const isRd = input.prompt.startsWith("task:");
      const agentSessionId =
        input.resumeSessionId ?? (isRd ? "rd-session" : "acceptance-session");
      yield {
        type: "session_ref",
        session: {
          agentSessionId,
          agent: input.agent,
          status: "running",
        },
      };
      yield {
        type: "text_delta",
        text: loopMockText(input.prompt),
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
export const inputs = {
  task: { type: "string", required: true },
}

const delivery = await loop({
  id: "delivery",
  maxIterations: 3,
  steps: [
    agent({
      id: "rd",
      session: { mode: "inherit", key: "rd_room" },
      prompt: \`task: {{task}}
feedback: {{acceptance}}\`,
      appendPrompt: \`iteration: {{iteration}}
feedback: {{acceptance}}\`,
    }),
    agent({
      id: "acceptance",
      session: { mode: "inherit", key: "acceptance_room" },
      prompt: \`review: {{rd}}\`,
    }),
  ],
  until: { source: "acceptance", finalStatus: "PASS: accepted" },
})
`,
      agent: "local:codex",
      cwd: process.cwd(),
      inputs: { task: "ship loop" },
    })) {
      events.push(event);
    }

    expect(calls.map((call) => call.prompt)).toEqual([
      "task: ship loop\nfeedback: ",
      "review: first delivery",
      "iteration: 2\nfeedback: FAIL: missing tests",
      "review: revised delivery",
    ]);
    expect(calls.map((call) => call.resumeSessionId)).toEqual([
      undefined,
      undefined,
      "rd-session",
      "acceptance-session",
    ]);
    expect(readStatusMessages(events)).toEqual(
      expect.arrayContaining([
        'Loop "delivery" iteration 1 until check: not matched (acceptance final status "PASS: accepted").',
        'Loop "delivery" iteration 2 until check: matched (acceptance final status "PASS: accepted").',
      ]),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "completed",
        outputs: {
          delivery: expect.stringContaining("Stop reason: until_matched"),
        },
      }),
    );
    const finalEvent = [...events]
      .reverse()
      .find(
        (event) => event.type === "node_completed" && event.nodeId === "delivery",
      );
    expect(finalEvent).toEqual(
      expect.objectContaining({
        output: expect.stringContaining("[acceptance]\nPASS: accepted"),
      }),
    );
    expect(
      events
        .filter((event) => event.type === "loop_step_state")
        .map((event) => [
          event.loopStep.executionKey,
          event.status,
          event.promptMode,
        ]),
    ).toEqual(expect.arrayContaining([
      ["loop:delivery:1:rd", "running", "full"],
      ["loop:delivery:1:acceptance", "completed", undefined],
      ["loop:delivery:2:rd", "running", "append"],
      ["loop:delivery:2:acceptance", "completed", undefined],
    ]));
  });

  it("matches finalStatus only against the final non-empty output line", async () => {
    const reviewOutputs = [
      "This is not ACCEPTED.\nNEEDS_WORK\n\n",
      "Looks good after fixes.\nACCEPTED\n\n",
    ];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      yield {
        type: "text_delta",
        text: input.prompt.startsWith("review")
          ? reviewOutputs.shift() ?? "ACCEPTED"
          : "work",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const delivery = await loop({
  id: "delivery",
  maxIterations: 2,
  steps: [
    agent({ id: "rd", prompt: "work {{iteration}}" }),
    agent({ id: "review", prompt: "review {{rd}}" }),
  ],
  until: { source: "review", finalStatus: "ACCEPTED" },
})
`,
      agent: "mock",
      cwd: process.cwd(),
    })) {
      events.push(event);
    }

    expect(runAgentMock).toHaveBeenCalledTimes(4);
    expect(readStatusMessages(events)).toEqual(
      expect.arrayContaining([
        'Loop "delivery" iteration 1 until check: not matched (review final status "ACCEPTED").',
        'Loop "delivery" iteration 2 until check: matched (review final status "ACCEPTED").',
      ]),
    );
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "completed",
      }),
    );
  });

  it("starts the first loop iteration at reviewer and exits without an unnecessary fix", async () => {
    const calls: AgentRunInput[] = [];
    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield { type: "text_delta", text: "PASS" };
      yield { type: "done", status: "completed", reason: "completed" };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const acceptance = await loop({
  id: "acceptance",
  maxIterations: 3,
  firstIteration: { startAt: "reviewer" },
  steps: [
    agent({ id: "rd_fix", label: "RD Fix", prompt: "fix {{reviewer}}" }),
    agent({ id: "reviewer", label: "Reviewer", prompt: "review" }),
  ],
  until: { source: "reviewer", finalStatus: "PASS" },
})
`,
      agent: "mock",
      cwd: process.cwd(),
    })) {
      events.push(event);
    }

    expect(calls.map((call) => call.title)).toEqual(["Reviewer"]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: "run_completed",
      status: "completed",
    }));
  });

  it("reuses one RD session across human alignment and reviewer repair loops", async () => {
    const calls: AgentRunInput[] = [];
    let reviewerRuns = 0;
    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      const isReviewer = input.title === "Reviewer";
      if (isReviewer) {
        reviewerRuns += 1;
      }
      yield {
        type: "session_ref",
        session: {
          agentSessionId:
            input.resumeSessionId ?? (isReviewer ? "reviewer-session" : "rd-session"),
          agent: input.agent,
          status: "running",
        },
      };
      yield {
        type: "text_delta",
        text: isReviewer && reviewerRuns === 1 ? "FAIL" : isReviewer ? "PASS" : "work",
      };
      yield { type: "done", status: "completed", reason: "completed" };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const alignment = await loop({
  id: "alignment",
  maxIterations: 2,
  steps: [
    agent({
      id: "rd",
      label: "RD",
      session: { mode: "inherit", key: "rd_room" },
      prompt: "implement",
      appendPrompt: "revise {{human_review.values.comment}}",
    }),
    human({ id: "human_review", actions: [{ id: "approve", label: "Approve" }] }),
  ],
  until: { source: "human_review.action", equals: "approve" },
})
const acceptance = await loop({
  id: "acceptance",
  inputs: { alignment },
  maxIterations: 3,
  firstIteration: { startAt: "reviewer" },
  steps: [
    agent({
      id: "rd_fix",
      label: "RD Fix",
      session: { mode: "inherit", key: "rd_room" },
      prompt: "fix {{reviewer}}",
      appendPrompt: "fix {{reviewer}}",
    }),
    agent({
      id: "reviewer",
      label: "Reviewer",
      session: { mode: "inherit", key: "reviewer_room" },
      prompt: "review",
      appendPrompt: "review again",
    }),
  ],
  until: { source: "reviewer", finalStatus: "PASS" },
})
`,
      agent: "mock",
      cwd: process.cwd(),
      onHumanTask: (request) => humanTask(request, "resolved", {
        action: "approve",
        values: {},
      }),
    })) {
      events.push(event);
    }

    expect(calls.map((call) => call.title)).toEqual([
      "RD",
      "Reviewer",
      "RD Fix",
      "Reviewer",
    ]);
    expect(calls.map((call) => call.resumeSessionId)).toEqual([
      undefined,
      undefined,
      "rd-session",
      "reviewer-session",
    ]);
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: "run_completed",
      status: "completed",
    }));
  });

  it("runs the human-gated RD blueprint through revise, acceptance repair, and submission", async () => {
    const script = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/lib/workflow/blueprints/rd-human-acceptance-delivery-v1.workflow.js",
      ),
      "utf8",
    );
    const calls: AgentRunInput[] = [];
    let reviewerRuns = 0;
    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      const isRd = input.title === "RD 工程师" || input.title === "RD 修复";
      const isReviewer = input.title === "验收 Reviewer";
      if (isReviewer) {
        reviewerRuns += 1;
      }
      if (isRd || isReviewer) {
        yield {
          type: "session_ref",
          session: {
            agentSessionId:
              input.resumeSessionId ?? (isReviewer ? "reviewer-session" : "rd-session"),
            agent: input.agent,
            status: "running",
          },
        };
      }
      yield {
        type: "text_delta",
        text: isReviewer
          ? reviewerRuns === 1
            ? "阻断：缺少边界测试\nFAIL"
            : "验收通过\nPASS"
          : input.title === "提交 MR"
            ? "MR prepared"
            : "implementation updated",
      };
      yield { type: "done", status: "completed", reason: "completed" };
    });

    const events = [];
    for await (const event of runWorkflow({
      script,
      agent: "mock",
      cwd: process.cwd(),
      inputs: { requirement: "实现并验证 Human gate 研发流程" },
      onHumanTask: (request) =>
        humanTask(request, "resolved", request.iteration === 1
          ? {
              action: "revise",
              values: { comment: "请补充边界测试" },
            }
          : { action: "approve", values: {} }),
    })) {
      events.push(event);
    }

    expect(calls.map((call) => call.title)).toEqual([
      "RD 工程师",
      "RD 工程师",
      "验收 Reviewer",
      "RD 修复",
      "验收 Reviewer",
      "提交 MR",
    ]);
    expect(calls.map((call) => call.resumeSessionId)).toEqual([
      undefined,
      "rd-session",
      undefined,
      "rd-session",
      "reviewer-session",
      undefined,
    ]);
    expect(calls[1].prompt).toContain("请补充边界测试");
    expect(calls[3].prompt).toContain("阻断：缺少边界测试");
    expect(calls[5].prompt).toContain("Stop reason: until_matched");
    expect(events.at(-1)).toEqual(expect.objectContaining({
      type: "run_completed",
      status: "completed",
    }));
  });

  it("fails by default when max_iterations_reached before until matches", async () => {
    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      yield {
        type: "text_delta",
        text: `NO: ${input.prompt}`,
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const debate = await loop({
  id: "debate",
  maxIterations: 2,
  steps: [
    agent({ id: "agent_a", prompt: "A sees {{agent_b}}" }),
    agent({ id: "agent_b", prompt: "B sees {{agent_a}}" }),
    agent({ id: "moderator", prompt: "Judge {{agent_a}} {{agent_b}}" }),
  ],
  until: { source: "moderator", finalStatus: "RESOLVED" },
})
`,
      agent: "mock",
      cwd: process.cwd(),
    })) {
      events.push(event);
    }

    expect(runAgentMock).toHaveBeenCalledTimes(6);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "failed",
        error: expect.stringContaining("Stop reason: max_iterations_reached"),
      }),
    );
  });

  it("can complete with max_iterations_reached when explicitly configured", async () => {
    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      yield {
        type: "text_delta",
        text: `NO: ${input.prompt}`,
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const debate = await loop({
  id: "debate",
  maxIterations: 2,
  onMaxIterations: "complete",
  steps: [
    agent({ id: "agent_a", prompt: "A sees {{agent_b}}" }),
    agent({ id: "agent_b", prompt: "B sees {{agent_a}}" }),
    agent({ id: "moderator", prompt: "Judge {{agent_a}} {{agent_b}}" }),
  ],
  until: { source: "moderator", finalStatus: "RESOLVED" },
})
`,
      agent: "mock",
      cwd: process.cwd(),
    })) {
      events.push(event);
    }

    expect(runAgentMock).toHaveBeenCalledTimes(6);
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "run_completed",
        status: "completed",
        outputs: {
          debate: expect.stringContaining("Stop reason: max_iterations_reached"),
        },
      }),
    );
  });

  it("keeps loop step sessions independent when requested", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      yield {
        type: "session_ref",
        session: {
          agentSessionId: `session-${calls.length}`,
          agent: input.agent,
          status: "running",
        },
      };
      yield {
        type: "text_delta",
        text: "NO",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    for await (const _event of runWorkflow({
      script: `
const debate = await loop({
  id: "debate",
  maxIterations: 2,
  steps: [
    agent({
      id: "agent_a",
      session: { mode: "independent" },
      prompt: "A sees {{moderator}}",
      appendPrompt: "A appends {{moderator}}",
    }),
    agent({ id: "moderator", prompt: "Judge {{agent_a}}" }),
  ],
  until: { source: "moderator", finalStatus: "RESOLVED" },
})
`,
      agent: "mock",
      cwd: process.cwd(),
    })) {
      // drain
    }

    expect(calls.map((call) => call.resumeSessionId)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(calls[2].prompt).toBe("A sees NO");
  });

  it("can derive per-step inherited sessions from a loop session default", async () => {
    const calls: AgentRunInput[] = [];

    runAgentMock.mockImplementation(async function* (
      input: AgentRunInput,
    ): AsyncGenerator<AgentRuntimeEvent> {
      calls.push(input);
      const isRd = input.prompt.startsWith("rd") || input.prompt.startsWith("rd append");
      yield {
        type: "session_ref",
        session: {
          agentSessionId:
            input.resumeSessionId ?? (isRd ? "rd-session" : "qa-session"),
          agent: input.agent,
          status: "running",
        },
      };
      yield {
        type: "text_delta",
        text: isRd ? "work" : "NO",
      };
      yield {
        type: "done",
        status: "completed",
        reason: "completed",
      };
    });

    const events = [];
    for await (const event of runWorkflow({
      script: `
const delivery = await loop({
  id: "delivery",
  maxIterations: 2,
  session: { mode: "inherit", key: "delivery", scope: "step" },
  steps: [
    agent({ id: "rd", prompt: "rd {{qa}}", appendPrompt: "rd append {{iteration}} {{qa}}" }),
    agent({ id: "qa", prompt: "qa {{rd}}" }),
  ],
  until: { source: "qa", finalStatus: "PASS" },
})
`,
      agent: "local:codex",
      cwd: process.cwd(),
    })) {
      events.push(event);
    }

    expect(calls.map((call) => call.resumeSessionId)).toEqual([
      undefined,
      undefined,
      "rd-session",
      "qa-session",
    ]);
    expect(calls[2].prompt).toBe("rd append 2 NO");
    expect(
      events.some(
        (event) => event.type === "node_event" && event.nodeId === "delivery.rd",
      ),
    ).toBe(true);
    expect(readStatusMessages(events)).toEqual(
      expect.arrayContaining([
        'Workflow session "delivery.rd" is reusing agent session rd-session for delivery[2].rd with appendPrompt.',
      ]),
    );
  });
});

function loopMockText(prompt: string): string {
  if (prompt.startsWith("iteration:")) {
    return "revised delivery";
  }
  if (prompt.startsWith("task:") && prompt.includes("FAIL:")) {
    return "revised delivery";
  }
  if (prompt.startsWith("task:")) {
    return "first delivery";
  }
  if (prompt.includes("revised delivery")) {
    return "PASS: accepted";
  }
  return "FAIL: missing tests";
}

function readStatusMessages(events: unknown[]): string[] {
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") {
      return [];
    }
    const raw = event as {
      type?: unknown;
      event?: {
        type?: unknown;
        message?: unknown;
      };
    };
    if (raw.type !== "node_event" || raw.event?.type !== "status") {
      return [];
    }
    return typeof raw.event.message === "string" ? [raw.event.message] : [];
  });
}

function readNodeFailures(events: unknown[]): string[] {
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") {
      return [];
    }
    const raw = event as {
      type?: unknown;
      error?: unknown;
    };
    return raw.type === "node_failed" && typeof raw.error === "string"
      ? [raw.error]
      : [];
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
