import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { openAgentSession } from "@/lib/agents/runtime";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    agentSessionId?: unknown;
  };
  const agentSessionId =
    typeof body.agentSessionId === "string" ? body.agentSessionId.trim() : "";

  if (!agentSessionId) {
    return NextResponse.json(
      apiError("WORKFLOW_RUN_FAILED", {
        message: "agentSessionId is required.",
      }),
      { status: 400 },
    );
  }

  try {
    await openAgentSession(agentSessionId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      apiError("WORKFLOW_RUN_FAILED", {
        message:
          error instanceof Error
            ? error.message
            : "Failed to open agent session.",
      }),
      { status: 500 },
    );
  }
}
