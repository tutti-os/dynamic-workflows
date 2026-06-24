import type {
  WorkspaceUserProject,
  WorkspaceUserProjectDefaultSelection,
  WorkspaceUserProjectPathCheck,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput,
  WorkspaceUserProjectService,
  WorkspaceUserProjectServiceSnapshot,
  WorkspaceUserProjectValtioStore,
} from "@tutti-os/workspace-user-project/contracts";
import {
  prepareWorkspaceUserProjectSelection,
  upsertWorkspaceUserProject,
} from "@tutti-os/workspace-user-project/core";
import { proxy, snapshot, subscribe } from "valtio/vanilla";
import type { TuttiUserProjectApi } from "@/lib/tutti/external";

export type TuttiUserProjectMirrorService = WorkspaceUserProjectService & {
  dispose: () => void;
};

export function createTuttiUserProjectMirrorService(
  api: TuttiUserProjectApi,
): TuttiUserProjectMirrorService {
  const store = proxy<WorkspaceUserProjectServiceSnapshot>({
    error: null,
    initialized: false,
    isLoading: false,
    projects: [],
    revision: 0,
  }) as WorkspaceUserProjectValtioStore;

  let disposed = false;
  let unsubscribeHost: (() => void) | undefined;

  const applySnapshot = (next: WorkspaceUserProjectServiceSnapshot): void => {
    if (disposed) {
      return;
    }
    const nextProjects = next.projects.map(cloneProject);
    if (store.error !== next.error) {
      store.error = next.error;
    }
    if (store.initialized !== next.initialized) {
      store.initialized = next.initialized;
    }
    if (store.isLoading !== next.isLoading) {
      store.isLoading = next.isLoading;
    }
    if (!areProjectsEqual(store.projects, nextProjects)) {
      store.projects = nextProjects;
    }
    if (store.revision !== next.revision) {
      store.revision = next.revision;
    }
  };

  const applyProject = (project: WorkspaceUserProject): void => {
    store.projects = upsertWorkspaceUserProject(
      store.projects,
      cloneProject(project),
    );
    store.error = null;
    store.initialized = true;
    store.revision += 1;
  };

  const service: TuttiUserProjectMirrorService = {
    store,
    async checkProjectPath(path: string): Promise<WorkspaceUserProjectPathCheck> {
      if (!api.checkPath) {
        return { exists: true, isDirectory: true, path };
      }
      return api.checkPath({ path });
    },
    async createProject(name: string): Promise<WorkspaceUserProject> {
      if (!api.create) {
        throw new Error("User project creation is unavailable.");
      }
      const project = await api.create({ name });
      applyProject(project);
      return project;
    },
    dispose() {
      disposed = true;
      unsubscribeHost?.();
    },
    async ensureLoaded(): Promise<void> {
      if (!store.initialized) {
        await service.refresh();
      }
    },
    async getDefaultSelection(): Promise<
      WorkspaceUserProjectDefaultSelection | null
    > {
      return api.getDefaultSelection?.() ?? null;
    },
    getRevision(): number {
      return store.revision;
    },
    getSnapshot(): WorkspaceUserProjectServiceSnapshot {
      return snapshot(store) as unknown as WorkspaceUserProjectServiceSnapshot;
    },
    isNoProjectPath(path: string): boolean {
      return api.isNoProjectPath?.({ path }) ?? false;
    },
    rememberNoProjectPath(): void {},
    async prepareSelection(
      input: WorkspaceUserProjectSelectionPreparationInput,
    ): Promise<WorkspaceUserProjectSelectionPreparation> {
      if (!store.initialized) {
        await service.refresh();
      }
      const prepared = api.prepareSelection
        ? await api.prepareSelection(input)
        : await prepareWorkspaceUserProjectSelection(api, input);
      const nextProjects = prepared.projects.map(cloneProject);
      const projectsChanged = !areProjectsEqual(store.projects, nextProjects);
      const statusChanged =
        store.error !== null || !store.initialized || store.isLoading;
      if (projectsChanged) {
        store.projects = nextProjects;
      }
      if (store.error !== null) {
        store.error = null;
      }
      if (!store.initialized) {
        store.initialized = true;
      }
      if (store.isLoading) {
        store.isLoading = false;
      }
      if (projectsChanged || statusChanged) {
        store.revision += 1;
      }
      return prepared;
    },
    async refresh(): Promise<void> {
      if (disposed) {
        return;
      }
      store.isLoading = true;
      store.error = null;
      store.revision += 1;
      try {
        applySnapshot(await loadHostSnapshot(api));
      } catch (error) {
        if (disposed) {
          return;
        }
        store.error = error instanceof Error ? error.message : String(error);
        store.isLoading = false;
        store.revision += 1;
      }
    },
    async registerProjectPath(path: string): Promise<WorkspaceUserProject> {
      const project =
        (await api.use?.({ path })) ??
        ({
          id: path,
          label: path,
          path,
        } satisfies WorkspaceUserProject);
      applyProject(project);
      return project;
    },
    async removeProjectPath(path: string): Promise<void> {
      await api.remove?.({ path });
      store.projects = store.projects.filter((project) => project.path !== path);
      store.revision += 1;
    },
    rememberDefaultSelection(
      input: { path: string | null },
    ): Promise<void> | void {
      return api.rememberDefaultSelection?.(input);
    },
    selectDirectory() {
      return api.selectDirectory?.() ?? null;
    },
    subscribe(listener: () => void): () => void {
      return subscribe(store, listener);
    },
  };

  unsubscribeHost = api.subscribe?.(applySnapshot);
  void service.refresh();
  return service;
}

async function loadHostSnapshot(
  api: TuttiUserProjectApi,
): Promise<WorkspaceUserProjectServiceSnapshot> {
  if (api.refresh) {
    return cloneSnapshot(await api.refresh());
  }
  if (api.getSnapshot) {
    return cloneSnapshot(await api.getSnapshot());
  }
  const response = await api.list();
  return {
    error: null,
    initialized: true,
    isLoading: false,
    projects: response.projects.map(cloneProject),
    revision: Date.now(),
  };
}

function cloneSnapshot(
  value: WorkspaceUserProjectServiceSnapshot,
): WorkspaceUserProjectServiceSnapshot {
  return {
    ...value,
    projects: value.projects.map(cloneProject),
  };
}

function cloneProject(project: WorkspaceUserProject): WorkspaceUserProject {
  return { ...project };
}

function areProjectsEqual(
  current: readonly WorkspaceUserProject[],
  next: readonly WorkspaceUserProject[],
): boolean {
  if (current.length !== next.length) {
    return false;
  }
  return current.every((project, index) => {
    const nextProject = next[index];
    return (
      nextProject !== undefined &&
      project.id === nextProject.id &&
      project.label === nextProject.label &&
      project.path === nextProject.path &&
      project.createdAtUnixMs === nextProject.createdAtUnixMs &&
      project.lastUsedAtUnixMs === nextProject.lastUsedAtUnixMs &&
      project.updatedAtUnixMs === nextProject.updatedAtUnixMs
    );
  });
}
