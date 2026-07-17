import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  workflowMapNodeInvalidError,
  workflowMapRetryInvalidError,
  workflowRunNotFoundError,
} from "@/lib/api/app-error";

const mocks = vi.hoisted(() => ({
  prepareRetryWorkflowRun: vi.fn(),
  startWorkflowRunJob: vi.fn(),
  retryFailedMapItems: vi.fn(),
}));

vi.mock("@/lib/workflow/run-request", () => ({
  prepareRetryWorkflowRun: mocks.prepareRetryWorkflowRun,
}));
vi.mock("@/lib/workflow/run-jobs", () => ({
  startWorkflowRunJob: mocks.startWorkflowRunJob,
  retryFailedMapItems: mocks.retryFailedMapItems,
}));

import { POST } from "./route";

function retryRequest(body?: unknown): Request {
  return new Request("http://localhost/retry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const params = Promise.resolve({ id: "workflow-1", runId: "run-1" });

describe("workflow run retry route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a fresh retry run when no mapNodeId is provided", async () => {
    mocks.prepareRetryWorkflowRun.mockReturnValue({ options: true });
    mocks.startWorkflowRunJob.mockReturnValue({ id: "run-2" });

    const response = await POST(retryRequest(), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: { id: "run-2" } });
    expect(mocks.prepareRetryWorkflowRun).toHaveBeenCalledWith({
      workflowId: "workflow-1",
      runId: "run-1",
    });
    expect(mocks.retryFailedMapItems).not.toHaveBeenCalled();
  });

  it("retries failed map items when a mapNodeId is provided", async () => {
    mocks.retryFailedMapItems.mockResolvedValue({ id: "run-1" });

    const response = await POST(retryRequest({ mapNodeId: "migrated" }), {
      params,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ run: { id: "run-1" } });
    expect(mocks.retryFailedMapItems).toHaveBeenCalledWith({
      workflowId: "workflow-1",
      runId: "run-1",
      mapNodeId: "migrated",
    });
    expect(mocks.startWorkflowRunJob).not.toHaveBeenCalled();
  });

  it("maps an unknown run to 404", async () => {
    mocks.retryFailedMapItems.mockRejectedValue(workflowRunNotFoundError());

    const response = await POST(retryRequest({ mapNodeId: "migrated" }), {
      params,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RUN_NOT_FOUND" },
    });
  });

  it("maps a non-terminal / no-failure run to 409", async () => {
    mocks.retryFailedMapItems.mockRejectedValue(
      workflowMapRetryInvalidError("Only a terminal workflow run can retry."),
    );

    const response = await POST(retryRequest({ mapNodeId: "migrated" }), {
      params,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "WORKFLOW_MAP_RETRY_INVALID" },
    });
  });

  it("maps an unknown / non-map node to 400", async () => {
    mocks.retryFailedMapItems.mockRejectedValue(
      workflowMapNodeInvalidError('"discover" is not a map node.'),
    );

    const response = await POST(retryRequest({ mapNodeId: "discover" }), {
      params,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "WORKFLOW_MAP_NODE_INVALID" },
    });
  });
});
