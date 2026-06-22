import { NextResponse } from "next/server";
import { handleDynamicWorkflowsCliRequest } from "@/lib/tutti/cli";

export async function POST(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const { path = [] } = await context.params;
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_json",
          message:
            error instanceof Error
              ? error.message
              : "Request body must be valid JSON.",
        },
      },
      { status: 400 },
    );
  }
  return handleDynamicWorkflowsCliRequest(path, body);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text);
}
