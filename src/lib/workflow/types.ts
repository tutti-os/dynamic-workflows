export type EditableRange = {
  start: number;
  end: number;
};

export type WorkflowMeta = {
  name: string;
  description: string;
  requiresCwd?: boolean;
};

export type WorkflowValue =
  | string
  | number
  | boolean
  | null
  | WorkflowValue[]
  | { [key: string]: WorkflowValue };

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

export type WorkflowHumanTaskResponse = {
  action: string;
  values: Record<string, WorkflowValue>;
};

export type RenderedWorkflowHumanContextItem = {
  label: string;
  value: WorkflowValue;
  display: WorkflowHumanContextDisplay;
  truncated?: boolean;
};

export type RenderedWorkflowHumanSpec = Omit<WorkflowHumanSpec, "context"> & {
  context: RenderedWorkflowHumanContextItem[];
};

export type WorkflowHumanTaskStatus = "pending" | "resolved" | "canceled";

export type WorkflowHumanTask = {
  id: string;
  runId: string;
  cycleId?: string;
  nodeId: string;
  executionKey: string;
  status: WorkflowHumanTaskStatus;
  spec: RenderedWorkflowHumanSpec;
  response?: WorkflowHumanTaskResponse;
  revision: number;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
};

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
