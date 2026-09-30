/** Shared by the adapters that call a provider's REST API with plain fetch (Gemini, DeepSeek). */

/** The parsed JSON body, or undefined when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** An error's message, with its cause's (fetch's TypeError hides the network error there). */
export function messageWithCause(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return err instanceof Error && err.cause instanceof Error ? `${message} (${err.cause.message})` : message;
}
