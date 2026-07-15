import type {
  WorkflowLoopStepRun,
  WorkflowNode,
  WorkflowNodeStatus,
} from "@/lib/workflow/types";

export type FlowNodeData = {
  onLoopStepSelect?: (loopNodeId: string, stepId: string) => void;
  selectedLoopStepId?: string;
  loopStepRuns?: WorkflowLoopStepRun[];
  workflowNode: WorkflowNode;
  status: WorkflowNodeStatus;
};

export type MainView = "graph" | "script";
export type InspectorTab = "edit" | "runs" | "authoring";
