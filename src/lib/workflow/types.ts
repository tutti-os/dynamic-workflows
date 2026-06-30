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

export type WorkflowLoopStep = {
  id: string;
  kind: "agent";
  label: string;
  prompt: string;
  provider?: string;
  model?: string;
  session?: string;
  templateRefs: string[];
  sourceRange?: EditableRange;
  promptRange?: EditableRange;
  labelRange?: EditableRange;
};

export type WorkflowLoopUntil = {
  source: string;
  includes: string;
};

export type WorkflowLoopSpec = {
  maxIterations: number;
  session?: string;
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
  provider?: string;
  model?: string;
  session?: string;
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
  provider?: string;
  model?: string;
  cwd?: string;
  inputs?: Record<string, string>;
  signal?: AbortSignal;
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
  provider: string;
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
      provider: string;
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
