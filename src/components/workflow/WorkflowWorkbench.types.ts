import type { WorkflowNode, WorkflowNodeStatus } from "@/lib/workflow/types";

export type FlowNodeData = {
  workflowNode: WorkflowNode;
  status: WorkflowNodeStatus;
};

export type MainView = "graph" | "script";
export type InspectorTab = "edit" | "runs";
