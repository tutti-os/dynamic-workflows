import {
  resolveLoopStepSessionSpec,
  resolveSessionKey,
} from "./session";
import type { WorkflowSessionSpec } from "./types";

export type LoopStepPromptMode = "append" | "full";

export type LoopStepRunContext = {
  prompt: string;
  promptMode: LoopStepPromptMode;
  sessionKey?: string;
  resumeSessionId?: string;
};

export function resolveLoopStepRunContext(input: {
  stepId: string;
  stepSession?: WorkflowSessionSpec;
  loopSession?: WorkflowSessionSpec;
  prompt: string;
  appendPrompt?: string;
  sessionIdsByKey: Record<string, string>;
}): LoopStepRunContext {
  const sessionSpec = resolveLoopStepSessionSpec({
    loopSession: input.loopSession,
    stepSession: input.stepSession,
    stepId: input.stepId,
  });
  const sessionKey = resolveSessionKey(sessionSpec);
  const resumeSessionId = sessionKey
    ? input.sessionIdsByKey[sessionKey]
    : undefined;
  const shouldUseAppendPrompt = Boolean(resumeSessionId && input.appendPrompt);

  return {
    prompt:
      shouldUseAppendPrompt && input.appendPrompt
        ? input.appendPrompt
        : input.prompt,
    promptMode: shouldUseAppendPrompt ? "append" : "full",
    ...(sessionKey ? { sessionKey } : {}),
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
}
