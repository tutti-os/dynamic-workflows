import { describe, expect, it } from "vitest";
import {
  assertWorkflowScriptValid,
  parseWorkflowScript,
  WorkflowScriptSyntaxError,
} from "./parser";

const VALID_SCRIPT = `export const meta = {
  name: "repo_review",
  description: "Review a repo",
}

phase("Scan")

const inventory = await agent({
  id: "inventory",
  label: "Inventory",
  prompt: \`Inspect {{repo}}\`,
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
const first = await agent({ id: "first", session: "writer", prompt: "one" })
const second = await agent({ id: "second", session: "writer", prompt: "two" })
`);

    expect(parsed.nodes.map((node) => [node.id, node.session])).toEqual([
      ["first", "writer"],
      ["second", "writer"],
    ]);
  });

  it("parses bounded loop nodes and excludes loop step refs from external inputs", () => {
    const parsed = parseWorkflowScript(`
const delivery = await loop({
  id: "delivery_loop",
  label: "Delivery Loop",
  maxIterations: 3,
  steps: [
    agent({
      id: "rd",
      label: "RD",
      session: "rd_room",
      prompt: \`Task: {{task}}
Previous acceptance: {{acceptance}}\`,
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
      variableName: "delivery",
      templateRefs: ["task"],
      loop: {
        maxIterations: 3,
        until: { source: "acceptance", includes: "PASS:" },
      },
    });
    expect(parsed.nodes[0].loop?.steps.map((step) => [step.id, step.session])).toEqual([
      ["rd", "rd_room"],
      ["acceptance", undefined],
    ]);
    expect(parsed.externalInputs).toEqual(["task"]);
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
});
