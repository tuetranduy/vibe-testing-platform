import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { LiveEvidence } from "./LiveEvidence";

const shot = (artifactId: string, sensitivity: "STANDARD" | "SECRET_BEARING") => ({
  artifactId,
  sensitivity,
  message: `Screenshot saved at checkpoint ${artifactId}`,
  timestamp: "2026-09-26T10:00:05.000Z",
});

function urlFetch() {
  let n = 0;
  const fetch = vi.fn(async (_input: RequestInfo | URL) => json(200, { url: `https://s3.test/shot-${++n}.png`, expiresAt: "2026-09-26T10:05:00.000Z" }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("LiveEvidence", () => {
  it("shows a placeholder before the first screenshot", () => {
    const fetch = urlFetch();
    render(<LiveEvidence runId="run_1" screenshot={null} />);
    expect(screen.getByText(/no screenshot yet/i)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("loads a STANDARD screenshot automatically through the proxy", async () => {
    const fetch = urlFetch();
    render(<LiveEvidence runId="run_1" screenshot={shot("art_1", "STANDARD")} />);
    const img = await screen.findByRole("img", { name: /screenshot saved at checkpoint art_1/i });
    expect(img).toHaveAttribute("src", "https://s3.test/shot-1.png");
    expect(String(fetch.mock.calls[0]![0])).toBe("/api/v1/test-runs/run_1/artifacts/art_1/url");
  });

  it("loads a SECRET_BEARING screenshot (recorded before 2026-10-07) without asking", async () => {
    const fetch = urlFetch();
    render(<LiveEvidence runId="run_1" screenshot={shot("art_2", "SECRET_BEARING")} />);
    expect(await screen.findByRole("img")).toHaveAttribute("src", "https://s3.test/shot-1.png");
    expect(String(fetch.mock.calls[0]![0])).toBe("/api/v1/test-runs/run_1/artifacts/art_2/url");
    expect(screen.queryByRole("button", { name: /reveal/i })).not.toBeInTheDocument();
  });

  it("refetches the signed URL when the image fails to load (expired)", async () => {
    const fetch = urlFetch();
    render(<LiveEvidence runId="run_1" screenshot={shot("art_1", "STANDARD")} />);
    const img = await screen.findByRole("img");
    fireEvent.error(img);
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", "https://s3.test/shot-2.png"));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after repeated load failures instead of looping", async () => {
    const fetch = urlFetch();
    render(<LiveEvidence runId="run_1" screenshot={shot("art_1", "STANDARD")} />);
    for (let i = 1; i <= 3; i++) {
      const img = await screen.findByRole("img");
      await waitFor(() => expect(img).toHaveAttribute("src", `https://s3.test/shot-${i}.png`));
      fireEvent.error(img);
    }
    expect(await screen.findByText(/couldn.t be loaded/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("switches to the newest screenshot", async () => {
    urlFetch();
    const { rerender } = render(<LiveEvidence runId="run_1" screenshot={shot("art_1", "STANDARD")} />);
    await screen.findByRole("img", { name: /art_1/ });
    rerender(<LiveEvidence runId="run_1" screenshot={shot("art_3", "STANDARD")} />);
    expect(await screen.findByRole("img", { name: /art_3/ })).toHaveAttribute("src", "https://s3.test/shot-2.png");
  });
});
