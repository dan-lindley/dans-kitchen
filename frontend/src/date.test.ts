import { describe, expect, it } from "vitest";
import { weekdayMondayZero } from "./date";

describe("weekdayMondayZero", () => {
  it.each([
    { calendarDate: "2026-11-09", weekday: 0 },
    { calendarDate: "2026-11-10", weekday: 1 },
    { calendarDate: "2026-11-15", weekday: 6 },
  ])("maps $calendarDate to Monday-zero weekday $weekday", ({ calendarDate, weekday }) => {
    expect(weekdayMondayZero(calendarDate)).toBe(weekday);
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => weekdayMondayZero("not-a-date")).toThrow(RangeError);
    expect(() => weekdayMondayZero("2026-02-31")).toThrow(RangeError);
  });
});
