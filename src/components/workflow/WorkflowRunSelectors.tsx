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
} from "@/components/workflow/useWorkflowRunSettings";
import type {
  AgentPermissionModeOption,
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
