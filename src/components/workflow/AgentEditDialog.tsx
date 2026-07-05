import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Button,
  CreateChatIcon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
  Textarea,
} from "@tutti-os/ui-system";
import { readApiJsonError } from "./workflowApiClient";
import {
  cancelWorkflowAgentEdit,
  listWorkflowAgentEdits,
  retryWorkflowAgentEdit,
  startWorkflowAgentEdit,
  watchWorkflowAgentEdit,
} from "./workflowApiService";
import { WorkflowProjectSelect } from "./WorkflowProjectSelect";
import {
  WorkflowAgentSelect,
  WorkflowModelSelect,
} from "./WorkflowRunSelectors";
import type {
  WorkflowEditJobRecord,
  WorkflowVersionRecord,
} from "@/lib/db/workflows";
import type { AgentTargetOption } from "@/lib/agents/types";

type AgentEditDialogProps = {
  open: boolean;
  workflowId: string;
  baseVersion: WorkflowVersionRecord | null;
  agents: AgentTargetOption[];
  agent: string;
  model: string;
  modelOptions: string[];
  cwd: string;
  onOpenChange: (open: boolean) => void;
  onAgentChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onCwdChange: (value: string) => void;
  onVersionCreated: (version: WorkflowVersionRecord) => Promise<void>;
  onOpenAgentSession: (agentSessionId: string) => Promise<void>;
  onLogEvent: (message: string) => void;
};

export function AgentEditDialog(props: AgentEditDialogProps) {
  const [instruction, setInstruction] = useState("");
  const [activeEdit, setActiveEdit] = useState<WorkflowEditJobRecord | null>(null);
  const [createdVersion, setCreatedVersion] =
    useState<WorkflowVersionRecord | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const pollingEditIdRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);
  const isActive = activeEdit?.status === "pending" || activeEdit?.status === "running";
  const status = activeEdit?.status ?? (createdVersion ? "completed" : "idle");

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("agent-edit-instruction")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [props.open]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void recoverActiveEdit();
    // Intentionally only keyed by workflow; agent/model changes should not
    // cause recovery requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workflowId]);

  async function recoverActiveEdit() {
    try {
      const edits = await listWorkflowAgentEdits(props.workflowId);
      const active = edits.find(
        (edit) => edit.status === "pending" || edit.status === "running",
      );
      if (!active || !mountedRef.current) {
        return;
      }
      setActiveEdit(active);
      setInstruction(active.instruction);
      setError(undefined);
      props.onOpenChange(true);
      void pollEdit(active.id);
    } catch (caught) {
      const apiError = readApiJsonError(caught, "WORKFLOW_EDIT_FAILED");
      setError(apiError.message);
    }
  }

  async function startEdit() {
    const trimmed = instruction.trim();
    if (!trimmed || !props.baseVersion) {
      return;
    }

    setIsSubmitting(true);
    setError(undefined);
    setCreatedVersion(null);
    try {
      const edit = await startWorkflowAgentEdit({
        workflowId: props.workflowId,
        instruction: trimmed,
        baseVersionId: props.baseVersion.id,
        agent: props.agent,
        model: props.model || undefined,
        cwd: props.cwd || undefined,
      });
      setActiveEdit(edit);
      props.onLogEvent(`agent edit: started from v${props.baseVersion.version}`);
      void pollEdit(edit.id);
    } catch (caught) {
      const apiError = readApiJsonError(caught, "WORKFLOW_EDIT_FAILED");
      setError(apiError.message);
      props.onLogEvent(`agent edit failed: ${apiError.message}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function pollEdit(editId: string) {
    if (pollingEditIdRef.current === editId) {
      return;
    }
    pollingEditIdRef.current = editId;

    try {
      const result = await watchWorkflowAgentEdit({
        workflowId: props.workflowId,
        editId,
        isMounted: () => mountedRef.current,
        onStatus: (data) => {
          if (!mountedRef.current) {
            return;
          }
          if (data.edit) {
            setActiveEdit(data.edit);
          }
        },
      });

      if (!result || !mountedRef.current) {
        return;
      }
      setActiveEdit(result.edit);
      if (result.edit.status === "canceled") {
        const message = result.edit.error?.message ?? "Workflow edit canceled";
        setError(message);
        props.onLogEvent("agent edit: canceled");
        return;
      }
      if (!result.version) {
        throw new Error("Workflow edit completed without a version");
      }
      setCreatedVersion(result.version);
      setError(undefined);
      props.onLogEvent(`agent edit: created v${result.version.version}`);
      await props.onVersionCreated(result.version);
    } catch (caught) {
      if (!mountedRef.current) {
        return;
      }
      const apiError = readApiJsonError(caught, "WORKFLOW_EDIT_FAILED");
      setError(apiError.message);
      props.onLogEvent(`agent edit failed: ${apiError.message}`);
    } finally {
      if (pollingEditIdRef.current === editId) {
        pollingEditIdRef.current = undefined;
      }
    }
  }

  function handleOpenChange(open: boolean) {
    props.onOpenChange(open);
  }

  async function cancelEdit() {
    if (!activeEdit || !isActive || isCancelling) {
      return;
    }
    setIsCancelling(true);
    setError(undefined);
    try {
      const data = await cancelWorkflowAgentEdit({
        workflowId: props.workflowId,
        editId: activeEdit.id,
      });
      if (data.edit) {
        setActiveEdit(data.edit);
      }
      props.onLogEvent("agent edit: cancel requested");
    } catch (caught) {
      const apiError = readApiJsonError(caught, "WORKFLOW_EDIT_FAILED");
      setError(apiError.message);
      props.onLogEvent(`agent edit cancel failed: ${apiError.message}`);
    } finally {
      setIsCancelling(false);
    }
  }

  async function retryEdit() {
    if (!activeEdit || isActive || isRetrying) {
      return;
    }
    setIsRetrying(true);
    setError(undefined);
    setCreatedVersion(null);
    try {
      const edit = await retryWorkflowAgentEdit({
        workflowId: props.workflowId,
        editId: activeEdit.id,
      });
      setActiveEdit(edit);
      setInstruction(edit.instruction);
      props.onLogEvent("agent edit: retry started");
      void pollEdit(edit.id);
    } catch (caught) {
      const apiError = readApiJsonError(caught, "WORKFLOW_EDIT_FAILED");
      setError(apiError.message);
      props.onLogEvent(`agent edit retry failed: ${apiError.message}`);
    } finally {
      setIsRetrying(false);
    }
  }

  const baseVersionLabel = props.baseVersion
    ? `v${props.baseVersion.version}`
    : "No version";
  const canStart =
    Boolean(props.baseVersion) && Boolean(instruction.trim()) && !isActive && !isSubmitting;
  const canRetry =
    !isActive &&
    (activeEdit?.status === "failed" || activeEdit?.status === "canceled");

  return (
    <Dialog open={props.open} onOpenChange={handleOpenChange}>
      <DialogContent className="agent-edit-dialog">
        <DialogHeader>
          <DialogTitle>AI edit workflow</DialogTitle>
          <DialogDescription>
            Create an unpublished version from a natural language change request.
          </DialogDescription>
        </DialogHeader>

        <div className="agent-edit-dialog-body">
          <div className="agent-edit-status-row">
            <Badge variant={status === "failed" ? "destructive" : isActive ? "pending" : "default"}>
              {formatStatus(status)}
            </Badge>
            <span>Base {baseVersionLabel}</span>
            {createdVersion ? <span>Created v{createdVersion.version}</span> : null}
            {activeEdit?.agentSessionId ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void props.onOpenAgentSession(activeEdit.agentSessionId!)}
              >
                Open session
              </Button>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="agent-edit-instruction">Change request</label>
            <Textarea
              id="agent-edit-instruction"
              rows={6}
              value={instruction}
              disabled={isActive}
              placeholder="Describe how this workflow should change."
              onChange={(event) => setInstruction(event.target.value)}
            />
          </div>

          <section className="agent-edit-settings">
            <label className="run-dialog-control-field">
              <span>Agent</span>
              <WorkflowAgentSelect
                agents={props.agents}
                value={props.agent}
                disabled={isActive}
                onValueChange={props.onAgentChange}
              />
            </label>
            <label className="run-dialog-control-field">
              <span>Model</span>
              {props.modelOptions.length > 0 ? (
                <WorkflowModelSelect
                  models={props.modelOptions}
                  value={props.model}
                  disabled={isActive}
                  onValueChange={props.onModelChange}
                />
              ) : (
                <Input
                  value={props.model}
                  disabled={isActive}
                  placeholder="Default model"
                  aria-label="Agent model"
                  onChange={(event) => props.onModelChange(event.target.value)}
                />
              )}
            </label>
            <label className="run-dialog-control-field run-dialog-control-field-wide">
              <span>Project</span>
              <WorkflowProjectSelect
                value={props.cwd}
                onChange={props.onCwdChange}
              />
            </label>
          </section>

          {error ? (
            <div className="form-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {isActive ? (
            <Button
              type="button"
              size="dialog"
              variant="outline"
              onClick={() => void cancelEdit()}
              disabled={isCancelling}
            >
              {isCancelling ? <Spinner size={14} /> : null}
              Cancel edit
            </Button>
          ) : null}
          {canRetry ? (
            <Button
              type="button"
              size="dialog"
              variant="outline"
              onClick={() => void retryEdit()}
              disabled={isRetrying}
            >
              {isRetrying ? <Spinner size={14} /> : null}
              Retry
            </Button>
          ) : null}
          <Button
            type="button"
            size="dialog"
            variant="outline"
            onClick={() => props.onOpenChange(false)}
          >
            Close
          </Button>
          <Button
            type="button"
            size="dialog"
            onClick={startEdit}
            disabled={!canStart}
          >
            {isSubmitting || isActive ? (
              <Spinner size={14} />
            ) : (
              <CreateChatIcon data-icon="inline-start" />
            )}
            {isActive ? "Editing" : "Start edit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatStatus(status: string): string {
  if (status === "idle") {
    return "ready";
  }
  return status;
}
