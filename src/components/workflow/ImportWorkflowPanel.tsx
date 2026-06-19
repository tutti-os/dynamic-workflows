import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  LoadingIcon,
  Textarea,
  UploadIcon,
} from "@tutti-os/ui-system";
import { useState } from "react";
import { DiagnosticsPanel } from "@/components/workflow/DiagnosticsPanel";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";

type ImportWorkflowPanelProps = {
  script: string;
  isImporting: boolean;
  importError?: string;
  importDiagnostics: WorkflowDiagnostic[];
  onScriptChange: (value: string) => void;
  onImport: () => Promise<void>;
};

export function ImportWorkflowDialog(props: ImportWorkflowPanelProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        className="import-dialog-trigger"
        variant="outline"
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <UploadIcon data-icon="inline-start" />
        Import
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="import-dialog">
          <DialogHeader>
            <DialogTitle>Import script</DialogTitle>
            <DialogDescription>
              Paste a workflow script to create a local workflow.
            </DialogDescription>
          </DialogHeader>
          <div className="import-dialog-body">
            <div className="field">
              <label htmlFor="workflow-import-script">Workflow script</label>
              <Textarea
                id="workflow-import-script"
                className="import-textarea"
                value={props.script}
                rows={10}
                placeholder={
                  'export const meta = { name: "...", description: "..." };'
                }
                onChange={(event) => props.onScriptChange(event.target.value)}
              />
            </div>
            <DiagnosticsPanel
              message={props.importError}
              diagnostics={props.importDiagnostics}
            />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button
                type="button"
                size="dialog"
                variant="outline"
                disabled={props.isImporting}
              >
                Cancel
              </Button>
            </DialogClose>
            <Button
              type="button"
              size="dialog"
              onClick={() => void props.onImport()}
              disabled={props.isImporting || !props.script.trim()}
            >
              {props.isImporting ? (
                <LoadingIcon className="spin" data-icon="inline-start" />
              ) : (
                <UploadIcon data-icon="inline-start" />
              )}
              Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
