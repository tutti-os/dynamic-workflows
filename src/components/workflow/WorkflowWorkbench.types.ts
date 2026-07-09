import type { WorkflowNode, WorkflowNodeStatus } from "@/lib/workflow/types";

export type FlowNodeData = {
  onLoopStepSelect?: (loopNodeId: string, stepId: string) => void;
  selectedLoopStepId?: string;
  workflowNode: WorkflowNode;
  status: WorkflowNodeStatus;
};

export type MainView = "graph" | "script";
export type InspectorTab = "edit" | "runs" | "authoring";
