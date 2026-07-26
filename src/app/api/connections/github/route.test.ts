import { beforeEach, describe, expect, it, vi } from "vitest";

const { listGitHubCliConnections } = vi.hoisted(() => ({
  listGitHubCliConnections: vi.fn(),
}));

vi.mock("@/lib/connections/github-cli", () => ({
  listGitHubCliConnections,
}));

import { GET } from "./route";

describe("GitHub connections route", () => {
  beforeEach(() => {
    listGitHubCliConnections.mockReset();
  });

  it("returns non-secret GitHub connection metadata", async () => {
    listGitHubCliConnections.mockResolvedValue({
      connections: [
        {
          id: "github-cli:github.com:octocat",
          provider: "github",
          source: "github_cli",
          host: "github.com",
          login: "octocat",
          active: true,
          available: true,
          tokenSource: "keyring",
          scopes: ["repo"],
        },
      ],
    });

    const response = await GET(
      new Request("http://localhost/api/connections/github"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connections: [
        expect.objectContaining({
          login: "octocat",
          tokenSource: "keyring",
        }),
      ],
    });
  });
});
