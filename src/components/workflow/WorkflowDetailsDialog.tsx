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

type WorkflowDetailsDialogProps = {
  open: boolean;
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
