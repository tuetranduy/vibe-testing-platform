import type { RunLifecycle } from "@platform/contracts";

export class NotFoundError extends Error {
  constructor(public readonly entity: string, public readonly id: string) {
    super(`${entity} ${id} not found`);
    this.name = "NotFoundError";
  }
}

export class IllegalRunTransitionError extends Error {
  constructor(public readonly from: RunLifecycle, public readonly to: RunLifecycle) {
    super(`Illegal run transition ${from} → ${to}`);
    this.name = "IllegalRunTransitionError";
  }
}

/** The CAS lost: the run was no longer in the expected lifecycle. */
export class StaleTransitionError extends Error {
  constructor(
    public readonly runId: string,
    public readonly expected: RunLifecycle,
    public readonly actual: RunLifecycle,
  ) {
    super(`Run ${runId} expected ${expected} but is ${actual}`);
    this.name = "StaleTransitionError";
  }
}

export class RunInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunInvariantError";
  }
}

export class RequirementFrozenError extends Error {
  constructor(public readonly runId: string) {
    super(`Criteria for run ${runId} are confirmed and can no longer change`);
    this.name = "RequirementFrozenError";
  }
}

export class RequirementStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementStateError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor(public readonly existingRunId: string) {
    super("Idempotency-Key was already used with a different request body");
    this.name = "IdempotencyConflictError";
  }
}

/** A selection named a suggestion that is not in the run's set. */
export class UnknownSuggestionError extends Error {
  constructor(public readonly suggestionId: string) {
    super(`Suggestion ${suggestionId} is not one of this run's suggested tests`);
    this.name = "UnknownSuggestionError";
  }
}
