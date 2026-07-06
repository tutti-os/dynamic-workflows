import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  WorkflowInputDefinition,
  WorkflowInputSchema,
  WorkflowInputValue,
} from "@/lib/workflow/types";

export function useWorkflowRunInputs(
  inputSchema: WorkflowInputSchema,
  requiredWorkflowInputNames: string[],
  optionalWorkflowInputNames: string[] = [],
): {
  workflowInputNames: string[];
  runInputValues: Record<string, WorkflowInputValue>;
  missingRunInputNames: string[];
  workflowInputPayload: Record<string, WorkflowInputValue>;
  setRunInputValue: (name: string, value: WorkflowInputValue) => void;
} {
  const [runInputValues, setRunInputValues] = useState<
    Record<string, WorkflowInputValue>
  >({});
  const workflowInputNames = useMemo(
    () => [
      ...requiredWorkflowInputNames,
      ...optionalWorkflowInputNames.filter(
        (name) => !requiredWorkflowInputNames.includes(name),
      ),
    ],
    [optionalWorkflowInputNames, requiredWorkflowInputNames],
  );

  const missingRunInputNames = useMemo(
    () =>
      requiredWorkflowInputNames.filter((name) =>
        isMissingInputValue(inputSchema[name], runInputValues[name]),
      ),
    [inputSchema, requiredWorkflowInputNames, runInputValues],
  );

  const workflowInputPayload = useMemo(
    () =>
      Object.fromEntries(
        workflowInputNames.flatMap((name) => {
          const value = runInputValues[name];
          return value === undefined ? [] : [[name, value]];
        }),
      ),
    [runInputValues, workflowInputNames],
  );

  useEffect(() => {
    setRunInputValues((values) => {
      const nextValues = Object.fromEntries(
        workflowInputNames.map((name) => [
          name,
          values[name] ?? createDefaultInputValue(inputSchema[name]),
        ]),
      );
      const hasSameKeys =
        Object.keys(values).length === workflowInputNames.length &&
        workflowInputNames.every((name) => values[name] === nextValues[name]);
      return hasSameKeys ? values : nextValues;
    });
  }, [inputSchema, workflowInputNames]);

  const setRunInputValue = useCallback((name: string, value: WorkflowInputValue) => {
    setRunInputValues((values) => ({ ...values, [name]: value }));
  }, []);

  return {
    workflowInputNames,
    runInputValues,
    missingRunInputNames,
    workflowInputPayload,
    setRunInputValue,
  };
}

function createDefaultInputValue(
  definition: WorkflowInputDefinition | undefined,
): WorkflowInputValue {
  if (!definition) {
    return "";
  }
  if (definition.default !== undefined) {
    return definition.default;
  }
  if (definition.type === "boolean") {
    return false;
  }
  return "";
}

function isMissingInputValue(
  definition: WorkflowInputDefinition | undefined,
  value: WorkflowInputValue | undefined,
): boolean {
  if (!definition) {
    return false;
  }
  if (definition.type === "boolean") {
    return value === undefined;
  }
  if (definition.type === "number") {
    return value === undefined || value === "";
  }
  return value === undefined || (typeof value === "string" && !value.trim());
}
