import {
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@tutti-os/ui-system";
import type { WorkflowRunStatus } from "@/lib/db/workflows";

type WorkflowIndexToolbarProps = {
  query: string;
  statusFilter: WorkflowRunStatus | "all";
  onQueryChange: (value: string) => void;
  onStatusFilterChange: (value: WorkflowRunStatus | "all") => void;
};

export function WorkflowIndexToolbar(props: WorkflowIndexToolbarProps) {
  return (
    <div className="workflow-tools">
      <Input
        className="workflow-search"
        value={props.query}
        placeholder="Search workflows"
        aria-label="Search workflows"
        onChange={(event) => props.onQueryChange(event.target.value)}
      />
      <RunStatusFilterSelect
        value={props.statusFilter}
        onValueChange={props.onStatusFilterChange}
      />
    </div>
  );
}

function RunStatusFilterSelect(props: {
  value: WorkflowRunStatus | "all";
  onValueChange: (value: WorkflowRunStatus | "all") => void;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(value) =>
        props.onValueChange(value as WorkflowRunStatus | "all")
      }
    >
      <SelectTrigger className="workflow-status-filter">
        <span className="select-display">
          {props.value === "all" ? "All statuses" : props.value}
        </span>
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="all">All statuses</SelectItem>
        <SelectItem value="running">running</SelectItem>
        <SelectItem value="interrupted">interrupted</SelectItem>
        <SelectItem value="completed">completed</SelectItem>
        <SelectItem value="failed">failed</SelectItem>
        <SelectItem value="canceled">canceled</SelectItem>
      </SelectContent>
    </Select>
  );
}
