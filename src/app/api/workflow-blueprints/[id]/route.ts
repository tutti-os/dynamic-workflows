import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";
import { getWorkflowBlueprint } from "@/lib/workflow/blueprint-catalog";
import { parseFlowV1Bundle } from "@/lib/flow-v1/parser";

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const blueprint = getWorkflowBlueprint(id);
  if (!blueprint) {
    return NextResponse.json(
      apiError("WORKFLOW_BLUEPRINT_NOT_FOUND"),
      { status: 404 },
    );
  }

  if (blueprint.schemaVersion === "tutti.flow.v1") {
    const parsed = parseFlowV1Bundle(blueprint.bundle);
    return NextResponse.json({
      blueprint: {
        ...blueprint,
        preview: {
          nodes: parsed.nodes,
          edges: parsed.edges,
          params: parsed.params,
          inputs: parsed.inputs,
          secrets: parsed.secrets,
        },
      },
    });
  }
  return NextResponse.json({ blueprint });
}
