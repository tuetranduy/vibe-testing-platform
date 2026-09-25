import type { StoredTestRunRequest } from "@platform/contracts";

export function storedRequest(overrides: Partial<StoredTestRunRequest> = {}): StoredTestRunRequest {
  return {
    targetUrl: "https://shop.example.com",
    requirement: "A user can add a product to the cart. The cart count should increase.",
    environment: "staging",
    browser: "chromium",
    testData: {},
    secretNames: [],
    options: {
      maxExplorationSteps: 40,
      maxRunSeconds: 300,
      generatePlaywright: true,
      rerunGeneratedTest: true,
      autoConfirmCriteria: false,
      allowDestructiveActions: false,
      additionalAllowedHosts: [],
    },
    ...overrides,
  };
}
