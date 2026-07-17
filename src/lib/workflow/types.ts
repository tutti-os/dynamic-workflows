import type { ApiErrorCode } from "@/lib/api/errors";

export type WorkflowNodeKind =
  | "agent"
  | "human"
  | "log"
  | "pipeline"
  | "dynamic"
  | "loop"
  | "map";

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

export type WorkflowAgentOutputFormat = "json";

export type WorkflowAgentLoopStep = {
  id: string;
  kind: "agent";
  label: string;
  prompt: string;
  appendPrompt?: string;
  agent?: string;
  model?: string;
  cwd?: string;
  output?: WorkflowAgentOutputFormat;
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
  output?: undefined;
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

export type WorkflowMapSpec = {
  /**
   * Display/binding name of the source. For node-bound sources this is the
   * upstream variable name; for an inline literal source it is a fixed marker
   * (`"inline list"`) and `items` carries the data instead.
   */
  source: string;
  /** Resolved node id for a node-bound `source`; undefined for literals. */
  sourceNodeId?: string;
  /**
   * Inline static list items when `source` is an array literal. Mutually
   * exclusive with `sourceNodeId`; resolved at parse time, no templates.
   */
  items?: WorkflowValue[];
  maxItems: number;
  onItemFailure: "skip" | "fail";
  /**
   * One or more agent steps forming a per-item pipeline (1..N). Steps run
   * sequentially within an item; across items there is no barrier. Children
   * always run independent sessions.
   */
  steps: WorkflowAgentLoopStep[];
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
  output?: WorkflowAgentOutputFormat;
  session?: WorkflowSessionSpec;
  human?: WorkflowHumanSpec;
  loop?: WorkflowLoopSpec;
  map?: WorkflowMapSpec;
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
  /**
   * Set when the rendered value was truncated to bound the gate payload. The
   * value carries an inline `…[truncated N chars]` marker as well, so a plain
   * text reader still sees that content was cut.
   */
  truncated?: boolean;
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

/** Where an operator note is delivered. */
export type WorkflowRunNoteTarget = "current" | "next-step";

/**
 * Lifecycle of an operator note:
 * - `pending`: recorded, not yet delivered (next-step notes awaiting an
 *   execution; a current note only lives in this state momentarily before
 *   delivery is attempted).
 * - `consumed`: a next-step note that was injected into an execution's prompt.
 * - `delivered`: a current note handed to a live agent session.
 * - `failed`: a current note whose live delivery failed.
 */
export type WorkflowRunNoteStatus =
  | "pending"
  | "consumed"
  | "delivered"
  | "failed";

/**
 * An operator note steering a running workflow with full provenance. Recorded
 * as a first-class run event before any delivery so run review and replay stay
 * truthful. See {@link WorkflowRunNoteTarget} for the two delivery semantics.
 */
export type WorkflowRunNote = {
  id: string;
  runId: string;
  message: string;
  target: WorkflowRunNoteTarget;
  /** When set, only an execution of this top-level node consumes the note. */
  nodeId?: string;
  status: WorkflowRunNoteStatus;
  /** Fine-grained execution key that consumed a next-step note. */
  consumedExecutionKey?: string;
  /** Result of a current-target live delivery. */
  delivery?: {
    ok: boolean;
    agentSessionId?: string;
    detail?: string;
  };
  createdAt: string;
  /** When a next-step note was consumed or a current note was delivered. */
  consumedAt?: string;
};

export type WorkflowRunNoteRequest = {
  runId: string;
  message: string;
  target: WorkflowRunNoteTarget;
  nodeId?: string;
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
  /**
   * Atomically claim any pending next-step operator notes that this execution
   * should consume, marking them consumed with `executionKey`. A note without a
   * nodeId matches any execution; a nodeId-scoped note matches only executions
   * of that top-level node. One note = one delivery, first consumer wins.
   */
  onConsumeNotes?: (input: {
    runId: string;
    nodeId: string;
    executionKey: string;
  }) => WorkflowRunNote[] | Promise<WorkflowRunNote[]>;
  signal?: AbortSignal;
};

export type WorkflowRunRecoveryState = {
  outputs?: Record<string, WorkflowValue>;
  completedNodeIds?: string[];
  sessionIdsByKey?: Record<string, string>;
  sessionCwdsByKey?: Record<string, string>;
  attachSessionIdsByNodeId?: Record<string, string>;
  loopStates?: Record<string, WorkflowLoopRecoveryState>;
  mapStates?: Record<string, WorkflowMapRecoveryState>;
};

export type WorkflowMapItemCompletion = {
  index: number;
  status: "completed" | "failed";
  /**
   * For a failed item, the id of the step that failed (remaining steps are
   * skipped). Absent on completed items and on legacy single-step checkpoints.
   */
  step?: string;
  output?: WorkflowValue;
  error?: string;
};

export type WorkflowMapRecoveryState = {
  /** The resolved source array, persisted at expansion time. */
  items: WorkflowValue[];
  /** Per-item outcomes so a resumed run only re-runs unfinished items. */
  completions: WorkflowMapItemCompletion[];
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

export type WorkflowRunCheckpointState =
  | {
      kind: "loop";
      state: WorkflowLoopRecoveryState;
    }
  | {
      kind: "map";
      state: WorkflowMapRecoveryState;
    };

export type WorkflowRunCheckpoint = {
  runId: string;
  nodeId: string;
} & WorkflowRunCheckpointState;

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

export type WorkflowLoopStepExecutionRef = {
  executionKey: string;
  parentNodeId: string;
  stepId: string;
  iteration: number;
};

export type WorkflowLoopStepRun = WorkflowLoopStepExecutionRef & {
  kind: WorkflowLoopStep["kind"];
  label: string;
  status: WorkflowNodeStatus;
  agent?: string;
  model?: string;
  sessionKey?: string;
  promptMode?: "full" | "append";
  input?: string;
  restored?: boolean;
  output?: WorkflowValue;
  error?: string;
  session?: WorkflowNodeSessionRef;
};

export type WorkflowMapItemExecutionRef = {
  executionKey: string;
  parentNodeId: string;
  stepId: string;
  /** 1-based item position within the resolved source array. */
  index: number;
};

export type WorkflowMapItemRun = WorkflowMapItemExecutionRef & {
  kind: "agent";
  label: string;
  status: WorkflowNodeStatus;
  agent?: string;
  model?: string;
  promptMode?: "full" | "append";
  input?: string;
  restored?: boolean;
  output?: WorkflowValue;
  error?: string;
  session?: WorkflowNodeSessionRef;
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
      /**
       * The rendered prompt actually sent to the agent, captured at run time so
       * run detail shows what was sent rather than re-rendering it from current
       * outputs. Optional: only agent nodes emit it, and legacy logs lack it.
       */
      input?: string;
    }
  | {
      type: "node_event";
      runId: string;
      nodeId: string;
      loopStep?: WorkflowLoopStepExecutionRef;
      mapItem?: WorkflowMapItemExecutionRef;
      event: unknown;
    }
  | {
      type: "loop_step_state";
      runId: string;
      loopStep: WorkflowLoopStepExecutionRef;
      kind: WorkflowLoopStep["kind"];
      label: string;
      status: WorkflowNodeStatus;
      agent?: string;
      model?: string;
      sessionKey?: string;
      promptMode?: "full" | "append";
      input?: string;
      restored?: boolean;
      output?: WorkflowValue;
      error?: string;
    }
  | {
      type: "map_item_state";
      runId: string;
      mapItem: WorkflowMapItemExecutionRef;
      kind: "agent";
      label: string;
      status: WorkflowNodeStatus;
      agent?: string;
      model?: string;
      promptMode?: "full" | "append";
      input?: string;
      restored?: boolean;
      output?: WorkflowValue;
      error?: string;
    }
  | {
      type: "run_note";
      runId: string;
      note: WorkflowRunNote;
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
