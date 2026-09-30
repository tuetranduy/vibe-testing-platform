"use client";

import type { UserView } from "@platform/contracts";
import { useEffect, useState } from "react";
import { getMe } from "./api";

/**
 * The signed-in user, fetched once per page load and shared by every component that asks (the header,
 * Settings, the history's owner filter). `null` while loading or when it could not be loaded.
 */
let cached: Promise<UserView> | null = null;

export function loadMe(): Promise<UserView> {
  cached ??= getMe().catch((err: unknown) => {
    cached = null;
    throw err;
  });
  return cached;
}

/** Test seam: forget the cached user. */
export function resetMe(): void {
  cached = null;
}

/** `enabled: false` (the sign-in page) asks nothing: there is no session to ask with. */
export function useMe(enabled = true): UserView | null {
  const [me, setMe] = useState<UserView | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadMe().then(
      (u) => live && setMe(u),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return me;
}

export const isAdminUser = (u: UserView | null): boolean => u?.role === "admin";
