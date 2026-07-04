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
  PlatformIcon,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Spinner,
  Textarea,
} from "@tutti-os/ui-system";
import { apiJson, readApiJsonError } from "./workflowApiClient";
import { DEFAULT_MODEL_VALUE } from "./useWorkflowRunSettings";
import { WorkflowProjectSelect } from "./WorkflowProjectSelect";
import type {
  WorkflowEditJobRecord,
  WorkflowVersionRecord,
} from "@/lib/db/workflows";
import type { AgentProviderOption } from "@/lib/agents/types";

type AgentEditDialogProps = {
  open: boolean;
  workflowId: string;
  baseVersion: WorkflowVersionRecord | null;
  providers: AgentProviderOption[];
  provider: string;
  model: string;
  modelOptions: string[];
  cwd: string;
  onOpenChange: (open: boolean) => void;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onCwdChange: (value: string) => void;
  onVersionCreated: (version: WorkflowVersionRecord) => Promise<void>;
  onOpenAgentSession: (agentSessionId: string) => Promise<void>;
  onLogEvent: (message: string) => void;
};

type EditListResponse = {
  edits?: WorkflowEditJobRecord[];
};

type EditStatusResponse = {
  edit?: WorkflowEditJobRecord;
  version?: WorkflowVersionRecord | null;
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
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void recoverActiveEdit();
    // Intentionally only keyed by workflow; provider/model changes should not
    // cause recovery requests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workflowId]);

  async function recoverActiveEdit() {
    try {
      const data = await apiJson<EditListResponse>(
        `/api/workflows/${props.workflowId}/agent-edits`,
        undefined,
        "WORKFLOW_EDIT_FAILED",
      );
      const active = (data.edits ?? []).find(
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
      const data = await apiJson<{ edit?: WorkflowEditJobRecord }>(
        `/api/workflows/${props.workflowId}/agent-edits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction: trimmed,
            baseVersionId: props.baseVersion.id,
            provider: props.provider,
            model: props.model || undefined,
            cwd: props.cwd || undefined,
          }),
        },
        "WORKFLOW_EDIT_FAILED",
      );
      if (!data.edit) {
        throw new Error("Workflow edit did not return a job");
      }
      setActiveEdit(data.edit);
      props.onLogEvent(`agent edit: started from v${props.baseVersion.version}`);
      void pollEdit(data.edit.id);
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
      while (mountedRef.current) {
        const data = await apiJson<EditStatusResponse>(
          `/api/workflows/${props.workflowId}/agent-edits/${editId}`,
          undefined,
          "WORKFLOW_EDIT_FAILED",
        );
        if (!data.edit) {
          throw new Error("Workflow edit status did not return a job");
        }

        setActiveEdit(data.edit);
        if (data.edit.status === "failed" || data.edit.status === "canceled") {
          const message = data.edit.error?.message ?? "Workflow edit failed";
          setError(message);
          props.onLogEvent(
            data.edit.status === "canceled"
              ? "agent edit: canceled"
              : `agent edit failed: ${message}`,
          );
          return;
        }
        if (data.edit.status === "completed") {
          if (!data.version) {
            throw new Error("Workflow edit completed without a version");
          }
          setCreatedVersion(data.version);
          setError(undefined);
          props.onLogEvent(`agent edit: created v${data.version.version}`);
          await props.onVersionCreated(data.version);
          return;
        }

        await delay(1000);
      }
    } catch (caught) {
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
      const data = await apiJson<EditStatusResponse>(
        `/api/workflows/${props.workflowId}/agent-edits/${activeEdit.id}/cancel`,
        { method: "POST" },
        "WORKFLOW_EDIT_FAILED",
      );
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
      const data = await apiJson<{ edit?: WorkflowEditJobRecord }>(
        `/api/workflows/${props.workflowId}/agent-edits/${activeEdit.id}/retry`,
        { method: "POST" },
        "WORKFLOW_EDIT_FAILED",
      );
      if (!data.edit) {
        throw new Error("Workflow edit retry did not return a job");
      }
      setActiveEdit(data.edit);
      setInstruction(data.edit.instruction);
      props.onLogEvent("agent edit: retry started");
      void pollEdit(data.edit.id);
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
              <span>Provider</span>
              <ProviderSelect
                providers={props.providers}
                value={props.provider}
                disabled={isActive}
                onValueChange={props.onProviderChange}
              />
            </label>
            <label className="run-dialog-control-field">
              <span>Model</span>
              {props.modelOptions.length > 0 ? (
                <ModelSelect
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

          {error ? <div className="form-error">{error}</div> : null}
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

function ProviderSelect(props: {
  providers: AgentProviderOption[];
  value: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
}) {
  const selectedValue = props.value || props.providers[0]?.id || "";
  const selected = props.providers.find((item) => item.id === selectedValue);

  return (
    <Select
      value={selectedValue}
      onValueChange={(value) => {
        if (value) {
          props.onValueChange(value);
        }
      }}
      disabled={props.disabled}
    >
      <SelectTrigger className="control-select">
        <PlatformIcon size={16} />
        <span className="select-display">{selected?.label ?? "Provider"}</span>
      </SelectTrigger>
      <SelectContent align="start" style={{ zIndex: "var(--z-dialog-popover)" }}>
        {props.providers.map((item) => (
          <SelectItem key={item.id} value={item.id} disabled={!item.supported}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ModelSelect(props: {
  models: string[];
  value: string;
  disabled: boolean;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select
      value={props.value || DEFAULT_MODEL_VALUE}
      disabled={props.disabled}
      onValueChange={(value) =>
        props.onValueChange(value === DEFAULT_MODEL_VALUE ? "" : value)
      }
    >
      <SelectTrigger className="control-select">
        <span className="select-display">
          {props.value || "Default model"}
        </span>
      </SelectTrigger>
      <SelectContent align="start" style={{ zIndex: "var(--z-dialog-popover)" }}>
        <SelectItem value={DEFAULT_MODEL_VALUE}>Default model</SelectItem>
        {props.models.map((item) => (
          <SelectItem key={item} value={item}>
            {item}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function formatStatus(status: string): string {
  if (status === "idle") {
    return "ready";
  }
  return status;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
