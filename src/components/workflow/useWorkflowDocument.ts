import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  delay,
  downloadTextFile,
  sanitizeFilename,
} from "@/components/workflow/workflowClientUtils";
import {
  apiJson,
  readApiJsonError,
} from "@/components/workflow/workflowApiClient";
import type {
  WorkflowEditJobRecord,
  WorkflowDetail,
  WorkflowVersionRecord,
} from "@/lib/db/workflows";
import type { WorkflowDiagnostic } from "@/lib/workflow/types";

export function useWorkflowDocument(input: {
  workflowId: string;
  script: string;
  isScriptDirty: boolean;
  acceptSavedScript: (nextScript: string) => void;
  clearScriptSaveFeedback: () => void;
  setScriptSaveFailure: (
    message: string,
    diagnostics?: WorkflowDiagnostic[],
  ) => void;
  setParseErrorMessage: (message: string) => void;
  onVersionApplied: () => void;
  onLogEvent: (message: string) => void;
}): {
  detail: WorkflowDetail | null;
  selectedVersion: WorkflowVersionRecord | null;
  versionLabelById: Record<string, string>;
  metadataName: string;
  metadataDescription: string;
  metadataDirty: boolean;
  detailsDialogOpen: boolean;
  isLoading: boolean;
  isSaving: boolean;
  isSavingMetadata: boolean;
  isDuplicatingWorkflow: boolean;
  isDeletingWorkflow: boolean;
  isGeneratingWorkflow: boolean;
  isRetryingGeneration: boolean;
  isAgentEditingWorkflow: boolean;
  isPublishingVersion: boolean;
  generationError: string | undefined;
  agentEditError: string | undefined;
  isViewingCurrentVersion: boolean;
  isViewingOldVersion: boolean;
  setMetadataName: (value: string) => void;
  setMetadataDescription: (value: string) => void;
  loadWorkflow: (options?: { resetScript?: boolean }) => Promise<WorkflowDetail>;
  applyVersion: (version: WorkflowVersionRecord) => void;
  selectVersion: (versionId: string) => void;
  saveCurrentVersion: () => Promise<void>;
  restoreSelectedVersion: () => Promise<void>;
  openDetailsDialog: () => void;
  handleDetailsDialogOpenChange: (open: boolean) => void;
  saveDetailsDialog: () => Promise<void>;
  duplicateCurrentWorkflow: () => Promise<void>;
  deleteCurrentWorkflow: () => Promise<void>;
  retryWorkflowGeneration: () => Promise<void>;
  agentEditWorkflow: (input: {
    instruction: string;
    baseVersionId?: string;
    agent?: string;
    model?: string;
    cwd?: string;
  }) => Promise<void>;
  publishSelectedVersion: () => Promise<void>;
  exportSelectedVersion: () => void;
} {
  const {
    workflowId,
    script,
    isScriptDirty,
    acceptSavedScript,
    clearScriptSaveFeedback,
    setScriptSaveFailure,
    setParseErrorMessage,
    onVersionApplied,
    onLogEvent,
  } = input;
  const router = useRouter();
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | undefined>();
  const [metadataName, setMetadataName] = useState("");
  const [metadataDescription, setMetadataDescription] = useState("");
  const [detailsDialogOpen, setDetailsDialogOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingMetadata, setIsSavingMetadata] = useState(false);
  const [isDuplicatingWorkflow, setIsDuplicatingWorkflow] = useState(false);
  const [isDeletingWorkflow, setIsDeletingWorkflow] = useState(false);
  const [isRetryingGeneration, setIsRetryingGeneration] = useState(false);
  const [isAgentEditingWorkflow, setIsAgentEditingWorkflow] = useState(false);
  const [isPublishingVersion, setIsPublishingVersion] = useState(false);
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [agentEditError, setAgentEditError] = useState<string | undefined>();
  const generationWatchIdRef = useRef<string | undefined>(undefined);
  const mountedRef = useRef(true);

  const selectedVersion = useMemo(() => {
    if (!detail) {
      return null;
    }
    return (
      detail.versions.find((version) => version.id === selectedVersionId) ??
      detail.currentVersion ??
      null
    );
  }, [detail, selectedVersionId]);

  const versionLabelById = useMemo(() => {
    return Object.fromEntries(
      (detail?.versions ?? []).map((version) => [
        version.id,
        `v${version.version}`,
      ]),
    );
  }, [detail?.versions]);

  const metadataDirty =
    detail !== null &&
    (metadataName !== detail.workflow.name ||
      metadataDescription !== detail.workflow.description);
  const isViewingCurrentVersion =
    Boolean(detail && selectedVersion && detail.currentVersion) &&
    selectedVersion?.id === detail?.currentVersion?.id;
  const isViewingOldVersion =
    Boolean(detail && selectedVersion) && !isViewingCurrentVersion;
  const isGeneratingWorkflow =
    detail?.generation?.status === "pending" ||
    detail?.generation?.status === "running";

  const applyLoadedDetail = useCallback(
    (nextDetail: WorkflowDetail, options?: { resetScript?: boolean }) => {
      setDetail(nextDetail);
      setMetadataName(nextDetail.workflow.name);
      setMetadataDescription(nextDetail.workflow.description);
      if (options?.resetScript) {
        if (nextDetail.currentVersion) {
          setSelectedVersionId(nextDetail.currentVersion.id);
          acceptSavedScript(nextDetail.currentVersion.script);
        } else {
          setSelectedVersionId(undefined);
        }
      }
    },
    [acceptSavedScript],
  );

  const loadWorkflow = useCallback(
    async (options?: { resetScript?: boolean }) => {
      const nextDetail = await apiJson<WorkflowDetail>(
        `/api/workflows/${workflowId}`,
        undefined,
        "WORKFLOW_NOT_FOUND",
      );
      applyLoadedDetail(nextDetail, options);
      return nextDetail;
    },
    [applyLoadedDetail, workflowId],
  );

  const requestWorkflowGeneration = useCallback(
    async (retry: boolean) => {
      const data = await apiJson<{ detail?: WorkflowDetail }>(
        `/api/workflows/${workflowId}/generation`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retry }),
        },
        "WORKFLOW_GENERATION_FAILED",
      );
      if (!data.detail) {
        throw new Error("Workflow generation did not return detail");
      }
      applyLoadedDetail(data.detail, { resetScript: true });
      return data.detail;
    },
    [applyLoadedDetail, workflowId],
  );

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setIsLoading(true);
    loadWorkflow({ resetScript: true })
      .catch((error) => {
        setParseErrorMessage(
          error instanceof Error ? error.message : "Load failed",
        );
      })
      .finally(() => setIsLoading(false));
  }, [loadWorkflow, setParseErrorMessage]);

  useEffect(() => {
    const generation = detail?.generation;
    if (
      !detail ||
      detail.currentVersion ||
      !generation ||
      !isActiveGenerationStatus(generation.status)
    ) {
      return;
    }
    if (generationWatchIdRef.current === generation.id) {
      return;
    }

    const generationId = generation.id;
    generationWatchIdRef.current = generationId;

    async function watchGeneration() {
      try {
        setGenerationError(undefined);
        const startedDetail = await requestWorkflowGeneration(false);
        if (
          !mountedRef.current ||
          startedDetail.currentVersion ||
          !isActiveGenerationStatus(startedDetail.generation?.status)
        ) {
          return;
        }

        while (mountedRef.current) {
          await delay(1000);
          if (!mountedRef.current) {
            return;
          }
          const nextDetail = await loadWorkflow({ resetScript: true });
          if (
            nextDetail.currentVersion ||
            !isActiveGenerationStatus(nextDetail.generation?.status)
          ) {
            return;
          }
        }
      } catch (error) {
        const apiError = readApiJsonError(error, "WORKFLOW_GENERATION_FAILED");
        if (mountedRef.current) {
          setGenerationError(apiError.message);
          onLogEvent(`generation failed: ${apiError.message}`);
        }
      } finally {
        if (generationWatchIdRef.current === generationId) {
          generationWatchIdRef.current = undefined;
        }
      }
    }

    void watchGeneration();

  }, [
    detail?.workflow.id,
    detail?.currentVersion?.id,
    detail?.generation?.id,
    detail?.generation?.status,
    loadWorkflow,
    onLogEvent,
    requestWorkflowGeneration,
  ]);

  const applyVersion = useCallback(
    (version: WorkflowVersionRecord) => {
      setSelectedVersionId(version.id);
      acceptSavedScript(version.script);
      onVersionApplied();
    },
    [acceptSavedScript, onVersionApplied],
  );

  function selectVersion(versionId: string) {
    if (!detail) {
      return;
    }
    const version = detail.versions.find((item) => item.id === versionId);
    if (!version || version.id === selectedVersion?.id) {
      return;
    }
    if (
      isScriptDirty &&
      !window.confirm("Discard unsaved changes and switch versions?")
    ) {
      return;
    }
    applyVersion(version);
    onLogEvent(`viewing: v${version.version}`);
  }

  async function saveCurrentVersion() {
    setIsSaving(true);
    clearScriptSaveFeedback();
    try {
      const data = await apiJson<{ detail?: WorkflowDetail }>(
        `/api/workflows/${workflowId}/versions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script }),
        },
        "WORKFLOW_SAVE_FAILED",
      );
      if (!data.detail?.currentVersion) {
        throw new Error("Workflow save failed");
      }
      applyLoadedDetail(data.detail, { resetScript: true });
      onLogEvent(
        `saved: v${data.detail.currentVersion.version}`,
      );
      clearScriptSaveFeedback();
    } catch (error) {
      const apiError = readApiJsonError(error, "WORKFLOW_SAVE_FAILED");
      setScriptSaveFailure(apiError.message, apiError.diagnostics ?? []);
      onLogEvent(
        `save failed: ${apiError.message}`,
      );
    } finally {
      setIsSaving(false);
    }
  }

  async function saveWorkflowMetadata(): Promise<boolean> {
    if (!metadataName.trim()) {
      onLogEvent("details failed: name is required");
      return false;
    }

    setIsSavingMetadata(true);
    try {
      const data = await apiJson<WorkflowDetail>(
        `/api/workflows/${workflowId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: metadataName,
            description: metadataDescription,
          }),
        },
        "WORKFLOW_UPDATE_FAILED",
      );
      if (!data.workflow) {
        throw new Error("Workflow update failed");
      }
      setDetail(data);
      setMetadataName(data.workflow.name);
      setMetadataDescription(data.workflow.description);
      onLogEvent("details: saved");
      return true;
    } catch (error) {
      const apiError = readApiJsonError(error, "WORKFLOW_UPDATE_FAILED");
      onLogEvent(
        `details failed: ${apiError.message}`,
      );
      return false;
    } finally {
      setIsSavingMetadata(false);
    }
  }

  function openDetailsDialog() {
    if (detail) {
      setMetadataName(detail.workflow.name);
      setMetadataDescription(detail.workflow.description);
    }
    setDetailsDialogOpen(true);
  }

  function handleDetailsDialogOpenChange(open: boolean) {
    if (!open && detail && !isSavingMetadata) {
      setMetadataName(detail.workflow.name);
      setMetadataDescription(detail.workflow.description);
    }
    setDetailsDialogOpen(open);
  }

  async function saveDetailsDialog() {
    const saved = await saveWorkflowMetadata();
    if (saved) {
      setDetailsDialogOpen(false);
    }
  }

  async function duplicateCurrentWorkflow() {
    setIsDuplicatingWorkflow(true);
    try {
      const data = await apiJson<WorkflowDetail>(
        `/api/workflows/${workflowId}/duplicate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            versionId: selectedVersion?.id,
          }),
        },
        "WORKFLOW_DUPLICATE_FAILED",
      );
      if (!data.workflow) {
        throw new Error("Workflow duplication failed");
      }
      router.push(`/workflows/${data.workflow.id}`);
    } catch (error) {
      const apiError = readApiJsonError(error, "WORKFLOW_DUPLICATE_FAILED");
      onLogEvent(
        `duplicate failed: ${apiError.message}`,
      );
    } finally {
      setIsDuplicatingWorkflow(false);
    }
  }

  async function deleteCurrentWorkflow() {
    if (!detail) {
      return;
    }
    if (
      !window.confirm(
        `Delete workflow "${detail.workflow.name}" and all local runs?`,
      )
    ) {
      return;
    }

    setIsDeletingWorkflow(true);
    try {
      await apiJson<{ ok: boolean }>(
        `/api/workflows/${workflowId}`,
        {
          method: "DELETE",
        },
        "WORKFLOW_DELETE_FAILED",
      );
      router.push("/");
    } catch (error) {
      const apiError = readApiJsonError(error, "WORKFLOW_DELETE_FAILED");
      onLogEvent(
        `delete failed: ${apiError.message}`,
      );
      setIsDeletingWorkflow(false);
    }
  }

  async function restoreSelectedVersion() {
    if (!selectedVersion || isViewingCurrentVersion || isScriptDirty) {
      return;
    }

    setIsSaving(true);
    clearScriptSaveFeedback();
    try {
      const data = await apiJson<{ detail?: WorkflowDetail }>(
        `/api/workflows/${workflowId}/versions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script: selectedVersion.script }),
        },
        "WORKFLOW_SAVE_FAILED",
      );
      if (!data.detail?.currentVersion) {
        throw new Error("Workflow restore failed");
      }
      applyLoadedDetail(data.detail, { resetScript: true });
      onLogEvent(
        `restored: v${selectedVersion.version} -> v${data.detail.currentVersion.version}`,
      );
      clearScriptSaveFeedback();
    } catch (error) {
      const apiError = readApiJsonError(error, "WORKFLOW_SAVE_FAILED");
      setScriptSaveFailure(apiError.message, apiError.diagnostics ?? []);
      onLogEvent(
        `restore failed: ${apiError.message}`,
      );
    } finally {
      setIsSaving(false);
    }
  }

  function exportSelectedVersion() {
    if (!detail || !selectedVersion) {
      return;
    }

    const filename = `${sanitizeFilename(detail.workflow.name)}-v${selectedVersion.version}.workflow.js`;
    downloadTextFile({
      filename,
      content: selectedVersion.script,
      mimeType: "text/javascript;charset=utf-8",
    });
    onLogEvent(`exported: ${filename}`);
  }

  async function retryWorkflowGeneration() {
    setIsRetryingGeneration(true);
    setGenerationError(undefined);
    generationWatchIdRef.current = undefined;
    try {
      const nextDetail = await requestWorkflowGeneration(true);
      if (!nextDetail.currentVersion) {
        onLogEvent("generation: retry started");
      }
    } catch (error) {
      const apiError = readApiJsonError(error, "WORKFLOW_GENERATION_FAILED");
      setGenerationError(apiError.message);
      onLogEvent(`generation retry failed: ${apiError.message}`);
    } finally {
      setIsRetryingGeneration(false);
    }
  }

  async function agentEditWorkflow(input: {
    instruction: string;
    baseVersionId?: string;
    agent?: string;
    model?: string;
    cwd?: string;
  }) {
    const instruction = input.instruction.trim();
    if (!instruction) {
      setAgentEditError("Instruction is required.");
      return;
    }

    setIsAgentEditingWorkflow(true);
    setAgentEditError(undefined);
    try {
      const started = await apiJson<{ edit?: WorkflowEditJobRecord }>(
        `/api/workflows/${workflowId}/agent-edits`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            instruction,
            baseVersionId: input.baseVersionId,
            agent: input.agent,
            model: input.model,
            cwd: input.cwd,
          }),
        },
        "WORKFLOW_EDIT_FAILED",
      );
      if (!started.edit) {
        throw new Error("Workflow edit did not return a job");
      }

      onLogEvent(`agent edit: started from ${input.baseVersionId?.slice(0, 8) ?? "current"}`);
      let edit = started.edit;
      let createdVersion: WorkflowVersionRecord | null = null;
      while (mountedRef.current && isActiveGenerationStatus(edit.status)) {
        await delay(1000);
        const next = await apiJson<{
          edit?: WorkflowEditJobRecord;
          version?: WorkflowVersionRecord | null;
        }>(
          `/api/workflows/${workflowId}/agent-edits/${edit.id}`,
          undefined,
          "WORKFLOW_EDIT_FAILED",
        );
        if (!next.edit) {
          throw new Error("Workflow edit status did not return a job");
        }
        edit = next.edit;
        createdVersion = next.version ?? null;
      }

      if (edit.status === "failed") {
        throw new Error(edit.error?.message ?? "Workflow edit failed");
      }
      if (!createdVersion && edit.createdVersionId) {
        const nextDetail = await loadWorkflow();
        createdVersion =
          nextDetail.versions.find((version) => version.id === edit.createdVersionId) ??
          null;
      }
      if (!createdVersion) {
        throw new Error("Workflow edit completed without a version");
      }

      const nextDetail = await loadWorkflow();
      applyLoadedDetail(nextDetail);
      setSelectedVersionId(createdVersion.id);
      acceptSavedScript(createdVersion.script);
      onVersionApplied();
      onLogEvent(`agent edit: created v${createdVersion.version}`);
    } catch (error) {
      const apiError = readApiJsonError(error, "WORKFLOW_EDIT_FAILED");
      setAgentEditError(apiError.message);
      onLogEvent(`agent edit failed: ${apiError.message}`);
    } finally {
      setIsAgentEditingWorkflow(false);
    }
  }

  async function publishSelectedVersion() {
    if (!selectedVersion || !detail || selectedVersion.id === detail.currentVersion?.id) {
      return;
    }

    setIsPublishingVersion(true);
    setAgentEditError(undefined);
    try {
      const data = await apiJson<{ detail?: WorkflowDetail }>(
        `/api/workflows/${workflowId}/versions/${selectedVersion.id}/publish`,
        {
          method: "POST",
        },
        "WORKFLOW_SAVE_FAILED",
      );
      if (!data.detail?.currentVersion) {
        throw new Error("Workflow publish failed");
      }
      applyLoadedDetail(data.detail, { resetScript: true });
      onLogEvent(`published: v${data.detail.currentVersion.version}`);
    } catch (error) {
      const apiError = readApiJsonError(error, "WORKFLOW_SAVE_FAILED");
      setAgentEditError(apiError.message);
      onLogEvent(`publish failed: ${apiError.message}`);
    } finally {
      setIsPublishingVersion(false);
    }
  }

  return {
    detail,
    selectedVersion,
    versionLabelById,
    metadataName,
    metadataDescription,
    metadataDirty,
    detailsDialogOpen,
    isLoading,
    isSaving,
    isSavingMetadata,
    isDuplicatingWorkflow,
    isDeletingWorkflow,
    isGeneratingWorkflow,
    isRetryingGeneration,
    isAgentEditingWorkflow,
    isPublishingVersion,
    generationError,
    agentEditError,
    isViewingCurrentVersion,
    isViewingOldVersion,
    setMetadataName,
    setMetadataDescription,
    loadWorkflow,
    applyVersion,
    selectVersion,
    saveCurrentVersion,
    restoreSelectedVersion,
    openDetailsDialog,
    handleDetailsDialogOpenChange,
    saveDetailsDialog,
    duplicateCurrentWorkflow,
    deleteCurrentWorkflow,
    retryWorkflowGeneration,
    agentEditWorkflow,
    publishSelectedVersion,
    exportSelectedVersion,
  };
}

function isActiveGenerationStatus(status: string | undefined): boolean {
  return status === "pending" || status === "running";
}
