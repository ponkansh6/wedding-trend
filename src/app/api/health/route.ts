import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ ok: true, service: "wedding-trend", time: new Date().toISOString() });
}
