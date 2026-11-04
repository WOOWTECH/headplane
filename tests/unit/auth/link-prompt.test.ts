import { describe, expect, test } from "vitest";

import { type Principal, shouldPromptHeadscaleLink } from "~/server/web/auth";

function userPrincipal(
  kind: "oidc" | "proxy",
  headscaleUserId?: string,
): Extract<Principal, { kind: "oidc" | "proxy" }> {
  return {
    kind,
    sessionId: kind === "proxy" ? "proxy-auth" : "session-1",
    user: { id: "u1", subject: `${kind}:admin`, role: "owner", headscaleUserId },
    profile: { name: "admin" },
  };
}

describe("shouldPromptHeadscaleLink", () => {
  test("proxy-auth admin who can use the UI is not asked to pick a Headscale user", () => {
    expect(shouldPromptHeadscaleLink(userPrincipal("proxy"), true)).toBe(false);
  });

  test("proxy-auth user without UI access is still asked (they need a device identity)", () => {
    expect(shouldPromptHeadscaleLink(userPrincipal("proxy"), false)).toBe(true);
  });

  test("OIDC users keep the upstream behavior", () => {
    expect(shouldPromptHeadscaleLink(userPrincipal("oidc"), true)).toBe(true);
    expect(shouldPromptHeadscaleLink(userPrincipal("oidc"), false)).toBe(true);
  });

  test("already linked users are never asked", () => {
    expect(shouldPromptHeadscaleLink(userPrincipal("proxy", "7"), false)).toBe(false);
    expect(shouldPromptHeadscaleLink(userPrincipal("oidc", "7"), true)).toBe(false);
  });

  test("API key sessions are never asked", () => {
    const principal: Principal = {
      kind: "api_key",
      sessionId: "s",
      displayName: "API Key",
      apiKey: "k",
    };
    expect(shouldPromptHeadscaleLink(principal, true)).toBe(false);
  });
});
