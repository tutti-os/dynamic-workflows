import { NextResponse } from "next/server";
import { apiError } from "@/lib/api/errors";

export async function POST() {
  return NextResponse.json(
    apiError("LEGACY_RUN_ENDPOINT"),
    { status: 410 },
  );
}
