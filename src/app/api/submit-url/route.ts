import { NextResponse } from "next/server";
import { isBearerAuthorized } from "@/lib/auth";
import { runSubmitUrl } from "@/lib/pipeline/submit-url";

interface SubmitUrlBody {
  url: string;
  note?: string;
}

function parseBody(raw: unknown): SubmitUrlBody | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.url !== "string" || body.url.trim() === "") return null;
  return {
    url: body.url,
    note: typeof body.note === "string" && body.note.trim() !== "" ? body.note : undefined,
  };
}

/**
 * 認証 → body 検証 → パイプライン実行 → JSON 応答、という薄いラッパー。
 * 実処理は `@/lib/pipeline/submit-url`（`runSubmitUrl`）に一本化されており、
 * ここに実装を重複させない。
 */
export async function POST(request: Request) {
  if (!isBearerAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawBody: unknown = await request.json().catch(() => null);
  const body = parseBody(rawBody);
  if (!body) {
    return NextResponse.json(
      { error: "invalid body: expected { url: string, note?: string }" },
      { status: 400 },
    );
  }

  const outcome = await runSubmitUrl(body.url, body.note);

  if (!outcome.ok) {
    if (outcome.reason === "invalid_url") {
      return NextResponse.json({ error: "invalid url" }, { status: 400 });
    }
    return NextResponse.json({ error: "failed to save post" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    needsReview: outcome.reason === "needs_review",
    card: outcome.card,
    createdAt: new Date().toISOString(),
  });
}
