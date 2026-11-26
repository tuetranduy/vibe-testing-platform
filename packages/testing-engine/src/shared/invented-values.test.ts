import { describe, expect, it } from "vitest";
import { inventedValueIssue } from "./invented-values";

const fill = (description: string, key: string, source: "literal" | "testData" | "secret" = "literal") => ({ kind: "fill", description, inputRef: { source, key } });
const TEXT = "verify user can register new account and login with newly created account successfully";

describe("inventedValueIssue", () => {
  it("refuses a made-up password, username or name typed as a literal, without repeating the value", () => {
    for (const step of [
      fill("Type the chosen password into the 'Mật khẩu' (password) field of the registration form", "password123"),
      fill("Retype the 'Tên đăng nhập' (username) field with a different, unused username", "qa.newuser.7f3a@example.com"),
      fill("Type a full name into the 'Họ và tên' text field of the registration form", "Test User"),
    ]) {
      const issue = inventedValueIssue(step, TEXT);
      expect(issue).toMatch(/test data key you name/);
      expect(issue).not.toContain(step.inputRef.key);
    }
  });

  it("allows a literal the requirement writes, a value that is not an account's, and every named reference", () => {
    expect(inventedValueIssue(fill("Type the password into the password field", "Secret 123"), "Log in with password  secret 123.")).toBeNull();
    expect(inventedValueIssue(fill("Enter the estimated value", "3122"), TEXT)).toBeNull();
    expect(inventedValueIssue(fill("Type the password", "new_account_password", "testData"), TEXT)).toBeNull();
    expect(inventedValueIssue(fill("Type the password", "new_account_password", "secret"), TEXT)).toBeNull();
    expect(inventedValueIssue({ kind: "search", description: "Search the account list", inputRef: { source: "literal", key: "shoes" } }, TEXT)).toBeNull();
    expect(inventedValueIssue(fill("Type the password", "password123"), undefined)).toBeNull();
  });
});
