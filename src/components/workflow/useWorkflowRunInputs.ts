import { useCallback, useEffect, useMemo, useState } from "react";

export function useWorkflowRunInputs(
  requiredWorkflowInputNames: string[],
  optionalWorkflowInputNames: string[] = [],
): {
  workflowInputNames: string[];
  runInputValues: Record<string, string>;
  missingRunInputNames: string[];
  workflowInputPayload: Record<string, string>;
  setRunInputValue: (name: string, value: string) => void;
} {
  const [runInputValues, setRunInputValues] = useState<Record<string, string>>({});
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
      requiredWorkflowInputNames.filter((name) => !runInputValues[name]?.trim()),
    [requiredWorkflowInputNames, runInputValues],
  );

  const workflowInputPayload = useMemo(
    () =>
      Object.fromEntries(
        workflowInputNames.map((name) => [name, runInputValues[name] ?? ""]),
      ),
    [runInputValues, workflowInputNames],
  );

  useEffect(() => {
    setRunInputValues((values) => {
      const nextValues = Object.fromEntries(
        workflowInputNames.map((name) => [name, values[name] ?? ""]),
      );
      const hasSameKeys =
        Object.keys(values).length === workflowInputNames.length &&
        workflowInputNames.every((name) => values[name] === nextValues[name]);
      return hasSameKeys ? values : nextValues;
    });
  }, [workflowInputNames]);

  const setRunInputValue = useCallback((name: string, value: string) => {
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
