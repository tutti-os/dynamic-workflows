import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFlowV1Bundle } from "./bundle";

const runAgentMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agents/runtime", () => ({
  runAgent: runAgentMock,
}));

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-memory-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
  runAgentMock.mockReset();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 canonical Markdown Memory", () => {
  it("applies replace/append updates idempotently and preserves manual edits on conflict", async () => {
    const service = await import("./flow-service");
    const memory = await import("./memory");
    const runtime = await import("@/lib/db/workflows/flow-runtime");
    const { getDb } = await import("@/lib/db/client");
    const created = service.createFlowV1({
      bundle: memoryUpdateBundle(),
      activate: true,
    });

    const first = await service.invokeFlowV1({
      flowId: created.flowId,
      invocationInput: {
        understanding: "The first understanding.",
        timeline: "Cycle one completed.",
      },
      idempotencyKey: "memory-cycle-1",
    });
    expect(first.execution?.stopReason).toBe("cycle_completed");
    const document = memory.readFlowV1Memory(created.flowId, MEMORY_DEFINITION);
    expect(document.sections).toEqual({
      currentUnderstanding: "The first understanding.",
      timeline: "Initial timeline.\n\nCycle one completed.",
    });

    const second = await service.invokeFlowV1({
      flowId: created.flowId,
      invocationInput: {
        understanding: "The second understanding.",
        timeline: "Cycle two completed.",
      },
      idempotencyKey: "memory-cycle-2",
      executeTick: false,
    });
    const manuallyEdited = document.markdown.replace(
      "The first understanding.",
      "A user edited this while the Cycle was running.",
    );
    fs.writeFileSync(
      memory.getFlowV1MemoryPath(created.flowId),
      manuallyEdited,
      "utf8",
    );

    const { runFlowV1Tick } = await import("./tick-supervisor");
    const conflict = await runFlowV1Tick({ runId: second.tick.run.id });
    expect(conflict.stopReason).toBe("paused_conflict");
    expect(runtime.getFlowV1Cycle(second.tick.cycle.id)?.status).toBe(
      "paused_conflict",
    );
    expect(
      fs.readFileSync(memory.getFlowV1MemoryPath(created.flowId), "utf8"),
    ).toBe(manuallyEdited);
    expect(
      getDb()
        .prepare(
          `
          SELECT status, candidate_markdown
          FROM workflow_memory_updates
          WHERE cycle_id = ?
          ORDER BY section_id
        `,
        )
        .all(second.tick.cycle.id),
    ).toEqual([
      {
        status: "conflict",
        candidate_markdown: expect.stringContaining(
          "The second understanding.",
        ),
      },
      {
        status: "conflict",
        candidate_markdown: expect.stringContaining(
          "Cycle two completed.",
        ),
      },
    ]);
  });

  it("injects only explicitly selected Memory sections into an Agent prompt", async () => {
    runAgentMock.mockImplementation(async function* () {
      yield { type: "text_delta", text: "done" };
      yield { type: "done", status: "completed" };
    });
    const service = await import("./flow-service");
    const created = service.createFlowV1({
      bundle: memoryAgentBundle(),
      activate: true,
    });

    const result = await service.invokeFlowV1({
      flowId: created.flowId,
      idempotencyKey: "memory-agent",
    });

    expect(result.execution?.stopReason).toBe("cycle_completed");
    const prompt = runAgentMock.mock.calls[0]?.[0]?.prompt as string;
    expect(prompt).toContain("<flow-memory sha256=");
    expect(prompt).toContain("## Current Understanding");
    expect(prompt).toContain("Initial understanding.");
    expect(prompt).not.toContain("## Timeline");
    expect(prompt).not.toContain("Initial timeline.");
  });
});

const MEMORY_DEFINITION = {
  sections: {
    currentUnderstanding: {
      id: "currentUnderstanding",
      title: "Current Understanding",
      update: "replace" as const,
    },
    timeline: {
      id: "timeline",
      title: "Timeline",
      update: "append" as const,
    },
  },
};

function memoryUpdateBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = { name: "memory-update", description: "Memory" };
        export const inputs = defineInputs({
          understanding: stringInput({ required: true }),
          timeline: stringInput({ required: true }),
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
        const summary = script({
          id: "summary",
          file: "scripts/summary.mjs",
          inputs: {
            understanding: ref("inputs.understanding"),
            timeline: ref("inputs.timeline"),
          },
        });
        const record = remember({
          id: "record",
          updates: {
            currentUnderstanding: {
              mode: "replace",
              value: ref("summary.currentUnderstanding"),
            },
            timeline: {
              mode: "append",
              value: ref("summary.timeline"),
            },
          },
        });
        const done = completeCycle({ id: "done", inputs: { record } });
      `,
    },
    {
      path: "memory.template.md",
      content: memoryTemplate(),
    },
    {
      path: "scripts/summary.mjs",
      content: `
        export async function run(ctx) {
          return {
            currentUnderstanding: ctx.understanding,
            timeline: ctx.timeline,
          };
        }
      `,
    },
  ]);
}

function memoryAgentBundle() {
  return createFlowV1Bundle([
    {
      path: "flow.js",
      content: `
        export const schemaVersion = "tutti.flow.v1";
        export const meta = { name: "memory-agent", description: "Memory" };
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
        const plan = agent({
          id: "plan",
          memory: { include: ["currentUnderstanding"] },
          prompt: "Create a plan.",
        });
        const done = completeCycle({ id: "done", inputs: { plan } });
      `,
    },
    {
      path: "memory.template.md",
      content: memoryTemplate(),
    },
  ]);
}

function memoryTemplate() {
  return [
    "# Flow Memory",
    "<!-- flow-memory:section:currentUnderstanding:start -->",
    "Initial understanding.",
    "<!-- flow-memory:section:currentUnderstanding:end -->",
    "<!-- flow-memory:section:timeline:start -->",
    "Initial timeline.",
    "<!-- flow-memory:section:timeline:end -->",
  ].join("\n");
}
