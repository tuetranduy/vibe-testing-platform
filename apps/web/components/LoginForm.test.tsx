import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { LoginForm, safeNext } from "./LoginForm";

describe("safeNext", () => {
  it.each([
    [null, "/"],
    ["/runs/run_1?x=1", "/runs/run_1?x=1"],
    ["https://evil.example/", "/"],
    ["//evil.example/", "/"],
    ["/\\evil.example", "/"],
    ["/login?next=/x", "/"],
    ["runs", "/"],
  ])("%j → %j", (next, expected) => {
    expect(safeNext(next)).toBe(expected);
  });
});

describe("LoginForm", () => {
  it("signs in and goes to the page the user came from", async () => {
    const fetch = vi.fn(async () =>
      json(200, {
        expiresAt: "2030-01-01T00:00:00.000Z",
        user: { id: "u", email: "a@example.com", name: "A", role: "member", disabled: false, createdAt: "2026-09-29T00:00:00.000Z" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const navigate = vi.fn();
    render(<LoginForm next="/runs/run_9" navigate={navigate} />);
    await userEvent.type(screen.getByLabelText("E-mail address"), "a@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "correct horse battery");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/auth/login",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "a@example.com", password: "correct horse battery" }) }),
    );
    expect(navigate).toHaveBeenCalledWith("/runs/run_9");
  });

  it("shows a wrong password plainly and clears the field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(401, { code: "INVALID_CREDENTIALS", message: "x" })),
    );
    const navigate = vi.fn();
    render(<LoginForm navigate={navigate} />);
    await userEvent.type(screen.getByLabelText("E-mail address"), "a@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The e-mail address or password is not correct.");
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("explains throttling, and asks for both fields before sending anything", async () => {
    const fetch = vi.fn(async () => json(429, { code: "TOO_MANY_ATTEMPTS", message: "x" }));
    vi.stubGlobal("fetch", fetch);
    render(<LoginForm navigate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter your e-mail address and password.");
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText("E-mail address"), "a@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "whatever");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Too many failed sign-ins. Try again in 15 minutes.")).toBeInTheDocument();
  });
});
