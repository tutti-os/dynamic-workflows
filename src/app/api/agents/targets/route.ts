import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { listAgentTargetCatalog } from "@/lib/agents/runtime";

export async function GET() {
  try {
    return NextResponse.json(await listAgentTargetCatalog());
  } catch (error) {
    console.error(
      "[agent-targets] detection failed",
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      {
        ...apiError("AGENT_TARGET_DETECTION_FAILED", {
          details: {
            retryable: true,
          },
        }),
      },
      { status: 503 },
    );
  }
}
