import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { json } from "../test/fixtures";
import { testMe, userFixture } from "../test/me";
import { AccountSettings } from "./AccountSettings";

describe("AccountSettings", () => {
  it("shows who is signed in", () => {
    testMe.current = userFixture({ name: "Ann", email: "ann@example.com", role: "admin" });
    render(<AccountSettings />);
    expect(screen.getByText(/ann@example.com · Administrator/)).toBeInTheDocument();
  });

  it("checks the new password locally, then changes it", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    render(<AccountSettings />);
    await userEvent.type(screen.getByLabelText("Current password"), "old password!");
    await userEvent.type(screen.getByLabelText("New password"), "brand new password");
    await userEvent.type(screen.getByLabelText("New password again"), "brand new passwork");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(screen.getByText("The two new passwords are not the same.")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    await userEvent.clear(screen.getByLabelText("New password again"));
    await userEvent.type(screen.getByLabelText("New password again"), "brand new password");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/auth/password",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ currentPassword: "old password!", newPassword: "brand new password" }),
      }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Password changed.");
    expect(screen.getByLabelText("Current password")).toHaveValue("");
  });

  it("puts a wrong current password on its field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(400, {
          code: "VALIDATION_FAILED",
          message: "x",
          issues: [{ path: ["currentPassword"], message: "The current password is not correct" }],
        }),
      ),
    );
    render(<AccountSettings />);
    await userEvent.type(screen.getByLabelText("Current password"), "wrong one");
    await userEvent.type(screen.getByLabelText("New password"), "brand new password");
    await userEvent.type(screen.getByLabelText("New password again"), "brand new password");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("The current password is not correct")).toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toHaveAttribute("aria-invalid", "true");
  });
});
