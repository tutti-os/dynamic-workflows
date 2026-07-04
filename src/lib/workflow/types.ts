import type { ApiErrorCode } from "@/lib/api/errors";

export type WorkflowNodeKind = "agent" | "log" | "pipeline" | "dynamic" | "loop";

export type WorkflowNodeStatus =
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export type EditableRange = {
  start: number;
  end: number;
};

export type WorkflowInputBinding = {
  name: string;
  sourceVariable: string;
  sourceNodeId?: string;
};

export type WorkflowSessionSpec =
  | {
      mode: "independent";
    }
  | {
      mode: "inherit";
      key: string;
      scope?: "loop" | "step";
    };

export type WorkflowLoopStep = {
  id: string;
  kind: "agent";
  label: string;
  prompt: string;
  appendPrompt?: string;
  agent?: string;
  model?: string;
  cwd?: string;
  session?: WorkflowSessionSpec;
  templateRefs: string[];
  sourceRange?: EditableRange;
  promptRange?: EditableRange;
  appendPromptRange?: EditableRange;
  labelRange?: EditableRange;
};

export type WorkflowLoopUntil = {
  source: string;
  includes: string;
};

export type WorkflowLoopSpec = {
  maxIterations: number;
  onMaxIterations: "fail" | "complete";
  session?: WorkflowSessionSpec;
  steps: WorkflowLoopStep[];
  until: WorkflowLoopUntil;
};

export type WorkflowNode = {
  id: string;
  kind: WorkflowNodeKind;
  label: string;
  phase?: string;
  variableName?: string;
  prompt?: string;
  message?: string;
  agent?: string;
  model?: string;
  cwd?: string;
  session?: WorkflowSessionSpec;
  loop?: WorkflowLoopSpec;
  inputs: WorkflowInputBinding[];
  templateRefs: string[];
  sourceRange?: EditableRange;
  promptRange?: EditableRange;
  labelRange?: EditableRange;
  diagnostics?: string[];
};

export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  label?: string;
};

export type WorkflowPhase = {
  id: string;
  title: string;
  nodeIds: string[];
};

export type WorkflowMeta = {
  name: string;
  description: string;
  requiresCwd?: boolean;
};

export type WorkflowDiagnostic = {
  severity: "info" | "warning" | "error";
  message: string;
  range?: EditableRange;
};

export type ParsedWorkflow = {
  meta: WorkflowMeta;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  phases: WorkflowPhase[];
  externalInputs: string[];
  diagnostics: WorkflowDiagnostic[];
  variableToNodeId: Record<string, string>;
};

export type WorkflowRunRequest = {
  runId?: string;
  script: string;
  agent?: string;
  model?: string;
  cwd?: string;
  inputs?: Record<string, string>;
  recovery?: WorkflowRunRecoveryState;
  onCheckpoint?: (checkpoint: WorkflowRunCheckpoint) => void | Promise<void>;
  signal?: AbortSignal;
};

export type WorkflowRunRecoveryState = {
  outputs?: Record<string, string>;
  completedNodeIds?: string[];
  sessionIdsByKey?: Record<string, string>;
  sessionCwdsByKey?: Record<string, string>;
  attachSessionIdsByNodeId?: Record<string, string>;
  loopStates?: Record<string, WorkflowLoopRecoveryState>;
};

export type WorkflowLoopRecoveryState = {
  nextIteration: number;
  previousStepOutputs: Record<string, string>;
  currentIteration?: number;
  currentStepOutputs?: Record<string, string>;
  iterations: Array<{
    index: number;
    outputs: Record<string, string>;
    untilOutput: string;
    untilMatched: boolean;
  }>;
};

export type WorkflowRunCheckpoint = {
  runId: string;
  nodeId: string;
  kind: "loop";
  state: WorkflowLoopRecoveryState;
};

export type WorkflowNodeSessionStatus =
  | "running"
  | "completed"
  | "failed"
  | "canceled";

export type WorkflowNodeSessionRef = {
  nodeId: string;
  agentSessionId: string;
  providerSessionId?: string;
  agent: string;
  model?: string;
  status: WorkflowNodeSessionStatus;
  title?: string;
  lastText?: string;
  lastError?: string;
};

export type WorkflowRunEvent =
  | {
      type: "run_started";
      runId: string;
      parsed: ParsedWorkflow;
    }
  | {
      type: "node_started";
      runId: string;
      nodeId: string;
      node: WorkflowNode;
      agent: string;
      model?: string;
    }
  | {
      type: "node_event";
      runId: string;
      nodeId: string;
      event: unknown;
    }
  | {
      type: "node_completed";
      runId: string;
      nodeId: string;
      output: string;
    }
  | {
      type: "node_failed";
      runId: string;
      nodeId: string;
      error: string;
    }
  | {
      type: "run_completed";
      runId: string;
      status: "completed" | "failed" | "canceled";
      outputs: Record<string, string>;
      error?: string;
      errorCode?: ApiErrorCode;
    };
