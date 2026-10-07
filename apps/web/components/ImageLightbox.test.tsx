import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ImageLightbox } from "./ImageLightbox";

function Opener({ onError }: { onError?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && <ImageLightbox src="https://s3.test/shot.png" alt="Cart page" caption="Screenshot at checkpoint cart_page" onClose={() => setOpen(false)} onError={onError} />}
    </>
  );
}

describe("ImageLightbox", () => {
  it("shows the image in a modal dialog, focuses Close, locks the page's scroll; Close gives focus back", async () => {
    const user = userEvent.setup();
    render(<Opener />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Screenshot at checkpoint cart_page" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("img", { name: "Cart page" })).toHaveAttribute("src", "https://s3.test/shot.png");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(opener).toHaveFocus();
  });

  it("switches between fit to width and actual size, by the button or a click on the image", async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    const img = screen.getByRole("img");
    expect(img).not.toHaveClass("lightbox-image-actual");
    await user.click(screen.getByRole("button", { name: "Actual size" }));
    expect(img).toHaveClass("lightbox-image-actual");
    await user.click(img);
    expect(img).not.toHaveClass("lightbox-image-actual");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("closes on Escape and on a click outside the image", async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.mouseDown(document.querySelector(".lightbox-backdrop")!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("reports an image that fails to load (an expired signed URL) to the caller", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    render(<Opener onError={onError} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    fireEvent.error(screen.getByRole("img"));
    expect(onError).toHaveBeenCalledOnce();
  });
});
