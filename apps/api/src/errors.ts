import type { ApiError } from "@platform/contracts";
import {
  IdempotencyConflictError,
  InvalidCursorError,
  NotFoundError,
  RequirementFrozenError,
  RequirementStateError,
  StaleTransitionError,
} from "@platform/db";
import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly issues?: ApiError["issues"],
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function zodIssues(err: ZodError): NonNullable<ApiError["issues"]> {
  return err.issues.map((i) => ({
    path: i.path.map((p) => (typeof p === "number" ? p : String(p))),
    message: i.message,
  }));
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    let status = 500;
    let body: ApiError = { code: "INTERNAL", message: "Internal server error" };
    if (err instanceof HttpError) {
      status = err.statusCode;
      body = { code: err.code, message: err.message, ...(err.issues ? { issues: err.issues } : {}) };
    } else if (err instanceof ZodError) {
      status = 400;
      body = { code: "VALIDATION_FAILED", message: "Request validation failed", issues: zodIssues(err) };
    } else if (err instanceof NotFoundError) {
      status = 404;
      body = { code: "NOT_FOUND", message: "Not found" };
    } else if (err instanceof InvalidCursorError) {
      status = 400;
      body = { code: "INVALID_CURSOR", message: err.message };
    } else if (err instanceof IdempotencyConflictError) {
      status = 409;
      body = { code: "IDEMPOTENCY_CONFLICT", message: err.message };
    } else if (err instanceof RequirementFrozenError || err instanceof RequirementStateError || err instanceof StaleTransitionError) {
      status = 409;
      body = { code: "CONFLICT", message: err.message };
    } else if ("statusCode" in err && typeof err.statusCode === "number" && err.statusCode < 500) {
      status = err.statusCode;
      body = { code: (err as FastifyError).code ?? "BAD_REQUEST", message: err.message };
    }
    if (status >= 500) req.log.error({ err }, "request failed");
    reply.status(status).send(body);
  });
}
