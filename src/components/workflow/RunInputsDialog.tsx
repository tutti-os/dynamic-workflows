import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  PlayIcon,
  Spinner,
  Textarea,
} from "@tutti-os/ui-system";
import { useEffect } from "react";
import { AgentCatalogStatus } from "@/components/workflow/AgentCatalogStatus";
import {
  WorkflowAgentSelect,
  WorkflowModelSelect,
  WorkflowPermissionModeSelect,
} from "@/components/workflow/WorkflowRunSelectors";
import { WorkflowProjectSelect } from "@/components/workflow/WorkflowProjectSelect";
import type { AgentTargetOption } from "@/lib/agents/types";
import type {
  WorkflowInputDefinition,
  WorkflowInputSchema,
  WorkflowInputValue,
} from "@/lib/workflow/types";

type RunInputsDialogProps = {
  open: boolean;
  agents: AgentTargetOption[];
  agent: string;
  model: string;
  modelOptions: string[];
  permissionMode: string;
  permissionModeOptions: NonNullable<AgentTargetOption["permissionModes"]>;
  cwd: string;
  agentsLoading: boolean;
  agentsError?: string;
  agentsWarning?: string;
  requiresCwd: boolean;
  inputSchema: WorkflowInputSchema;
  workflowInputNames: string[];
  optionalWorkflowInputNames: string[];
  runInputValues: Record<string, WorkflowInputValue>;
  missingRunInputNames: string[];
  missingCwd: boolean;
  isRunning: boolean;
  onOpenChange: (open: boolean) => void;
  onAgentChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onPermissionModeChange: (value: string) => void;
  onCwdChange: (value: string) => void;
  onRetryAgents: () => Promise<void>;
  onRunInputChange: (name: string, value: WorkflowInputValue) => void;
  onRun: () => void;
};

export function RunInputsDialog(props: RunInputsDialogProps) {
  const requiredWorkflowInputNames = props.workflowInputNames.filter(
    (name) => !props.optionalWorkflowInputNames.includes(name),
  );
  const filledRunInputCount =
    requiredWorkflowInputNames.length - props.missingRunInputNames.length;
  const inputStatusLabel =
    requiredWorkflowInputNames.length > 0
      ? `${filledRunInputCount}/${requiredWorkflowInputNames.length}`
      : "optional";
  const hasMissingInputs = props.missingRunInputNames.length > 0;
  const agentsBlocked = props.agentsLoading || Boolean(props.agentsError);
  const isBlocked = hasMissingInputs || props.missingCwd || agentsBlocked;

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const firstInputName = props.workflowInputNames[0];
      const firstInput = firstInputName
        ? document.getElementById(`run-dialog-input-${firstInputName}`)
        : null;
      const fallback = document.querySelector<HTMLElement>(
        ".workflow-input-dialog input, .workflow-input-dialog textarea, .workflow-input-dialog button",
      );
      (firstInput as HTMLElement | null)?.focus();
      if (!firstInput) {
        fallback?.focus();
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.open, props.workflowInputNames]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="workflow-input-dialog">
        <DialogHeader>
          <DialogTitle>Run workflow</DialogTitle>
          <DialogDescription>
            Configure runtime options and start this workflow run.
          </DialogDescription>
        </DialogHeader>
        <div className="workflow-input-dialog-body">
          <section className="workflow-run-settings">
            <div className="field-heading">
              <label>Run settings</label>
            </div>
            <label className="run-dialog-control-field">
              <span>Agent</span>
              <WorkflowAgentSelect
                agents={props.agents}
                value={props.agent}
                disabled={agentsBlocked}
                onValueChange={props.onAgentChange}
              />
            </label>
            <label className="run-dialog-control-field">
              <span>Model</span>
              {props.modelOptions.length > 0 ? (
                <WorkflowModelSelect
                  models={props.modelOptions}
                  value={props.model}
                  disabled={agentsBlocked}
                  onValueChange={props.onModelChange}
                />
              ) : (
                <Input
                  value={props.model}
                  disabled={agentsBlocked}
                  placeholder="Default model"
                  aria-label="Agent model"
                  onChange={(event) => props.onModelChange(event.target.value)}
                />
              )}
            </label>
            <label className="run-dialog-control-field">
              <span>Permissions</span>
              <WorkflowPermissionModeSelect
                modes={props.permissionModeOptions}
                value={props.permissionMode}
                disabled={agentsBlocked}
                onValueChange={props.onPermissionModeChange}
              />
            </label>
            <label className="run-dialog-control-field run-dialog-control-field-wide">
              <span>
                Project
                {props.requiresCwd ? (
                  <Badge variant={props.missingCwd ? "warning" : "success"}>
                    required
                  </Badge>
                ) : null}
              </span>
              <WorkflowProjectSelect
                value={props.cwd}
                onChange={props.onCwdChange}
              />
            </label>
            {props.missingCwd ? (
              <span className="run-dialog-setting-hint">
                Select a project before running this workflow.
              </span>
            ) : null}
            <AgentCatalogStatus
              loading={props.agentsLoading}
              error={props.agentsError}
              warning={props.agentsWarning}
              onRetry={props.onRetryAgents}
            />
          </section>

          {props.workflowInputNames.length > 0 ? (
            <section className="workflow-run-inputs">
              <div className="workflow-input-dialog-status">
                <div className="field-heading">
                  <label>Inputs</label>
                  <Badge variant={hasMissingInputs ? "warning" : "success"}>
                    {inputStatusLabel}
                  </Badge>
                </div>
                <span>
                  {hasMissingInputs
                    ? `Missing: ${props.missingRunInputNames.join(", ")}`
                    : "Ready to run."}
                </span>
              </div>
              {props.workflowInputNames.map((name) => {
                const fieldId = `run-dialog-input-${name}`;
                const definition = props.inputSchema[name];
                const isMissing = props.missingRunInputNames.includes(name);
                const isOptional = props.optionalWorkflowInputNames.includes(name);
                return (
                  <div className="field" key={name}>
                    <label htmlFor={fieldId}>
                      {definition?.label ?? name}
                      {isOptional ? <Badge variant="default">optional</Badge> : null}
                    </label>
                    {renderWorkflowInputControl({
                      id: fieldId,
                      name,
                      definition,
                      value: props.runInputValues[name],
                      isMissing,
                      onChange: props.onRunInputChange,
                    })}
                    {definition?.description ? (
                      <span className="run-dialog-input-description">
                        {definition.description}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </section>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" size="dialog" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            size="dialog"
            onClick={props.onRun}
            disabled={isBlocked || props.isRunning}
          >
            {props.isRunning ? (
              <Spinner size={14} />
            ) : (
              <PlayIcon data-icon="inline-start" />
            )}
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function renderWorkflowInputControl(input: {
  id: string;
  name: string;
  definition: WorkflowInputDefinition | undefined;
  value: WorkflowInputValue | undefined;
  isMissing: boolean;
  onChange: (name: string, value: WorkflowInputValue) => void;
}) {
  const definition = input.definition;
  if (!definition || definition.type === "string") {
    const stringDefinition =
      definition?.type === "string" ? definition : undefined;
    if (stringDefinition?.widget === "text") {
      return (
        <Input
          id={input.id}
          value={String(input.value ?? "")}
          placeholder={stringDefinition.placeholder}
          aria-invalid={input.isMissing}
          onChange={(event) => input.onChange(input.name, event.target.value)}
        />
      );
    }
    return (
      <Textarea
        id={input.id}
        rows={stringDefinition?.widget === "textarea" ? 4 : 2}
        value={String(input.value ?? "")}
        placeholder={stringDefinition?.placeholder}
        aria-invalid={input.isMissing}
        onChange={(event) => input.onChange(input.name, event.target.value)}
      />
    );
  }

  if (definition.type === "number") {
    return (
      <Input
        id={input.id}
        type="number"
        min={definition.min}
        max={definition.max}
        step={definition.step}
        value={String(input.value ?? "")}
        aria-invalid={input.isMissing}
        onChange={(event) => input.onChange(input.name, event.target.value)}
      />
    );
  }

  if (definition.type === "boolean") {
    return (
      <label className="run-dialog-checkbox-field">
        <input
          id={input.id}
          type="checkbox"
          checked={input.value === true}
          onChange={(event) => input.onChange(input.name, event.target.checked)}
        />
        <span>{definition.description ?? definition.label ?? input.name}</span>
      </label>
    );
  }

  return (
    <select
      id={input.id}
      className="control-select"
      value={String(input.value ?? "")}
      aria-invalid={input.isMissing}
      onChange={(event) => input.onChange(input.name, event.target.value)}
    >
      {definition.required && definition.default === undefined ? (
        <option value="">Select {definition.label ?? input.name}</option>
      ) : null}
      {definition.options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
