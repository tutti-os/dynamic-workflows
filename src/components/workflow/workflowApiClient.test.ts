import { afterEach, describe, expect, it, vi } from "vitest";
import { apiJson, ApiJsonError } from "./workflowApiClient";

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

  it("normalizes legacy string error payloads", async () => {
    mockFetch(
      new Response(JSON.stringify({ error: "legacy failure" }), {
        status: 500,
      }),
    );

    const error = await apiJson("/legacy", undefined, "WORKFLOW_RUN_FAILED").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiJsonError);
    expect((error as ApiJsonError).apiError).toEqual({
      code: "WORKFLOW_RUN_FAILED",
      message: "legacy failure",
    });
  });
});

function mockFetch(response: Response): void {
  globalThis.fetch = vi.fn(async () => response) as typeof fetch;
}
