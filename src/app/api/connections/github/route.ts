import { NextResponse } from "next/server";
import { listGitHubCliConnections } from "@/lib/connections/github-cli";

export async function GET(request: Request) {
  const forceRefresh =
    new URL(request.url).searchParams.get("refresh") === "1";
  return NextResponse.json(
    await listGitHubCliConnections(undefined, { forceRefresh }),
  );
}
