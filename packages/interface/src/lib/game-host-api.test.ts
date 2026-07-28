import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  getVideoGamePackageStatus,
  initializeVideoGamePackage,
} from "./game-host-api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("game-host API", () => {
  test("encodes the slug when reading package status", async () => {
    const fetchMock = mock(async () =>
      new Response(JSON.stringify({ state: "initialized" }), { status: 200 })
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(getVideoGamePackageStatus("game / one")).resolves.toEqual({
      state: "initialized",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/game-host/games/game%20%2F%20one/package/status",
    );
  });

  test("preserves initialize response semantics", async () => {
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({ state: "pending", error: { hint: "asset missing" } }),
        { status: 409 },
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(initializeVideoGamePackage("demo")).resolves.toEqual({
      ok: false,
      error: "asset missing",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/game-host/games/demo/package/initialize",
      { method: "POST" },
    );
  });
});
