import { NextRequest, NextResponse } from "next/server";

const PROTECTED = ["/dashboard", "/bookings", "/clients", "/staff", "/packages", "/deals", "/reports", "/settings"];
const SUPER_PROTECTED = ["/super-admin/dashboard"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Super admin routes
  if (SUPER_PROTECTED.some((p) => pathname.startsWith(p))) {
    const superToken = req.cookies.get("superAdminSession");
    if (!superToken) {
      return NextResponse.redirect(new URL("/super-admin/login", req.url));
    }
  }

  // Tenant admin routes
  if (PROTECTED.some((p) => pathname.startsWith(p))) {
    const tenantToken = req.cookies.get("tenantToken");
    if (!tenantToken) {
      return NextResponse.redirect(new URL("/login", req.url));
    }
  }

  // Redirect root to dashboard or login
  if (pathname === "/") {
    const tenantToken = req.cookies.get("tenantToken");
    return NextResponse.redirect(
      new URL(tenantToken ? "/dashboard" : "/login", req.url),
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|salon-admin|super-admin|widget).*)",
  ],
};
