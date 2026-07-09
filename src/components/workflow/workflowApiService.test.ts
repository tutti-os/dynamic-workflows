import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiJson,
  ApiJsonError,
  instantiateWorkflowBlueprint,
  listWorkflowBlueprints,
  loadWorkflowBlueprint,
  searchWorkflowBlueprints,
} from "./workflowApiService";

const originalFetch = globalThis.fetch;

describe("apiJson", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns parsed JSON for successful responses", async () => {
    mockFetch(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
      }),
    );

    await expect(apiJson<{ ok: boolean }>("/ok")).resolves.toEqual({ ok: true });
  });

  it("throws ApiJsonError for standard ApiErrorResponse payloads", async () => {
    mockFetch(
      new Response(
        JSON.stringify({
          error: {
            code: "WORKFLOW_NOT_FOUND",
            message: "Workflow not found.",
          },
        }),
        { status: 404 },
      ),
    );

    await expect(apiJson("/missing", undefined, "UNKNOWN_ERROR")).rejects.toEqual(
      expect.objectContaining({
        name: "ApiJsonError",
        status: 404,
        apiError: {
          code: "WORKFLOW_NOT_FOUND",
          message: "Workflow not found.",
        },
      }),
    );
  });

  it("loads workflow blueprint summaries from the blueprint API", async () => {
    const fetchMock = mockFetch(
      new Response(
        JSON.stringify({
          blueprints: [
            {
              id: "loop-primitive-rd-acceptance-test-v1",
              title: "RD Acceptance Delivery",
              description: "Run a bounded RD acceptance loop.",
              category: "coding",
              tags: ["loop", "rd"],
              difficulty: "advanced",
              requiresCwd: true,
              patternSummary: "Bounded implementation and review loop.",
              useCases: ["Implement with acceptance review."],
            },
          ],
        }),
      ),
    );

    await expect(listWorkflowBlueprints()).resolves.toEqual([
      expect.objectContaining({
        id: "loop-primitive-rd-acceptance-test-v1",
        requiresCwd: true,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/workflow-blueprints", undefined);
  });

  it("searches workflow blueprints with a JSON body", async () => {
    const fetchMock = mockFetch(
      new Response(
        JSON.stringify({
          blueprints: [
            {
              id: "loop-primitive-rd-acceptance-test-v1",
              title: "RD Acceptance Delivery",
              description: "Run a bounded RD acceptance loop.",
              category: "coding",
              tags: ["loop", "rd"],
              difficulty: "advanced",
              requiresCwd: true,
              patternSummary: "Bounded implementation and review loop.",
              useCases: ["Implement with acceptance review."],
              score: 12,
            },
          ],
        }),
      ),
    );

    await expect(
      searchWorkflowBlueprints({ query: "loop", limit: 12 }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "loop-primitive-rd-acceptance-test-v1",
        score: 12,
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledWith("/api/workflow-blueprints/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "loop", limit: 12 }),
    });
  });

  it("loads and instantiates workflow blueprint details", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            blueprint: {
              id: "loop-primitive-rd-acceptance-test-v1",
              title: "RD Acceptance Delivery",
              description: "Run a bounded RD acceptance loop.",
              category: "coding",
              tags: ["loop", "rd"],
              difficulty: "advanced",
              requiresCwd: true,
              patternSummary: "Bounded implementation and review loop.",
              useCases: ["Implement with acceptance review."],
              script: "export const meta = {}",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            workflow: { id: "workflow_1" },
            currentVersion: null,
            versions: [],
            runs: [],
            generation: null,
          }),
          { status: 201 },
        ),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      loadWorkflowBlueprint("loop-primitive-rd-acceptance-test-v1"),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "loop-primitive-rd-acceptance-test-v1",
        script: "export const meta = {}",
      }),
    );
    await expect(
      instantiateWorkflowBlueprint("loop-primitive-rd-acceptance-test-v1"),
    ).resolves.toEqual(
      expect.objectContaining({
        workflow: { id: "workflow_1" },
      }),
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/workflow-blueprints/loop-primitive-rd-acceptance-test-v1",
      undefined,
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/workflow-blueprints/loop-primitive-rd-acceptance-test-v1/instantiate",
      { method: "POST" },
    );
  });
});

function mockFetch(response: Response) {
  const fetchMock = vi.fn(async () => response) as unknown as typeof fetch;
  globalThis.fetch = fetchMock;
  return fetchMock;
}
