import { describe, expect, it } from "vitest";
import { createRecipeDraft, recipeDraftPayload } from "./recipe-form";

describe("recipe form", () => {
  it("defaults all weekdays on and requires effort and cooking time", () => {
    const draft = createRecipeDraft();
    expect(draft.weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(recipeDraftPayload({ ...draft, name: "Soup" }, [])).toEqual({
      error: "Choose an effort level.",
    });
    expect(
      recipeDraftPayload(
        { ...draft, name: "Soup", effort: "low" },
        [],
      ).error,
    ).toContain("cooking time");
  });

  it("serializes the four required fields and allows empty optional fields", () => {
    const draft = createRecipeDraft();
    const result = recipeDraftPayload(
      { ...draft, name: "Soup", effort: "medium", cookingMinutes: "25" },
      [],
    );

    expect(result.error).toBeUndefined();
    expect(result.payload).toMatchObject({
      name: "Soup",
      effort: "medium",
      cooking_minutes: 25,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      ingredients: [],
      instructions: null,
    });
  });

  it("prevents recipes with no eligible weekdays", () => {
    const draft = createRecipeDraft();
    expect(
      recipeDraftPayload(
        { ...draft, name: "Soup", effort: "high", cookingMinutes: "40", weekdays: [] },
        [],
      ).error,
    ).toContain("at least one");
  });
});
