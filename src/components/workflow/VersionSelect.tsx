import {
  Badge,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@tutti-os/ui-system";
import type { WorkflowVersionRecord } from "@/lib/db/workflows";

type VersionSelectProps = {
  versions: WorkflowVersionRecord[];
  currentVersionId: string;
  selectedVersionId: string;
  onValueChange: (versionId: string) => void;
};

export function VersionSelect(props: VersionSelectProps) {
  const selected = props.versions.find(
    (version) => version.id === props.selectedVersionId,
  );
  const selectedLabel = selected ? `v${selected.version}` : "Version";

  return (
    <Select value={props.selectedVersionId} onValueChange={props.onValueChange}>
      <SelectTrigger className="version-select-trigger">
        <Badge
          variant={
            props.selectedVersionId === props.currentVersionId
              ? "success"
              : "warning"
          }
        >
          {selectedLabel}
        </Badge>
      </SelectTrigger>
      <SelectContent align="start">
        {props.versions.map((version) => (
          <SelectItem key={version.id} value={version.id}>
            v{version.version}
            {version.id === props.currentVersionId ? " · current" : ""}
            {" · "}
            {formatDate(version.createdAt)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
