import { describe, expect, it } from "vitest";
import { hrefFor, parseHash } from "./router.js";

describe("hash router", () => {
  it("parses pages, request ids and the full view", () => {
    expect(parseHash("#/overview").page).toBe("overview");
    expect(parseHash("#/traffic?status=blocked").query.status).toBe("blocked");
    expect(parseHash("#/traffic/r1")).toMatchObject({ page: "traffic", id: "r1" });
    expect(parseHash("#/traffic/r1?view=full")).toMatchObject({ id: "r1", view: "full" });
  });
  it("falls back to overview for unknown or empty hashes", () => {
    expect(parseHash("").page).toBe("overview");
    expect(parseHash("#/nope").page).toBe("overview");
  });
  it("builds links that parse back", () => {
    expect(parseHash(hrefFor("traffic", "a b", { view: "full" }))).toMatchObject({ id: "a b", view: "full" });
  });
});
