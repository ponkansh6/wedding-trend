import { NextResponse, type NextRequest } from "next/server";

export const config = {
  matcher: ["/admin/:path*"],
};

/**
 * Edge ランタイムでは node:crypto が使えないため、Web Crypto (crypto.subtle) で
 * タイミングセーフな比較を行う（両方の SHA-256 ダイジェストを固定長で比較する）。
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return a === b;
  }
  const enc = new TextEncoder();
  const [aDigest, bDigest] = await Promise.all([
    subtle.digest("SHA-256", enc.encode(a)),
    subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const aBytes = new Uint8Array(aDigest);
  const bBytes = new Uint8Array(bDigest);
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  if (!pathname.startsWith("/admin")) {
    return NextResponse.next();
  }

  const user = process.env.ADMIN_BASIC_AUTH_USER;
  const pass = process.env.ADMIN_BASIC_AUTH_PASSWORD;

  if (!user || !pass) {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ error: "Admin interface not configured" }, { status: 503 });
    }
    return NextResponse.next();
  }

  const auth = request.headers.get("authorization");
  if (!auth || !auth.startsWith("Basic ")) {
    return new NextResponse("Unauthorized", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Wedding Trend Admin"' },
    });
  }

  const credentials = auth.slice(6);
  const decoded = atob(credentials);
  const separatorIndex = decoded.indexOf(":");
  const username = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
  const password = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : "";

  const [userMatch, passMatch] = await Promise.all([
    timingSafeEqual(user, username),
    timingSafeEqual(pass, password),
  ]);

  if (userMatch && passMatch) {
    return NextResponse.next();
  }

  return new NextResponse("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Wedding Trend Admin"' },
  });
}
