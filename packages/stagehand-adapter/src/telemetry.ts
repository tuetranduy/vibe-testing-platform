/**
 * Reserved host for Stagehand's in-browser OTel export (Ruling R22: it can't be turned off). The
 * worker's egress proxy denies it silently as a background host (no `egress.blocked` event), and it
 * never resolves (`.invalid`, RFC 6761). Kept free of Stagehand imports so the worker's proxy can
 * import it (`@platform/stagehand-adapter/telemetry`) without loading Stagehand.
 */
export const STAGEHAND_TELEMETRY_HOST = "stagehand-telemetry.invalid";
export const DEFAULT_TELEMETRY_ENDPOINT = `https://${STAGEHAND_TELEMETRY_HOST}/v1/traces`;
