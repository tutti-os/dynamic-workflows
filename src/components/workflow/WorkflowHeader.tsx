import Link from "next/link";
import {
  ArrowLeftIcon,
  Badge,
  Button,
  DashboardIcon,
  EditIcon,
} from "@tutti-os/ui-system";
import type {
  WorkflowDetail,
  WorkflowVersionRecord,
} from "@/lib/db/workflows";
import { VersionSelect } from "@/components/workflow/VersionSelect";
import { WorkflowActionBar } from "@/components/workflow/WorkflowActionBar";

type WorkflowHeaderProps = {
  detail: WorkflowDetail;
  selectedVersion: WorkflowVersionRecord | null;
  dirty: boolean;
  saving: boolean;
  hasParseErrors: boolean;
  canRun: boolean;
  viewingOldVersion: boolean;
  duplicating: boolean;
  deleting: boolean;
  running: boolean;
  cancellingRun: boolean;
  onSelectVersion: (versionId: string) => void;
  onOpenDetails: () => void;
  onSave: () => void;
  onReset: () => void;
  onRestore: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
  onCancelRun: () => void;
  onRun: () => void;
};

export function WorkflowHeader(props: WorkflowHeaderProps) {
  return (
    <header className="detail-topbar">
      <div className="detail-titlebar">
        <Button asChild variant="outline" size="icon-lg" aria-label="Home">
          <Link href="/">
            <DashboardIcon />
          </Link>
        </Button>
        <Button asChild variant="outline" size="icon-lg" aria-label="Back to workflows">
          <Link href="/">
            <ArrowLeftIcon />
          </Link>
        </Button>
        <div className="detail-heading">
          <div className="detail-heading-title">
            <h1>{props.detail.workflow.name}</h1>
            <Button
              className="workflow-details-edit-button"
              variant="ghost"
              size="icon-sm"
              type="button"
              aria-label="Edit workflow details"
              title="Edit workflow details"
              onClick={props.onOpenDetails}
            >
              <EditIcon />
            </Button>
          </div>
          <div className="detail-meta">
            <VersionSelect
              versions={props.detail.versions}
              currentVersionId={props.detail.currentVersion.id}
              selectedVersionId={
                props.selectedVersion?.id ?? props.detail.currentVersion.id
              }
              onValueChange={props.onSelectVersion}
            />
            {props.viewingOldVersion ? (
              <Badge variant="warning">viewing old version</Badge>
            ) : null}
            {props.dirty ? <Badge variant="warning">unsaved</Badge> : null}
            <span className="detail-description">
              {props.detail.workflow.description}
            </span>
          </div>
        </div>
      </div>

      <WorkflowActionBar
        dirty={props.dirty}
        saving={props.saving}
        hasParseErrors={props.hasParseErrors}
        canRun={props.canRun}
        viewingOldVersion={props.viewingOldVersion}
        canExport={Boolean(props.selectedVersion)}
        duplicating={props.duplicating}
        deleting={props.deleting}
        running={props.running}
        cancellingRun={props.cancellingRun}
        onSave={props.onSave}
        onReset={props.onReset}
        onRestore={props.onRestore}
        onDuplicate={props.onDuplicate}
        onExport={props.onExport}
        onDelete={props.onDelete}
        onCancelRun={props.onCancelRun}
        onRun={props.onRun}
      />
    </header>
  );
}
