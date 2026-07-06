import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FileTextIcon,
  Input,
  Spinner,
  Textarea,
} from "@tutti-os/ui-system";
import { useEffect } from "react";
import { CopyToClipboardButton } from "@/components/workflow/CopyToClipboardButton";

type WorkflowDetailsDialogProps = {
  open: boolean;
  workflowId?: string;
  name: string;
  description: string;
  dirty: boolean;
  saving: boolean;
  onOpenChange: (open: boolean) => void;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSave: () => void;
};

export function WorkflowDetailsDialog(props: WorkflowDetailsDialogProps) {
  useEffect(() => {
    if (!props.open) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("workflow-details-name")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.open]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="workflow-details-dialog">
        <DialogHeader>
          <DialogTitle>Workflow details</DialogTitle>
          <DialogDescription>
            Update the name and description shown in the workflow header.
          </DialogDescription>
        </DialogHeader>
        <div className="workflow-details-dialog-body">
          {props.workflowId ? (
            <div className="field">
              <label htmlFor="workflow-details-id">Workflow ID</label>
              <div className="workflow-id-field">
                <Input id="workflow-details-id" value={props.workflowId} readOnly />
                <CopyToClipboardButton
                  size="sm"
                  variant="outline"
                  text={props.workflowId}
                  label="Copy ID"
                  title="Copy workflow ID for CLI usage"
                  aria-label="Copy workflow ID"
                />
              </div>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="workflow-details-name">Workflow name</label>
            <Input
              id="workflow-details-name"
              value={props.name}
              maxLength={120}
              onChange={(event) => props.onNameChange(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="workflow-details-description">Description</label>
            <Textarea
              id="workflow-details-description"
              rows={4}
              value={props.description}
              maxLength={500}
              onChange={(event) => props.onDescriptionChange(event.target.value)}
            />
          </div>
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
            onClick={props.onSave}
            disabled={props.saving || !props.dirty || !props.name.trim()}
          >
            {props.saving ? (
              <Spinner size={14} />
            ) : (
              <FileTextIcon data-icon="inline-start" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
