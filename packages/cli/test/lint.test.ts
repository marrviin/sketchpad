import { describe, expect, it } from "vitest";
import { lintDoc } from "../src/lint.js";
import type { SketchStroke, SketchText } from "../src/contract.js";

const stroke: SketchStroke = {
  id: "s1",
  tool: "felt",
  color: "ink",
  size: 1,
  pts: [[0, 0], [100, 100]],
};

const text: SketchText = { id: "t1", x: 10, y: 10, size: 16, color: "ink", text: "标签" };

describe("lintDoc", () => {
  it("flags an empty canvas as info", () => {
    const issues = lintDoc({ width: 100, height: 100, strokes: [], texts: [] });
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe("info");
  });

  it("passes a clean doc with no issues", () => {
    const farText = { ...text, x: 200, y: 200 };
    const issues = lintDoc({ width: 500, height: 500, strokes: [stroke], texts: [farText] });
    expect(issues).toHaveLength(0);
  });

  it("detects overlapping texts", () => {
    const a: SketchText = { ...text, text: "很长的标题文本" };
    const b: SketchText = { ...text, id: "t2", text: "另一段标题文本" };
    const issues = lintDoc({ width: 500, height: 500, strokes: [], texts: [a, b] });
    expect(issues.some((i) => i.kind === "text-overlap" && i.severity === "warn")).toBe(true);
  });

  it("accepts a label nested inside its container stroke", () => {
    const container: SketchStroke = {
      id: "s2",
      tool: "felt",
      color: "ink",
      size: 1,
      pts: [[0, 0], [120, 0], [120, 60], [0, 60], [0, 0]],
    };
    const label: SketchText = { ...text, x: 30, y: 20 };
    const issues = lintDoc({ width: 500, height: 500, strokes: [container], texts: [label] });
    expect(issues).toHaveLength(0);
  });
});
