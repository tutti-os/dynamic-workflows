import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  downloadTextFile,
  sanitizeFilename,
} from "@/components/workflow/workflowClientUtils";
import {
  apiJson,
  readApiJsonError,
} from "@/components/workflow/workflowApiClient";
import type {
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

  const selectedVersion = useMemo(() => {
    if (!detail) {
      return null;
    }
    return (
      detail.versions.find((version) => version.id === selectedVersionId) ??
      detail.currentVersion
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
    Boolean(detail && selectedVersion) &&
    selectedVersion?.id === detail?.currentVersion.id;
  const isViewingOldVersion =
    Boolean(detail && selectedVersion) && !isViewingCurrentVersion;

  const loadWorkflow = useCallback(
    async (options?: { resetScript?: boolean }) => {
      const nextDetail = await apiJson<WorkflowDetail>(
        `/api/workflows/${workflowId}`,
        undefined,
        "WORKFLOW_NOT_FOUND",
      );
      setDetail(nextDetail);
      setMetadataName(nextDetail.workflow.name);
      setMetadataDescription(nextDetail.workflow.description);
      if (options?.resetScript) {
        setSelectedVersionId(nextDetail.currentVersion.id);
        acceptSavedScript(nextDetail.currentVersion.script);
      }
      return nextDetail;
    },
    [acceptSavedScript, workflowId],
  );

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
      if (!data.detail) {
        throw new Error("Workflow save failed");
      }
      setDetail(data.detail);
      setSelectedVersionId(data.detail.currentVersion.id);
      acceptSavedScript(data.detail.currentVersion.script);
      onLogEvent(
        `saved: v${data.detail?.currentVersion.version ?? ""}`,
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
      if (!data.detail) {
        throw new Error("Workflow restore failed");
      }
      setDetail(data.detail);
      setSelectedVersionId(data.detail.currentVersion.id);
      acceptSavedScript(data.detail.currentVersion.script);
      onLogEvent(
        `restored: v${selectedVersion.version} -> v${data.detail?.currentVersion.version ?? ""}`,
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
    exportSelectedVersion,
  };
}
