import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { listAgentProviders } from "@/lib/agents/runtime";

export async function GET() {
  try {
    return NextResponse.json({ providers: await listAgentProviders() });
  } catch (error) {
    return NextResponse.json(
      {
        providers: [
          {
            id: "mock",
            label: "Mock local agent",
            supported: true,
            models: ["mock"],
          },
        ],
        ...apiError("PROVIDER_DETECTION_FAILED", {
          message: error instanceof Error ? error.message : undefined,
        }),
      },
      { status: 200 },
    );
  }
}
