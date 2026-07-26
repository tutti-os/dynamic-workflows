import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "flow-blueprints-test-"));
  process.env.DYNAMIC_WORKFLOWS_DATA_DIR = dataDir;
  vi.resetModules();
});

afterEach(() => {
  vi.resetModules();
  delete process.env.DYNAMIC_WORKFLOWS_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("Flow v1 Blueprint instantiation", () => {
  it("persists every preserved goal as an independent draft Flow", async () => {
    const { listWorkflowBlueprints } = await import("./blueprint-catalog");
    const { instantiateWorkflowBlueprint } = await import(
      "./blueprint-instantiate"
    );
    const { getFlowV1RuntimeSummary } = await import(
      "@/lib/db/workflows/flow-settings"
    );

    const blueprints = listWorkflowBlueprints();
    const created = blueprints.map((blueprint) => ({
      blueprint,
      detail: instantiateWorkflowBlueprint(blueprint.id),
    }));

    expect(created).toHaveLength(10);
    expect(new Set(created.map(({ detail }) => detail.workflow.id)).size).toBe(
      10,
    );
    for (const { blueprint, detail } of created) {
      expect(detail.workflow.name).toBe(blueprint.title);
      expect(detail.currentVersion).toMatchObject({
        workflowId: detail.workflow.id,
        version: 1,
      });
      expect(getFlowV1RuntimeSummary(detail.workflow.id)).toMatchObject({
        lifecycle: "draft",
        cycleCount: 0,
      });
    }
  });
});
