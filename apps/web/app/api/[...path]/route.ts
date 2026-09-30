import { proxy } from "../../../lib/proxy";

// Every request is proxied live to the API (SSE included): never cached, never prerendered, and
// the API token is read from the server environment at request time.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export function GET(req: Request): Promise<Response> {
  return proxy(req, "GET");
}

export function POST(req: Request): Promise<Response> {
  return proxy(req, "POST");
}

export function PUT(req: Request): Promise<Response> {
  return proxy(req, "PUT");
}

export function PATCH(req: Request): Promise<Response> {
  return proxy(req, "PATCH");
}

export function DELETE(req: Request): Promise<Response> {
  return proxy(req, "DELETE");
}
