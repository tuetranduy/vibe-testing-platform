import type { Server } from "node:http";

export declare const VALID_EMAIL: "qa@demo.test";
export declare const VALID_PASSWORD: "demo-pass-123";
export declare const INJECTION_TEXT: string;
export declare const MAX_SLOW_MS: number;
export declare const KNOWN_BUGS: readonly string[];
export declare const CATALOG: ReadonlyArray<{
  readonly id: number;
  readonly name: string;
  readonly price: number;
  readonly description: string;
}>;

export interface DemoShopRequest {
  /** Counts every request since the server started (a reset keeps counting). */
  seq: number;
  method: string;
  /** The path only, never the query. */
  path: string;
}

export interface DemoShopServer extends Server {
  demoShop: { reset(): void; readonly deleteClicks: number; readonly requests: DemoShopRequest[] };
}

export interface DemoShopOptions {
  /** Enable `/__test/*` endpoints. Defaults to DEMO_SHOP_TEST_ENDPOINTS=1, or NODE_ENV !== "production". */
  testEndpoints?: boolean;
}

export interface StartDemoShopOptions extends DemoShopOptions {
  /** Port to listen on; 0 (default) picks a free port. */
  port?: number;
  /** Host to bind; defaults to 127.0.0.1. */
  host?: string;
}

export interface RunningDemoShop {
  url: string;
  port: number;
  server: DemoShopServer;
  close(): Promise<void>;
}

export declare function createDemoShopServer(options?: DemoShopOptions): DemoShopServer;
export declare function startDemoShop(options?: StartDemoShopOptions): Promise<RunningDemoShop>;
