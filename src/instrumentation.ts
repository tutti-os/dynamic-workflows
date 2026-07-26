export async function register(): Promise<void> {
  if (
    process.env.NEXT_RUNTIME !== "nodejs" ||
    process.env.DYNAMIC_WORKFLOWS_DISABLE_SCHEDULER === "1"
  ) {
    return;
  }
  const { reconcileFlowV1RuntimeOnStartup } = await import(
    "@/lib/flow-v1/recovery"
  );
  const recovery = reconcileFlowV1RuntimeOnStartup();
  if (recovery.pendingRunIds.length > 0) {
    const { runFlowV1Tick } = await import(
      "@/lib/flow-v1/tick-supervisor"
    );
    void Promise.allSettled(
      recovery.pendingRunIds.map((runId) => runFlowV1Tick({ runId })),
    ).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[flow-v1 recovery]", result.reason);
        }
      }
    });
  }
  const { ensureFlowV1SchedulerSupervisorStarted } = await import(
    "@/lib/flow-v1/scheduler-supervisor"
  );
  const configuredInterval = Number(
    process.env.DYNAMIC_WORKFLOWS_SCHEDULER_INTERVAL_MS,
  );
  ensureFlowV1SchedulerSupervisorStarted({
    intervalMs:
      Number.isFinite(configuredInterval) && configuredInterval >= 10
        ? configuredInterval
        : undefined,
    onError(error) {
      console.error("[flow-v1 scheduler]", error);
    },
  });
}
