import { beforeEach, describe, expect, it, vi } from "vitest";

const { listAgentTargetCatalog } = vi.hoisted(() => ({
  listAgentTargetCatalog: vi.fn(),
}));

vi.mock("@/lib/agents/runtime", () => ({
  listAgentTargetCatalog,
}));

import { GET } from "./route";

describe("agent targets route", () => {
  beforeEach(() => {
    listAgentTargetCatalog.mockReset();
  });

  it("exposes degraded catalog freshness on a successful response", async () => {
    listAgentTargetCatalog.mockResolvedValue({
      targets: [
        {
          id: "local:codex",
          name: "Codex",
          provider: "codex",
          supported: true,
          models: ["gpt-5"],
        },
      ],
      freshness: "stale",
      loadedAt: 123,
      warning: "Using cached agents.",
    });

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      freshness: "stale",
      loadedAt: 123,
      warning: "Using cached agents.",
    });
  });

  it("returns a standard retryable 503 without success targets", async () => {
    listAgentTargetCatalog.mockRejectedValue(new Error("internal CLI detail"));

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "AGENT_TARGET_DETECTION_FAILED",
        message: "Agent target detection failed.",
        details: { retryable: true },
      },
    });
    expect(body).not.toHaveProperty("targets");
  });
});
