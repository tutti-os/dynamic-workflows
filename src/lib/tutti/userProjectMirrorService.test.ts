import { describe, expect, it } from "vitest";
import type { WorkspaceUserProjectServiceSnapshot } from "@tutti-os/workspace-user-project/contracts";
import type { TuttiUserProjectApi } from "@/lib/tutti/external";
import { createTuttiUserProjectMirrorService } from "@/lib/tutti/userProjectMirrorService";

describe("tutti user project mirror service", () => {
  it("loads and mirrors host user project snapshots", async () => {
    const firstSnapshot = snapshotWithProject("repo-a", 1);
    const secondSnapshot = snapshotWithProject("repo-b", 2);
    const hostListeners: Array<
      (snapshot: WorkspaceUserProjectServiceSnapshot) => void
    > = [];
    let didUnsubscribe = false;
    const api: TuttiUserProjectApi = {
      async list() {
        return { projects: [] };
      },
      async refresh() {
        return firstSnapshot;
      },
      subscribe(listener) {
        hostListeners.push(listener);
        return () => {
          didUnsubscribe = true;
        };
      },
    };

    const service = createTuttiUserProjectMirrorService(api);
    await service.refresh();

    expect(service.store.projects.map((project) => project.id)).toEqual([
      "repo-a",
    ]);
    expect(service.store.revision).toBe(1);

    expect(hostListeners).toHaveLength(1);
    hostListeners[0]?.(secondSnapshot);

    expect(service.store.projects.map((project) => project.id)).toEqual([
      "repo-b",
    ]);
    expect(service.store.revision).toBe(2);

    service.dispose();
    expect(didUnsubscribe).toBe(true);
  });
});

function snapshotWithProject(
  id: string,
  revision: number,
): WorkspaceUserProjectServiceSnapshot {
  return {
    error: null,
    initialized: true,
    isLoading: false,
    projects: [{ id, label: id, path: `/workspace/${id}` }],
    revision,
  };
}
