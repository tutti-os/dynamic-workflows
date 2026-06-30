import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@tutti-os/ui-system";
import type { WorkspaceUserProjectServiceSnapshot } from "@tutti-os/workspace-user-project/contracts";
import {
  Ban,
  Folder,
  Link as LinkIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { readTuttiUserProjectApi } from "@/lib/tutti/external";
import {
  createTuttiUserProjectMirrorService,
  type TuttiUserProjectMirrorService,
} from "@/lib/tutti/userProjectMirrorService";

type WorkflowProjectSelectProps = {
  disabled?: boolean;
  value: string;
  onChange: (value: string) => void;
};

const NO_PROJECT_VALUE = "__dynamic_workflows_no_project__";
const LINK_EXISTING_VALUE = "__dynamic_workflows_link_existing__";

export function WorkflowProjectSelect(props: WorkflowProjectSelectProps) {
  const [service, setService] = useState<TuttiUserProjectMirrorService | null>(
    null,
  );
  const [projectSnapshot, setProjectSnapshot] =
    useState<WorkspaceUserProjectServiceSnapshot | null>(null);

  useEffect(() => {
    const api = readTuttiUserProjectApi();
    if (!api) {
      setService(null);
      setProjectSnapshot(null);
      return;
    }
    const nextService = createTuttiUserProjectMirrorService(api);
    setService(nextService);
    setProjectSnapshot(nextService.getSnapshot?.() ?? null);
    const unsubscribe = nextService.subscribe?.(() => {
      setProjectSnapshot(nextService.getSnapshot?.() ?? null);
    });
    return () => {
      unsubscribe?.();
      nextService.dispose();
    };
  }, []);

  const projects = projectSnapshot?.projects ?? [];
  const selectedProject = projects.find((project) => project.path === props.value);
  const value = props.value || NO_PROJECT_VALUE;
  const disabled = props.disabled || !service;
  const triggerLabel = selectedProject
    ? selectedProject.label
    : props.value
      ? basenamePath(props.value)
      : "No project";

  return (
    <Select
      disabled={disabled}
      value={value}
      onValueChange={(nextValue) => {
        if (!service) {
          return;
        }
        if (nextValue === NO_PROJECT_VALUE) {
          void service.rememberDefaultSelection?.({ path: null });
          props.onChange("");
          return;
        }
        if (nextValue === LINK_EXISTING_VALUE) {
          void Promise.resolve(service.selectDirectory?.()).then(async (selection) => {
            const path = selection?.path?.trim() ?? "";
            if (!path) {
              return;
            }
            await service.registerProjectPath?.(path);
            void service.rememberDefaultSelection?.({ path });
            props.onChange(path);
          });
          return;
        }
        void service.rememberDefaultSelection?.({ path: nextValue });
        props.onChange(nextValue);
      }}
    >
      <SelectTrigger
        aria-label={disabled ? "Project unavailable" : "Project"}
        className="control-select workflow-project-select-trigger"
      >
        {props.value ? (
          <Folder aria-hidden size={16} />
        ) : (
          <Ban aria-hidden size={16} />
        )}
        <span className="select-display">{triggerLabel}</span>
      </SelectTrigger>
      <SelectContent
        align="start"
        side="bottom"
        sideOffset={4}
        collisionPadding={16}
        className="workflow-project-select-content"
        style={{ zIndex: "var(--z-dialog-popover)" }}
      >
        {projects.map((project) => (
          <SelectItem
            className="workflow-project-select-item"
            key={project.id || project.path}
            value={project.path}
          >
            <span className="project-select-item-label">
              <Folder aria-hidden size={15} />
              <span>{project.label}</span>
            </span>
          </SelectItem>
        ))}
        {service?.selectDirectory ? (
          <SelectItem
            className="workflow-project-select-item"
            value={LINK_EXISTING_VALUE}
          >
            <span className="project-select-item-label">
              <LinkIcon aria-hidden size={15} />
              <span>Link existing project</span>
            </span>
          </SelectItem>
        ) : null}
        <SelectItem
          className="workflow-project-select-item"
          value={NO_PROJECT_VALUE}
        >
          <span className="project-select-item-label">
            <Ban aria-hidden size={15} />
            <span>No project</span>
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}

function basenamePath(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).at(-1) || path;
}
