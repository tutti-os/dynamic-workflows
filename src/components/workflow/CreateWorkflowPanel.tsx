import {
  BareIconButton,
  Button,
  CreateChatIcon,
  FolderIcon,
  Input,
  LoadingIcon,
  NewWorkspaceIcon,
  ProductDocIcon,
  Textarea,
} from "@tutti-os/ui-system";
import type { ReactNode } from "react";
import { DiagnosticsPanel } from "@/components/workflow/DiagnosticsPanel";
import { WorkflowProjectSelect } from "@/components/workflow/WorkflowProjectSelect";
import {
  WorkflowAgentSelect,
  WorkflowModelSelect,
} from "@/components/workflow/WorkflowRunSelectors";
import type { AgentTargetOption } from "@/lib/agents/types";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";

type CreateWorkflowPanelProps = {
  prompt: string;
  agents: AgentTargetOption[];
  agent: string;
  model: string;
  modelOptions: string[];
  cwd: string;
  isCreating: boolean;
  createError?: string;
  createDiagnostics: WorkflowDiagnostic[];
  onPromptChange: (value: string) => void;
  onAgentChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onCwdChange: (value: string) => void;
  onCreate: () => Promise<void>;
};

export function CreateWorkflowPanel(props: CreateWorkflowPanelProps) {
  return (
    <form
      className="create-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onCreate();
      }}
    >
      <div className="prompt-composer">
        <CreateChatIcon className="prompt-composer-icon" size={20} />
        <Textarea
          value={props.prompt}
          rows={7}
          maxLength={2000}
          aria-label="Workflow prompt"
          className="prompt-textarea"
          placeholder="E.g., Scan a GitHub repository, summarize key files, and generate an implementation plan."
          onChange={(event) => props.onPromptChange(event.target.value)}
        />
        <div className="prompt-actions">
          <BareIconButton aria-label="Attach context" disabled>
            <FolderIcon />
          </BareIconButton>
          <BareIconButton aria-label="Insert workflow primitive" disabled>
            <ProductDocIcon />
          </BareIconButton>
        </div>
        <span className="prompt-count">{props.prompt.length} / 2000</span>
      </div>

      <div className="create-controls">
        <ControlField label="Agent">
          <WorkflowAgentSelect
            agents={props.agents}
            value={props.agent}
            fallbackValue="mock"
            onValueChange={props.onAgentChange}
          />
        </ControlField>
        <ControlField label="Model">
          {props.modelOptions.length > 0 ? (
            <WorkflowModelSelect
              models={props.modelOptions}
              value={props.model}
              onValueChange={props.onModelChange}
            />
          ) : (
            <Input
              value={props.model}
              placeholder="Default model"
              aria-label="Agent model"
              onChange={(event) => props.onModelChange(event.target.value)}
            />
          )}
        </ControlField>
        <ControlField label="Project">
          <WorkflowProjectSelect
            value={props.cwd}
            onChange={props.onCwdChange}
          />
        </ControlField>
        <Button
          className="create-button"
          disabled={props.isCreating}
          type="submit"
        >
          {props.isCreating ? (
            <LoadingIcon className="spin" data-icon="inline-start" />
          ) : (
            <NewWorkspaceIcon data-icon="inline-start" />
          )}
          Create
        </Button>
      </div>
      <DiagnosticsPanel
        message={props.createError}
        diagnostics={props.createDiagnostics}
      />
    </form>
  );
}

function ControlField(props: { label: string; children: ReactNode }) {
  return (
    <label className="control-field">
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}
