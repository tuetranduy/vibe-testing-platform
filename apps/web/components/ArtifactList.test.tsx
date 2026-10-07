import type { ArtifactSensitivity, ArtifactType } from "@platform/contracts";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactInfo } from "../lib/progress-reducer";
import { json } from "../test/fixtures";
import { ArtifactList } from "./ArtifactList";

const info = (artifactId: string, type: ArtifactType, sensitivity: ArtifactSensitivity, message = `${type} ${artifactId}`): ArtifactInfo => ({
  artifactId,
  type,
  sensitivity,
  message,
  timestamp: "2026-09-26T10:01:00.000Z",
});
const known = (...list: ArtifactInfo[]) => new Map(list.map((a) => [a.artifactId, a]));

function urlFetch(expiresAt = "2099-01-01T00:00:00.000Z") {
  let n = 0;
  const fetch = vi.fn(async (_input: RequestInfo | URL) => json(200, { url: `https://s3.test/file-${++n}`, expiresAt }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
const urls = (fetch: ReturnType<typeof urlFetch>) => fetch.mock.calls.map((c) => String(c[0]));

describe("ArtifactList", () => {
  it("says so when there is no evidence", () => {
    const fetch = urlFetch();
    render(<ArtifactList runId="run_1" artifactIds={[]} artifacts={known()} />);
    expect(screen.getByText(/no evidence/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads a STANDARD screenshot automatically and links to the full-size image", async () => {
    const fetch = urlFetch();
    render(
      <ArtifactList runId="run_1" artifactIds={["art_1"]} artifacts={known(info("art_1", "SCREENSHOT", "STANDARD", "Screenshot saved at checkpoint after_add"))} />,
    );
    const img = await screen.findByRole("img", { name: /checkpoint after_add/i });
    expect(img).toHaveAttribute("src", "https://s3.test/file-1");
    expect(urls(fetch)).toEqual(["/api/v1/test-runs/run_1/artifacts/art_1/url"]);
    const open = screen.getByRole("link", { name: /open full size/i });
    expect(open).toHaveAttribute("href", "https://s3.test/file-1");
    expect(open).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("loads a SECRET_BEARING artifact (recorded before 2026-10-07) straight away: nothing is hidden behind a reveal", async () => {
    const fetch = urlFetch();
    render(<ArtifactList runId="run_1" artifactIds={["art_2"]} artifacts={known(info("art_2", "SCREENSHOT", "SECRET_BEARING", "Screenshot saved at checkpoint after_login"))} />);
    expect(await screen.findByRole("img", { name: /after_login/ })).toHaveAttribute("src", "https://s3.test/file-1");
    expect(urls(fetch)).toEqual(["/api/v1/test-runs/run_1/artifacts/art_2/url"]);
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/may contain credentials/i)).not.toBeInTheDocument();
  });

  it("loads an artifact it knows nothing about too", async () => {
    const fetch = urlFetch();
    render(<ArtifactList runId="run_1" artifactIds={["art_x"]} artifacts={known()} />);
    await waitFor(() => expect(urls(fetch)).toEqual(["/api/v1/test-runs/run_1/artifacts/art_x/url"]));
  });

  it("offers a trace as a download and plays a video inline", async () => {
    urlFetch();
    render(
      <ArtifactList
        runId="run_1"
        artifactIds={["art_t", "art_v"]}
        artifacts={known(info("art_t", "TRACE", "STANDARD", "Rerun trace stored"), info("art_v", "VIDEO", "STANDARD", "Rerun video stored"))}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]!).getByText("Trace")).toBeInTheDocument();
    expect(await within(items[0]!).findByRole("link", { name: /download trace/i })).toHaveAttribute("href", expect.stringMatching(/^https:\/\/s3\.test\//));
    expect(within(items[0]!).getByText(/playwright show-trace/)).toBeInTheDocument();
    await waitFor(() => expect(items[1]!.querySelector("video")).toHaveAttribute("src", expect.stringMatching(/^https:\/\/s3\.test\//)));
  });

  it("fetches a fresh URL when the image fails to load (the signed URL expired)", async () => {
    const fetch = urlFetch();
    render(<ArtifactList runId="run_1" artifactIds={["art_1"]} artifacts={known(info("art_1", "SCREENSHOT", "STANDARD"))} />);
    fireEvent.error(await screen.findByRole("img"));
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "https://s3.test/file-2"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refreshes an expired download link instead of following it", async () => {
    const user = userEvent.setup();
    const fetch = urlFetch("2000-01-01T00:00:00.000Z"); // already expired
    render(<ArtifactList runId="run_1" artifactIds={["art_t"]} artifacts={known(info("art_t", "TRACE", "STANDARD"))} />);
    await user.click(await screen.findByRole("link", { name: /download trace/i }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/link expired and was refreshed/i)).toBeInTheDocument();
  });
});
