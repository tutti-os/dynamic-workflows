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

export const inputs = {
  repo: { type: "string", required: true, label: "Repo" },
  audience: { type: "string", required: true, label: "Audience" },
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
  it("parses workflow nodes, edges, and input schema", () => {
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
    expect(parsed.inputSchema).toMatchObject({
      audience: { type: "string", required: true },
      repo: { type: "string", required: true },
    });
    expect(parsed.requiredInputNames.sort()).toEqual(["audience", "repo"]);
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

  it("reports undeclared template inputs", () => {
    const parsed = parseWorkflowScript(`
const plan = await agent({ id: "plan", prompt: "Plan {{requirement}}" })
`);

    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message:
          'Workflow input "requirement" is used in a template but is not declared in export const inputs.',
      }),
    );
  });

  it("validates workflow input schema fields", () => {
    const parsed = parseWorkflowScript(`
export const inputs = {
  requirement: { type: "string", required: true, widget: "textarea" },
  threshold: { type: "number", default: -1, min: -5, max: 5 },
  mode: { type: "enum", options: ["research", "implementation"], default: "research" },
  broken: { type: "enum", options: [], typo: true },
}
`);

    expect(parsed.inputSchema.requirement).toMatchObject({
      type: "string",
      required: true,
      widget: "textarea",
    });
    expect(parsed.inputSchema.mode).toMatchObject({
      type: "enum",
      options: ["research", "implementation"],
      default: "research",
    });
    expect(parsed.inputSchema.threshold).toMatchObject({
      type: "number",
      default: -1,
      min: -5,
      max: 5,
    });
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message:
          'Workflow input "broken" options must contain at least one option.',
      }),
    );
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: 'Workflow input "broken" has unsupported field "typo".',
      }),
    );
  });

  it("reports defaults that violate input schema constraints", () => {
    const parsed = parseWorkflowScript(`
export const inputs = {
  tooShort: { type: "string", default: "x", minLength: 2 },
  tooLong: { type: "string", default: "abcd", maxLength: 3 },
  patternMismatch: { type: "string", default: "abc", pattern: "^req-" },
  tooSmall: { type: "number", default: -1, min: 0 },
  tooLarge: { type: "number", default: 11, max: 10 },
}
`);

    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          message: 'Workflow input "tooShort" default must be at least 2 characters.',
        }),
        expect.objectContaining({
          severity: "error",
          message: 'Workflow input "tooLong" default must be at most 3 characters.',
        }),
        expect.objectContaining({
          severity: "error",
          message:
            'Workflow input "patternMismatch" default does not match the required pattern.',
        }),
        expect.objectContaining({
          severity: "error",
          message: 'Workflow input "tooSmall" default must be at least 0.',
        }),
        expect.objectContaining({
          severity: "error",
          message: 'Workflow input "tooLarge" default must be at most 10.',
        }),
      ]),
    );
  });

  it("parses bounded loop nodes and excludes loop step refs from external inputs", () => {
    const parsed = parseWorkflowScript(`
export const inputs = {
  task: { type: "string", required: true },
}

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
  until: { source: "acceptance", finalStatus: "PASS" },
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
        until: { source: "acceptance", finalStatus: "PASS" },
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
    expect(parsed.requiredInputNames).toEqual(["task"]);
  });

  it("parses loop until finalStatus", () => {
    const parsed = parseWorkflowScript(`
const last_line = await loop({
  id: "last_line",
  maxIterations: 1,
  steps: [agent({ id: "reviewer", prompt: "Review" })],
  until: { source: "reviewer", finalStatus: "ACCEPTED" },
})
`);

    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(parsed.nodes[0].loop?.until).toEqual({
      source: "reviewer",
      finalStatus: "ACCEPTED",
    });
  });

  it("reports missing and blank loop until finalStatus", () => {
    const parsed = parseWorkflowScript(`
const missing = await loop({
  id: "missing",
  maxIterations: 1,
  steps: [agent({ id: "reviewer", prompt: "Review" })],
  until: { source: "reviewer" },
})
const empty = await loop({
  id: "empty",
  maxIterations: 1,
  steps: [agent({ id: "reviewer", prompt: "Review" })],
  until: { source: "reviewer", finalStatus: "   " },
})
`);

    expect(parsed.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "error",
          message: "loop until.finalStatus is required.",
        }),
        expect.objectContaining({
          severity: "error",
          message: "loop until.finalStatus must be non-empty.",
        }),
      ]),
    );
  });

  it("rejects legacy loop until matchers", () => {
    const script = `
const delivery = await loop({
  id: "delivery",
  maxIterations: 1,
  steps: [agent({ id: "reviewer", prompt: "Review" })],
  until: { source: "reviewer", includes: "PASS:" },
})
`;

    const parsed = parseWorkflowScript(script);

    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: "loop until.finalStatus is required.",
      }),
    );
    expect(() => assertWorkflowScriptValid(script)).toThrow(
      WorkflowScriptSyntaxError,
    );
  });

  it("collects required agent and model template inputs without requiring defaults", () => {
    const parsed = parseWorkflowScript(`
export const inputs = {
  planner_agent: { type: "string", required: true },
  planner_model: { type: "string", default: "gpt-5" },
  task: { type: "string", required: true },
  loop_agent: { type: "string", default: "local:codex" },
  loop_model: { type: "string", required: true },
  coder_model: { type: "string", default: "gpt-5.1" },
  reviewer_agent: { type: "string", required: true },
  reviewer_model: { type: "string", required: true },
}

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
  until: { source: "reviewer", finalStatus: "PASS" },
})
`);

    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(parsed.requiredInputNames.sort()).toEqual([
      "loop_model",
      "planner_agent",
      "reviewer_agent",
      "reviewer_model",
      "task",
    ]);
    expect(parsed.optionalInputNames.sort()).toEqual([
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
  until: { source: "reviewer", finalStatus: "PASS" },
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
export const inputs = {
  requirement: { type: "string", required: true },
}

phase("RD delivery and acceptance", () => {
  const delivery_loop = loop({
    id: "delivery_loop",
    maxIterations: 4,
    steps: [
      agent({ id: "rd", prompt: \`Task: {{requirement}}\nFeedback: {{acceptance}}\` }),
      agent({ id: "acceptance", prompt: \`Review {{rd}}\` }),
    ],
    until: { source: "acceptance", finalStatus: "PASS" },
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
    expect(parsed.requiredInputNames).toEqual(["requirement"]);
  });

  it("reports invalid loop configuration as validation errors", () => {
    expect(() =>
      assertWorkflowScriptValid(`
const broken = await loop({
  id: "broken",
  maxIterations: 99,
  steps: [agent({ id: "one", prompt: "one" })],
  until: { source: "missing", finalStatus: "PASS" },
})
`),
    ).toThrow(WorkflowScriptSyntaxError);
  });

  it("keeps the loop RD acceptance sample aligned with cwd protocol", () => {
    const parsed = assertWorkflowScriptValid(LOOP_RD_ACCEPTANCE_TEST_WORKFLOW);

    expect(parsed.meta.requiresCwd).toBe(true);
    expect(parsed.requiredInputNames).toEqual(["requirement"]);
    expect(parsed.nodes[0].loop?.onMaxIterations).toBe("fail");
    expect(parsed.nodes.map((node) => [node.id, node.cwd])).toEqual([
      ["delivery_loop", "."],
      ["submit_mr", "."],
    ]);
  });
});
