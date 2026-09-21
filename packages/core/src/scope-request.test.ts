import { describe, expect, it } from "vitest";
import { scopeRequestFrom } from "./connector";

describe("scopeRequestFrom", () => {
  it("reads a scope object out of connect() input and nothing else", () => {
    const scope = {
      required: { eip155: { chains: ["eip155:1"], methods: [], events: [] } },
    };
    expect(scopeRequestFrom({ scope })).toBe(scope);
    expect(scopeRequestFrom({ chainId: "eip155:1" })).toBeUndefined();
    expect(scopeRequestFrom({ scope: "eip155:1" })).toBeUndefined();
    expect(scopeRequestFrom("io.metamask")).toBeUndefined();
    expect(scopeRequestFrom(undefined)).toBeUndefined();
  });
});
