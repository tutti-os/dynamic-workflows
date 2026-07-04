import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { listAgentTargets } from "@/lib/agents/runtime";

export async function GET() {
  try {
    return NextResponse.json({ targets: await listAgentTargets() });
  } catch (error) {
    return NextResponse.json(
      {
        targets: [
          {
            id: "mock",
            name: "Mock local agent",
            provider: "mock",
            supported: true,
            models: ["mock"],
          },
        ],
        ...apiError("AGENT_TARGET_DETECTION_FAILED", {
          message: error instanceof Error ? error.message : undefined,
        }),
      },
      { status: 200 },
    );
  }
}
