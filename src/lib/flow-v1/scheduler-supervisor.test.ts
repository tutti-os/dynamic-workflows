import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureFlowV1SchedulerSupervisorStarted,
  startFlowV1SchedulerSupervisor,
  stopFlowV1SchedulerSupervisor,
} from "./scheduler-supervisor";

afterEach(() => {
  stopFlowV1SchedulerSupervisor();
  vi.useRealTimers();
});

describe("Flow v1 scheduler supervisor", () => {
  it("suppresses overlapping passes and runs again after completion", async () => {
    let release: (() => void) | undefined;
    const runPass = vi.fn(
      async () =>
        await new Promise<[]>(resolve => {
          release = () => resolve([]);
        }),
    );
    const supervisor = startFlowV1SchedulerSupervisor({
      intervalMs: 60_000,
      runImmediately: false,
      runPass,
    });

    const first = supervisor.trigger();
    const overlapping = await supervisor.trigger();
    expect(overlapping).toEqual([]);
    expect(runPass).toHaveBeenCalledTimes(1);
    release?.();
    await first;
    const second = supervisor.trigger();
    expect(runPass).toHaveBeenCalledTimes(2);
    release?.();
    await second;
    supervisor.stop();
  });

  it("keeps one process-global supervisor and stops its timer", async () => {
    vi.useFakeTimers();
    const runPass = vi.fn(async () => []);
    const first = ensureFlowV1SchedulerSupervisorStarted({
      intervalMs: 100,
      runImmediately: false,
      runPass,
    });
    const second = ensureFlowV1SchedulerSupervisorStarted({
      intervalMs: 100,
      runImmediately: false,
      runPass,
    });
    expect(second).toBe(first);

    await vi.advanceTimersByTimeAsync(250);
    expect(runPass).toHaveBeenCalledTimes(2);
    first.stop();
    await vi.advanceTimersByTimeAsync(250);
    expect(runPass).toHaveBeenCalledTimes(2);
  });
});
