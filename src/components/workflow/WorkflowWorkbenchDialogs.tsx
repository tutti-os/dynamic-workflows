import { AgentEditDialog } from "@/components/workflow/AgentEditDialog";
import { RunInputsDialog } from "@/components/workflow/RunInputsDialog";
import { WorkflowDetailsDialog } from "@/components/workflow/WorkflowDetailsDialog";
import type {
  WorkflowVersionRecord,
} from "@/lib/db/workflows/types";
import type { AgentTargetOption } from "@/lib/agents/types";

export function WorkflowWorkbenchDialogs(props: {
  runInputsOpen: boolean;
  detailsOpen: boolean;
  agentEditOpen: boolean;
  workflowId: string;
  agents: AgentTargetOption[];
  agent: string;
  model: string;
  modelOptions: string[];
  cwd: string;
  requiresCwd: boolean;
  workflowInputNames: string[];
  optionalWorkflowInputNames: string[];
  runInputValues: Record<string, string>;
  missingRunInputNames: string[];
  missingCwd: boolean;
  isRunning: boolean;
  metadataName: string;
  metadataDescription: string;
  metadataDirty: boolean;
  isSavingMetadata: boolean;
  selectedVersion: WorkflowVersionRecord | null;
  onRunInputsOpenChange: (open: boolean) => void;
  onDetailsOpenChange: (open: boolean) => void;
  onAgentEditOpenChange: (open: boolean) => void;
  onAgentChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onCwdChange: (value: string) => void;
  onRunInputChange: (name: string, value: string) => void;
  onRun: () => void;
  onMetadataNameChange: (value: string) => void;
  onMetadataDescriptionChange: (value: string) => void;
  onSaveDetails: () => void;
  onAgentVersionCreated: (version: WorkflowVersionRecord) => Promise<void>;
  onOpenAgentSession: (agentSessionId: string) => Promise<void>;
  onLogEvent: (message: string) => void;
}) {
  return (
    <>
      <RunInputsDialog
        open={props.runInputsOpen}
        agents={props.agents}
        agent={props.agent}
        model={props.model}
        modelOptions={props.modelOptions}
        cwd={props.cwd}
        requiresCwd={props.requiresCwd}
        workflowInputNames={props.workflowInputNames}
        optionalWorkflowInputNames={props.optionalWorkflowInputNames}
        runInputValues={props.runInputValues}
        missingRunInputNames={props.missingRunInputNames}
        missingCwd={props.missingCwd}
        isRunning={props.isRunning}
        onOpenChange={props.onRunInputsOpenChange}
        onAgentChange={props.onAgentChange}
        onModelChange={props.onModelChange}
        onCwdChange={props.onCwdChange}
        onRunInputChange={props.onRunInputChange}
        onRun={props.onRun}
      />

      <WorkflowDetailsDialog
        open={props.detailsOpen}
        workflowId={props.workflowId}
        name={props.metadataName}
        description={props.metadataDescription}
        dirty={props.metadataDirty}
        saving={props.isSavingMetadata}
        onOpenChange={props.onDetailsOpenChange}
        onNameChange={props.onMetadataNameChange}
        onDescriptionChange={props.onMetadataDescriptionChange}
        onSave={props.onSaveDetails}
      />

      <AgentEditDialog
        open={props.agentEditOpen}
        workflowId={props.workflowId}
        baseVersion={props.selectedVersion}
        agents={props.agents}
        agent={props.agent}
        model={props.model}
        modelOptions={props.modelOptions}
        cwd={props.cwd}
        onOpenChange={props.onAgentEditOpenChange}
        onAgentChange={props.onAgentChange}
        onModelChange={props.onModelChange}
        onCwdChange={props.onCwdChange}
        onVersionCreated={props.onAgentVersionCreated}
        onOpenAgentSession={props.onOpenAgentSession}
        onLogEvent={props.onLogEvent}
      />
    </>
  );
}
