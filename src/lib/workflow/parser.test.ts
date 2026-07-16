import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  assertWorkflowScriptValid,
  parseWorkflowScript,
  WorkflowScriptSyntaxError,
} from "./parser";

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
  it("parses top-level and loop human tasks with structured references", () => {
    const parsed = parseWorkflowScript(`
const approval = await human({
  id: "approval",
  label: "Approve",
  context: [{ label: "Draft", value: "{{draft}}", display: "markdown" }],
  actions: [
    { id: "pass", label: "Pass", intent: "primary" },
    { id: "revise", label: "Revise", fields: [{ id: "comment", type: "textarea", label: "Comment", required: true }] },
  ],
})
const draft = await agent({ id: "draft", prompt: "Create" })
const next = await agent({ id: "next", prompt: "{{approval.action}} {{approval.values.comment}}" })
const looped = await loop({
  id: "looped",
  maxIterations: 2,
  steps: [
    agent({ id: "worker", prompt: "{{review.values.comment}}" }),
    human({ id: "review", actions: [{ id: "pass", label: "Pass" }] }),
  ],
  until: { source: "review.action", equals: "pass" },
})
`);

    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(parsed.nodes.find((node) => node.id === "approval")).toEqual(
      expect.objectContaining({ kind: "human" }),
    );
    expect(parsed.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "approval", target: "next" }),
      expect.objectContaining({ source: "draft", target: "approval" }),
    ]));
    const loop = parsed.nodes.find((node) => node.id === "looped")?.loop;
    expect(loop?.steps[1]).toEqual(expect.objectContaining({
      id: "review",
      kind: "human",
    }));
    expect(loop?.until).toEqual({ source: "review.action", equals: "pass" });
  });

  it('accepts output: "json" on agent nodes and loop steps', () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List items as JSON." })
const graded = await loop({
  id: "graded",
  maxIterations: 2,
  steps: [
    agent({ id: "worker", prompt: "Do the work." }),
    agent({ id: "review", output: "json", prompt: "Judge {{worker}} and return JSON." }),
  ],
  until: { source: "review.verdict", equals: "pass" },
})
`);

    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(parsed.nodes.find((node) => node.id === "discover")).toEqual(
      expect.objectContaining({ output: "json" }),
    );
    const loop = parsed.nodes.find((node) => node.id === "graded")?.loop;
    expect(loop?.steps.find((step) => step.id === "review")).toEqual(
      expect.objectContaining({ output: "json" }),
    );
    expect(loop?.steps.find((step) => step.id === "worker")?.output).toBeUndefined();
    expect(loop?.until).toEqual({ source: "review.verdict", equals: "pass" });
  });

  it("rejects an unsupported output format on agent nodes and loop steps", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "yaml", prompt: "List items." })
const graded = await loop({
  id: "graded",
  maxIterations: 2,
  steps: [
    agent({ id: "review", output: "xml", prompt: "Judge and return." }),
  ],
  until: { source: "review", finalStatus: "PASS" },
})
`);

    expect(parsed.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        'node "discover" output must be "json" when set.',
        'loop step "review" output must be "json" when set.',
      ]),
    );
  });

  it("validates human task actions and fields", () => {
    const parsed = parseWorkflowScript(`
const invalid = human({
  id: "invalid",
  actions: [
    { id: "same", label: "One" },
    { id: "same", label: "Two", fields: [
      { id: "choice", type: "select", label: "Choice" },
      { id: "choice", type: "unknown", label: "Duplicate" },
    ] },
  ],
})
`);
    expect(parsed.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        'Duplicate human action id "same".',
        "human select fields require at least one option.",
        'Duplicate human field id "choice".',
        'human field type must be "text", "textarea", or "select".',
      ]),
    );
  });
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

  it("rejects concatenated or interpolated prompts instead of silently emptying them", () => {
    const concatenated = parseWorkflowScript(`
const first = await agent({ id: "first", prompt: "part one " + "part two" })
`);
    expect(concatenated.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message:
          "agent prompt must be one plain string literal; string concatenation and ${...} interpolation are not supported.",
      }),
    );

    const interpolated = parseWorkflowScript(`
const topic = "x"
const first = await agent({ id: "first", prompt: \`about \${topic}\` })
`);
    expect(interpolated.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message:
          "agent prompt must be one plain string literal; string concatenation and ${...} interpolation are not supported.",
      }),
    );
  });

  it("rejects missing or empty agent prompts", () => {
    const missing = parseWorkflowScript(`
const first = await agent({ id: "first" })
`);
    expect(missing.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: "agent(...) requires a non-empty prompt string.",
      }),
    );

    const empty = parseWorkflowScript(`
const first = await agent({ id: "first", prompt: "   " })
`);
    expect(empty.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: "agent prompt must be non-empty.",
      }),
    );
  });

  it("rejects concatenated prompts and appendPrompts inside loop steps", () => {
    const parsed = parseWorkflowScript(`
loop({
  id: "delivery",
  maxIterations: 3,
  steps: [
    agent({ id: "coder", prompt: "Implement " + "{{requirement}}", appendPrompt: "Round " + "{{iteration}}" }),
    agent({ id: "reviewer" }),
  ],
  until: { source: "reviewer", finalStatus: "PASS" },
})
`);

    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message:
          "loop step prompt must be one plain string literal; string concatenation and ${...} interpolation are not supported.",
      }),
    );
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message:
          "loop step appendPrompt must be one plain string literal; string concatenation and ${...} interpolation are not supported.",
      }),
    );
    expect(parsed.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: "loop step agent(...) requires a non-empty prompt string.",
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

  it("parses a loop that enters the first iteration at a later step", () => {
    const parsed = parseWorkflowScript(`
const acceptance = await loop({
  id: "acceptance",
  maxIterations: 3,
  firstIteration: { startAt: "reviewer" },
  steps: [
    agent({ id: "rd_fix", prompt: "Fix {{reviewer}}" }),
    agent({ id: "reviewer", prompt: "Review" }),
  ],
  until: { source: "reviewer", finalStatus: "PASS" },
})
`);

    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(parsed.nodes[0].loop?.firstIteration).toEqual({ startAt: "reviewer" });
  });

  it("validates firstIteration.startAt and requires the until step on the first iteration", () => {
    const parsed = parseWorkflowScript(`
const missing = await loop({
  id: "missing",
  maxIterations: 1,
  firstIteration: { startAt: "unknown" },
  steps: [agent({ id: "reviewer", prompt: "Review" })],
  until: { source: "reviewer", finalStatus: "PASS" },
})
const skipped_until = await loop({
  id: "skipped_until",
  maxIterations: 1,
  firstIteration: { startAt: "reviewer" },
  steps: [
    agent({ id: "decision", prompt: "Decide" }),
    agent({ id: "reviewer", prompt: "Review" }),
  ],
  until: { source: "decision", finalStatus: "PASS" },
})
`);

    expect(parsed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        severity: "error",
        message: 'loop firstIteration.startAt "unknown" must match a loop step id.',
      }),
      expect.objectContaining({
        severity: "error",
        message: 'loop until.source "decision" must run on the first iteration at or after firstIteration.startAt.',
      }),
    ]));
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
    const script = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/lib/workflow/blueprints/loop-primitive-rd-acceptance-test-v1.workflow.js",
      ),
      "utf8",
    );
    const parsed = assertWorkflowScriptValid(script);

    expect(parsed.meta.requiresCwd).toBe(true);
    expect(parsed.requiredInputNames).toEqual(["requirement"]);
    expect(parsed.nodes[0].loop?.onMaxIterations).toBe("complete");
    expect(parsed.nodes.map((node) => [node.id, node.cwd])).toEqual([
      ["delivery_loop", "."],
      ["submit_mr", "."],
    ]);
    const acceptance = parsed.nodes[0].loop?.steps.find(
      (step) => step.id === "acceptance",
    );
    expect(acceptance?.templateRefs).not.toContain("rd");
    expect(acceptance?.prompt).not.toContain("{{rd}}");
    // The reviewer runs each round in a fresh session; its only history is its
    // own previous review, carried through dataflow rather than session memory.
    expect(acceptance?.session).toEqual({ mode: "independent" });
    expect(acceptance?.appendPrompt).toBeUndefined();
    expect(acceptance?.templateRefs).toContain("acceptance");
  });

  it("keeps the human-gated RD blueprint on one RD session across both loops", () => {
    const script = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/lib/workflow/blueprints/rd-human-acceptance-delivery-v1.workflow.js",
      ),
      "utf8",
    );
    const parsed = assertWorkflowScriptValid(script);
    const alignment = parsed.nodes.find((node) => node.id === "human_alignment");
    const acceptance = parsed.nodes.find((node) => node.id === "acceptance_loop");
    const rd = alignment?.loop?.steps.find((step) => step.id === "rd");
    const rdFix = acceptance?.loop?.steps.find((step) => step.id === "rd_fix");
    const reviewer = acceptance?.loop?.steps.find((step) => step.id === "reviewer");

    expect(parsed.meta.requiresCwd).toBe(true);
    expect(parsed.requiredInputNames).toEqual(["requirement"]);
    expect(rd?.session).toEqual({ mode: "inherit", key: "rd_room" });
    expect(rdFix?.session).toEqual({ mode: "inherit", key: "rd_room" });
    expect(reviewer?.session).toEqual({ mode: "inherit", key: "reviewer_room" });
    expect(acceptance?.loop?.firstIteration).toEqual({ startAt: "reviewer" });
    expect(rdFix?.appendPrompt).toContain("不要再次请求 Human 审批");
    expect(reviewer?.prompt).toContain(
      "Human 通过只表示允许进入验收，不构成需求已经满足的证据",
    );
    expect(acceptance?.inputs).toContainEqual(expect.objectContaining({
      sourceNodeId: "human_alignment",
    }));
  });

  it("parses a map node with item refs and binds its source", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List work as JSON." })
const migrated = await map({
  id: "migrated",
  label: "Migrate each site",
  source: discover,
  maxItems: 20,
  onItemFailure: "skip",
  step: agent({
    id: "migrate_one",
    label: "Migrate {{item.file}}",
    prompt: "Migrate {{item.file}}:{{item.line}} (item {{item_index}}) with {{item}}",
  }),
})
`);

    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual(
      [],
    );
    const map = parsed.nodes.find((node) => node.id === "migrated");
    expect(map).toEqual(
      expect.objectContaining({ kind: "map" }),
    );
    expect(map?.map).toEqual(
      expect.objectContaining({
        source: "discover",
        sourceNodeId: "discover",
        maxItems: 20,
        onItemFailure: "skip",
      }),
    );
    expect(map?.map?.steps).toEqual([
      expect.objectContaining({ id: "migrate_one", kind: "agent" }),
    ]);
    // The source is a DAG dependency.
    expect(parsed.edges).toContainEqual(
      expect.objectContaining({ source: "discover", target: "migrated" }),
    );
    // Item refs never appear as workflow inputs or bindings.
    expect(map?.templateRefs).not.toContain("item");
    expect(map?.templateRefs).not.toContain("item.file");
    expect(map?.templateRefs).not.toContain("item_index");
  });

  it("does not require declaring map item refs as inputs", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List work as JSON." })
const migrated = await map({
  id: "migrated",
  source: discover,
  maxItems: 5,
  step: agent({ id: "one", prompt: "Do {{item.name}} #{{item_index}}: {{item}}" }),
})
`);

    expect(
      parsed.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    expect(
      parsed.diagnostics.some((item) =>
        item.message.includes('"item"') || item.message.includes('"item_index"'),
      ),
    ).toBe(false);
  });

  it("reports a missing or unknown map source", () => {
    const missing = parseWorkflowScript(`
const migrated = await map({
  id: "migrated",
  maxItems: 5,
  step: agent({ id: "one", prompt: "Do {{item}}" }),
})
`);
    expect(missing.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("map(...) requires source to reference"),
      ]),
    );

    const unknown = parseWorkflowScript(`
const migrated = await map({
  id: "migrated",
  source: ghost,
  maxItems: 5,
  step: agent({ id: "one", prompt: "Do {{item}}" }),
})
`);
    expect(unknown.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        'map source "ghost" must reference an earlier workflow node.',
      ]),
    );
  });

  it("rejects an out-of-range map maxItems", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List." })
const a = await map({ id: "a", source: discover, maxItems: 0, step: agent({ id: "one", prompt: "Do {{item}}" }) })
const b = await map({ id: "b", source: discover, maxItems: 51, step: agent({ id: "two", prompt: "Do {{item}}" }) })
`);
    const maxItemsErrors = parsed.diagnostics.filter((item) =>
      item.message.includes("maxItems as an integer from 1 to 50"),
    );
    expect(maxItemsErrors).toHaveLength(2);
  });

  it("rejects a non-agent map step", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List." })
const migrated = await map({
  id: "migrated",
  source: discover,
  maxItems: 5,
  step: human({ id: "one", actions: [{ id: "ok", label: "OK" }] }),
})
`);
    expect(parsed.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("map steps must each be an agent({...})"),
      ]),
    );
  });

  it("rejects an inherit session on a map step", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List." })
const migrated = await map({
  id: "migrated",
  source: discover,
  maxItems: 5,
  step: agent({ id: "one", prompt: "Do {{item}}", session: { mode: "inherit", key: "shared" } }),
})
`);
    expect(parsed.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("map step session cannot be"),
      ]),
    );
    const map = parsed.nodes.find((node) => node.id === "migrated");
    expect(map?.map?.steps[0].session).toBeUndefined();
  });

  it("allows a redundant independent session on a map step", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List." })
const migrated = await map({
  id: "migrated",
  source: discover,
  maxItems: 5,
  step: agent({ id: "one", prompt: "Do {{item}}", session: { mode: "independent" } }),
})
`);
    expect(
      parsed.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    const map = parsed.nodes.find((node) => node.id === "migrated");
    expect(map?.map?.steps[0].session).toEqual({ mode: "independent" });
  });

  it("rejects an unknown map onItemFailure", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List." })
const migrated = await map({
  id: "migrated",
  source: discover,
  maxItems: 5,
  onItemFailure: "retry",
  step: agent({ id: "one", prompt: "Do {{item}}" }),
})
`);
    expect(parsed.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        'map onItemFailure must be "skip" or "fail".',
      ]),
    );
  });

  it("parses a multi-step map pipeline and keeps later step refs internal", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List work as JSON." })
const migrated = await map({
  id: "migrated",
  source: discover,
  maxItems: 5,
  steps: [
    agent({ id: "process_one", label: "Process {{item.file}}", prompt: "Process {{item.file}}." }),
    agent({ id: "verify_one", label: "Verify {{item.file}}", prompt: "Verify {{process_one}} for {{item.file}}." }),
  ],
})
`);
    expect(
      parsed.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    const map = parsed.nodes.find((node) => node.id === "migrated");
    expect(map?.map?.steps.map((step) => step.id)).toEqual([
      "process_one",
      "verify_one",
    ]);
    // The earlier-step ref never leaks out as a workflow input / binding / edge.
    expect(map?.templateRefs).not.toContain("process_one");
    expect(map?.inputs.some((input) => input.name === "process_one")).toBe(false);
    expect(
      parsed.edges.some((edge) => edge.target === "migrated" && edge.label === "process_one"),
    ).toBe(false);
  });

  it("treats step: as sugar for a single-entry steps: pipeline", () => {
    const sugar = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List as JSON." })
const m = await map({ id: "m", source: discover, maxItems: 5, step: agent({ id: "one", prompt: "Do {{item}}" }) })
`);
    const array = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List as JSON." })
const m = await map({ id: "m", source: discover, maxItems: 5, steps: [agent({ id: "one", prompt: "Do {{item}}" })] })
`);
    const sugarSteps = sugar.nodes.find((node) => node.id === "m")?.map?.steps;
    const arraySteps = array.nodes.find((node) => node.id === "m")?.map?.steps;
    expect(sugarSteps).toHaveLength(1);
    expect(sugarSteps?.[0].id).toBe("one");
    expect(arraySteps?.[0].id).toBe("one");
    expect(
      sugar.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
  });

  it("rejects declaring both step and steps on a map", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List as JSON." })
const m = await map({
  id: "m",
  source: discover,
  maxItems: 5,
  step: agent({ id: "one", prompt: "Do {{item}}" }),
  steps: [agent({ id: "two", prompt: "Do {{item}}" })],
})
`);
    expect(parsed.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("map(...) declares both step and steps"),
      ]),
    );
  });

  it("rejects duplicate map step ids", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List as JSON." })
const m = await map({
  id: "m",
  source: discover,
  maxItems: 5,
  steps: [
    agent({ id: "dup", prompt: "First {{item}}" }),
    agent({ id: "dup", prompt: "Second {{item}}" }),
  ],
})
`);
    expect(parsed.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Duplicate map step id "dup"'),
      ]),
    );
  });

  it("rejects a map step referencing a later or its own step id", () => {
    const forward = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List as JSON." })
const m = await map({
  id: "m",
  source: discover,
  maxItems: 5,
  steps: [
    agent({ id: "first", prompt: "Use {{second}} for {{item}}" }),
    agent({ id: "second", prompt: "Do {{item}}" }),
  ],
})
`);
    expect(forward.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('references "second" from a later step'),
      ]),
    );

    const self = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List as JSON." })
const m = await map({
  id: "m",
  source: discover,
  maxItems: 5,
  steps: [agent({ id: "solo", prompt: "Loop {{solo}} on {{item}}" })],
})
`);
    expect(self.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('references its own output "solo"'),
      ]),
    );
  });

  it("accepts a static inline array source without a discover node", () => {
    const parsed = parseWorkflowScript(`
const checks = await map({
  id: "checks",
  source: [{ env: "dev" }, { env: "staging" }, { env: "prod" }],
  step: agent({ id: "one", prompt: "Check {{item.env}}: {{item}}" }),
})
`);
    expect(
      parsed.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    const map = parsed.nodes.find((node) => node.id === "checks");
    expect(map?.map?.items).toEqual([
      { env: "dev" },
      { env: "staging" },
      { env: "prod" },
    ]);
    // maxItems defaults to the literal length; there is no source binding/edge.
    expect(map?.map?.maxItems).toBe(3);
    expect(map?.map?.sourceNodeId).toBeUndefined();
    expect(map?.inputs).toEqual([]);
    expect(parsed.edges.some((edge) => edge.target === "checks")).toBe(false);
  });

  it("allows a literal source with an explicit maxItems at least its length", () => {
    const parsed = parseWorkflowScript(`
const checks = await map({
  id: "checks",
  source: [{ env: "dev" }, { env: "prod" }],
  maxItems: 5,
  step: agent({ id: "one", prompt: "Check {{item.env}}" }),
})
`);
    expect(
      parsed.diagnostics.filter((item) => item.severity === "error"),
    ).toEqual([]);
    const map = parsed.nodes.find((node) => node.id === "checks");
    expect(map?.map?.maxItems).toBe(5);
    expect(map?.map?.items).toHaveLength(2);
  });

  it("errors when a literal source is longer than maxItems", () => {
    const parsed = parseWorkflowScript(`
const checks = await map({
  id: "checks",
  source: [{ env: "dev" }, { env: "staging" }, { env: "prod" }],
  maxItems: 2,
  step: agent({ id: "one", prompt: "Check {{item.env}}" }),
})
`);
    expect(parsed.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("inline list has 3 items, exceeding maxItems 2"),
      ]),
    );
  });

  it("errors when a literal source without maxItems exceeds the map limit of 50", () => {
    const items = Array.from({ length: 51 }, (_, index) => `"item-${index}"`).join(", ");
    const parsed = parseWorkflowScript(`
const checks = await map({
  id: "checks",
  source: [${items}],
  step: agent({ id: "one", prompt: "Check {{item}}" }),
})
`);
    expect(parsed.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("inline list has 51 items, exceeding the map limit of 50"),
      ]),
    );
  });

  it("still requires maxItems for a node-bound map source", () => {
    const parsed = parseWorkflowScript(`
const discover = await agent({ id: "discover", output: "json", prompt: "List as JSON." })
const m = await map({
  id: "m",
  source: discover,
  step: agent({ id: "one", prompt: "Do {{item}}" }),
})
`);
    expect(parsed.diagnostics.map((item) => item.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("map(...) requires maxItems as an integer from 1 to 50"),
      ]),
    );
  });
});

const warningCodes = (script: string): string[] =>
  parseWorkflowScript(script)
    .diagnostics.filter((diagnostic) => diagnostic.severity === "warning")
    .map((diagnostic) => diagnostic.code ?? "");

const errorCount = (script: string): number =>
  parseWorkflowScript(script).diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;

describe("parseWorkflowScript quality warnings", () => {
  it("never escalates a quality rule to an error", () => {
    // Every quality-rule script below stays parseable: warnings are advisory.
    const firing = `
const a = await agent({ id: "a", prompt: "Work in {{workflow.cwd}}" })
`;
    expect(errorCount(firing)).toBe(0);
  });

  it("warns when {{workflow.cwd}} is used without meta.requiresCwd", () => {
    const codes = warningCodes(`
const a = await agent({ id: "a", prompt: "Work in {{workflow.cwd}}" })
`);
    expect(codes).toContain("workflow.cwd.requiresCwdMissing");
  });

  it("does not warn about {{workflow.cwd}} when meta.requiresCwd is set", () => {
    const codes = warningCodes(`
export const meta = { name: "x", description: "y", requiresCwd: true }
const a = await agent({ id: "a", prompt: "Work in {{workflow.cwd}}" })
`);
    expect(codes).not.toContain("workflow.cwd.requiresCwdMissing");
  });

  it("warns when an until.finalStatus token is absent from the source prompt", () => {
    const codes = warningCodes(`
loop({
  id: "l",
  maxIterations: 2,
  steps: [
    agent({ id: "w", prompt: "Do work" }),
    agent({ id: "r", prompt: "Review the work" }),
  ],
  until: { source: "r", finalStatus: "PASS" },
})
`);
    expect(codes).toContain("workflow.until.finalStatusTokenMissing");
  });

  it("accepts an until.finalStatus token stated only in appendPrompt", () => {
    const codes = warningCodes(`
loop({
  id: "l",
  maxIterations: 2,
  steps: [
    agent({ id: "w", prompt: "Do work" }),
    agent({ id: "r", prompt: "Review the work", appendPrompt: "End with PASS or FAIL." }),
  ],
  until: { source: "r", finalStatus: "PASS" },
})
`);
    expect(codes).not.toContain("workflow.until.finalStatusTokenMissing");
  });

  it("warns when an inherited loop step has no appendPrompt", () => {
    const codes = warningCodes(`
loop({
  id: "l",
  maxIterations: 2,
  steps: [
    agent({ id: "c", session: { mode: "inherit", key: "room" }, prompt: "Implement" }),
    agent({ id: "r", prompt: "Review. End with PASS." }),
  ],
  until: { source: "r", finalStatus: "PASS" },
})
`);
    expect(codes).toContain("workflow.session.inheritAppendPromptMissing");
  });

  it("does not warn about inherited steps with appendPrompt or independent steps", () => {
    const codes = warningCodes(`
loop({
  id: "l",
  maxIterations: 2,
  steps: [
    agent({ id: "c", session: { mode: "inherit", key: "room" }, prompt: "Implement", appendPrompt: "Round {{iteration}}" }),
    agent({ id: "r", session: { mode: "independent" }, prompt: "Review. End with PASS." }),
  ],
  until: { source: "r", finalStatus: "PASS" },
})
`);
    expect(codes).not.toContain("workflow.session.inheritAppendPromptMissing");
  });

  it("warns when an agent node binds an input it never references", () => {
    const codes = warningCodes(`
const src = await agent({ id: "src", prompt: "Produce" })
const use = await agent({ id: "use", inputs: { src }, prompt: "No reference here" })
`);
    expect(codes).toContain("workflow.input.unusedBinding");
  });

  it("exempts ordering-only bindings on loop nodes", () => {
    const codes = warningCodes(`
const first = await agent({ id: "first", prompt: "First step done" })
const l = await loop({
  id: "l",
  inputs: { first },
  maxIterations: 2,
  steps: [
    agent({ id: "w", prompt: "Work" }),
    agent({ id: "r", prompt: "Review. End with PASS." }),
  ],
  until: { source: "r", finalStatus: "PASS" },
})
`);
    expect(codes).not.toContain("workflow.input.unusedBinding");
  });

  it("warns when a dotted until.source reads a non-json agent step", () => {
    const codes = warningCodes(`
loop({
  id: "l",
  maxIterations: 2,
  steps: [
    agent({ id: "w", prompt: "Work" }),
    agent({ id: "r", prompt: "Review" }),
  ],
  until: { source: "r.verdict", equals: "pass" },
})
`);
    expect(codes).toContain("workflow.until.dottedSourceNotJson");
  });

  it("exempts dotted until.source that reads a human step", () => {
    const codes = warningCodes(`
loop({
  id: "l",
  maxIterations: 2,
  steps: [
    agent({ id: "w", prompt: "Work" }),
    human({ id: "rev", actions: [{ id: "pass", label: "Pass" }] }),
  ],
  until: { source: "rev.action", equals: "pass" },
})
`);
    expect(codes).not.toContain("workflow.until.dottedSourceNotJson");
  });

  it("warns when until.finalStatus matches a json step", () => {
    const codes = warningCodes(`
loop({
  id: "l",
  maxIterations: 2,
  steps: [
    agent({ id: "w", prompt: "Work" }),
    agent({ id: "r", output: "json", prompt: "Return a JSON verdict" }),
  ],
  until: { source: "r", finalStatus: "PASS" },
})
`);
    expect(codes).toContain("workflow.until.finalStatusOnJson");
  });

  it("does not warn about finalStatus on a plain-text step", () => {
    const codes = warningCodes(`
loop({
  id: "l",
  maxIterations: 2,
  steps: [
    agent({ id: "w", prompt: "Work" }),
    agent({ id: "r", prompt: "Review. End with PASS." }),
  ],
  until: { source: "r", finalStatus: "PASS" },
})
`);
    expect(codes).not.toContain("workflow.until.finalStatusOnJson");
  });

  it("warns when a json agent prompt never mentions JSON", () => {
    const codes = warningCodes(`
const a = await agent({ id: "a", output: "json", prompt: "Return the verdict" })
`);
    expect(codes).toContain("workflow.output.jsonContractMissing");
  });

  it("does not warn when a json agent prompt states the contract", () => {
    const codes = warningCodes(`
const a = await agent({ id: "a", output: "json", prompt: "Return a JSON object" })
`);
    expect(codes).not.toContain("workflow.output.jsonContractMissing");
  });

  it("warns when a map source agent lacks output json", () => {
    const codes = warningCodes(`
const discover = await agent({ id: "discover", prompt: "List items" })
const m = await map({
  id: "m",
  source: discover,
  maxItems: 5,
  step: agent({ id: "one", prompt: "Do {{item}}" }),
})
`);
    expect(codes).toContain("workflow.map.sourceNotJson");
  });

  it("does not warn when a map source agent emits json", () => {
    const codes = warningCodes(`
const discover = await agent({ id: "discover", output: "json", prompt: "List items as a JSON array" })
const m = await map({
  id: "m",
  source: discover,
  maxItems: 5,
  step: agent({ id: "one", prompt: "Do {{item}}" }),
})
`);
    expect(codes).not.toContain("workflow.map.sourceNotJson");
  });

  it("keeps every builtin blueprint free of quality warnings", () => {
    const blueprintsDir = path.join(__dirname, "blueprints");
    const files = fs
      .readdirSync(blueprintsDir)
      .filter((file) => file.endsWith(".workflow.js"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const script = fs.readFileSync(
        path.join(blueprintsDir, file),
        "utf8",
      );
      const warnings = parseWorkflowScript(script).diagnostics.filter(
        (diagnostic) => diagnostic.severity === "warning",
      );
      expect(
        warnings.map((warning) => `${file}: ${warning.code} ${warning.message}`),
      ).toEqual([]);
    }
  });
});
