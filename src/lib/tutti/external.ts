import type {
  WorkspaceUserProjectApi,
  WorkspaceUserProjectServiceSnapshot,
} from "@tutti-os/workspace-user-project/contracts";

export type TuttiUserProjectApi = WorkspaceUserProjectApi & {
  getSnapshot?: () => Promise<WorkspaceUserProjectServiceSnapshot>;
  refresh?: () => Promise<WorkspaceUserProjectServiceSnapshot>;
  subscribe?: (
    listener: (snapshot: WorkspaceUserProjectServiceSnapshot) => void,
  ) => () => void;
};

type DynamicWorkflowsTuttiExternal = {
  userProjects?: TuttiUserProjectApi;
};

declare global {
  interface Window {
    tuttiExternal?: DynamicWorkflowsTuttiExternal;
  }
}

export function readTuttiUserProjectApi(): TuttiUserProjectApi | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.tuttiExternal?.userProjects ?? null;
}
