import { WorkspaceUserProjectSelect } from "@tutti-os/workspace-user-project/ui";
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

export function WorkflowProjectSelect(props: WorkflowProjectSelectProps) {
  const [service, setService] = useState<TuttiUserProjectMirrorService | null>(
    null,
  );

  useEffect(() => {
    const api = readTuttiUserProjectApi();
    if (!api) {
      setService(null);
      return;
    }
    const nextService = createTuttiUserProjectMirrorService(api);
    setService(nextService);
    return () => {
      nextService.dispose();
    };
  }, []);

  return (
    <WorkspaceUserProjectSelect
      classNames={{
        content: "workflow-project-select-content",
        item: "workflow-project-select-item",
        trigger: "control-select workflow-project-select-trigger",
      }}
      contentAlign="start"
      contentSide="bottom"
      disabled={props.disabled || !service}
      service={service}
      selectedProjectPath={props.value || null}
      unlistedProjectLabel="Custom project"
      onProjectPathChange={(path) => props.onChange(path ?? "")}
    />
  );
}
