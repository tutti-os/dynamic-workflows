import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/api/app-error";
import { getWorkflowApiErrorCode } from "@/lib/api/server-errors";

describe("server error mapping", () => {
  it("maps typed app errors by code", () => {
    expect(
      getWorkflowApiErrorCode(
        new AppError("WORKFLOW_NOT_FOUND", "Workflow not found"),
        "UNKNOWN_ERROR",
      ),
    ).toBe("WORKFLOW_NOT_FOUND");
  });

  it("does not infer codes from ordinary error messages", () => {
    expect(
      getWorkflowApiErrorCode(
        new Error("Workflow not found"),
        "WORKFLOW_UPDATE_FAILED",
      ),
    ).toBe("WORKFLOW_UPDATE_FAILED");
  });
});
