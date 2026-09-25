import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time bearer check. Both sides are hashed so length differences don't leak. */
export function createBearerAuth(apiToken: string) {
  const expected = digest(apiToken);
  return async function bearerAuth(req: FastifyRequest, reply: FastifyReply) {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer (.+)$/i.exec(header);
    const ok = !!match && timingSafeEqual(digest(match[1]!.trim()), expected);
    if (!ok) {
      reply.header("www-authenticate", 'Bearer realm="api"');
      return reply.status(401).send({ code: "UNAUTHORIZED", message: "Missing or invalid bearer token" });
    }
  };
}
