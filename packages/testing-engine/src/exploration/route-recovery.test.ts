import type { DiscoveryRoute } from "@platform/contracts";
import { describe, expect, it } from "vitest";
import { chooseRouteUrl } from "./route-recovery";

const route = (title: string, relevantPaths: string[], goal = `${title} from the listing page.`): DiscoveryRoute => ({
  title, goal, relevantPaths, expectedBehavior: ["The page shows the result."],
});
const where = { current: "http://127.0.0.1:4599/", targetUrl: "http://127.0.0.1:4599/", additionalAllowedHosts: [] as string[] };

describe("route recovery from Browser Use routes (Phase C)", () => {
  it("opens the route page that matches the step, on the run's own origin", () => {
    const routes = [route("Read the help page", ["/help.html"]), route("Add tea to the cart", ["/catalog.html", "/product-assam.html", "/cart.html"])];
    expect(chooseRouteUrl(routes, "Click the 'Add to cart' button for Assam tea", where)).toBe("http://127.0.0.1:4599/product-assam.html");
    expect(chooseRouteUrl(routes, "Open the cart", where)).toBe("http://127.0.0.1:4599/cart.html");
  });

  it("never redirects an unrelated step, the current page, or a destructive path", () => {
    const routes = [route("Add tea to the cart", ["/cart.html"]), route("Remove account", ["/account/delete"], "Account settings page.")];
    expect(chooseRouteUrl(routes, "Type a review in the comment box", where)).toBeNull();
    expect(chooseRouteUrl(routes, "Open the cart", { ...where, current: "http://127.0.0.1:4599/cart.html" })).toBeNull();
    expect(chooseRouteUrl(routes, "Open account settings", where)).toBeNull();
  });

  it("stays on allowed hosts", () => {
    // A route path is resolved against the target's origin, so a host in a path cannot leave it.
    const url = chooseRouteUrl([route("Open the cart", ["/cart.html"])], "Open the cart", { ...where, targetUrl: "https://shop.example.com/" });
    expect(new URL(url!).origin).toBe("https://shop.example.com");
  });
});
