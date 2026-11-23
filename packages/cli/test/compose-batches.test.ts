import { describe, expect, it } from "vitest";
import { composeBatches } from "../src/compose.js";
import { shapeSchema, textSchema } from "../src/contract.js";

describe("composeBatches", () => {
  const flow = {
    scene: "flow" as const,
    title: "购物流程",
    nodes: [
      { id: "a", label: "打开应用", kind: "start" as const },
      { id: "b", label: "浏览商品" },
      { id: "c", label: "支付", kind: "decision" as const },
    ],
    edges: [{ from: "a", to: "b" }, { from: "b", to: "c", label: "选好了" }],
  };

  it("produces batches with unique groups and valid shapes", () => {
    const batches = composeBatches(flow, "flow", 1);
    expect(batches.length).toBeGreaterThan(0);
    const groups = batches.map((b) => b.group);
    expect(new Set(groups).size).toBe(groups.length);
    for (const b of batches) {
      expect(b.shapes.length).toBeGreaterThan(0);
      expect(b.order).toBeGreaterThanOrEqual(1);
    }
  });

  it("emits valid shape specs", () => {
    const batches = composeBatches(flow, "flow", 1);
    for (const b of batches) {
      for (const s of b.shapes) {
        expect(shapeSchema.safeParse(s).success).toBe(true);
      }
    }
  });
});

describe("schemas", () => {
  it("accepts a valid text element", () => {
    expect(
      textSchema.safeParse({ id: "t1", x: 0, y: 0, size: 16, color: "ink", text: "标签" }).success,
    ).toBe(true);
  });

  it("rejects text size out of range", () => {
    expect(
      textSchema.safeParse({ id: "t1", x: 0, y: 0, size: 4, color: "ink", text: "标签" }).success,
    ).toBe(false);
  });
});
