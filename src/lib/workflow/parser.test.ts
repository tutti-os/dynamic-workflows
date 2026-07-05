import { describe, expect, it } from "vitest";
import {
  assertWorkflowScriptValid,
  parseWorkflowScript,
  WorkflowScriptSyntaxError,
} from "./parser";
import { LOOP_RD_ACCEPTANCE_TEST_WORKFLOW } from "./sample";

const VALID_SCRIPT = `export const meta = {
  name: "repo_review",
  description: "Review a repo",
  requiresCwd: true,
}

phase("Scan")

const inventory = await agent({
  id: "inventory",
  label: "Inventory",
  prompt: \`Inspect {{repo}} in {{workflow.cwd}}\`,
})

phase("Synthesize")

const summary = await agent({
  id: "summary",
  label: "Summary",
  inputs: { inventory },
  prompt: \`Use {{inventory}} for {{audience}}\`,
})

log("done")
`;

describe("parseWorkflowScript", () => {
  it("parses workflow nodes, edges, and external inputs", () => {
    const parsed = parseWorkflowScript(VALID_SCRIPT);

    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(parsed.meta).toEqual({
      name: "repo_review",
      description: "Review a repo",
      requiresCwd: true,
    });
    expect(parsed.nodes.map((node) => node.id)).toEqual([
      "inventory",
      "summary",
      "log_1",
    ]);
    expect(parsed.edges).toEqual([
      {
        id: "inventory->summary:inventory",
        source: "inventory",
        target: "summary",
        label: "inventory",
      },
    ]);
    expect(parsed.externalInputs.sort()).toEqual(["audience", "repo"]);
  });

  it("reports duplicate node ids as validation errors", () => {
    const parsed = parseWorkflowScript(`
const first = await agent({ id: "same", prompt: "one" })
const second = await agent({ id: "same", prompt: "two" })
`);

    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: 'Duplicate workflow node id "same". Node ids must be unique.',
      }),
    );
    expect(() =>
      assertWorkflowScriptValid(`
const first = await agent({ id: "same", prompt: "one" })
const second = await agent({ id: "same", prompt: "two" })
`),
    ).toThrow(WorkflowScriptSyntaxError);
  });

  it("parses agent session keys", () => {
    const parsed = parseWorkflowScript(`
const first = await agent({ id: "first", session: { mode: "inherit", key: "writer" }, prompt: "one" })
const second = await agent({ id: "second", session: { mode: "inherit", key: "writer" }, cwd: "src", prompt: "two" })
`);

    expect(parsed.nodes.map((node) => [node.id, node.session, node.cwd])).toEqual([
      ["first", { mode: "inherit", key: "writer" }, undefined],
      ["second", { mode: "inherit", key: "writer" }, "src"],
    ]);
  });

  it("rejects legacy string session keys", () => {
    const parsed = parseWorkflowScript(`
const first = await agent({ id: "first", session: "writer", prompt: "one" })
`);

    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message:
          'session must be an object, for example { mode: "inherit", key: "room" } or { mode: "independent" }.',
      }),
    );
  });

  it("parses bounded loop nodes and excludes loop step refs from external inputs", () => {
    const parsed = parseWorkflowScript(`
const delivery = await loop({
  id: "delivery_loop",
  label: "Delivery Loop",
  maxIterations: 3,
  onMaxIterations: "complete",
  agent: "local:claude-code",
  model: "claude-sonnet-4",
  cwd: "src",
  session: { mode: "inherit", key: "delivery", scope: "step" },
  steps: [
    agent({
      id: "rd",
      label: "RD",
      agent: "local:codex",
      model: "gpt-5.1",
      cwd: "src/lib",
      session: { mode: "inherit", key: "rd_room" },
      prompt: \`Task: {{task}}
Previous acceptance: {{acceptance}}\`,
      appendPrompt: \`Iteration {{iteration}} feedback: {{acceptance}}\`,
    }),
    agent({
      id: "acceptance",
      label: "Acceptance",
      prompt: \`Review {{rd}} for {{task}}\`,
    }),
  ],
  until: { source: "acceptance", includes: "PASS:" },
})
`);

    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0]).toMatchObject({
      id: "delivery_loop",
      kind: "loop",
      label: "Delivery Loop",
      agent: "local:claude-code",
      model: "claude-sonnet-4",
      cwd: "src",
      variableName: "delivery",
      templateRefs: ["task"],
      loop: {
        maxIterations: 3,
        onMaxIterations: "complete",
        session: { mode: "inherit", key: "delivery", scope: "step" },
        until: { source: "acceptance", includes: "PASS:" },
      },
    });
    expect(
      parsed.nodes[0].loop?.steps.map((step) => [
        step.id,
        step.agent,
        step.model,
        step.session,
        step.cwd,
      ]),
    ).toEqual([
      [
        "rd",
        "local:codex",
        "gpt-5.1",
        { mode: "inherit", key: "rd_room" },
        "src/lib",
      ],
      ["acceptance", undefined, undefined, undefined, undefined],
    ]);
    expect(parsed.nodes[0].loop?.steps[0].appendPrompt).toBe(
      "Iteration {{iteration}} feedback: {{acceptance}}",
    );
    expect(parsed.externalInputs).toEqual(["task"]);
  });

  it("collects required agent and model template inputs without requiring defaults", () => {
    const parsed = parseWorkflowScript(`
const plan = await agent({
  id: "plan",
  agent: "{{planner_agent}}",
  model: "{{planner_model:gpt-5}}",
  prompt: "Plan {{task}}",
})

const delivery = await loop({
  id: "delivery",
  agent: "{{loop_agent:local:codex}}",
  model: "{{loop_model}}",
  maxIterations: 1,
  steps: [
    agent({
      id: "coder",
      model: "{{coder_model:gpt-5.1}}",
      prompt: "Code {{task}}",
    }),
    agent({
      id: "reviewer",
      agent: "{{reviewer_agent}}",
      model: "{{reviewer_model}}",
      prompt: "Review {{coder}}",
    }),
  ],
  until: { source: "reviewer", includes: "PASS:" },
})
`);

    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(parsed.externalInputs.sort()).toEqual([
      "loop_model",
      "planner_agent",
      "reviewer_agent",
      "reviewer_model",
      "task",
    ]);
    expect(parsed.optionalExternalInputs.sort()).toEqual([
      "coder_model",
      "loop_agent",
      "planner_model",
    ]);
  });

  it("reports invalid agent and model runtime option templates", () => {
    const parsed = parseWorkflowScript(`
const setup = await agent({ id: "setup", prompt: "setup" })
const invalid = await agent({
  id: "invalid",
  agent: "local:{{agent_name}}",
  model: "{{workflow.cwd}}",
  prompt: "Invalid",
})
const conflict = await loop({
  id: "conflict",
  model: "{{setup}}",
  maxIterations: 1,
  steps: [
    agent({ id: "coder", model: "{{coder:}}", prompt: "Code" }),
    agent({ id: "reviewer", model: "{{coder}}", prompt: "Review {{coder}}" }),
  ],
  until: { source: "reviewer", includes: "PASS:" },
})
`);

    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining(
            "must be exactly one placeholder with no surrounding text",
          ),
        }),
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining(
            'runtime template "{{workflow.cwd}}" is invalid',
          ),
        }),
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining(
            'runtime input "setup" conflicts with a workflow node',
          ),
        }),
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining(
            "runtime template defaults must be non-empty",
          ),
        }),
        expect.objectContaining({
          severity: "error",
          message: expect.stringContaining(
            'runtime input "coder" conflicts with a workflow node',
          ),
        }),
      ]),
    );
    expect(() =>
      assertWorkflowScriptValid(`
const invalid = await agent({ id: "invalid", model: "gpt-{{model}}", prompt: "x" })
`),
    ).toThrow(WorkflowScriptSyntaxError);
  });

  it("prevents runtime option inputs from conflicting with parallel aliases", () => {
    const parsed = parseWorkflowScript(`
const work = parallel([
  () => agent({ id: "first", prompt: "one" }),
  () => agent({ id: "second", prompt: "two" }),
])
const summary = await agent({
  id: "summary",
  model: "{{work_0}}",
  prompt: "Summarize {{work_0}}",
})
`);

    expect(parsed.variableToNodeId.work_0).toBe("first");
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining(
          'runtime input "work_0" conflicts with a workflow node',
        ),
      }),
    );
  });

  it("parses workflow nodes inside phase callback blocks", () => {
    const parsed = parseWorkflowScript(`
phase("RD delivery and acceptance", () => {
  const delivery_loop = loop({
    id: "delivery_loop",
    maxIterations: 4,
    steps: [
      agent({ id: "rd", prompt: \`Task: {{requirement}}\nFeedback: {{acceptance}}\` }),
      agent({ id: "acceptance", prompt: \`Review {{rd}}\` }),
    ],
    until: { source: "acceptance", includes: "PASS:" },
  })

  agent({
    id: "final_summary",
    inputs: { delivery_loop },
    prompt: \`Summarize {{delivery_loop}}\`,
  })
})
`);

    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(parsed.nodes.map((node) => [node.id, node.kind, node.phase])).toEqual([
      ["delivery_loop", "loop", "RD delivery and acceptance"],
      ["final_summary", "agent", "RD delivery and acceptance"],
    ]);
    expect(parsed.edges).toEqual([
      {
        id: "delivery_loop->final_summary:delivery_loop",
        source: "delivery_loop",
        target: "final_summary",
        label: "delivery_loop",
      },
    ]);
    expect(parsed.externalInputs).toEqual(["requirement"]);
  });

  it("reports invalid loop configuration as validation errors", () => {
    expect(() =>
      assertWorkflowScriptValid(`
const broken = await loop({
  id: "broken",
  maxIterations: 99,
  steps: [agent({ id: "one", prompt: "one" })],
  until: { source: "missing", includes: "PASS:" },
})
`),
    ).toThrow(WorkflowScriptSyntaxError);
  });

  it("keeps the loop RD acceptance sample aligned with cwd protocol", () => {
    const parsed = assertWorkflowScriptValid(LOOP_RD_ACCEPTANCE_TEST_WORKFLOW);

    expect(parsed.meta.requiresCwd).toBe(true);
    expect(parsed.externalInputs).toEqual(["requirement"]);
    expect(parsed.nodes[0].loop?.onMaxIterations).toBe("fail");
    expect(parsed.nodes.map((node) => [node.id, node.cwd])).toEqual([
      ["delivery_loop", "."],
      ["submit_mr", "."],
    ]);
  });
});
