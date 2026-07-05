import { afterEach, describe, expect, it, vi } from "vitest";
import { apiJson, ApiJsonError } from "./workflowApiService";

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

});

function mockFetch(response: Response): void {
  globalThis.fetch = vi.fn(async () => response) as typeof fetch;
}
