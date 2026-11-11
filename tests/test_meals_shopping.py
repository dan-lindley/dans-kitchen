"""Recipe, planner, recurrence and shopping tests."""

from datetime import date, timedelta

import pytest

from custom_components.dans_kitchen.database import Database
from custom_components.dans_kitchen.services import DomainError, KitchenService

MONDAY = date(2026, 11, 9)


@pytest.fixture
async def kitchen(tmp_path):
    database = Database(tmp_path / "kitchen.sqlite3")
    await database.async_initialize()
    return KitchenService(database)


async def create_recipe(kitchen, **kwargs):
    kwargs.setdefault("effort", "medium")
    kwargs.setdefault("cooking_minutes", 30)
    return await kitchen.async_create_recipe(**kwargs)


async def test_recipe_defaults_to_all_monday_zero_weekdays(kitchen):
    recipe = await create_recipe(kitchen, name="Tea")
    assert recipe["weekdays"] == list(range(7))
    assert recipe["ingredients"] == []
    assert (await kitchen.async_recipe_availability(recipe["id"]))["status"] == "no_ingredients"


async def test_recipe_requires_effort_cooking_time_and_at_least_one_weekday(kitchen):
    with pytest.raises(DomainError, match="Effort"):
        await kitchen.async_create_recipe(name="No effort", cooking_minutes=20)
    with pytest.raises(DomainError, match="Cooking time is required"):
        await kitchen.async_create_recipe(name="No cooking time", effort="low")
    with pytest.raises(DomainError, match="one or more unique weekdays"):
        await kitchen.async_create_recipe(
            name="No weekdays", effort="high", cooking_minutes=20, weekdays=[]
        )


async def test_recipe_updates_cannot_clear_required_fields(kitchen):
    recipe = await create_recipe(kitchen, name="Required fields")

    with pytest.raises(DomainError, match="Effort"):
        await kitchen.async_update_recipe(recipe["id"], effort=None)
    with pytest.raises(DomainError, match="Cooking time is required"):
        await kitchen.async_update_recipe(recipe["id"], cooking_minutes=None)


async def test_free_text_recipe_ingredients_persist_and_create_shopping_items(kitchen):
    product = await kitchen.async_create_product(name="Beans", stock_unit="tin")
    recipe = await create_recipe(
        kitchen,
        name="Bean and cumin soup",
        ingredients=[
            {"product_id": product["id"]},
            {"ingredient_name": "  Cumin  ", "quantity": 1, "unit": "tsp"},
        ],
    )

    product_ingredient, text_ingredient = recipe["ingredients"]
    assert product_ingredient["product_id"] == product["id"]
    assert product_ingredient["ingredient_name"] is None
    assert text_ingredient["product_id"] is None
    assert text_ingredient["ingredient_name"] == "Cumin"
    assert text_ingredient["product_name"] == "Cumin"
    assert await kitchen.db.async_fetch_one(
        "SELECT id FROM products WHERE name='Cumin'"
    ) is None

    availability = await kitchen.async_recipe_availability(recipe["id"])
    assert availability["status"] == "missing"
    assert availability["ingredients"][1]["tracked"] is False
    assert availability["ingredients"][1]["available"] is False

    shopping = await kitchen.async_add_recipe_shopping_items(recipe["id"])
    custom_items = [item for item in shopping["added"] if item["custom_name"] == "Cumin"]
    assert len(custom_items) == 1
    assert custom_items[0]["quantity"] == 1
    assert custom_items[0]["unit"] == "tsp"
    assert await kitchen.async_add_recipe_shopping_items(recipe["id"]) == {"added": []}


async def test_free_text_recipe_ingredient_quantity_requires_a_unit(kitchen):
    with pytest.raises(DomainError, match="both an ingredient quantity and its unit"):
        await create_recipe(
            kitchen,
            name="Unmeasured cumin",
            ingredients=[{"ingredient_name": "Cumin", "quantity": 1}],
        )


async def test_incomplete_legacy_recipes_are_not_automatically_eligible(kitchen):
    recipe = await create_recipe(kitchen, name="Legacy recipe")
    await kitchen.db.async_execute(
        "UPDATE recipes SET effort=NULL,cooking_minutes=NULL WHERE id=?",
        (recipe["id"],),
    )

    assert await kitchen.async_eligible_recipes(MONDAY) == []


async def test_recipe_eligibility_and_effort_time_settings_apply_to_suggestions(kitchen):
    monday = await create_recipe(
        kitchen,
        name="Monday pasta", weekdays=[0], effort="low", preparation_minutes=10,
        cooking_minutes=20,
    )
    await create_recipe(
        kitchen,
        name="Slow roast", weekdays=list(range(7)), effort="high", cooking_minutes=90
    )
    await kitchen.async_set_setting("planner_max_effort", "low")
    await kitchen.async_set_setting("planner_max_cooking_minutes", 30)

    assert [item["id"] for item in await kitchen.async_eligible_recipes(MONDAY)] == [monday["id"]]
    assert await kitchen.async_eligible_recipes(date(2026, 11, 10)) == []


async def test_recipe_exact_variant_must_belong_to_generic_product(kitchen):
    product = await kitchen.async_create_product(name="Beans", stock_unit="tin")
    other = await kitchen.async_create_product(name="Tomatoes", stock_unit="tin")
    variant = await kitchen.async_create_variant(product["id"])
    with pytest.raises(DomainError, match="belong to"):
        await create_recipe(
            kitchen,
            name="Bad recipe",
            ingredients=[
                {
                    "product_id": other["id"],
                    "required_variant_id": variant["id"],
                }
            ],
        )


async def test_recipe_availability_requires_stock_and_explicit_unit_conversion(kitchen):
    product = await kitchen.async_create_product(name="Milk", stock_unit="ml")
    variant = await kitchen.async_create_variant(product["id"])
    await kitchen.async_add_stock(variant["id"], 500)
    recipe = await create_recipe(
        kitchen,
        name="Pancakes",
        ingredients=[{"product_id": product["id"], "quantity": 0.5, "unit": "l"}],
    )

    assert (await kitchen.async_recipe_availability(recipe["id"]))["status"] == "missing"
    await kitchen.async_set_unit_conversion("l", "ml", 1000)
    assert (await kitchen.async_recipe_availability(recipe["id"]))["status"] == "available"


async def test_suggest_meals_fills_four_real_weeks_and_persists_random_entries(kitchen):
    await create_recipe(kitchen, name="Any day")
    generated = await kitchen.async_suggest_meals(today=MONDAY, seed=3)
    after_reload = await kitchen.async_get_planner(today=MONDAY)

    assert len(generated["weeks"]) == 4
    assert len(generated["weeks"][0]["days"]) == 7
    assert generated["changed"] is True
    assert all(
        day["assignment_type"] == "random" for week in after_reload["weeks"] for day in week["days"]
    )


async def test_random_meals_never_appear_outside_their_eligible_weekday(kitchen):
    sunday_recipe = await create_recipe(kitchen, name="Sunday only", weekdays=[6])
    await create_recipe(kitchen, name="Tuesday only", weekdays=[1])

    plan = await kitchen.async_suggest_meals(today=MONDAY, seed=10)

    for week in plan["weeks"]:
        for day in week["days"]:
            if day["recipe_id"] == sunday_recipe["id"]:
                assert date.fromisoformat(day["date"]).weekday() == 6


async def test_fixed_assignments_and_explicit_unplanned_days_survive_suggestions(kitchen):
    recipe = await create_recipe(kitchen, name="Fixed meal")
    fixed_day = "2026-11-10"
    clear_day = "2026-11-11"
    await kitchen.async_plan_meal(fixed_day, recipe["id"])
    await kitchen.async_suggest_meals(today=MONDAY, seed=4)
    fixed = await kitchen.async_planner_day(date.fromisoformat(fixed_day))

    assert fixed["assignment_type"] == "fixed"
    assert fixed["recipe_id"] == recipe["id"]
    assert (await kitchen.async_planner_day(date.fromisoformat(clear_day)))[
        "assignment_type"
    ] == "random"
    await kitchen.async_plan_meal(clear_day, None)
    await kitchen.async_suggest_meals(today=MONDAY, seed=5)
    assert (await kitchen.async_planner_day(date.fromisoformat(clear_day)))[
        "assignment_type"
    ] == "random"


async def test_weekly_fortnightly_and_four_week_recurrences_resolve_by_anchor(kitchen):
    for weekday, interval in ((0, 1), (1, 2), (2, 4)):
        recipe = await create_recipe(kitchen, name=f"Recurring {interval}", weekdays=[weekday])
        anchor = date(2026, 11, 9) + __import__("datetime").timedelta(days=weekday)
        await kitchen.async_set_recurrence(
            recipe["id"],
            weekday=weekday,
            anchor_date=anchor.isoformat(),
            interval_weeks=interval,
        )
        assert (await kitchen.async_planner_day(anchor))["assignment_type"] == "recurring"
        skipped = anchor + __import__("datetime").timedelta(weeks=interval)
        assert (await kitchen.async_planner_day(skipped))["assignment_type"] == "recurring"


async def test_one_date_override_can_be_restored_without_changing_rule(kitchen):
    recipe = await create_recipe(kitchen, name="Soup", weekdays=[1])
    replacement = await create_recipe(kitchen, name="Curry", weekdays=[1])
    day = date(2026, 11, 10)
    rule = await kitchen.async_set_recurrence(
        recipe["id"], weekday=1, anchor_date=day.isoformat(), interval_weeks=1
    )
    override = await kitchen.async_plan_meal(day.isoformat(), replacement["id"])
    assert override["assignment_type"] == "override"
    next_tuesday = await kitchen.async_planner_day(day.replace(day=17))
    assert next_tuesday["recipe_id"] == recipe["id"]
    await kitchen.async_restore_recurrence(day.isoformat())
    assert (await kitchen.async_planner_day(day))["recipe_id"] == recipe["id"]
    assert (await kitchen.async_list_recurrences())[0]["id"] == rule["id"]


async def test_suggestion_variety_and_small_catalogue_are_graceful(kitchen):
    first = await create_recipe(kitchen, name="Pasta", weekdays=[0, 1, 2, 3, 4, 5])
    second = await create_recipe(kitchen, name="Tacos", weekdays=[0, 1, 2, 3, 4, 5])
    plan = await kitchen.async_suggest_meals(today=MONDAY, seed=12)
    planned_days = {
        day["date"]: day["recipe_id"]
        for week in plan["weeks"]
        for day in week["days"]
        if day["recipe_id"] is not None
    }
    meal_ids = list(planned_days.values())
    assert set(meal_ids) == {first["id"], second["id"]}
    for day_text, recipe_id in planned_days.items():
        following_day = (date.fromisoformat(day_text) + timedelta(days=1)).isoformat()
        if following_day in planned_days:
            assert planned_days[following_day] != recipe_id

    only = await create_recipe(kitchen, name="Only Sunday", weekdays=[6])
    sunday_only = await kitchen.async_eligible_recipes(date(2026, 11, 15))
    assert [item["id"] for item in sunday_only] == [only["id"]]


async def test_low_stock_shopping_is_opt_in_generic_and_deduplicated(kitchen):
    product = await kitchen.async_create_product(name="Pasta", stock_unit="pack", reorder_level=2)
    first = await kitchen.async_refresh_low_stock_suggestions()
    second = await kitchen.async_refresh_low_stock_suggestions()
    items = await kitchen.async_list_shopping(status="needed")

    assert first["added"] == 1
    assert second["added"] == 0
    assert len(items) == 1
    assert items[0]["product_id"] == product["id"]
    assert items[0]["source"] == "low_stock"


async def test_shopping_can_be_added_completed_and_dismissed(kitchen):
    item = await kitchen.async_add_shopping_item(custom_name="Batteries")
    updated = await kitchen.async_update_shopping_status(item["id"], "purchased")
    assert updated["status"] == "purchased"
    await kitchen.async_update_shopping_status(item["id"], "dismissed")
    assert (await kitchen.async_list_shopping(status="dismissed"))[0]["id"] == item["id"]
    await kitchen.async_delete_shopping_item(item["id"])
    assert await kitchen.async_list_shopping() == []
