import type { WorkflowDiagnostic } from "@/lib/workflow/types";

export const FLOW_V1_SCHEMA_VERSION = "tutti.flow.v1" as const;

export type FlowV1SchemaVersion = typeof FLOW_V1_SCHEMA_VERSION;

export type FlowV1JsonPrimitive = string | number | boolean | null;
export type FlowV1JsonValue =
  | FlowV1JsonPrimitive
  | FlowV1JsonValue[]
  | { [key: string]: FlowV1JsonValue };
export type FlowV1JsonObject = { [key: string]: FlowV1JsonValue };

export const FLOW_V1_LIFECYCLES = [
  "draft",
  "active",
  "paused",
  "archived",
] as const;
export type FlowV1Lifecycle = (typeof FLOW_V1_LIFECYCLES)[number];

export const FLOW_V1_VERSION_STATUSES = [
  "draft",
  "published",
  "superseded",
] as const;
export type FlowV1VersionStatus = (typeof FLOW_V1_VERSION_STATUSES)[number];

export const FLOW_V1_CYCLE_STATUSES = [
  "runnable",
  "running",
  "waiting_gate",
  "waiting_human",
  "paused_failed",
  "paused_uncertain",
  "paused_conflict",
  "paused_budget",
  "completed",
  "canceled",
] as const;
export type FlowV1CycleStatus = (typeof FLOW_V1_CYCLE_STATUSES)[number];

export const FLOW_V1_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "canceled",
  "interrupted",
] as const;
export type FlowV1RunStatus = (typeof FLOW_V1_RUN_STATUSES)[number];

export const FLOW_V1_RUN_STOP_REASONS = [
  "cycle_completed",
  "cycle_canceled",
  "waiting_gate",
  "waiting_human",
  "paused_failed",
  "paused_uncertain",
  "paused_conflict",
  "paused_budget",
  "canceled",
] as const;
export type FlowV1RunStopReason = (typeof FLOW_V1_RUN_STOP_REASONS)[number];

export const FLOW_V1_INVOCATION_STATUSES = [
  "accepted",
  "started",
  "coalesced",
  "ignored",
  "rejected",
] as const;
export type FlowV1InvocationStatus =
  (typeof FLOW_V1_INVOCATION_STATUSES)[number];

export type FlowV1InvocationOrigin =
  | { kind: "agent"; agentSessionId: string }
  | { kind: "user" }
  | { kind: "schedule"; scheduleId: string; scheduledAt: string }
  | { kind: "continuation"; previousCycleId: string }
  | { kind: "recovery"; reason: string };

export const FLOW_V1_NODE_KINDS = [
  "agent",
  "human",
  "script",
  "transform",
  "gate",
  "effect",
  "finally",
  "loop",
  "map",
  "remember",
  "complete_cycle",
  "cancel_cycle",
] as const;
export type FlowV1NodeKind = (typeof FLOW_V1_NODE_KINDS)[number];

export const FLOW_V1_NODE_STATUSES = [
  "idle",
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "canceled",
  "uncertain",
  "not_selected",
] as const;
export type FlowV1NodeStatus = (typeof FLOW_V1_NODE_STATUSES)[number];

export type FlowV1Reference = {
  expression: string;
  source: string;
  path: string[];
};

export type FlowV1ResolvableString = string | FlowV1Reference;
export type FlowV1ResolvableNumber = number | FlowV1Reference;
export type FlowV1JsonSchema = FlowV1JsonObject;
export type FlowV1AgentOutput =
  | { kind: "text" }
  | {
      kind: "json";
      schema?: FlowV1JsonSchema;
      validationMaxAttempts?: number;
    };

export type FlowV1ExecutionContract = {
  access: "read" | "write" | "review";
  isolation: "shared" | "required";
};

export type FlowV1SessionSpec =
  | {
      mode: "independent";
    }
  | {
      mode: "inherit";
      key: string;
    };

export type FlowV1HumanContextItem = {
  label: string;
  value: string;
  display: "text" | "markdown" | "json";
};

export type FlowV1HumanField = {
  id: string;
  type: "text" | "textarea" | "select";
  label: string;
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
  options?: Array<{ label: string; value: string }>;
};

export type FlowV1HumanAction = {
  id: string;
  label: string;
  intent: "primary" | "default" | "danger";
  fields: FlowV1HumanField[];
};

export type FlowV1HumanSpec = {
  description?: string;
  context: FlowV1HumanContextItem[];
  actions: FlowV1HumanAction[];
};

export type FlowV1CompositeAgentStep = {
  id: string;
  kind: "agent";
  label: string;
  prompt: string;
  appendPrompt?: string;
  session?: FlowV1SessionSpec;
  agent?: FlowV1ResolvableString;
  model?: FlowV1ResolvableString;
  permissionMode?: FlowV1ResolvableString;
  cwd?: string;
  workspace?: FlowV1Reference;
  execution?: FlowV1ExecutionContract;
  output?: FlowV1AgentOutput;
};

export type FlowV1CompositeHumanStep = {
  id: string;
  kind: "human";
  label: string;
  human: FlowV1HumanSpec;
};

export type FlowV1LoopSpec = {
  maxIterations: FlowV1ResolvableNumber;
  onMaxIterations: "fail" | "complete";
  firstIterationStartAt?: string;
  steps: Array<FlowV1CompositeAgentStep | FlowV1CompositeHumanStep>;
  until:
    | { source: string; finalStatus: string }
    | { source: string; equals: FlowV1JsonValue };
};

export type FlowV1MapSpec = {
  source: FlowV1Reference;
  maxItems: number;
  onItemFailure: "skip" | "fail";
  onItemRejected: "collect" | "fail";
  itemOutcome?: {
    source: string;
    success: string[];
    rejected: string[];
  };
  execution?: FlowV1ExecutionContract;
  steps: FlowV1CompositeAgentStep[];
};

export type FlowV1DataEdge = {
  id: string;
  kind: "data";
  sourceNodeId: string;
  sourcePath: string[];
  targetNodeId: string;
  targetInput: string;
};

export type FlowV1ControlEdge = {
  id: string;
  kind: "control";
  sourceNodeId: string;
  outcome: string;
  targetNodeId: string;
};

export type FlowV1Edge = FlowV1DataEdge | FlowV1ControlEdge;

export type FlowV1RetryPolicy = {
  maxAttempts: number;
  errorCodes: string[];
  backoffMs: number;
};

export type FlowV1Node = {
  id: string;
  variableName?: string;
  kind: FlowV1NodeKind;
  label: string;
  file?: string;
  prompt?: string;
  session?: FlowV1SessionSpec;
  agent?: FlowV1ResolvableString;
  model?: FlowV1ResolvableString;
  permissionMode?: FlowV1ResolvableString;
  cwd?: string;
  workspace?: FlowV1Reference;
  execution?: FlowV1ExecutionContract;
  human?: FlowV1HumanSpec;
  loop?: FlowV1LoopSpec;
  map?: FlowV1MapSpec;
  output?: FlowV1AgentOutput;
  outcomes: string[];
  inputs: Record<string, FlowV1Reference>;
  idempotencyKey?: FlowV1Reference | string;
  retry?: FlowV1RetryPolicy;
  runOn?: Array<"completed" | "failed" | "canceled">;
  retainOnFailure?: boolean;
  memorySections?: string[];
  memoryUpdates?: Record<string, FlowV1MemoryUpdateSpec>;
  continueMode?: "immediate" | "scheduled";
  terminalOutcome?: string;
  secretNames?: string[];
  sourceRange?: { start: number; end: number };
};

export type FlowV1Meta = {
  name: string;
  description: string;
  requiresCwd: boolean;
};

export type FlowV1SchemaEntry = {
  name: string;
  helper: string;
  required: boolean;
  hasDefault: boolean;
  config: FlowV1JsonObject;
};

export type FlowV1MemorySection = {
  id: string;
  title: string;
  update: "replace" | "append";
};

export type FlowV1MemoryDefinition = {
  sections: Record<string, FlowV1MemorySection>;
};

export type FlowV1CycleDefinition = {
  mode: "singleton" | "keyed";
  key?: FlowV1Reference;
};

export type FlowV1ScheduleDefinition = {
  id: string;
  expression: FlowV1Reference | string;
  timezone: FlowV1Reference | string;
  catchUp: "latest";
  overlap: "coalesce-latest" | "skip";
  inputs: Record<string, FlowV1Reference | FlowV1JsonValue>;
};

export type FlowV1RuntimeDefinition = {
  maxNodeExecutionsPerTick: number;
  maxImmediateContinuations: number;
  maxParallelNodes: number;
};

export type ParsedFlowV1 = {
  schemaVersion?: string;
  meta: FlowV1Meta;
  params: Record<string, FlowV1SchemaEntry>;
  inputs: Record<string, FlowV1SchemaEntry>;
  secrets: Record<string, FlowV1SchemaEntry>;
  cycles: FlowV1CycleDefinition;
  schedule: FlowV1ScheduleDefinition | null;
  memory: FlowV1MemoryDefinition | null;
  runtime: FlowV1RuntimeDefinition;
  nodes: FlowV1Node[];
  edges: FlowV1Edge[];
  variableToNodeId: Record<string, string>;
  diagnostics: WorkflowDiagnostic[];
};

export type FlowV1BundleSourceFile = {
  path: string;
  content: string;
};

export type FlowV1BundleMediaKind =
  | "javascript"
  | "shell"
  | "markdown"
  | "json";

export type FlowV1BundleFileRole =
  | "entry"
  | "memory_template"
  | "documentation"
  | "code"
  | "resource";

export type FlowV1BundleFile = FlowV1BundleSourceFile & {
  sha256: string;
  sizeBytes: number;
  mediaKind: FlowV1BundleMediaKind;
  role: FlowV1BundleFileRole;
};

export type FlowV1Bundle = {
  schemaVersion: FlowV1SchemaVersion;
  hash: string;
  files: FlowV1BundleFile[];
};

export type FlowV1NodeResult =
  | {
      status: "completed";
      outcome?: string;
      output?: FlowV1JsonValue;
    }
  | {
      status: "waiting";
      reason: string;
    }
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "failed";
      error: {
        code: string;
        message: string;
        retryable?: boolean;
      };
    }
  | {
      status: "uncertain";
      error: {
        code: string;
        message: string;
      };
    }
  | {
      status: "conflict";
      error: {
        code: string;
        message: string;
      };
    };

export type FlowV1EffectApplyResult = {
  externalRef?: string;
  output?: FlowV1JsonValue;
};

export type FlowV1EffectReconcileResult =
  | {
      status: "completed";
      externalRef?: string;
      output?: FlowV1JsonValue;
    }
  | {
      status: "not_applied";
    }
  | {
      status: "unknown";
      reason: string;
    };

export type FlowV1MemoryUpdate = {
  sectionId: string;
  mode: "replace" | "append";
  markdown: string;
};

export type FlowV1MemoryUpdateSpec = {
  mode: "replace" | "append";
  value: FlowV1Reference | string;
};

export type FlowV1CycleRecord = {
  id: string;
  flowId: string;
  sequence: number;
  flowVersionId: string;
  status: FlowV1CycleStatus;
  outcome: string | null;
  currentNodeId: string | null;
  inputSnapshot: FlowV1JsonObject;
  paramsRevision: number;
  paramsSnapshot: FlowV1JsonObject;
  memoryHashAtStart: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type FlowV1InvocationRecord = {
  id: string;
  flowId: string;
  cycleId: string | null;
  runId: string | null;
  origin: FlowV1InvocationOrigin;
  status: FlowV1InvocationStatus;
  idempotencyKey: string;
  input: FlowV1JsonObject;
  error: FlowV1JsonObject | null;
  requestedAt: string;
  updatedAt: string;
};

export type FlowV1RunRecord = {
  id: string;
  flowId: string;
  flowVersionId: string;
  cycleId: string;
  invocationId: string;
  tickSequence: number;
  status: FlowV1RunStatus;
  stopReason: FlowV1RunStopReason | null;
  input: FlowV1JsonObject;
  result: FlowV1JsonObject | null;
  ownerToken: string | null;
  ownerClaimedAt: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type FlowV1CycleCheckpointRecord = {
  cycleId: string;
  revision: number;
  state: FlowV1JsonObject;
  updatedAt: string;
};

export type FlowV1TickBundle = {
  created: boolean;
  cycle: FlowV1CycleRecord;
  invocation: FlowV1InvocationRecord;
  run: FlowV1RunRecord;
};

export type FlowV1NodeAttemptRecord = {
  id: string;
  cycleId: string;
  runId: string;
  nodeId: string;
  sequence: number;
  status: FlowV1NodeStatus;
  input: FlowV1JsonObject;
  output: FlowV1JsonValue | null;
  error: FlowV1JsonObject | null;
  controlOutcome: string | null;
  agentSessionKey: string | null;
  agentSessionId: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export const FLOW_V1_EFFECT_STATUSES = [
  "starting",
  "completed",
  "not_applied",
  "uncertain",
  "failed",
] as const;
export type FlowV1EffectStatus = (typeof FLOW_V1_EFFECT_STATUSES)[number];

export type FlowV1EffectRecord = {
  id: string;
  cycleId: string;
  runId: string;
  nodeId: string;
  attemptId: string | null;
  idempotencyKey: string;
  status: FlowV1EffectStatus;
  externalRef: string | null;
  result: FlowV1JsonValue | null;
  error: FlowV1JsonObject | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type FlowV1ScheduleStatus = "active" | "paused";

export type FlowV1ScheduleRecord = {
  id: string;
  flowId: string;
  status: FlowV1ScheduleStatus;
  cronExpression: string;
  timezone: string;
  catchUp: "latest";
  overlapPolicy: "coalesce-latest" | "skip";
  input: FlowV1JsonObject;
  revision: number;
  nextFireAt: string | null;
  lastScheduledAt: string | null;
  coalescedScheduledAt: string | null;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
};

export type FlowV1ParamsRecord = {
  flowId: string;
  revision: number;
  values: FlowV1JsonObject;
  createdAt: string;
};

export type FlowV1RuntimeSummary = {
  flowId: string;
  lifecycle: FlowV1Lifecycle;
  paramsRevision: number;
  activeCycle: FlowV1CycleRecord | null;
  latestRun: FlowV1RunRecord | null;
  schedule: FlowV1ScheduleRecord | null;
  cycleCount: number;
  runCount: number;
  completedCycleCount: number;
  attentionCycleCount: number;
};

export type FlowV1CheckpointNodeState = {
  status: FlowV1NodeStatus;
  attemptCount: number;
  output?: FlowV1JsonValue;
  outcome?: string;
  waitingReason?: string;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
  progress?: FlowV1JsonObject;
};

export type FlowV1GraphCheckpoint = {
  nodes: Record<string, FlowV1CheckpointNodeState>;
  selectedControlEdgeIds: string[];
  notSelectedControlEdgeIds: string[];
};

export type FlowV1MemoryProjection = {
  path: string;
  markdown: string;
  hash: string;
  sections: Record<string, string>;
  conflicts: Array<{
    cycleId: string;
    nodeId: string;
    baseHash: string;
    currentHash: string;
    candidateHash: string;
    candidateMarkdown: string;
    createdAt: string;
  }>;
  error?: string;
};

export type FlowV1DetailProjection = {
  schemaVersion: FlowV1SchemaVersion;
  runtime: FlowV1RuntimeSummary;
  graph: {
    nodes: FlowV1Node[];
    edges: FlowV1Edge[];
  };
  cycles: FlowV1CycleRecord[];
  selectedCycle: FlowV1CycleRecord | null;
  runs: FlowV1RunRecord[];
  checkpoint: FlowV1GraphCheckpoint | null;
  attempts: FlowV1NodeAttemptRecord[];
  effects: FlowV1EffectRecord[];
  humanTasks: import("@/lib/workflow/types").WorkflowHumanTask[];
  configuration: {
    paramsSchema: Record<string, FlowV1SchemaEntry>;
    inputsSchema: Record<string, FlowV1SchemaEntry>;
    secretsSchema: Record<string, FlowV1SchemaEntry>;
    params: FlowV1ParamsRecord | null;
    projectCwd: string | null;
    defaultAgent: string | null;
    defaultModel: string | null;
    defaultPermissionMode: string | null;
    secretBindings: Record<
      string,
      import("./secret-bindings").FlowV1SecretBinding
    >;
  };
  memory: FlowV1MemoryProjection | null;
};
