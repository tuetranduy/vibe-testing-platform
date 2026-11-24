import type { Page } from "playwright-core";

interface Oracle {
  id: string;
  inventory: RegExp;
  /** The behavior a suggestion must name to cover this check, worded for any source (survey or Browser Use). */
  proposal: RegExp;
  requirement: string;
  paths?: string[];
}

interface Fixture {
  id: string;
  path: string;
  oracles: Oracle[];
  verify(page: Page): Promise<boolean>;
}

const fixture = (id: string, oracles: Oracle[], verify: Fixture["verify"]): Fixture => ({
  id, path: `/benchmark/${id}/index.html`, oracles, verify,
});
const hasHeading = (page: Page, title: string) => page.getByRole("heading", { name: title, exact: true }).count().then(Boolean);

export const DISCOVERY_CORPUS: Fixture[] = [
  fixture("museum", [{
    id: "exhibit-navigation", inventory: /Wetland exhibit/, proposal: /wetland exhibit|exhibit page/i,
    requirement: "Open Wetland exhibit and verify that the page heading identifies the exhibit.",
    paths: ["exhibit.html"],
  }], async (page) => {
    await page.getByRole("link", { name: "Wetland exhibit" }).click();
    return hasHeading(page, "Wetland exhibit");
  }),
  fixture("planner", [{
    id: "client-side-routing", inventory: /This week/, proposal: /this week|weekly section|client.side (navigation|routing)/i,
    requirement: "Choose This week and verify that the planner switches to the weekly section.",
  }], async (page) => {
    await page.getByRole("link", { name: "This week" }).click();
    await page.getByRole("heading", { name: "This week" }).waitFor();
    return page.url().endsWith("#week");
  }),
  fixture("library", [{
    id: "catalog-search", inventory: /Search books/, proposal: /search/i,
    requirement: "Search for Urban birds and check that it is the only visible book.",
  }, {
    id: "pagination", inventory: /Next page/, proposal: /pagination|next page/i,
    requirement: "Open the next page and verify that Catalog page two is the heading.",
    paths: ["page-two.html"],
  }], async (page) => {
    await page.getByRole("searchbox").fill("Urban birds");
    await page.getByRole("button", { name: "Search" }).click();
    const matched = await page.getByRole("listitem").allTextContents();
    await page.getByRole("link", { name: "Next page" }).click();
    return matched.join(",") === "Urban birds" && await hasHeading(page, "Catalog page two");
  }),
  fixture("appointment", [{
    id: "required-fields", inventory: /Preview estimate/, proposal: /required|estimate/i,
    requirement: "Preview with an empty required email field and check that the estimate remains empty.",
  }], async (page) => {
    await page.getByRole("button", { name: "Preview estimate" }).click();
    const emailInvalid = await page.getByLabel("Email").evaluate((input: HTMLInputElement) => input.validity.valueMissing);
    return emailInvalid && await page.getByRole("status").textContent() === "";
  }),
  fixture("support", [{
    id: "disclosure", inventory: /Where is my reference number/, proposal: /reference.number|disclosure|expand/i,
    requirement: "Expand the reference-number question and check that it shows where to find the number.",
  }, {
    id: "dialog-dismissal", inventory: /Open help dialog/, proposal: /dialog/i,
    requirement: "Open the help dialog and verify that Close help dismisses it.",
  }], async (page) => {
    await page.getByText("Where is my reference number?").click();
    const answerVisible = await page.getByText("Look at the top of the receipt.").isVisible();
    await page.getByRole("button", { name: "Open help dialog" }).click();
    const dialog = page.getByRole("dialog");
    const opened = await dialog.isVisible();
    await page.getByRole("button", { name: "Close help" }).click();
    return answerVisible && opened && !await dialog.isVisible();
  }),
  fixture("workspace", [{
    id: "guest-guide", inventory: /public workspace guide/, proposal: /guest|public workspace guide/i,
    requirement: "Open the public workspace guide as a guest and verify that the guide is visible.",
    paths: ["guide.html"],
  }], async (page) => {
    await page.getByRole("link", { name: "Read the public workspace guide" }).click();
    return hasHeading(page, "Workspace guide");
  }),
  fixture("status", [{
    id: "status-error", inventory: /Refresh status/, proposal: /status refresh|refresh the status/i,
    requirement: "Refresh the status and verify that the status region offers retry guidance when the response fails.",
  }], async (page) => {
    await page.getByRole("button", { name: "Refresh status" }).click();
    await page.getByText("Status unavailable. Try again.").waitFor();
    return true;
  }),
  fixture("academy", [{
    id: "enrollment-journey", inventory: /Review enrollment/, proposal: /enrol?lment|course schedule/i,
    requirement: "Follow the field course, schedule, and review links and check that enrollment review shows the weekday session.",
    paths: ["program.html", "schedule.html", "review.html"],
  }], async (page) => {
    await page.getByRole("link", { name: "Browse field courses" }).click();
    await page.getByRole("link", { name: "View course schedule" }).click();
    await page.getByRole("link", { name: "Review enrollment" }).click();
    return await hasHeading(page, "Enrollment review") && await page.getByText(/Weekday session/).isVisible();
  }),
  fixture("community", [{
    id: "guidelines", inventory: /Community guidelines/, proposal: /guidelines/i,
    requirement: "Follow Community guidelines and verify that the guidelines page identifies itself.",
    paths: ["guidelines.html"],
  }], async (page) => {
    await page.getByRole("link", { name: "Community guidelines" }).click();
    return hasHeading(page, "Community guidelines");
  }),
  {
    id: "tea-shop", path: "/",
    oracles: [{
      id: "cart-quantity", inventory: /Add to cart/, proposal: /add\b.*\bto the cart|cart\b.*\bquantity/i,
      requirement: "Add two Sencha teas to the cart and verify that the cart displays the quantity.",
      paths: ["product-sencha.html", "cart.html"],
    }],
    verify: async (page) => {
      await page.getByRole("link", { name: "Sencha", exact: true }).click();
      await page.getByRole("spinbutton", { name: "Quantity" }).fill("2");
      await page.getByRole("button", { name: "Add to cart" }).click();
      await page.getByRole("link", { name: "Cart", exact: true }).click();
      const row = page.getByRole("row").filter({ hasText: "Sencha" });
      return row.getByRole("cell", { name: "2", exact: true }).isVisible();
    },
  },
];
