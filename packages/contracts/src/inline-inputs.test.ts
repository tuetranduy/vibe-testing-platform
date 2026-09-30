import { describe, expect, it } from "vitest";
import { extractInlineInputs } from "./inline-inputs";

describe("extractInlineInputs: credentials written in the requirement are used, never ignored", () => {
  it.each([
    ["Log in as admin@shop.test with password Adm1n#2026 and see the dashboard.", "admin@shop.test", "Adm1n#2026"],
    ["Log in with admin@shop.test / Adm1n#2026, then open the cart.", "admin@shop.test", "Adm1n#2026"],
    ["Sign in using admin@shop.test:Secret-99 and check the orders page.", "admin@shop.test", "Secret-99"],
    ['Email: qa@example.com, password: "correct horse". The account page greets the user.', "qa@example.com", "correct horse"],
    ["Đăng nhập với tài khoản qa@example.com, mật khẩu: Matkhau@123 rồi mở giỏ hàng.", "qa@example.com", "Matkhau@123"],
  ])("%s", (text, email, password) => {
    const out = extractInlineInputs(text);
    expect(out.testData).toEqual({ email });
    expect(out.secrets).toEqual({ password });
    expect(out.text).not.toContain(password);
    expect(out.text).toContain("[secret: password]");
    expect(out.text).toContain(email); // test data stays in the text
    expect(out.found).toEqual([
      { kind: "secret", name: "password" },
      { kind: "testData", name: "email" },
    ]);
  });

  it("a username pair and a username label", () => {
    expect(extractInlineInputs("Log in with admin / S3cret! and the header shows Logout.")).toMatchObject({
      testData: { username: "admin" },
      secrets: { password: "S3cret!" },
    });
    expect(extractInlineInputs('Sign in with username "tester_01" and password "hunter22".')).toMatchObject({
      testData: { username: "tester_01" },
      secrets: { password: "hunter22" },
    });
  });

  it("two passwords (a password change) become two secrets, each replaced in the text", () => {
    const out = extractInlineInputs("Change the password from Old-Pass1 to: fine; new password: New-Pass2 is accepted.");
    expect(out.secrets).toEqual({ password: "New-Pass2" });
    const both = extractInlineInputs('Old password "Old-Pass1", new password "New-Pass2": the change succeeds.');
    expect(both.secrets).toEqual({ password: "Old-Pass1", password_2: "New-Pass2" });
    expect(both.text).toBe('Old password "[secret: password]", new password "[secret: password_2]": the change succeeds.');
  });

  it("leaves sentences about passwords alone: no label value, no credential-looking value", () => {
    for (const text of [
      "An invalid password shows an error under the password field.",
      "When the password is incorrect, the login page says so.",
      "The password is required and must be at least 8 characters.",
      "After signing in, the user is redirected to the account page.",
      "Pass the checkout step and see the confirmation.",
    ]) {
      expect(extractInlineInputs(text)).toEqual({ text, testData: {}, secrets: {}, found: [] });
    }
  });

  it("an email outside any sign-in context is left as an expected value, not test data", () => {
    expect(extractInlineInputs("The footer shows support@shop.test as the contact address.").testData).toEqual({});
    expect(extractInlineInputs("Register with jane@example.com and see the welcome page.").testData).toEqual({ email: "jane@example.com" });
  });

  it("the user's own values win: a secret already entered keeps its name; an existing key is not overwritten", () => {
    const out = extractInlineInputs("Log in as admin@shop.test with password Adm1n#2026.", {
      secrets: { admin_pw: "Adm1n#2026" },
      testData: { email: "other@shop.test" },
    });
    expect(out.secrets).toEqual({});
    expect(out.testData).toEqual({});
    expect(out.text).toBe("Log in as admin@shop.test with password [secret: admin_pw].");
    expect(out.found).toEqual([{ kind: "secret", name: "admin_pw" }]);

    const named = extractInlineInputs("Log in with password Adm1n#2026.", { secrets: { password: "something-else" } });
    expect(named.secrets).toEqual({ password_2: "Adm1n#2026" });
  });

  it("is idempotent on its own output, and respects the limits", () => {
    const once = extractInlineInputs("Log in as admin@shop.test with password Adm1n#2026.");
    expect(extractInlineInputs(once.text, { testData: once.testData, secrets: once.secrets })).toMatchObject({ secrets: {}, testData: {} });
    const full = extractInlineInputs("Log in as admin@shop.test with password Adm1n#2026.", { maxSecrets: 0, maxTestData: 0 });
    expect(full).toMatchObject({ secrets: {}, testData: {} });
  });
});
