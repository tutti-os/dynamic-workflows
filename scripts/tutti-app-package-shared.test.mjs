import { describe, expect, it } from "vitest";
import { DYNAMIC_WORKFLOWS_CLI_COMMAND_PATHS } from "../src/lib/tutti/cli.ts";
import { cliManifest, commandsMarkdown } from "./tutti-app-package-shared.mjs";

describe("Tutti app CLI package contract", () => {
  it("publishes every command implemented by the HTTP dispatcher", () => {
    const manifestPaths = cliManifest().commands.map((command) =>
      command.path.join("/"),
    );

    expect(manifestPaths).toEqual([...DYNAMIC_WORKFLOWS_CLI_COMMAND_PATHS]);
  });

  it("documents every public manifest command", () => {
    const markdown = commandsMarkdown();
    for (const command of cliManifest().commands) {
      expect(markdown).toContain(command.path.join(" "));
    }
  });

  it("declares runs wait as a durable wait without an app-owned timeout", () => {
    const command = cliManifest().commands.find(
      (candidate) => candidate.path.join("/") === "runs/wait",
    );

    expect(command).toMatchObject({
      execution: { mode: "wait" },
      output: { defaultMode: "json", json: true },
    });
    expect(command.inputSchema.properties).not.toHaveProperty("timeout-ms");

    const markdown = commandsMarkdown();
    expect(markdown).not.toContain("--timeout-ms 10000");
    expect(markdown).not.toContain("~16s");
    expect(markdown).not.toContain("bounded waits");
  });
});
