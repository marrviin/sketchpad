import { describe, expect, it } from "vitest";
import { renderDocSvg } from "../src/render.js";
import type { SketchStroke } from "../src/contract.js";

const stroke: SketchStroke = {
  id: "s1",
  tool: "felt",
  color: "ink",
  size: 1,
  pts: [[0, 0], [50, 50]],
};

describe("renderDocSvg", () => {
  it("produces an svg sized to the doc frame", () => {
    const svg = renderDocSvg({ width: 100, height: 80, strokes: [stroke] });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('viewBox="0.0 0.0 100.0 80.0"');
  });

  it("includes strokes as paths and paper background by default", () => {
    const svg = renderDocSvg({ width: 100, height: 80, strokes: [stroke] });
    expect(svg).toContain("<path");
    expect(svg).toMatch(/<rect[^>]*fill="#/);
  });

  it("drops the background rect in transparent mode", () => {
    const svg = renderDocSvg({ width: 100, height: 80, strokes: [stroke] }, { transparent: true });
    expect(svg).not.toContain("<rect");
  });

  it("frames a region when given", () => {
    const svg = renderDocSvg(
      { width: 100, height: 80, strokes: [stroke] },
      { region: { x0: 10, y0: 10, w: 40, h: 30 } },
    );
    expect(svg).toContain('viewBox="10.0 10.0 40.0 30.0"');
  });

  it("renders texts and icons", () => {
    const svg = renderDocSvg({
      width: 100,
      height: 80,
      strokes: [],
      texts: [{ id: "t1", x: 5, y: 5, size: 16, color: "ink", text: "标签" }],
      icons: [{ id: "i1", name: "search", x: 30, y: 30, size: 24, color: "ink" }],
    });
    expect(svg).toContain("标签");
  });
});
