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
  UploadIcon,
} from "@tutti-os/ui-system";
import { useRef, useState } from "react";
import { DiagnosticsPanel } from "@/components/workflow/DiagnosticsPanel";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";

type ImportWorkflowPanelProps = {
  file?: File;
  isImporting: boolean;
  importError?: string;
  importDiagnostics: WorkflowDiagnostic[];
  onFileChange: (file: File | undefined) => void;
  onImport: () => Promise<void>;
};

export function ImportWorkflowDialog(props: ImportWorkflowPanelProps) {
  const [open, setOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const selectedFile = props.file;

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
            <DialogTitle>Import workflow</DialogTitle>
            <DialogDescription>
              Choose a workflow script file to create a local workflow.
            </DialogDescription>
          </DialogHeader>
          <div className="import-dialog-body">
            <div className="field">
              <label htmlFor="workflow-import-file">Workflow file</label>
              <input
                id="workflow-import-file"
                ref={fileInputRef}
                className="import-file-input"
                type="file"
                accept=".js,.mjs,.ts,.workflow.js,text/javascript,application/javascript,text/plain"
                disabled={props.isImporting}
                onChange={(event) =>
                  props.onFileChange(event.target.files?.[0])
                }
              />
              <div className="import-file-picker">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    if (fileInputRef.current) {
                      fileInputRef.current.value = "";
                      fileInputRef.current.click();
                    }
                  }}
                  disabled={props.isImporting}
                >
                  <UploadIcon data-icon="inline-start" />
                  Choose file
                </Button>
                {selectedFile ? (
                  <div className="import-file-meta">
                    <span className="import-file-name">{selectedFile.name}</span>
                    <span>{formatFileSize(selectedFile.size)}</span>
                  </div>
                ) : (
                  <div className="field-hint import-file-hint">
                    Select a .js, .mjs, .ts, or .workflow.js file.
                  </div>
                )}
              </div>
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
              disabled={props.isImporting || !selectedFile}
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

function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
