import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  patchNodeFieldInScript,
  type EditableNodeRanges,
} from "@/lib/workflow/script-patch";
import { apiJson } from "@/components/workflow/workflowApiClient";
import type {
  ParsedWorkflow,
  WorkflowDiagnostic,
  WorkflowLoopStep,
} from "@/lib/workflow/types";

const EMPTY_PARSED: ParsedWorkflow = {
  meta: { name: "untitled_workflow", description: "Dynamic workflow" },
  nodes: [],
  edges: [],
  phases: [],
  externalInputs: [],
  diagnostics: [],
  variableToNodeId: {},
};

export function useWorkflowScriptEditing(input: {
  selectedLoopStepId?: string;
  selectedNodeId?: string;
}): {
  script: string;
  parsed: ParsedWorkflow;
  selectedNode: ParsedWorkflow["nodes"][number] | undefined;
  selectedLoopStep: WorkflowLoopStep | undefined;
  labelDraft: string;
  promptDraft: string;
  appendPromptDraft: string;
  parseError?: string;
  scriptSaveError?: string;
  scriptSaveDiagnostics: WorkflowDiagnostic[];
  diagnosticErrorCount: number;
  diagnosticWarningCount: number;
  hasParseErrors: boolean;
  isDirty: boolean;
  workflowInputNames: string[];
  acceptSavedScript: (nextScript: string) => void;
  setScriptFromEditor: (nextScript: string) => void;
  resetScriptChanges: () => void;
  replaceParsed: (nextParsed: ParsedWorkflow) => void;
  setParseErrorMessage: (message: string) => void;
  clearScriptSaveFeedback: () => void;
  setScriptSaveFailure: (
    message: string,
    diagnostics?: WorkflowDiagnostic[],
  ) => void;
  updateLabelDraft: (value: string) => void;
  updatePromptDraft: (value: string) => void;
  updateAppendPromptDraft: (value: string) => void;
} {
  const [script, setScript] = useState("");
  const [savedScript, setSavedScript] = useState("");
  const [parsed, setParsed] = useState<ParsedWorkflow>(EMPTY_PARSED);
  const [labelDraft, setLabelDraft] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [appendPromptDraft, setAppendPromptDraft] = useState("");
  const [parseError, setParseError] = useState<string | undefined>();
  const [scriptSaveError, setScriptSaveError] = useState<string | undefined>();
  const [scriptSaveDiagnostics, setScriptSaveDiagnostics] = useState<
    WorkflowDiagnostic[]
  >([]);
  const scriptRef = useRef(script);
  const parseRequestIdRef = useRef(0);
  const editableNodeRangesRef = useRef<EditableNodeRanges | undefined>(
    undefined,
  );

  const selectedNode = useMemo(
    () => parsed.nodes.find((node) => node.id === input.selectedNodeId),
    [input.selectedNodeId, parsed.nodes],
  );
  const selectedLoopStep = useMemo(
    () =>
      selectedNode?.loop?.steps.find(
        (step) => step.id === input.selectedLoopStepId,
      ),
    [input.selectedLoopStepId, selectedNode],
  );
  const selectedEditableTarget = selectedLoopStep ?? selectedNode;
  const selectedEditableTargetId = selectedLoopStep
    ? `${selectedNode?.id ?? "loop"}.${selectedLoopStep.id}`
    : selectedNode?.id;

  const setWorkflowScript = useCallback((nextScript: string) => {
    scriptRef.current = nextScript;
    setScript(nextScript);
  }, []);

  const clearScriptSaveFeedback = useCallback(() => {
    setScriptSaveError(undefined);
    setScriptSaveDiagnostics([]);
  }, []);

  const acceptSavedScript = useCallback(
    (nextScript: string) => {
      editableNodeRangesRef.current = undefined;
      setWorkflowScript(nextScript);
      setSavedScript(nextScript);
    },
    [setWorkflowScript],
  );

  const setScriptFromEditor = useCallback(
    (nextScript: string) => {
      editableNodeRangesRef.current = undefined;
      setWorkflowScript(nextScript);
      clearScriptSaveFeedback();
    },
    [clearScriptSaveFeedback, setWorkflowScript],
  );

  const resetScriptChanges = useCallback(() => {
    editableNodeRangesRef.current = undefined;
    setWorkflowScript(savedScript);
    clearScriptSaveFeedback();
  }, [clearScriptSaveFeedback, savedScript, setWorkflowScript]);

  const replaceParsed = useCallback((nextParsed: ParsedWorkflow) => {
    setParsed(nextParsed);
  }, []);

  const setParseErrorMessage = useCallback((message: string) => {
    setParseError(message);
  }, []);

  const setScriptSaveFailure = useCallback(
    (message: string, diagnostics?: WorkflowDiagnostic[]) => {
      setScriptSaveError(message);
      if (diagnostics) {
        setScriptSaveDiagnostics(diagnostics);
      }
    },
    [],
  );

  const parseScript = useCallback(async (nextScript: string) => {
    const requestId = parseRequestIdRef.current + 1;
    parseRequestIdRef.current = requestId;

    try {
      const nextParsed = await apiJson<ParsedWorkflow>(
        "/api/workflows/parse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ script: nextScript }),
        },
      );
      if (requestId !== parseRequestIdRef.current) {
        return;
      }
      setParsed(nextParsed);
      setParseError(undefined);
    } catch (error) {
      if (requestId !== parseRequestIdRef.current) {
        return;
      }
      setParseError(error instanceof Error ? error.message : "Parse failed");
    }
  }, []);

  useEffect(() => {
    scriptRef.current = script;
  }, [script]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void parseScript(script);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [parseScript, script]);

  useEffect(() => {
    setLabelDraft(selectedEditableTarget?.label ?? "");
    setPromptDraft(
      selectedEditableTarget?.prompt ??
        (selectedEditableTarget && "message" in selectedEditableTarget
          ? selectedEditableTarget.message
          : "") ??
        "",
    );
    setAppendPromptDraft(selectedLoopStep?.appendPrompt ?? "");
    editableNodeRangesRef.current = selectedEditableTargetId
      ? {
          nodeId: selectedEditableTargetId,
          labelRange: selectedEditableTarget?.labelRange,
          promptRange: selectedEditableTarget?.promptRange,
          appendPromptRange: selectedLoopStep?.appendPromptRange,
        }
      : undefined;
  }, [selectedEditableTarget, selectedEditableTargetId, selectedLoopStep]);

  const patchSelectedNodeField = useCallback(
    (field: "label" | "prompt" | "appendPrompt", value: string) => {
      if (!selectedEditableTarget || !selectedEditableTargetId) {
        return;
      }

      clearScriptSaveFeedback();

      const currentRanges =
        editableNodeRangesRef.current?.nodeId === selectedEditableTargetId
          ? editableNodeRangesRef.current
          : {
              nodeId: selectedEditableTargetId,
              labelRange: selectedEditableTarget.labelRange,
              promptRange: selectedEditableTarget.promptRange,
              appendPromptRange: selectedLoopStep?.appendPromptRange,
            };
      const patched = patchNodeFieldInScript({
        script: scriptRef.current,
        ranges: currentRanges,
        field,
        value,
      });
      if (!patched) {
        return;
      }

      editableNodeRangesRef.current = patched.ranges;
      setWorkflowScript(patched.script);
    },
    [
      clearScriptSaveFeedback,
      selectedEditableTarget,
      selectedEditableTargetId,
      selectedLoopStep,
      setWorkflowScript,
    ],
  );

  const updateLabelDraft = useCallback(
    (value: string) => {
      setLabelDraft(value);
      patchSelectedNodeField("label", value);
    },
    [patchSelectedNodeField],
  );

  const updatePromptDraft = useCallback(
    (value: string) => {
      setPromptDraft(value);
      patchSelectedNodeField("prompt", value);
    },
    [patchSelectedNodeField],
  );

  const updateAppendPromptDraft = useCallback(
    (value: string) => {
      setAppendPromptDraft(value);
      patchSelectedNodeField("appendPrompt", value);
    },
    [patchSelectedNodeField],
  );

  const diagnosticErrorCount = parsed.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;
  const diagnosticWarningCount = parsed.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "warning",
  ).length;
  const hasParseErrors = Boolean(parseError) || diagnosticErrorCount > 0;
  const isDirty = script !== savedScript;

  return {
    script,
    parsed,
    selectedNode,
    selectedLoopStep,
    labelDraft,
    promptDraft,
    appendPromptDraft,
    parseError,
    scriptSaveError,
    scriptSaveDiagnostics,
    diagnosticErrorCount,
    diagnosticWarningCount,
    hasParseErrors,
    isDirty,
    workflowInputNames: parsed.externalInputs,
    acceptSavedScript,
    setScriptFromEditor,
    resetScriptChanges,
    replaceParsed,
    setParseErrorMessage,
    clearScriptSaveFeedback,
    setScriptSaveFailure,
    updateLabelDraft,
    updatePromptDraft,
    updateAppendPromptDraft,
  };
}
