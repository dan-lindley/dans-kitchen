import type { Product, Recipe } from "./types";

export type RecipeDraft = {
  recipeId?: string;
  name: string;
  effort: "" | "low" | "medium" | "high";
  preparationMinutes: string;
  cookingMinutes: string;
  weekdays: number[];
  description: string;
  instructions: string;
  ingredients: Array<{
    productId: string;
    ingredientName: string;
    quantity: string;
    unit: string;
    variantId: string;
    notes: string;
  }>;
};

export function createRecipeDraft(recipe?: Recipe): RecipeDraft {
  return {
    recipeId: recipe?.id,
    name: recipe?.name ?? "",
    effort: recipe?.effort ?? "",
    preparationMinutes: recipe?.preparation_minutes?.toString() ?? "",
    cookingMinutes: recipe?.cooking_minutes?.toString() ?? "",
    weekdays: recipe ? [...recipe.weekdays] : [0, 1, 2, 3, 4, 5, 6],
    description: recipe?.description ?? "",
    instructions: recipe?.instructions ?? "",
    ingredients: (recipe?.ingredients ?? []).map((ingredient) => ({
      productId: ingredient.product_id ?? "",
      ingredientName: ingredient.ingredient_name ?? "",
      quantity: ingredient.quantity?.toString() ?? "",
      unit: ingredient.unit ?? "",
      variantId: ingredient.required_variant_id ?? "",
      notes: ingredient.notes ?? "",
    })),
  };
}

export function recipeDraftPayload(
  draft: RecipeDraft,
  products: Product[],
): { payload?: Record<string, unknown>; error?: string } {
  if (!draft.name.trim()) return { error: "Enter a recipe name." };
  if (!draft.effort) return { error: "Choose an effort level." };
  if (!/^\d+$/.test(draft.cookingMinutes) || Number(draft.cookingMinutes) > 1440) {
    return { error: "Enter a cooking time from 0 to 1440 whole minutes." };
  }
  if (!draft.weekdays.length) return { error: "Turn on at least one eligible weekday." };
  if (
    draft.preparationMinutes &&
    (!/^\d+$/.test(draft.preparationMinutes) || Number(draft.preparationMinutes) > 1440)
  ) {
    return { error: "Preparation time must be a whole number from 0 to 1440 minutes." };
  }

  const ingredients = [];
  for (const ingredient of draft.ingredients) {
    const product = ingredient.productId
      ? products.find((item) => item.id === ingredient.productId)
      : undefined;
    const ingredientName = ingredient.ingredientName.trim();
    if (ingredient.productId && !product) {
      return { error: "An ingredient refers to a product that no longer exists." };
    }
    if (!product && !ingredientName) return { error: "Enter an ingredient name." };
    const displayName = product?.name ?? ingredientName;
    if (ingredient.quantity && (!Number.isFinite(Number(ingredient.quantity)) || Number(ingredient.quantity) <= 0)) {
      return { error: `Enter a positive quantity for ${displayName}, or leave it blank.` };
    }
    if (ingredient.quantity && !product && !ingredient.unit.trim()) {
      return { error: `Enter a unit for ${displayName}, or leave the quantity blank.` };
    }
    if (ingredient.variantId && (!product || !product.variants.some((variant) => variant.id === ingredient.variantId))) {
      return { error: `Choose a valid product variant for ${displayName}.` };
    }
    ingredients.push({
      product_id: product?.id ?? null,
      ingredient_name: product ? null : ingredientName,
      required_variant_id: product ? ingredient.variantId || null : null,
      quantity: ingredient.quantity ? Number(ingredient.quantity) : null,
      unit: ingredient.quantity ? ingredient.unit || product?.stock_unit || null : null,
      notes: ingredient.notes.trim() || null,
    });
  }

  return {
    payload: {
      ...(draft.recipeId ? { recipe_id: draft.recipeId } : {}),
      name: draft.name.trim(),
      effort: draft.effort,
      cooking_minutes: Number(draft.cookingMinutes),
      preparation_minutes: draft.preparationMinutes ? Number(draft.preparationMinutes) : null,
      weekdays: [...draft.weekdays].sort((a, b) => a - b),
      description: draft.description.trim() || null,
      instructions: draft.instructions.trim() || null,
      ingredients,
    },
  };
}
