import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  downloadTextFile,
  sanitizeFilename,
} from "@/components/workflow/workflowClientUtils";
import {
  deleteWorkflow,
  duplicateWorkflow,
  isActiveWorkflowJobStatus,
  loadWorkflowDetail,
  publishWorkflowVersion,
  requestWorkflowGeneration,
  saveWorkflowVersion,
  updateWorkflowMetadata,
  watchWorkflowGeneration,
  readApiJsonError,
} from "@/components/workflow/workflowApiService";
import type {
  WorkflowDetail,
  WorkflowVersionRecord,
} from "@/lib/db/workflows/types";
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
      const nextDetail = await loadWorkflowDetail(workflowId);
      applyLoadedDetail(nextDetail, options);
      return nextDetail;
    },
    [applyLoadedDetail, workflowId],
  );

  const startGeneration = useCallback(
    async (retry: boolean) => {
      const nextDetail = await requestWorkflowGeneration(workflowId, retry);
      applyLoadedDetail(nextDetail, { resetScript: true });
      return nextDetail;
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
      !isActiveWorkflowJobStatus(generation.status)
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
        await watchWorkflowGeneration({
          workflowId,
          isMounted: () => mountedRef.current,
          onDetail: applyLoadedDetail,
        });
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
    onLogEvent,
    applyLoadedDetail,
    workflowId,
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
      const nextDetail = await saveWorkflowVersion({ workflowId, script });
      applyLoadedDetail(nextDetail, { resetScript: true });
      onLogEvent(
        `saved: v${nextDetail.currentVersion?.version}`,
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
      const data = await updateWorkflowMetadata({
        workflowId,
        name: metadataName,
        description: metadataDescription,
      });
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
      const data = await duplicateWorkflow({
        workflowId,
        versionId: selectedVersion?.id,
      });
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
      await deleteWorkflow(workflowId);
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
      const nextDetail = await saveWorkflowVersion({
        workflowId,
        script: selectedVersion.script,
      });
      applyLoadedDetail(nextDetail, { resetScript: true });
      onLogEvent(
        `restored: v${selectedVersion.version} -> v${nextDetail.currentVersion?.version}`,
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
      const nextDetail = await startGeneration(true);
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

  async function publishSelectedVersion() {
    if (!selectedVersion || !detail || selectedVersion.id === detail.currentVersion?.id) {
      return;
    }

    setIsPublishingVersion(true);
    setAgentEditError(undefined);
    try {
      const nextDetail = await publishWorkflowVersion({
        workflowId,
        versionId: selectedVersion.id,
      });
      applyLoadedDetail(nextDetail, { resetScript: true });
      onLogEvent(`published: v${nextDetail.currentVersion?.version}`);
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
    publishSelectedVersion,
    exportSelectedVersion,
  };
}
