import type { WorkflowSessionSpec } from "./types";

export function resolveSessionKey(
  session: WorkflowSessionSpec | undefined,
): string | undefined {
  return session?.mode === "inherit" ? session.key : undefined;
}

export function resolveLoopStepSessionSpec(input: {
  loopSession?: WorkflowSessionSpec;
  stepSession?: WorkflowSessionSpec;
  stepId: string;
}): WorkflowSessionSpec | undefined {
  if (input.stepSession) {
    return input.stepSession;
  }
  if (!input.loopSession) {
    return undefined;
  }
  if (input.loopSession.mode === "independent") {
    return input.loopSession;
  }
  if (input.loopSession.scope === "step") {
    return {
      mode: "inherit",
      key: `${input.loopSession.key}.${input.stepId}`,
    };
  }
  return {
    mode: "inherit",
    key: input.loopSession.key,
  };
}

export function createLoopStepSessionNodeId(
  loopId: string,
  stepId: string,
): string {
  return `${loopId}.${stepId}`;
}
