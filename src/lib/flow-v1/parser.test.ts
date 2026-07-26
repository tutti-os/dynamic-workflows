import { describe, expect, it } from "vitest";
import { createFlowV1Bundle } from "./bundle";
import { parseFlowV1Bundle } from "./parser";

const VALID_FLOW = `
export const schemaVersion = "tutti.flow.v1";
export const meta = {
  name: "large-file-governance",
  description: "Govern large files",
  requiresCwd: true,
};
export const params = defineParams({
  targetDirectory: stringParam({ required: true }),
  scanCron: cronParam({ default: "0 9 * * *" }),
  timezone: stringParam({ default: "Asia/Singapore" }),
});
export const inputs = defineInputs({
  targetDirectory: stringInput({ required: true }),
});
export const secrets = defineSecrets({
  githubConnection: connectionSecret({ provider: "github", required: true }),
});
export const cycles = defineCycles({ mode: "singleton" });
export const schedule = cron({
  id: "daily",
  expression: ref("params.scanCron"),
  timezone: ref("params.timezone"),
  catchUp: "latest",
  overlap: "coalesce-latest",
  inputs: { targetDirectory: ref("params.targetDirectory") },
});
export const memory = defineMemory({
  sections: {
    currentUnderstanding: {
      title: "Current Understanding",
      update: "replace",
    },
    timeline: {
      title: "Timeline",
      update: "append",
    },
  },
});

const candidate = script({
  id: "candidate",
  file: "scripts/scan.mjs",
  inputs: { directory: ref("inputs.targetDirectory") },
  retry: {
    maxAttempts: 3,
    errorCodes: ["flow_runner_timeout", "flow_runner_exit_nonzero"],
    backoffMs: 250,
  },
});
const plan = agent({
  id: "plan",
  agent: "codex",
  model: "gpt-5",
  permissionMode: "workspace-write",
  cwd: "packages/app",
  inputs: { candidate },
  memory: { include: ["currentUnderstanding"] },
  prompt: "Plan {{candidate.path}} without exposing any secret.",
  output: "json",
});
const issue = effect({
  id: "issue",
  file: "scripts/create-issue.mjs",
  inputs: { plan: ref("plan") },
  idempotencyKey: template("{{cycle.id}}:issue"),
});
const approval = gate({
  id: "approval",
  file: "scripts/approval.mjs",
  inputs: { issue },
  outcomes: ["approved", "rejected"],
});
const implement = agent({
  id: "implement",
  inputs: { approval, plan },
  prompt: "Implement the approved plan {{plan}}.",
});
const done = completeCycle({
  id: "done",
  inputs: { implement },
});
const rejected = cancelCycle({
  id: "rejected",
  inputs: { approval },
});
route(approval, {
  approved: implement,
  rejected,
});
`;

describe("flow v1 parser", () => {
  it("parses Bundle declarations, data edges, and control routes", () => {
    const parsed = parseFlowV1Bundle(validBundle());

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.meta.name).toBe("large-file-governance");
    expect(parsed.schedule?.id).toBe("daily");
    expect(parsed.memory?.sections.timeline.update).toBe("append");
    expect(parsed.nodes.map((node) => [node.id, node.kind])).toEqual([
      ["candidate", "script"],
      ["plan", "agent"],
      ["issue", "effect"],
      ["approval", "gate"],
      ["implement", "agent"],
      ["done", "complete_cycle"],
      ["rejected", "cancel_cycle"],
    ]);
    expect(parsed.nodes.find((node) => node.id === "plan")).toEqual(
      expect.objectContaining({
        agent: "codex",
        model: "gpt-5",
        permissionMode: "workspace-write",
        cwd: "packages/app",
      }),
    );
    expect(parsed.nodes.find((node) => node.id === "candidate")?.retry).toEqual(
      {
        maxAttempts: 3,
        errorCodes: [
          "flow_runner_timeout",
          "flow_runner_exit_nonzero",
        ],
        backoffMs: 250,
      },
    );
    expect(parsed.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "data",
          sourceNodeId: "candidate",
          targetNodeId: "plan",
        }),
        expect.objectContaining({
          kind: "control",
          sourceNodeId: "approval",
          outcome: "approved",
          targetNodeId: "implement",
        }),
      ]),
    );
  });

  it("requires Agent nodes to declare a prompt", () => {
    const parsed = parseFlowV1Bundle(
      createFlowV1Bundle([
        {
          path: "flow.js",
          content: `
            export const schemaVersion = "tutti.flow.v1";
            const plan = agent({ id: "plan" });
            const done = completeCycle({ id: "done", inputs: { plan } });
          `,
        },
      ]),
    );
    expect(parsed.diagnostics.map((entry) => entry.code)).toContain(
      "flow.agent_prompt_required",
    );
  });

  it("parses Transform, typed output retry, and isolated review contracts", () => {
    const parsed = parseFlowV1Bundle(
      createFlowV1Bundle([
        {
          path: "flow.js",
          content: `
            export const schemaVersion = "tutti.flow.v1";
            const workspace = effect({
              id: "workspace",
              file: "scripts/workspace.mjs",
              idempotencyKey: template("{{cycle.id}}:workspace"),
            });
            const project = transform({
              id: "project",
              file: "scripts/project.mjs",
              inputs: { workspace },
            });
            const acceptance = loop({
              id: "acceptance",
              inputs: { workspace, project },
              workspace,
              execution: { access: "write", isolation: "required" },
              maxIterations: 2,
              onMaxIterations: "complete",
              steps: [
                agent({
                  id: "review",
                  prompt: "Review repository truth.",
                  execution: { access: "review", isolation: "required" },
                  output: json({
                    validationMaxAttempts: 3,
                    schema: {
                      type: "object",
                      required: ["status"],
                      properties: {
                        status: { enum: ["PASS", "FAIL"] },
                      },
                    },
                  }),
                }),
              ],
              until: { source: "review", finalStatus: "PASS" },
            });
            const done = completeCycle({
              id: "done",
              outcome: "accepted",
              inputs: { acceptance },
            });
          `,
        },
        {
          path: "scripts/workspace.mjs",
          content:
            "export async function apply() { return {}; }\nexport async function reconcile() { return { status: 'not_applied' }; }",
        },
        {
          path: "scripts/project.mjs",
          content: "export async function run(ctx) { return ctx; }",
        },
      ]),
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.nodes.find((node) => node.id === "project")?.kind).toBe(
      "transform",
    );
    const acceptance = parsed.nodes.find(
      (node) => node.id === "acceptance",
    );
    expect(acceptance?.execution).toEqual({
      access: "write",
      isolation: "required",
    });
    expect(acceptance?.loop?.steps[0]).toEqual(
      expect.objectContaining({
        execution: { access: "review", isolation: "required" },
        output: expect.objectContaining({
          kind: "json",
          validationMaxAttempts: 3,
        }),
      }),
    );
  });

  it("rejects unbounded structured output validation attempts", () => {
    const parsed = parseFlowV1Bundle(
      createFlowV1Bundle([
        {
          path: "flow.js",
          content: `
            export const schemaVersion = "tutti.flow.v1";
            const review = agent({
              id: "review",
              prompt: "Review.",
              output: json({ validationMaxAttempts: 99 }),
            });
            const done = completeCycle({ id: "done", inputs: { review } });
          `,
        },
      ]),
    );
    expect(parsed.diagnostics.map((entry) => entry.code)).toContain(
      "flow.agent_output_validation_attempts_invalid",
    );
  });

  it("parses Human task actions as control outcomes", () => {
    const parsed = parseFlowV1Bundle(
      createFlowV1Bundle([
        {
          path: "flow.js",
          content: `
            export const schemaVersion = "tutti.flow.v1";
            export const inputs = defineInputs({
              plan: stringInput({ required: true }),
            });
            const review = human({
              id: "review",
              description: "Approve the plan",
              context: [
                { label: "Plan", value: "{{inputs.plan}}", display: "markdown" },
              ],
              actions: [
                {
                  id: "approve",
                  label: "Approve",
                  intent: "primary",
                  fields: [],
                },
                {
                  id: "reject",
                  label: "Reject",
                  intent: "danger",
                  fields: [
                    {
                      id: "reason",
                      type: "textarea",
                      label: "Reason",
                      required: true,
                    },
                  ],
                },
              ],
            });
            const done = completeCycle({ id: "done", inputs: { review } });
            const canceled = cancelCycle({ id: "canceled", inputs: { review } });
            route(review, { approve: done, reject: canceled });
          `,
        },
      ]),
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.nodes[0]).toEqual(
      expect.objectContaining({
        kind: "human",
        outcomes: ["approve", "reject"],
        human: expect.objectContaining({
          description: "Approve the plan",
        }),
      }),
    );
  });

  it("parses and validates graph-visible Remember updates", () => {
    const parsed = parseFlowV1Bundle(
      createFlowV1Bundle([
        {
          path: "flow.js",
          content: `
            export const schemaVersion = "tutti.flow.v1";
            export const memory = defineMemory({
              sections: {
                current: { title: "Current", update: "replace" },
              },
            });
            const summary = agent({ id: "summary", prompt: "Summarize." });
            const record = remember({
              id: "record",
              updates: {
                current: {
                  mode: "replace",
                  value: ref("summary.current"),
                },
              },
            });
            const done = completeCycle({ id: "done", inputs: { record } });
          `,
        },
        {
          path: "memory.template.md",
          content: [
            "<!-- flow-memory:section:current:start -->",
            "Initial",
            "<!-- flow-memory:section:current:end -->",
          ].join("\\n"),
        },
      ]),
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.nodes.find((node) => node.id === "record")).toEqual(
      expect.objectContaining({
        memoryUpdates: {
          current: {
            mode: "replace",
            value: {
              expression: "summary.current",
              source: "summary",
              path: ["current"],
            },
          },
        },
      }),
    );
  });

  it("rejects missing schedule inputs, keyed memory, secret prompts, and incomplete effects", () => {
    const bundle = createFlowV1Bundle([
      {
        path: "flow.js",
        content: `
          export const schemaVersion = "tutti.flow.v1";
          export const inputs = defineInputs({
            requirement: stringInput({ required: true }),
          });
          export const cycles = defineCycles({
            mode: "keyed",
            key: ref("inputs.requirement"),
          });
          export const schedule = cron({
            expression: "0 9 * * *",
            timezone: "UTC",
            inputs: {},
          });
          export const memory = defineMemory({
            sections: {
              context: { title: "Context", update: "replace" },
            },
          });
          export const secrets = defineSecrets({
            token: secret({ required: true }),
          });
          const write = effect({
            id: "write",
            file: "scripts/write.mjs",
          });
          const agentNode = agent({
            id: "agent",
            prompt: "Token {{secrets.token}}",
            inputs: { write },
          });
          const done = completeCycle({ id: "done", inputs: { agentNode } });
        `,
      },
      {
        path: "memory.template.md",
        content: "# Memory",
      },
      {
        path: "scripts/write.mjs",
        content: "export async function apply() {}",
      },
    ]);

    const parsed = parseFlowV1Bundle(bundle);
    expect(parsed.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "flow.memory.concurrent_cycles_not_supported",
        "flow.schedule_required_input_unbound",
        "flow.secret_prompt_forbidden",
        "flow.effect_idempotency_required",
        "flow.code_export_missing",
      ]),
    );
  });

  it("rejects external imports and missing relative imports", () => {
    const bundle = createFlowV1Bundle([
      {
        path: "flow.js",
        content: `
          export const schemaVersion = "tutti.flow.v1";
          const scan = script({
            id: "scan",
            file: "scripts/scan.mjs",
          });
          const done = completeCycle({ id: "done", inputs: { scan } });
        `,
      },
      {
        path: "scripts/scan.mjs",
        content: `
          import { Octokit } from "@octokit/rest";
          import { helper } from "./missing.mjs";
          export async function run() { return helper(Octokit); }
        `,
      },
    ]);

    const parsed = parseFlowV1Bundle(bundle);
    expect(parsed.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "bundle.script_external_dependency_forbidden",
        "bundle.script_import_missing",
      ]),
    );
  });

  it("requires one ordered marker pair for every declared Memory section", () => {
    const bundle = createFlowV1Bundle([
      {
        path: "flow.js",
        content: `
          export const schemaVersion = "tutti.flow.v1";
          export const memory = defineMemory({
            sections: {
              context: { title: "Context", update: "replace" },
            },
          });
          const done = completeCycle({ id: "done" });
        `,
      },
      {
        path: "memory.template.md",
        content: [
          "<!-- flow-memory:section:context:end -->",
          "<!-- flow-memory:section:context:start -->",
          "<!-- flow-memory:section:extra:start -->",
          "<!-- flow-memory:section:extra:end -->",
        ].join("\n"),
      },
    ]);

    const parsed = parseFlowV1Bundle(bundle);
    expect(parsed.diagnostics.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "flow.memory_template_section_unknown",
        "flow.memory_template_marker_order_invalid",
      ]),
    );
  });

  it("never executes flow or script modules while validating", () => {
    delete (globalThis as Record<string, unknown>).__flowV1Executed;
    const bundle = createFlowV1Bundle([
      {
        path: "flow.js",
        content: `
          globalThis.__flowV1Executed = true;
          export const schemaVersion = "tutti.flow.v1";
          const scan = script({
            id: "scan",
            file: "scripts/scan.mjs",
          });
          const done = completeCycle({ id: "done", inputs: { scan } });
        `,
      },
      {
        path: "scripts/scan.mjs",
        content: `
          globalThis.__flowV1Executed = true;
          export async function run() { return {}; }
        `,
      },
    ]);

    parseFlowV1Bundle(bundle);
    expect(
      (globalThis as Record<string, unknown>).__flowV1Executed,
    ).toBeUndefined();
  });
});

function validBundle() {
  return createFlowV1Bundle([
    { path: "flow.js", content: VALID_FLOW },
    {
      path: "memory.template.md",
      content: [
        "# Flow Memory",
        "<!-- flow-memory:section:currentUnderstanding:start -->",
        "## Current Understanding",
        "<!-- flow-memory:section:currentUnderstanding:end -->",
        "<!-- flow-memory:section:timeline:start -->",
        "## Timeline",
        "<!-- flow-memory:section:timeline:end -->",
      ].join("\n"),
    },
    {
      path: "scripts/scan.mjs",
      content: "export async function run() { return {}; }",
    },
    {
      path: "scripts/create-issue.mjs",
      content:
        "export async function apply() { return {}; }\nexport async function reconcile() { return { status: 'not_applied' }; }",
    },
    {
      path: "scripts/approval.mjs",
      content:
        "export async function check() { return { status: 'waiting', reason: 'pending' }; }",
    },
  ]);
}
