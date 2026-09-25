/**
 * Minimal Chrome DevTools Protocol client over the browser WebSocket (flattened sessions).
 * The navigation guard needs its own connection — independent of Playwright — so it can
 * auto-attach to every page (popups included) before it runs and pause redirect hops,
 * which Playwright's `route` never exposes.
 */

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
}

export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closedByUs = false;
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (m) => this.onMessage(String(m.data)));
    ws.addEventListener("close", () => this.onClose());
    ws.addEventListener("error", () => this.onClose());
  }

  static open(wsUrl: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("CDP connection timed out"));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("CDP connection failed"));
      });
    });
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`CDP connection closed (${method})`));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(listener: (e: CdpEvent) => void): void {
    this.listeners.add(listener);
  }

  /** Called once if the connection drops without `close()` having been called. */
  onUnexpectedClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  close(): Promise<void> {
    this.closedByUs = true;
    if (this.closed) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.addEventListener("close", () => resolve());
      this.ws.close();
    });
  }

  private onMessage(raw: string): void {
    let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`CDP error: ${msg.error.message ?? "unknown"}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method === "string") {
      const event: CdpEvent = { method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId };
      for (const l of this.listeners) l(event);
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error("CDP connection closed"));
    this.pending.clear();
    if (!this.closedByUs) for (const l of this.closeListeners) l();
  }
}
