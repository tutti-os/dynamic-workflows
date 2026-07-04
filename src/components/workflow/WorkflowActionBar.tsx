import {
  Button,
  CreateChatIcon,
  DownloadIcon,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  FailedLinedIcon,
  FileCreateIcon,
  MoreHorizontalIcon,
  PlayIcon,
  RestoreIcon,
  Spinner,
} from "@tutti-os/ui-system";

type WorkflowActionBarProps = {
  dirty: boolean;
  saving: boolean;
  hasParseErrors: boolean;
  canRun: boolean;
  viewingOldVersion: boolean;
  agentEditing: boolean;
  publishingVersion: boolean;
  canExport: boolean;
  duplicating: boolean;
  deleting: boolean;
  running: boolean;
  cancellingRun: boolean;
  onSave: () => void;
  onReset: () => void;
  onRestore: () => void;
  onAgentEdit: () => void;
  onPublishVersion: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onCancelRun: () => void;
  onRun: () => void;
};

export function WorkflowActionBar(props: WorkflowActionBarProps) {
  return (
    <div className="detail-controls">
      {props.dirty ? (
        <>
          <Button
            variant="outline"
            onClick={props.onSave}
            disabled={props.saving || props.hasParseErrors}
          >
            {props.saving ? (
              <Spinner size={14} />
            ) : (
              <FileCreateIcon data-icon="inline-start" />
            )}
            Save
          </Button>
          <Button
            variant="outline"
            onClick={props.onReset}
            disabled={props.saving}
          >
            <RestoreIcon data-icon="inline-start" />
            Reset
          </Button>
        </>
      ) : null}
      {props.viewingOldVersion ? (
        <Button
          variant="outline"
          onClick={props.onPublishVersion}
          disabled={props.publishingVersion || props.dirty || props.hasParseErrors}
          title={
            props.dirty
              ? "Save or discard local edits before publishing this version"
              : "Set this version as the official workflow version"
          }
        >
          {props.publishingVersion ? (
            <Spinner size={14} />
          ) : (
            <FileCreateIcon data-icon="inline-start" />
          )}
          Publish version
        </Button>
      ) : null}
      {props.viewingOldVersion ? (
        <Button
          variant="outline"
          onClick={props.onRestore}
          disabled={props.saving || props.dirty || props.hasParseErrors}
          title={
            props.dirty
              ? "Save or discard local edits before restoring this version"
              : "Restore this version as a new current version"
          }
        >
          {props.saving ? (
            <Spinner size={14} />
          ) : (
            <RestoreIcon data-icon="inline-start" />
          )}
          Restore as new version
        </Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-lg"
            aria-label="More workflow actions"
            title="More workflow actions"
          >
            <MoreHorizontalIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="workflow-actions-menu">
          <DropdownMenuItem
            onSelect={() => props.onAgentEdit()}
            disabled={props.agentEditing || props.dirty || props.running}
          >
            {props.agentEditing ? (
              <Spinner size={14} />
            ) : (
              <CreateChatIcon data-icon="inline-start" />
            )}
            AI edit
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => props.onDuplicate()}
            disabled={props.duplicating || props.deleting}
          >
            {props.duplicating ? (
              <Spinner size={14} />
            ) : (
              <FileCreateIcon data-icon="inline-start" />
            )}
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => props.onExport()}
            disabled={!props.canExport}
          >
            <DownloadIcon data-icon="inline-start" />
            Export
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => props.onDelete()}
            disabled={props.deleting || props.running}
          >
            {props.deleting ? (
              <Spinner size={14} />
            ) : (
              <FailedLinedIcon data-icon="inline-start" />
            )}
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {props.running ? (
        <Button
          className="cancel-run-button"
          variant="outline"
          onClick={props.onCancelRun}
          disabled={props.cancellingRun}
        >
          {props.cancellingRun ? (
            <Spinner size={14} />
          ) : (
            <FailedLinedIcon data-icon="inline-start" />
          )}
          Cancel
        </Button>
      ) : (
        <Button
          className="run-button"
          onClick={props.onRun}
          disabled={!props.canRun}
        >
          <PlayIcon data-icon="inline-start" />
          Run
        </Button>
      )}
    </div>
  );
}
