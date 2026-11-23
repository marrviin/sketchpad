import { describe, expect, it } from "vitest";
import { estimateTextWidth } from "../src/compose.js";

describe("estimateTextWidth", () => {
  it("CJK characters count one em each", () => {
    expect(estimateTextWidth("中文", 10)).toBe(20);
  });

  it("latin characters are narrower than CJK", () => {
    expect(estimateTextWidth("ab", 10)).toBeLessThan(estimateTextWidth("中文", 10));
  });

  it("scales linearly with size", () => {
    expect(estimateTextWidth("ab", 20)).toBe(2 * estimateTextWidth("ab", 10));
  });
});
