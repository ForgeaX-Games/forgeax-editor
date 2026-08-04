import { describe, expect, test } from "bun:test";
import { validateApiCall } from "./agnostic-api-policy";

describe("agnostic API policy", () => {
  test("confines game-host package routes to the centralized client", () => {
    const source = "src/lib/game-host-api.ts";
    expect(
      validateApiCall(
        "/api/game-host/games/${encodeURIComponent(slug)}/package/initialize",
        source,
      ),
    ).toBeNull();
    expect(
      validateApiCall(
        "/api/game-host/games/${encodeURIComponent(slug)}/package/status",
        source,
      ),
    ).toBeNull();

    expect(
      validateApiCall(
        "/api/game-host/games/${encodeURIComponent(slug)}/package/status",
        "src/components/MainArea/StandaloneExtensionIframe.tsx",
      ),
    ).toContain("must be called from src/lib/game-host-api.ts");
  });

  test("recognizes the centralized client with Windows path separators", () => {
    const endpoint =
      "/api/game-host/games/${encodeURIComponent(slug)}/package/status";

    expect(validateApiCall(endpoint, "src\\lib\\game-host-api.ts")).toBeNull();
    expect(validateApiCall(endpoint, "src\\lib/game-host-api.ts")).toBeNull();
    expect(
      validateApiCall(
        endpoint,
        "src\\components\\MainArea\\StandaloneExtensionIframe.tsx",
      ),
    ).toContain("must be called from src/lib/game-host-api.ts");
  });

  test("rejects a mutated game-host package route", () => {
    expect(
      validateApiCall(
        "/api/game-host/games/${encodeURIComponent(slug)}/package/delete",
        "src/lib/game-host-api.ts",
      ),
    ).toContain("unallowlisted API endpoint");
  });

  test("allows the project version endpoints", () => {
    expect(
      validateApiCall(
        "/api/version",
        "src/components/StatusBar/footer/ProjectVersionPopover.tsx",
      ),
    ).toBeNull();
    expect(
      validateApiCall(
        "/api/version/tags",
        "src/components/StatusBar/footer/ProjectVersionPopover.tsx",
      ),
    ).toBeNull();
  });
});
