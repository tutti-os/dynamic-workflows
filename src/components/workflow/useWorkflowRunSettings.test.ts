import { describe, expect, it, vi } from "vitest";
import {
  createAgentCatalogLoadCoordinator,
  selectDefaultAgentTarget,
} from "./useWorkflowRunSettings";
import type { AgentTargetCatalogResult } from "@/lib/agents/types";

describe("workflow run settings", () => {
  it("uses the daemon default when it is available", () => {
    expect(
      selectDefaultAgentTarget([
        {
          id: "team:builder",
          name: "Builder",
          provider: "codex",
          supported: true,
          models: ["gpt-5"],
        },
        {
          id: "team:reviewer",
          name: "Reviewer",
          provider: "codex",
          supported: true,
          models: ["gpt-5"],
          isDefault: true,
        },
      ])?.id,
    ).toBe("team:reviewer");
  });

  it("falls back to an available non-mock target when the daemon default is unavailable", () => {
    expect(
      selectDefaultAgentTarget([
        {
          id: "mock",
          name: "Mock",
          provider: "mock",
          supported: true,
          models: ["mock"],
        },
        {
          id: "team:builder",
          name: "Builder",
          provider: "codex",
          supported: true,
          models: ["gpt-5"],
        },
        {
          id: "team:reviewer",
          name: "Reviewer",
          provider: "codex",
          supported: false,
          models: ["gpt-5"],
          isDefault: true,
        },
      ])?.id,
    ).toBe("team:builder");
  });

  it("only commits the latest agent catalog request", async () => {
    const coordinator = createAgentCatalogLoadCoordinator();
    const first = deferredCatalog();
    const second = deferredCatalog();
    const successes: string[] = [];
    const settled = vi.fn();
    let firstSignal: AbortSignal | undefined;

    const firstRun = coordinator.run(
      (signal) => {
        firstSignal = signal;
        return first.promise;
      },
      handlers((id) => successes.push(id), settled),
    );
    const secondRun = coordinator.run(
      () => second.promise,
      handlers((id) => successes.push(id), settled),
    );

    expect(firstSignal?.aborted).toBe(true);
    second.resolve(catalog("new"));
    first.resolve(catalog("old"));
    await Promise.all([firstRun, secondRun]);

    expect(successes).toEqual(["new"]);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("aborts and ignores an in-flight request on cleanup", async () => {
    const coordinator = createAgentCatalogLoadCoordinator();
    const pending = deferredCatalog();
    const success = vi.fn();
    const error = vi.fn();
    const settled = vi.fn();
    let signal: AbortSignal | undefined;

    const run = coordinator.run(
      (nextSignal) => {
        signal = nextSignal;
        return pending.promise;
      },
      {
        onStart: vi.fn(),
        onSuccess: success,
        onError: error,
        onSettled: settled,
      },
    );
    coordinator.cancel();
    pending.resolve(catalog("late"));
    await run;

    expect(signal?.aborted).toBe(true);
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });
});

function catalog(id: string) {
  return {
    targets: [
      {
        id,
        name: id,
        provider: "codex",
        supported: true,
        models: ["gpt-5"],
      },
    ],
    freshness: "fresh" as const,
  };
}

function handlers(onSuccess: (id: string) => void, onSettled: () => void) {
  return {
    onStart: vi.fn(),
    onSuccess: (result: AgentTargetCatalogResult) =>
      onSuccess(result.targets[0]?.id ?? ""),
    onError: vi.fn(),
    onSettled,
  };
}

function deferredCatalog() {
  let resolve!: (value: ReturnType<typeof catalog>) => void;
  const promise = new Promise<ReturnType<typeof catalog>>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
