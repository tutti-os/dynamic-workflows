import {
  Input,
  SearchIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@tutti-os/ui-system";
import type { FlowStatusFilter } from "./useWorkflowHomeController";

type WorkflowIndexToolbarProps = {
  query: string;
  statusFilter: FlowStatusFilter;
  onQueryChange: (value: string) => void;
  onStatusFilterChange: (value: FlowStatusFilter) => void;
};

export function WorkflowIndexToolbar(props: WorkflowIndexToolbarProps) {
  return (
    <div className="workflow-tools">
      <label className="workflow-search-wrap">
        <SearchIcon size={15} />
        <Input
          className="workflow-search"
          value={props.query}
          placeholder="Search workflows"
          aria-label="Search workflows"
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
      </label>
      <RunStatusFilterSelect
        value={props.statusFilter}
        onValueChange={props.onStatusFilterChange}
      />
    </div>
  );
}

function RunStatusFilterSelect(props: {
  value: FlowStatusFilter;
  onValueChange: (value: FlowStatusFilter) => void;
}) {
  return (
    <Select
      value={props.value}
      onValueChange={(value) =>
        props.onValueChange(value as FlowStatusFilter)
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
        <SelectItem value="waiting_gate">waiting on gate</SelectItem>
        <SelectItem value="waiting_human">waiting for human</SelectItem>
        <SelectItem value="paused_failure">paused on failure</SelectItem>
        <SelectItem value="paused_uncertain">paused on uncertainty</SelectItem>
        <SelectItem value="paused_conflict">paused on conflict</SelectItem>
        <SelectItem value="paused_budget">paused on budget</SelectItem>
        <SelectItem value="pending">pending</SelectItem>
        <SelectItem value="interrupted">interrupted</SelectItem>
        <SelectItem value="completed">completed</SelectItem>
        <SelectItem value="failed">failed</SelectItem>
        <SelectItem value="canceled">canceled</SelectItem>
      </SelectContent>
    </Select>
  );
}
