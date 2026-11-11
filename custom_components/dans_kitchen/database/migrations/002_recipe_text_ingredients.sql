CREATE TABLE recipe_ingredients_new (
    id TEXT PRIMARY KEY,
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    product_id TEXT REFERENCES products(id) ON DELETE RESTRICT,
    ingredient_name TEXT,
    required_variant_id TEXT REFERENCES product_variants(id) ON DELETE RESTRICT,
    quantity REAL CHECK (quantity IS NULL OR quantity > 0),
    unit TEXT,
    notes TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    CHECK (
        (product_id IS NOT NULL AND ingredient_name IS NULL) OR
        (product_id IS NULL AND ingredient_name IS NOT NULL
         AND length(trim(ingredient_name)) > 0 AND required_variant_id IS NULL)
    ),
    CHECK ((quantity IS NULL) = (unit IS NULL))
);

INSERT INTO recipe_ingredients_new (
    id,recipe_id,product_id,ingredient_name,required_variant_id,quantity,unit,notes,sort_order
)
SELECT id,recipe_id,product_id,NULL,required_variant_id,quantity,unit,notes,sort_order
FROM recipe_ingredients;

DROP TABLE recipe_ingredients;
ALTER TABLE recipe_ingredients_new RENAME TO recipe_ingredients;
CREATE INDEX idx_recipe_ingredients_recipe ON recipe_ingredients(recipe_id, sort_order);
CREATE INDEX idx_recipe_ingredients_product ON recipe_ingredients(product_id);
