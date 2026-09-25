import { isIP } from "node:net";
import { classifyAddress, isHostPortAllowlisted } from "@platform/security";
import { CdpConnection, type CdpEvent } from "./cdp-connection";

/**
 * Main-frame navigation guard. Confines top-level navigation (including redirect hops and
 * `window.open` popups) to the run's allowed hosts. Subresources and subframes are not
 * restricted here — only the egress proxy applies to them.
 */

export type NavigationBlockReason = "OFF_DOMAIN_NAVIGATION" | "TARGET_BLOCKED_BY_POLICY";

export interface NavigationBlockEvent {
  url: string;
  reason: NavigationBlockReason;
}

export interface NavigationPolicy {
  /** Exact hosts, or `*.example.com` for strict subdomains of example.com. */
  allowedHosts: string[];
  /** `host:port` entries exempt from the non-public address check (TARGET_PRIVATE_ALLOWLIST). */
  privateAllowlist: string[];
}

function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

/** Target host + its subdomains + `options.additionalAllowedHosts` (exact). */
export function computeAllowedHosts(targetUrl: string, additionalAllowedHosts: string[]): string[] {
  const host = normalizeHost(new URL(targetUrl).hostname);
  const hosts = [host];
  if (isIP(host) === 0) hosts.push(`*.${host}`);
  for (const extra of additionalAllowedHosts) hosts.push(normalizeHost(extra));
  return [...new Set(hosts.filter(Boolean))];
}

export function isHostAllowed(host: string, allowedHosts: string[]): boolean {
  const h = normalizeHost(host);
  if (!h) return false;
  return allowedHosts.some((entry) => {
    const e = normalizeHost(entry);
    if (e.startsWith("*.")) return h.endsWith(`.${e.slice(2)}`);
    return h === e;
  });
}

const DEFAULT_PORTS: Record<string, number> = { "http:": 80, "https:": 443 };

/** Decide a main-frame navigation. Address policy first, then the domain policy. Never resolves DNS. */
export function checkMainFrameNavigation(rawUrl: string, policy: NavigationPolicy): NavigationBlockReason | null {
  if (rawUrl === "about:blank" || rawUrl === "about:srcdoc") return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return "TARGET_BLOCKED_BY_POLICY";
  }
  const defaultPort = DEFAULT_PORTS[url.protocol];
  if (defaultPort === undefined) return "TARGET_BLOCKED_BY_POLICY";
  if (url.username !== "" || url.password !== "") return "TARGET_BLOCKED_BY_POLICY";

  const host = normalizeHost(url.hostname);
  if (!host) return "TARGET_BLOCKED_BY_POLICY";
  const port = url.port === "" ? defaultPort : Number(url.port);
  if (!isHostPortAllowlisted(host, port, policy.privateAllowlist)) {
    if (isIP(host) !== 0 && classifyAddress(host) !== "public") return "TARGET_BLOCKED_BY_POLICY";
    if (host === "localhost" || host.endsWith(".localhost")) return "TARGET_BLOCKED_BY_POLICY";
  }
  if (!isHostAllowed(host, policy.allowedHosts)) return "OFF_DOMAIN_NAVIGATION";
  return null;
}

export interface NavigationGuardOptions {
  allowedHosts: string[];
  privateAllowlist?: string[];
  onBlock: (e: NavigationBlockEvent) => void;
  /** The guard's CDP connection dropped while the browser may still run: navigation is no longer guarded. */
  onError?: (err: Error) => void;
}

export interface NavigationGuard {
  close(): Promise<void>;
}

interface AttachedEvent {
  sessionId: string;
  targetInfo: { targetId: string; type: string };
  waitingForDebugger: boolean;
}

interface PausedEvent {
  requestId: string;
  request: { url: string };
  frameId: string;
}

const DOCUMENT_REQUESTS = { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] };

/**
 * Installs the guard on every current and future page of the browser.
 *
 * Takes the browser WebSocket rather than a Playwright page (plan text: `installNavigationGuard(page, …)`):
 * Playwright's `route` does not see redirect hops, and a page-scoped hook would attach to popups
 * only after they started loading. Here, a browser-level auto-attach holds each new page until
 * `Fetch` interception of its documents is enabled; redirect hops are paused like any request.
 * Resolves once every existing page is guarded.
 */
export async function installNavigationGuard(
  browser: { browserWsUrl: string },
  opts: NavigationGuardOptions,
): Promise<NavigationGuard> {
  const policy: NavigationPolicy = { allowedHosts: opts.allowedHosts, privateAllowlist: opts.privateAllowlist ?? [] };
  const conn = await CdpConnection.open(browser.browserWsUrl);
  /** sessionId → page targetId (== its main frame id). */
  const pages = new Map<string, string>();
  const attaching = new Set<Promise<void>>();

  const emit = (e: NavigationBlockEvent) => {
    try {
      opts.onBlock(e);
    } catch {
      // Listener errors never change the decision.
    }
  };

  async function onAttached({ sessionId, targetInfo, waitingForDebugger }: AttachedEvent): Promise<void> {
    if (targetInfo.type === "page") {
      pages.set(sessionId, targetInfo.targetId);
      try {
        await conn.send("Fetch.enable", DOCUMENT_REQUESTS, sessionId);
      } catch {
        // Could not guard this page: never let it run.
        await conn.send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => {});
        return;
      }
      if (waitingForDebugger) await conn.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
      return;
    }
    // Workers etc.: nothing to guard here; let them run and drop the session.
    if (waitingForDebugger) await conn.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
    await conn.send("Target.detachFromTarget", { sessionId }).catch(() => {});
  }

  async function onPaused(sessionId: string | undefined, { requestId, request, frameId }: PausedEvent): Promise<void> {
    const mainFrameId = sessionId ? pages.get(sessionId) : undefined;
    // Unknown session: treat as a main frame (fail closed).
    const isMainFrame = mainFrameId === undefined || frameId === mainFrameId;
    const reason = isMainFrame ? checkMainFrameNavigation(request.url, policy) : null;
    if (reason) {
      await conn.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" }, sessionId).catch(() => {});
      emit({ url: request.url, reason });
      return;
    }
    await conn.send("Fetch.continueRequest", { requestId }, sessionId).catch(() => {});
  }

  conn.on((e: CdpEvent) => {
    if (e.method === "Target.attachedToTarget") {
      const p = onAttached(e.params as unknown as AttachedEvent).finally(() => attaching.delete(p));
      attaching.add(p);
    } else if (e.method === "Target.detachedFromTarget") {
      pages.delete(String(e.params.sessionId));
    } else if (e.method === "Fetch.requestPaused") {
      void onPaused(e.sessionId, e.params as unknown as PausedEvent);
    }
  });
  conn.onUnexpectedClose(() => opts.onError?.(new Error("navigation guard lost its browser connection")));

  try {
    await conn.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    // Existing targets are attached as part of setAutoAttach; wait until each page is guarded.
    await new Promise((r) => setImmediate(r));
    await Promise.all([...attaching]);
  } catch (err) {
    await conn.close();
    throw err;
  }
  return { close: () => conn.close() };
}
