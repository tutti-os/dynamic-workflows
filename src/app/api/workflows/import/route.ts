import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { toWorkflowApiErrorResponse } from "@/lib/api/server-errors";
import { createWorkflowFromScript } from "@/lib/db/workflows";

export async function POST(request: Request) {
  try {
    const script = await readWorkflowScript(request);
    if (!script.trim()) {
      return NextResponse.json(
        apiError("SCRIPT_REQUIRED", {
          message: "Choose a workflow script file before importing.",
        }),
        { status: 400 },
      );
    }

    const detail = createWorkflowFromScript(script);
    return NextResponse.json(detail, { status: 201 });
  } catch (error) {
    if (isRequestBodyParseError(error)) {
      return NextResponse.json(
        apiError("SCRIPT_REQUIRED", {
          message: "Choose a valid workflow script file before importing.",
        }),
        { status: 400 },
      );
    }

    return toWorkflowApiErrorResponse(error, "WORKFLOW_IMPORT_FAILED");
  }
}

async function readWorkflowScript(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    const formData = await request.formData();
    const file = formData.get("file");
    if (file instanceof File) {
      return file.text();
    }

    const script = formData.get("script");
    return typeof script === "string" ? script : "";
  }

  const body = (await request.json().catch(() => undefined)) as
    | { script?: string }
    | undefined;
  return body?.script ?? "";
}

function isRequestBodyParseError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message.toLowerCase().includes("formdata")
  );
}
