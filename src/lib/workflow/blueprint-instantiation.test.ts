import { mkdtempSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
    const { getCurrentFlowV1Params, getFlowV1RuntimeSummary } = await import(
      "@/lib/db/workflows/flow-settings"
    );
    const { getFlowV1RuntimeConfig } = await import(
      "@/lib/flow-v1/runtime-config"
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

    const governance = created.find(
      ({ blueprint }) => blueprint.id === "large-file-governance-v1",
    );
    expect(governance).toBeDefined();
    const governanceFlowId = governance!.detail.workflow.id;
    const governanceParams = getCurrentFlowV1Params(governanceFlowId)?.values;
    expect(governanceParams).toMatchObject({
      scanCron: "*/30 * * * *",
      timezone: "Asia/Singapore",
      lineThreshold: 800,
      mainBranch: "main",
      scanRoot: "",
      approvalLabel: "flow-approved",
    });
    expect(governanceParams).not.toHaveProperty("maxAcceptanceRounds");
    expect(governanceParams).not.toHaveProperty("qaAgent");
    expect(governanceParams).not.toHaveProperty("qaModel");
    expect(governanceParams).not.toHaveProperty("qaPermission");
    const runtimeConfig = getFlowV1RuntimeConfig(governanceFlowId);
    expect(runtimeConfig.defaultAgent).toBe("local:codex");
    const configuredProject = path.join(homedir(), "tsh-project", "tutti");
    expect(runtimeConfig.projectCwd).toBe(
      fsExistsAsDirectory(configuredProject) ? configuredProject : null,
    );
  });
});

function fsExistsAsDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}
