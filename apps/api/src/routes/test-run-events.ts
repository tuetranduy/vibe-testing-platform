import { isTerminalEvent, isTerminalLifecycle, type TestEvent } from "@platform/contracts";
import { EventRepository, RunRepository } from "@platform/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { runScope } from "../auth/principal";
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
  // Open streams, ended before the server closes: server.close() waits for every connection, and a
  // live run's stream would otherwise hold a stopping API up until the run ends. Clients reconnect
  // with Last-Event-ID (to the next instance) and lose nothing.
  // A handler still awaiting its run lookup when shutdown starts registers after the hook has run,
  // so it checks `closing` and ends its stream at once.
  const open = new Set<() => void>();
  let closing = false;
  app.addHook("preClose", async () => {
    closing = true;
    for (const close of [...open]) close();
  });

  app.get("/v1/test-runs/:runId/events", async (req, reply) => {
    const { runId } = parseOr400(Params, req.params);
    const { afterSequence } = parseOr400(Query, req.query);
    const lastEventIdHeader = req.headers["last-event-id"];
    const fromHeader = typeof lastEventIdHeader === "string" && /^\d+$/.test(lastEventIdHeader) ? Number(lastEventIdHeader) : 0;
    let lastSent = Math.max(afterSequence ?? 0, fromHeader);

    const run = await new RunRepository(deps.db).getRequired(runScope(req.principal), runId);
    const events = new EventRepository(deps.db);

    reply.hijack();
    const raw = reply.raw;
    // Shutdown began while the run was looked up: end at once, and without keep-alive, so this
    // connection can't hold close() open either. The client reconnects like any ended stream.
    const stopping = closing;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: stopping ? "close" : "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.write(": connected\n\n");
    if (stopping) {
      raw.end();
      return;
    }

    let closed = false;
    let live = false;
    const buffer: TestEvent[] = [];
    let chain: Promise<void> = Promise.resolve();
    let unsubscribe: (() => Promise<void>) | null = null;

    const close = () => {
      if (closed) return;
      closed = true;
      open.delete(close);
      clearInterval(heartbeat);
      void unsubscribe?.();
      raw.end();
    };
    open.add(close);
    req.raw.on("close", close);
    const runs = new RunRepository(deps.db);
    const graceMs = Math.max(2_000, deps.config.sseHeartbeatMs);
    const settled = (changedAt: Date) => Date.now() - changedAt.getTime() >= graceMs;
    // Heartbeat: keep the connection alive, and re-check the database so a lost live message
    // (Redis reconnect, crash between persist and publish) can never leave the stream hanging.
    const heartbeat = setInterval(() => {
      if (closed) return;
      raw.write(": ping\n\n");
      if (live) {
        enqueue(async () => {
          await backfill();
          if (closed) return;
          const current = await runs.getById(runId);
          // The terminal event is persisted just after the terminal transition; give it a grace
          // period before concluding its live message was lost.
          if (isTerminalLifecycle(current.lifecycle) && settled(current.lifecycleChangedAt)) {
            await backfill();
            close();
          }
        });
      }
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

    try {
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
    } catch (err) {
      req.log.error({ err, runId }, "sse subscribe failed");
      close();
      return;
    }

    enqueue(async () => {
      await backfill();
      // Events that arrive while we backfill land in `buffer` again, so drain until it stays empty;
      // `live` flips with no await in between, so nothing can slip past.
      while (buffer.length > 0 && !closed) {
        const batch = buffer.splice(0).sort((a, b) => a.sequence - b.sequence);
        for (const e of batch) {
          if (e.sequence > lastSent + 1) await backfill();
          send(e);
        }
      }
      live = true;
      // A run that is already terminal but whose terminal event we've already delivered (or never
      // will receive) must not hang the client.
      if (!closed && isTerminalLifecycle(run.lifecycle) && settled(run.lifecycleChangedAt)) {
        await backfill();
        close();
      }
    });
    if (closed) void unsubscribe?.();
  });
}
