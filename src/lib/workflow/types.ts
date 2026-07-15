import type { ApiErrorCode } from "@/lib/api/errors";

export type WorkflowNodeKind =
  | "agent"
  | "human"
  | "log"
  | "pipeline"
  | "dynamic"
  | "loop";

export type WorkflowNodeStatus =
  | "idle"
  | "queued"
  | "running"
  | "waiting"
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

export type WorkflowAgentLoopStep = {
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

export type WorkflowHumanContextDisplay = "text" | "markdown" | "json";

export type WorkflowHumanContextItem = {
  label: string;
  value: string;
  display: WorkflowHumanContextDisplay;
};

export type WorkflowHumanFieldOption = {
  label: string;
  value: string;
};

export type WorkflowHumanField = {
  id: string;
  type: "text" | "textarea" | "select";
  label: string;
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
  options?: WorkflowHumanFieldOption[];
};

export type WorkflowHumanAction = {
  id: string;
  label: string;
  intent: "primary" | "default" | "danger";
  fields: WorkflowHumanField[];
};

export type WorkflowHumanSpec = {
  description?: string;
  context: WorkflowHumanContextItem[];
  actions: WorkflowHumanAction[];
};

export type WorkflowHumanLoopStep = {
  id: string;
  kind: "human";
  label: string;
  human: WorkflowHumanSpec;
  prompt?: undefined;
  appendPrompt?: undefined;
  agent?: undefined;
  model?: undefined;
  cwd?: undefined;
  session?: undefined;
  templateRefs: string[];
  sourceRange?: EditableRange;
  promptRange?: undefined;
  appendPromptRange?: undefined;
  labelRange?: EditableRange;
};

export type WorkflowLoopStep = WorkflowAgentLoopStep | WorkflowHumanLoopStep;

export type WorkflowLoopUntil =
  | {
      source: string;
      finalStatus: string;
      equals?: never;
    }
  | {
      source: string;
      equals: WorkflowScalarValue;
      finalStatus?: never;
    };

export type WorkflowLoopSpec = {
  maxIterations: number;
  onMaxIterations: "fail" | "complete";
  firstIteration?: {
    startAt: string;
  };
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
  human?: WorkflowHumanSpec;
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

export type WorkflowScalarValue = string | number | boolean | null;

export type WorkflowValue =
  | WorkflowScalarValue
  | WorkflowValue[]
  | { [key: string]: WorkflowValue };

export type WorkflowInputValue = Exclude<WorkflowScalarValue, null>;

export type WorkflowHumanTaskResponse = {
  action: string;
  values: Record<string, WorkflowValue>;
};

export type RenderedWorkflowHumanContextItem = {
  label: string;
  value: WorkflowValue;
  display: WorkflowHumanContextDisplay;
};

export type RenderedWorkflowHumanSpec = Omit<WorkflowHumanSpec, "context"> & {
  context: RenderedWorkflowHumanContextItem[];
};

export type WorkflowHumanTaskStatus = "pending" | "resolved" | "canceled";

export type WorkflowHumanTask = {
  id: string;
  runId: string;
  nodeId: string;
  parentNodeId?: string;
  iteration?: number;
  executionKey: string;
  status: WorkflowHumanTaskStatus;
  spec: RenderedWorkflowHumanSpec;
  response?: WorkflowHumanTaskResponse;
  revision: number;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

export type WorkflowHumanTaskRequest = {
  runId: string;
  nodeId: string;
  parentNodeId?: string;
  iteration?: number;
  executionKey: string;
  spec: RenderedWorkflowHumanSpec;
};

export type WorkflowInputCommon = {
  required?: boolean;
  label?: string;
  description?: string;
};

export type WorkflowStringInput = WorkflowInputCommon & {
  type: "string";
  default?: string;
  placeholder?: string;
  widget?: "text" | "textarea";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
};

export type WorkflowNumberInput = WorkflowInputCommon & {
  type: "number";
  default?: number;
  min?: number;
  max?: number;
  step?: number;
};

export type WorkflowBooleanInput = WorkflowInputCommon & {
  type: "boolean";
  default?: boolean;
};

export type WorkflowEnumInput = WorkflowInputCommon & {
  type: "enum";
  default?: string;
  options: string[];
};

export type WorkflowInputDefinition =
  | WorkflowStringInput
  | WorkflowNumberInput
  | WorkflowBooleanInput
  | WorkflowEnumInput;

export type WorkflowInputSchema = Record<string, WorkflowInputDefinition>;

export type WorkflowDiagnostic = {
  severity: "info" | "warning" | "error";
  code?: string;
  message: string;
  path?: string;
  hint?: string;
  range?: EditableRange;
};

export type WorkflowDiagnosticSummary = {
  errorCount: number;
  warningCount: number;
  infoCount: number;
};

export type ParsedWorkflow = {
  meta: WorkflowMeta;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  phases: WorkflowPhase[];
  inputSchema: WorkflowInputSchema;
  requiredInputNames: string[];
  optionalInputNames: string[];
  diagnostics: WorkflowDiagnostic[];
  variableToNodeId: Record<string, string>;
};

export type WorkflowRunRequest = {
  runId?: string;
  script: string;
  agent?: string;
  model?: string;
  cwd?: string;
  inputs?: Record<string, WorkflowInputValue>;
  recovery?: WorkflowRunRecoveryState;
  onCheckpoint?: (checkpoint: WorkflowRunCheckpoint) => void | Promise<void>;
  onHumanTask?: (
    request: WorkflowHumanTaskRequest,
  ) => WorkflowHumanTask | Promise<WorkflowHumanTask>;
  signal?: AbortSignal;
};

export type WorkflowRunRecoveryState = {
  outputs?: Record<string, WorkflowValue>;
  completedNodeIds?: string[];
  sessionIdsByKey?: Record<string, string>;
  sessionCwdsByKey?: Record<string, string>;
  attachSessionIdsByNodeId?: Record<string, string>;
  loopStates?: Record<string, WorkflowLoopRecoveryState>;
};

export type WorkflowLoopRecoveryState = {
  nextIteration: number;
  previousStepOutputs: Record<string, WorkflowValue>;
  currentIteration?: number;
  currentStepOutputs?: Record<string, WorkflowValue>;
  iterations: Array<{
    index: number;
    outputs: Record<string, WorkflowValue>;
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
      executionId?: string;
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
      output: WorkflowValue;
    }
  | {
      type: "human_task_requested";
      runId: string;
      nodeId: string;
      task: WorkflowHumanTask;
    }
  | {
      type: "human_task_resolved";
      runId: string;
      nodeId: string;
      taskId: string;
      response: WorkflowHumanTaskResponse;
    }
  | {
      type: "node_failed";
      runId: string;
      nodeId: string;
      error: string;
    }
  | {
      type: "run_waiting";
      runId: string;
      pendingTaskIds: string[];
      outputs: Record<string, WorkflowValue>;
    }
  | {
      type: "run_completed";
      runId: string;
      status: "completed" | "failed" | "canceled";
      outputs: Record<string, WorkflowValue>;
      error?: string;
      errorCode?: ApiErrorCode;
    };
