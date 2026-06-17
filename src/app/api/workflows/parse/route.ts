import { NextResponse } from "next/server";
import { parseWorkflowScript } from "@/lib/workflow/parser";

export async function POST(request: Request) {
  const body = (await request.json()) as { script?: string };
  return NextResponse.json(parseWorkflowScript(body.script ?? ""));
}
