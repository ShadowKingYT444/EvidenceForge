import { NextResponse, type NextRequest } from "next/server";

import { researchSessionCookies } from "./server/session/research-session";

export function proxy(request: NextRequest) {
  if (!request.cookies.has(researchSessionCookies.research)) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ["/intake/:path*", "/example/:path*"] };
