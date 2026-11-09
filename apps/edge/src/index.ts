/**
 * The Cloudflare front door. Public traffic reaches only the web container; the API has no public route
 * (docs/operations.md): the web container calls it at http://api.internal, which the outbound handler below
 * hands to the API container inside Cloudflare.
 */
import { Container, ContainerProxy, getContainer } from "@cloudflare/containers";

export { ContainerProxy };

interface Env {
  API: DurableObjectNamespace<ApiContainer>;
  WEB: DurableObjectNamespace<WebContainer>;
  WEB_ALLOWED_HOSTS: string;
  LLM_PROVIDER: string;
  LLM_MODEL?: string;
  S3_ENDPOINT: string;
  ARTIFACT_BUCKET: string;
  DATABASE_URL: string;
  REDIS_URL: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  API_TOKEN: string;
  SECRETS_ENCRYPTION_KEY: string;
  BOOTSTRAP_ADMIN_EMAIL: string;
  BOOTSTRAP_ADMIN_PASSWORD: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
}

/** Drops unset optional values: the config treats a missing key and an empty one differently. */
function defined(vars: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).filter((e): e is [string, string] => Boolean(e[1])));
}

export class ApiContainer extends Container<Env> {
  defaultPort = 3001;
  // The scheduled ping below keeps it awake: it fires suite schedules and consumes the reaper.
  sleepAfter = "1h";

  constructor(ctx: DurableObjectState<object>, env: Env) {
    super(ctx, env);
    this.envVars = defined({
      NODE_ENV: "production",
      API_PORT: "3001",
      BROWSER_MODE: "local",
      DEFAULT_TENANT_ID: "t_default",
      RUN_MIGRATIONS_ON_START: "false",
      ARTIFACT_STORAGE_TYPE: "s3",
      S3_REGION: "auto",
      S3_FORCE_PATH_STYLE: "true",
      S3_ENDPOINT: env.S3_ENDPOINT,
      ARTIFACT_BUCKET: env.ARTIFACT_BUCKET,
      LLM_PROVIDER: env.LLM_PROVIDER,
      LLM_MODEL: env.LLM_MODEL,
      DATABASE_URL: env.DATABASE_URL,
      REDIS_URL: env.REDIS_URL,
      S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
      S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
      API_TOKEN: env.API_TOKEN,
      SECRETS_ENCRYPTION_KEY: env.SECRETS_ENCRYPTION_KEY,
      BOOTSTRAP_ADMIN_EMAIL: env.BOOTSTRAP_ADMIN_EMAIL,
      BOOTSTRAP_ADMIN_PASSWORD: env.BOOTSTRAP_ADMIN_PASSWORD,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      GEMINI_API_KEY: env.GEMINI_API_KEY,
      DEEPSEEK_API_KEY: env.DEEPSEEK_API_KEY,
    });
  }
}

export class WebContainer extends Container<Env> {
  defaultPort = 3000;
  sleepAfter = "30m";

  static outboundByHost = {
    "api.internal": (request: Request, env: Env) => getContainer(env.API).fetch(request),
  };

  constructor(ctx: DurableObjectState<object>, env: Env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: "production",
      API_URL: "http://api.internal",
      API_TOKEN: env.API_TOKEN,
      WEB_ALLOWED_HOSTS: env.WEB_ALLOWED_HOSTS,
    };
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return getContainer(env.WEB).fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await getContainer(env.API).fetch(new Request("http://api.internal/healthz"));
  },
};
