import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { TraceScrubError, scrubTrace } from "./trace-scrubber";

/**
 * Step 3 (Task 17): a Playwright trace is a zip of NDJSON events (`*.trace`, `*.network`), source
 * and resource blobs (`resources/<sha1>`: page HTML, posted bodies, screenshots). A secret the test
 * filled shows up in action params, request headers and bodies, in plain, URL-encoded and base64
 * form. After scrubbing, no entry may contain it in any of those forms.
 */

// Characters that URL-encode, JSON-escape and HTML-escape differently from the plain value.
const SECRET = 'p@ss w/rd+"é"<&>';
const OTHER = "second-Secret-42";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const formEncoded = (s: string) => new URLSearchParams([["", s]]).toString().slice(1);
const htmlEscaped = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const lowerHexPercent = (s: string) => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());

/** Every form the secret must not survive in, computed independently of the scrubber. */
function forms(secret: string): string[] {
  const basic = b64(`qa@demo.test:${secret}`); // "Basic" auth: the secret is base64'd at an offset
  const inJson = JSON.stringify(secret).slice(1, -1);
  return [
    secret,
    inJson,
    htmlEscaped(secret),
    encodeURIComponent(secret),
    lowerHexPercent(secret),
    formEncoded(secret),
    b64(secret),
    b64(secret).replace(/=+$/, ""),
    b64url(secret),
    basic.slice(8, -4), // the part of an offset encoding that depends only on the secret
  ];
}

function traceZip(): Uint8Array {
  const events = [
    { type: "before", callId: "call@1", apiName: "locator.fill", method: "fill", params: { selector: "internal:label=\"Password\"", value: SECRET } },
    { type: "after", callId: "call@1", title: `Fill "${SECRET}"` },
    { type: "before", callId: "call@2", method: "fill", params: { value: OTHER } },
  ];
  const network = [
    {
      type: "resource-snapshot",
      snapshot: {
        request: {
          url: `https://shop.test/login?password=${encodeURIComponent(SECRET)}`,
          headers: [
            { name: "Authorization", value: `Basic ${b64(`qa@demo.test:${SECRET}`)}` },
            { name: "Cookie", value: `token=${lowerHexPercent(SECRET)}; other=${b64url(OTHER)}` },
          ],
          postData: { _sha1: "post-body.dat" },
        },
      },
    },
  ];
  const binary = new Uint8Array(256).map((_, i) => (i * 37) & 0xff); // not valid UTF-8
  const binaryWithSecret = new Uint8Array([0xff, 0xfe, 0x00, ...strToU8(SECRET), 0x00, 0xff]);
  return zipSync({
    "0-trace.trace": strToU8(events.map((e) => JSON.stringify(e)).join("\n")),
    "0-trace.network": strToU8(network.map((e) => JSON.stringify(e)).join("\n")),
    "resources/post-body.dat": strToU8(`email=qa%40demo.test&password=${formEncoded(SECRET)}`),
    "resources/page.html": strToU8(`<input value="${htmlEscaped(SECRET)}"><p>${b64(SECRET)}</p>`),
    "resources/shot.jpeg": binary,
    "resources/blob.bin": binaryWithSecret,
  });
}

describe("scrubTrace", () => {
  it("removes each secret from every text entry: plain, JSON-escaped, URL-encoded and base64 forms", () => {
    const scrubbed = unzipSync(scrubTrace(traceZip(), [SECRET, OTHER]));
    expect(Object.keys(scrubbed).sort()).toEqual(["0-trace.network", "0-trace.trace", "resources/blob.bin", "resources/page.html", "resources/post-body.dat", "resources/shot.jpeg"]);
    for (const [name, bytes] of Object.entries(scrubbed)) {
      const text = Buffer.from(bytes).toString("latin1") + Buffer.from(bytes).toString("utf8");
      for (const form of [...forms(SECRET), ...forms(OTHER)]) {
        expect(text.includes(form), `${name} still contains ${JSON.stringify(form)}`).toBe(false);
      }
    }
  });

  it("keeps the trace usable: events still parse, with the values replaced by [REDACTED]", () => {
    const scrubbed = unzipSync(scrubTrace(traceZip(), [SECRET, OTHER]));
    const events = strFromU8(scrubbed["0-trace.trace"]!).split("\n").map((l) => JSON.parse(l) as { params?: { value?: string; selector?: string } });
    expect(events[0]!.params).toEqual({ selector: 'internal:label="Password"', value: "[REDACTED]" });
    expect(events[2]!.params!.value).toBe("[REDACTED]");
    const network = JSON.parse(strFromU8(scrubbed["0-trace.network"]!)) as { snapshot: { request: { headers: { name: string; value: string }[] } } };
    expect(network.snapshot.request.headers.map((h) => h.name)).toEqual(["Authorization", "Cookie"]);
    expect(network.snapshot.request.headers[1]!.value).toContain("[REDACTED]");
  });

  it("leaves binary entries without a secret byte-for-byte identical, and masks a secret found in one", () => {
    const original = unzipSync(traceZip());
    const scrubbed = unzipSync(scrubTrace(traceZip(), [SECRET]));
    expect(Buffer.from(scrubbed["resources/shot.jpeg"]!).equals(Buffer.from(original["resources/shot.jpeg"]!))).toBe(true);
    const blob = Buffer.from(scrubbed["resources/blob.bin"]!);
    expect(blob.includes(Buffer.from(SECRET))).toBe(false);
    expect(blob.length).toBe(original["resources/blob.bin"]!.length); // masked in place
  });

  it("no secrets → the trace is returned unchanged", () => {
    const zip = traceZip();
    expect(scrubTrace(zip, [])).toBe(zip);
  });

  it.each([
    ["not a zip", strToU8("this is not a zip file")],
    ["truncated", traceZip().slice(0, 40)],
    ["empty", new Uint8Array()],
  ])("an unparseable trace (%s) → TraceScrubError", (_label, bytes) => {
    expect(() => scrubTrace(bytes, [SECRET])).toThrow(TraceScrubError);
  });
});
