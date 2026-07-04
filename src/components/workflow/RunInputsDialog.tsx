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
  PlatformIcon,
  PlayIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Spinner,
  Textarea,
} from "@tutti-os/ui-system";
import { DEFAULT_MODEL_VALUE } from "@/components/workflow/useWorkflowRunSettings";
import { WorkflowProjectSelect } from "@/components/workflow/WorkflowProjectSelect";
import type { AgentTargetOption } from "@/lib/agents/types";

type RunInputsDialogProps = {
  open: boolean;
  agents: AgentTargetOption[];
  agent: string;
  model: string;
  modelOptions: string[];
  cwd: string;
  requiresCwd: boolean;
  workflowInputNames: string[];
  runInputValues: Record<string, string>;
  missingRunInputNames: string[];
  missingCwd: boolean;
  isRunning: boolean;
  onOpenChange: (open: boolean) => void;
  onAgentChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onCwdChange: (value: string) => void;
  onRunInputChange: (name: string, value: string) => void;
  onRun: () => void;
};

export function RunInputsDialog(props: RunInputsDialogProps) {
  const filledRunInputCount = props.workflowInputNames.filter((name) =>
    props.runInputValues[name]?.trim(),
  ).length;
  const hasMissingInputs = props.missingRunInputNames.length > 0;
  const isBlocked = hasMissingInputs || props.missingCwd;

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
              <AgentSelect
                agents={props.agents}
                value={props.agent}
                onValueChange={props.onAgentChange}
              />
            </label>
            <label className="run-dialog-control-field">
              <span>Model</span>
              {props.modelOptions.length > 0 ? (
                <ModelSelect
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
          </section>

          {props.workflowInputNames.length > 0 ? (
            <section className="workflow-run-inputs">
              <div className="workflow-input-dialog-status">
                <div className="field-heading">
                  <label>Inputs</label>
                  <Badge variant={hasMissingInputs ? "warning" : "success"}>
                    {filledRunInputCount}/{props.workflowInputNames.length}
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
                const isMissing = props.missingRunInputNames.includes(name);
                return (
                  <div className="field" key={name}>
                    <label htmlFor={fieldId}>{name}</label>
                    <Textarea
                      id={fieldId}
                      rows={name === "bug" ? 4 : 2}
                      value={props.runInputValues[name] ?? ""}
                      aria-invalid={isMissing}
                      onChange={(event) =>
                        props.onRunInputChange(name, event.target.value)
                      }
                    />
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

function AgentSelect(props: {
  agents: AgentTargetOption[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const selectedValue = props.value || props.agents[0]?.id || "";
  const selected = props.agents.find((item) => item.id === selectedValue);

  return (
    <Select
      value={selectedValue}
      onValueChange={(value) => {
        if (value) {
          props.onValueChange(value);
        }
      }}
    >
      <SelectTrigger className="control-select">
        <PlatformIcon size={16} />
        <span className="select-display">{selected?.name ?? "Agent"}</span>
      </SelectTrigger>
      <SelectContent align="start" style={{ zIndex: "var(--z-dialog-popover)" }}>
        {props.agents.map((item) => (
          <SelectItem key={item.id} value={item.id} disabled={!item.supported}>
            {item.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModelSelect(props: {
  models: string[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value || DEFAULT_MODEL_VALUE}
      onValueChange={(value) =>
        props.onValueChange(value === DEFAULT_MODEL_VALUE ? "" : value)
      }
    >
      <SelectTrigger className="control-select">
        <span className="select-display">
          {props.value || "Default model"}
        </span>
      </SelectTrigger>
      <SelectContent align="start" style={{ zIndex: "var(--z-dialog-popover)" }}>
        <SelectItem value={DEFAULT_MODEL_VALUE}>Default model</SelectItem>
        {props.models.map((item) => (
          <SelectItem key={item} value={item}>
            {item}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
