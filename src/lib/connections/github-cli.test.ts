import { describe, expect, it } from "vitest";
import {
  githubCliConnectionId,
  listGitHubCliConnections,
  parseGitHubAuthStatus,
  resolveGitHubCliToken,
} from "./github-cli";

describe("GitHub CLI connections", () => {
  it("parses account metadata without requesting or returning tokens", () => {
    expect(
      parseGitHubAuthStatus(
        JSON.stringify({
          hosts: {
            "github.com": [
              {
                state: "success",
                active: true,
                host: "github.com",
                login: "octocat",
                tokenSource: "keyring",
                scopes: "repo, workflow",
              },
            ],
          },
        }),
      ),
    ).toEqual([
      {
        id: githubCliConnectionId("github.com", "octocat"),
        provider: "github",
        source: "github_cli",
        host: "github.com",
        login: "octocat",
        active: true,
        available: true,
        tokenSource: "keyring",
        scopes: ["repo", "workflow"],
      },
    ]);
  });

  it("returns actionable catalog guidance when GitHub CLI is unavailable", async () => {
    await expect(
      listGitHubCliConnections(async () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("ENOENT"),
      })),
    ).resolves.toEqual({
      connections: [],
      warning:
        "GitHub connections could not be loaded. Install GitHub CLI and run `gh auth login`, then retry.",
    });
  });

  it("resolves the selected account token without including it in metadata", async () => {
    const calls: string[][] = [];
    const token = await resolveGitHubCliToken(
      { host: "github.com", login: "octocat" },
      async (args) => {
        calls.push(args);
        return {
          status: 0,
          stdout: "secret-token\n",
          stderr: "",
        };
      },
    );

    expect(token).toBe("secret-token");
    expect(calls).toEqual([
      [
        "auth",
        "token",
        "--hostname",
        "github.com",
        "--user",
        "octocat",
      ],
    ]);
  });
});
