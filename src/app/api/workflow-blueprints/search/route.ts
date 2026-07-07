import { NextResponse } from "next/server";
import { searchWorkflowBlueprints } from "@/lib/workflow/blueprint-catalog";
import {
  readWorkflowBlueprintSearchRequest,
} from "@/lib/workflow/blueprint-search-request";

export async function POST(request: Request) {
  const body = await request.json().catch(() => undefined);

  return NextResponse.json({
    blueprints: searchWorkflowBlueprints(
      readWorkflowBlueprintSearchRequest(body),
    ),
  });
}
