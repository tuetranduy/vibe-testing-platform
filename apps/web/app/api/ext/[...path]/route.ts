import { extProxy } from "../../../../lib/ext-proxy";

// API-token callers (V1.2 F4): CI jobs and scripts. Proxied live, never cached.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Promise<Response> {
  return extProxy(req, "GET");
}

export function POST(req: Request): Promise<Response> {
  return extProxy(req, "POST");
}
