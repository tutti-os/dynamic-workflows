import { NextResponse } from "next/server";
import {
  listWorkflowBlueprints,
  searchWorkflowBlueprints,
} from "@/lib/workflow/blueprint-catalog";
import {
  readWorkflowBlueprintSearchParams,
} from "@/lib/workflow/blueprint-search-request";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const query = url.searchParams.get("query")?.trim();
  const hasFilters =
    url.searchParams.has("category") ||
    url.searchParams.has("tag") ||
    url.searchParams.has("requiresCwd") ||
    url.searchParams.has("includeScript") ||
    url.searchParams.has("limit");

  if (query || hasFilters) {
    return NextResponse.json({
      blueprints: searchWorkflowBlueprints(
        readWorkflowBlueprintSearchParams(url.searchParams),
      ),
    });
  }

  return NextResponse.json({ blueprints: listWorkflowBlueprints() });
}
