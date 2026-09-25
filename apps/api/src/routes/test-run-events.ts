import { isTerminalEvent, isTerminalLifecycle, type TestEvent } from "@platform/contracts";
import { EventRepository, RunRepository } from "@platform/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiDeps } from "../deps";
import { parseOr400 } from "./test-runs";

const Params = z.object({ runId: z.string().min(1).max(100) });
const Query = z.object({ afterSequence: z.coerce.number().int().min(0).optional() });
const PAGE = 500;

/**
 * SSE: SUBSCRIBE first → backfill from DB (sequence > cursor) → flush buffered live events → live.
 * Every write goes through one serial chain, so events are sent once and in order. A live event that
 * skips ahead (e.g. two publishers racing) triggers a DB backfill to fill the gap.
 */
export async function testRunEventRoutes(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  app.get("/v1/test-runs/:runId/events", async (req, reply) => {
    const { runId } = parseOr400(Params, req.params);
    const { afterSequence } = parseOr400(Query, req.query);
    const lastEventIdHeader = req.headers["last-event-id"];
    const fromHeader = typeof lastEventIdHeader === "string" && /^\d+$/.test(lastEventIdHeader) ? Number(lastEventIdHeader) : 0;
    let lastSent = Math.max(afterSequence ?? 0, fromHeader);

    const run = await new RunRepository(deps.db).getRequired(deps.config.defaultTenantId, runId);
    const events = new EventRepository(deps.db);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write(": connected\n\n");

    let closed = false;
    let live = false;
    const buffer: TestEvent[] = [];
    let chain: Promise<void> = Promise.resolve();
    let unsubscribe: (() => Promise<void>) | null = null;

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      void unsubscribe?.();
      raw.end();
    };
    req.raw.on("close", close);
    const heartbeat = setInterval(() => {
      if (!closed) raw.write(": ping\n\n");
    }, deps.config.sseHeartbeatMs);

    const send = (e: TestEvent) => {
      if (closed || e.sequence <= lastSent) return;
      raw.write(`id: ${e.sequence}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      lastSent = e.sequence;
      if (isTerminalEvent(e)) close();
    };

    const backfill = async () => {
      for (;;) {
        if (closed) return;
        const page = await events.listAfter(runId, lastSent, PAGE);
        page.forEach(send);
        if (page.length < PAGE) return;
      }
    };

    const enqueue = (fn: () => Promise<void> | void) => {
      chain = chain.then(fn).catch((err) => {
        req.log.error({ err, runId }, "sse stream failed");
        close();
      });
    };

    unsubscribe = await deps.hub.subscribe(runId, (e) => {
      if (!live) {
        buffer.push(e);
        return;
      }
      enqueue(async () => {
        if (e.sequence > lastSent + 1) await backfill();
        send(e);
      });
    });

    enqueue(async () => {
      await backfill();
      buffer.sort((a, b) => a.sequence - b.sequence);
      for (const e of buffer.splice(0)) {
        if (e.sequence > lastSent + 1) await backfill();
        send(e);
      }
      live = true;
      // A run that is already terminal but whose terminal event we've already delivered (or never
      // will receive) must not hang the client.
      if (!closed && isTerminalLifecycle(run.lifecycle)) {
        const latest = await new RunRepository(deps.db).getById(runId);
        if (isTerminalLifecycle(latest.lifecycle)) {
          await backfill();
          close();
        }
      }
    });
    if (closed) void unsubscribe();
  });
}
