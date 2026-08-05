import {
  PlatformIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@tutti-os/ui-system";
import {
  DEFAULT_MODEL_VALUE,
  DEFAULT_PERMISSION_MODE_VALUE,
  DEFAULT_REASONING_EFFORT_VALUE,
} from "@/components/workflow/useWorkflowRunSettings";
import type {
  AgentPermissionModeOption,
  AgentReasoningEffortOption,
  AgentTargetOption,
} from "@/lib/agents/types";

export function WorkflowAgentSelect(props: {
  agents: AgentTargetOption[];
  value: string;
  disabled?: boolean;
  fallbackValue?: string;
  onValueChange: (value: string) => void;
}) {
  const selectedValue = props.value || props.agents[0]?.id || props.fallbackValue || "";
  const selected = props.agents.find((item) => item.id === selectedValue);

  return (
    <Select
      value={selectedValue}
      onValueChange={(value) => {
        if (value) {
          props.onValueChange(value);
        }
      }}
      disabled={props.disabled}
    >
      <SelectTrigger className="control-select">
        <PlatformIcon size={16} />
        <span className="select-display">{selected?.name ?? "Agent"}</span>
      </SelectTrigger>
      <SelectContent align="start" className="workflow-select-content">
        {props.agents.map((item) => (
          <SelectItem key={item.id} value={item.id} disabled={!item.supported}>
            {item.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function WorkflowModelSelect(props: {
  models: string[];
  value: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value || DEFAULT_MODEL_VALUE}
      disabled={props.disabled}
      onValueChange={(value) =>
        props.onValueChange(value === DEFAULT_MODEL_VALUE ? "" : value)
      }
    >
      <SelectTrigger className="control-select">
        <span className="select-display">
          {props.value || "Default model"}
        </span>
      </SelectTrigger>
      <SelectContent align="start" className="workflow-select-content">
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

export function WorkflowPermissionModeSelect(props: {
  modes: AgentPermissionModeOption[];
  value: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  const selected = props.modes.find((mode) => mode.id === props.value);
  return (
    <Select
      value={props.value || DEFAULT_PERMISSION_MODE_VALUE}
      disabled={props.disabled}
      onValueChange={(value) =>
        props.onValueChange(
          value === DEFAULT_PERMISSION_MODE_VALUE ? "" : value,
        )
      }
    >
      <SelectTrigger className="control-select">
        <span className="select-display">
          {selected?.label ?? "Default permissions"}
        </span>
      </SelectTrigger>
      <SelectContent align="start" className="workflow-select-content">
        <SelectItem value={DEFAULT_PERMISSION_MODE_VALUE}>
          Default permissions
        </SelectItem>
        {props.modes.map((mode) => (
          <SelectItem key={mode.id} value={mode.id}>
            {mode.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function WorkflowReasoningEffortSelect(props: {
  efforts: AgentReasoningEffortOption[];
  value: string;
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  const selected = props.efforts.find((effort) => effort.id === props.value);
  const hasCurrentValue =
    Boolean(props.value) && !selected && props.value !== DEFAULT_REASONING_EFFORT_VALUE;

  return (
    <Select
      value={props.value || DEFAULT_REASONING_EFFORT_VALUE}
      disabled={props.disabled}
      onValueChange={(value) =>
        props.onValueChange(
          value === DEFAULT_REASONING_EFFORT_VALUE ? "" : value,
        )
      }
    >
      <SelectTrigger className="control-select">
        <span className="select-display">
          {selected?.label ?? (hasCurrentValue ? props.value : "Agent default")}
        </span>
      </SelectTrigger>
      <SelectContent align="start" className="workflow-select-content">
        <SelectItem value={DEFAULT_REASONING_EFFORT_VALUE}>
          Agent default
        </SelectItem>
        {hasCurrentValue ? (
          <SelectItem value={props.value}>{props.value}</SelectItem>
        ) : null}
        {props.efforts.map((effort) => (
          <SelectItem key={effort.id} value={effort.id}>
            {effort.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
