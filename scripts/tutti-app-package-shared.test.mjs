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
});
