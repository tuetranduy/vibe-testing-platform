import type { UserView } from "@platform/contracts";

/**
 * The signed-in user as components see it in tests (`useMe` is mocked in vitest.setup.ts, so no test
 * spends a fetch on /auth/me). Null by default; reset after each test.
 */
export const testMe: { current: UserView | null } = { current: null };

export const userFixture = (patch: Partial<UserView> = {}): UserView => ({
  id: "usr_1",
  email: "ann@example.com",
  name: "Ann",
  role: "member",
  disabled: false,
  createdAt: "2026-09-29T10:00:00.000Z",
  ...patch,
});
