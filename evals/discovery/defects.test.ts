import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { reproductionRequirement } from "@platform/contracts";
import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFECTS, scoreFindings } from "./defects";

const SITE = path.resolve(import.meta.dirname, "../../apps/browser-use-discovery/fixture/site");
const findings = [
  { title: "Help link opens a missing page", path: "/benchmark/defects/index.html", observation: "The Help link opened /benchmark/defects/help.html, which answers 404.",
    expected: "The Help page opens", reproduction: ["Open /benchmark/defects/index.html", 'Click the "Help" link'] },
  { title: "Item count contradicts the list", path: "/benchmark/defects/catalog.html", observation: 'The heading says "0 seeds available" but the page lists 3 items.',
    expected: "The count in the heading matches the 3 listed items", reproduction: ["Open /benchmark/defects/catalog.html", "Compare the count with the list"] },
];

describe("findings scored against known defects", () => {
  it("counts matches, misses and false alarms", () => {
    expect(scoreFindings(findings)).toMatchObject({ recall: 1, precision: 1, falseAlarms: 0, missed: [] });
    const noisy = scoreFindings([findings[0]!, { title: "Shipping looks wrong", path: "/benchmark/defects/shipping.html", observation: "Odd." }]);
    expect(noisy).toMatchObject({ recall: 0.5, precision: 0.5, falseAlarms: 1, missed: ["count-mismatch"] });
    expect(scoreFindings([]).precision).toBeNull();
  });
});

describe.runIf(existsSync(chromium.executablePath()))("the defects are real, and a reproduction checks what they break", () => {
  let server: Server;
  let browser: Browser;
  let origin: string;
  beforeAll(async () => {
    server = createServer((req, res) => {
      const file = path.join(SITE, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
      if (!file.startsWith(SITE) || !existsSync(file)) {
        res.writeHead(404, { "content-type": "text/html" }).end("<title>Error response</title><h1>Error response</h1><p>404 Not Found</p>");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      createReadStream(file).pipe(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
  });

  it("broken-help-link: the Help link's page answers 404, so 'the help page opens' fails", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}${DEFECTS.fixture}`);
    const [response] = await Promise.all([page.waitForEvent("response"), page.getByRole("link", { name: "Help" }).click()]);
    expect(response.status()).toBe(404);
    expect(reproductionRequirement({ ...findings[0]!, path: findings[0]!.path })).toContain("Verify that the Help page opens.");
  });

  it("count-mismatch: the heading's count differs from the list, so 'the count matches' fails", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}/benchmark/defects/catalog.html`);
    const heading = Number((await page.locator("#summary").textContent())!.match(/\d+/)![0]);
    expect(heading).not.toBe(await page.locator("#seeds li").count());
    expect(reproductionRequirement(findings[1]!)).toContain("Verify that the count in the heading matches the 3 listed items.");
  });

  it("the healthy page has no defect: its count matches its list", async () => {
    const page = await browser.newPage();
    await page.goto(`${origin}${DEFECTS.healthy[0]}`);
    expect(Number((await page.locator("h2").textContent())!.match(/\d+/)![0])).toBe(await page.locator("li").count());
  });
});
