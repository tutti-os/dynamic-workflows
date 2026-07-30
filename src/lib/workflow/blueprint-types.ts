import type {
  WorkflowBlueprintCategory,
  WorkflowBlueprintDifficulty,
} from "./blueprint-contract";
import type {
  FlowV1Bundle,
  FlowV1Edge,
  FlowV1Node,
  FlowV1SchemaEntry,
} from "@/lib/flow-v1/types";

export type {
  WorkflowBlueprintCategory,
  WorkflowBlueprintDifficulty,
} from "./blueprint-contract";

export type WorkflowBlueprintSummary = {
  id: string;
  title: string;
  description: string;
  category: WorkflowBlueprintCategory;
  tags: string[];
  difficulty: WorkflowBlueprintDifficulty;
  requiresCwd: boolean;
  patternSummary: string;
  useCases: string[];
  schemaVersion?: "tutti.flow.v1";
  capabilities?: string[];
};

export type WorkflowBlueprintDetail = WorkflowBlueprintSummary & {
  schemaVersion: "tutti.flow.v1";
  bundle: FlowV1Bundle;
  instantiationDefaults?: {
    projectCwd?: string;
    defaultAgent?: string;
    defaultModel?: string;
    defaultPermissionMode?: string;
  };
  preview?: {
    nodes: FlowV1Node[];
    edges: FlowV1Edge[];
    params: Record<string, FlowV1SchemaEntry>;
    inputs: Record<string, FlowV1SchemaEntry>;
    secrets: Record<string, FlowV1SchemaEntry>;
  };
};

export type WorkflowBlueprintSearchResult = WorkflowBlueprintSummary & {
  score: number;
  bundle?: FlowV1Bundle;
};
