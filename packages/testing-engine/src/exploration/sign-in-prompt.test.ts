import { describe, expect, it } from "vitest";
import { openedSignIn } from "./sign-in-prompt";

const at = (url: string, passwordFields = 0) => ({ url, passwordFields });

describe("openedSignIn (KI-073)", () => {
  it("a password field appeared: a sign-in dialog", () => {
    expect(openedSignIn(at("https://shop.test/p/1"), at("https://shop.test/p/1", 1), "Click the 'Add to wishlist' button")).toBe(true);
  });

  it("the click opened a login page", () => {
    expect(openedSignIn(at("https://shop.test/p/1"), at("https://shop.test/account/login?next=/wishlist"), "Click 'Add to wishlist'")).toBe(true);
    expect(openedSignIn(at("https://shop.test/p/1"), at("https://shop.test/signin"), "Click 'Write a review'")).toBe(true);
  });

  it("nothing changed, or a password field was already there", () => {
    expect(openedSignIn(at("https://shop.test/p/1"), at("https://shop.test/cart"), "Click 'Add to cart'")).toBe(false);
    expect(openedSignIn(at("https://shop.test/login", 1), at("https://shop.test/login", 1), "Click 'Add to cart'")).toBe(false);
  });

  it("ignores a step that asks for sign-in, registration or the account itself", () => {
    for (const description of ["Click Sign in", "Open the login dialog", "Click the 'Register' link", "Click 'Sign up'", "Open my account"]) {
      expect(openedSignIn(at("https://shop.test/"), at("https://shop.test/login", 1), description)).toBe(false);
    }
  });

  it("a page whose path only contains the words is not a login page", () => {
    expect(openedSignIn(at("https://shop.test/"), at("https://shop.test/blog/how-to-login-faster-guide"), "Click 'Blog'")).toBe(false);
  });
});
