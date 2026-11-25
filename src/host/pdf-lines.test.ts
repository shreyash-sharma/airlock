import { describe, expect, it } from "vitest";
import { itemsToText, type PdfItem } from "./pdf-lines.js";

const it_ = (str: string, x: number, y: number): PdfItem => ({ str, transform: [1, 0, 0, 1, x, y] });

describe("itemsToText", () => {
  it("joins items on a baseline left to right and separates lines", () => {
    const items = [it_("world", 60, 700), it_("Hello", 10, 700), it_("Second line", 10, 686)];
    expect(itemsToText(items)).toBe("Hello world\nSecond line");
  });
  it("inserts a blank line for a larger vertical gap", () => {
    const items = [it_("1. Salary", 10, 700), it_("Base pay", 10, 686), it_("2. Notice", 10, 640), it_("Three months", 10, 626)];
    expect(itemsToText(items)).toBe("1. Salary\nBase pay\n\n2. Notice\nThree months");
  });
  it("returns an empty string when there is no text", () => {
    expect(itemsToText([it_("  ", 0, 0)])).toBe("");
  });
});
