import { describe, expect, it } from "vitest";
import { parseFirebaseConfig } from "./own-firebase.js";

describe("own Firebase config", () => {
  it("reads the console snippet", () => {
    const text = `const firebaseConfig = {\n  apiKey: "k-123",\n  authDomain: "p.firebaseapp.com",\n  projectId: "my-project",\n  appId: "1:2:web:3"\n};`;
    expect(parseFirebaseConfig(text)).toEqual({ apiKey: "k-123", authDomain: "p.firebaseapp.com", projectId: "my-project", appId: "1:2:web:3" });
  });

  it("reads JSON and keeps the optional site key", () => {
    const text = JSON.stringify({ apiKey: "k", projectId: "p", appId: "a" });
    expect(parseFirebaseConfig(text, " site ")).toEqual({ apiKey: "k", projectId: "p", appId: "a", recaptchaSiteKey: "site" });
  });

  it("rejects an incomplete or hostile paste", () => {
    expect(parseFirebaseConfig(`{ apiKey: "k" }`)).toBeNull();
    expect(parseFirebaseConfig(`{ apiKey: alert(1), projectId: "p", appId: "a" }`)).toBeNull();
  });
});
