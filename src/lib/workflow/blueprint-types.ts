import type {
  WorkflowBlueprintCategory,
  WorkflowBlueprintDifficulty,
} from "./blueprint-contract";

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
};

export type WorkflowBlueprintDetail = WorkflowBlueprintSummary & {
  script: string;
};

export type WorkflowBlueprintSearchResult = WorkflowBlueprintSummary & {
  score: number;
  script?: string;
};
