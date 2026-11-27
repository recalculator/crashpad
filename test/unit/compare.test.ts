import { describe, expect, it } from "vitest";
import { compareColumns, compareRows, dropIgnored } from "../../src/compare.ts";

describe("row comparison", () => {
  it("treats unordered results as multisets (duplicate counts matter)", () => {
    expect(compareRows([["a"], ["a"], ["b"]], [["b"], ["a"], ["a"]], false, 0)).toBeNull();
    const d = compareRows([["a"], ["a"], ["b"]], [["a"], ["b"], ["b"]], false, 5);
    expect(d).toMatchObject({ missingCount: 1, extraCount: 1 });
    expect(d?.samples).toEqual({ missing: [["a"]], extra: [["b"]] });
  });

  it("detects a dropped duplicate", () => {
    expect(compareRows([["x"], ["x"]], [["x"]], false, 0)).toMatchObject({ missingCount: 1, extraCount: 0 });
  });

  it("ordered comparison detects reordering that unordered comparison ignores", () => {
    expect(compareRows([["1"], ["2"]], [["2"], ["1"]], false, 0)).toBeNull();
    expect(compareRows([["1"], ["2"]], [["2"], ["1"]], true, 0)).toMatchObject({ firstDifferenceAt: 0, missingCount: 0, extraCount: 0 });
  });

  it("compares exact text, so numeric precision and scale are preserved", () => {
    expect(compareRows([["12345678901234567.89"]], [["12345678901234567.88"]], false, 0)).not.toBeNull();
    expect(compareRows([["1.50"]], [["1.5"]], false, 0)).not.toBeNull();
    expect(compareRows([["0.1"]], [["0.1"]], false, 0)).toBeNull();
  });

  it("distinguishes NULL from the string 'null'", () => {
    expect(compareRows([[null]], [["null"]], false, 0)).not.toBeNull();
  });

  it("drops ignored columns before comparing", () => {
    const r = { columns: [{ name: "id", type: "bigint" }, { name: "v", type: "text" }], rows: [["1", "a"]], truncated: false, rowCount: 1 };
    expect(dropIgnored(r, ["id"])).toEqual({ columns: [{ name: "v", type: "text" }], rows: [["a"]] });
  });
});

describe("column comparison", () => {
  it("reports renamed, retyped, added and removed columns", () => {
    const d = compareColumns(
      [{ name: "id", type: "integer" }, { name: "name", type: "text" }, { name: "total", type: "numeric(12,2)" }],
      [{ name: "id", type: "bigint" }, { name: "full_name", type: "text" }],
    );
    expect(d?.changes).toEqual([
      "column 1 \"id\" type changed integer → bigint",
      "column 2 renamed \"name\" → \"full_name\"",
      "column 3 \"total\" (numeric(12,2)) was removed",
    ]);
  });
});
