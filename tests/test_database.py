"""Schema, transaction, migration, and recovery tests."""

import sqlite3
from pathlib import Path

import pytest

from custom_components.dans_kitchen.database import Database, DatabaseError
from custom_components.dans_kitchen.services import KitchenService


async def test_initial_schema_enables_foreign_keys_and_seeds_locations(tmp_path):
    database = Database(tmp_path / "dans-kitchen.sqlite3")
    await database.async_initialize()

    status = await database.async_status()
    locations = await database.async_fetch_all(
        "SELECT id,name FROM storage_locations ORDER BY sort_order"
    )
    foreign_keys = await database.async_fetch_one("PRAGMA foreign_keys")

    assert status["schema_version"] == 2
    assert status["integrity"] == "ok"
    assert [row["name"] for row in locations] == [
        "Cupboard",
        "Fridge",
        "Freezer",
        "Pantry",
    ]
    assert foreign_keys is not None


async def test_recipe_ingredient_migration_preserves_existing_product_rows(tmp_path):
    database_path = tmp_path / "legacy.sqlite3"
    migration = (
        Path(__file__).parents[1]
        / "custom_components"
        / "dans_kitchen"
        / "database"
        / "migrations"
        / "001_initial.sql"
    )
    connection = sqlite3.connect(database_path)
    try:
        connection.execute("PRAGMA foreign_keys = ON")
        connection.executescript(migration.read_text(encoding="utf-8"))
        connection.execute(
            "INSERT INTO products(id,name,stock_unit,created_at,updated_at) "
            "VALUES ('product','Beans','tin','now','now')"
        )
        connection.execute(
            "INSERT INTO product_variants(id,product_id,created_at,updated_at) "
            "VALUES ('variant','product','now','now')"
        )
        connection.execute(
            "INSERT INTO recipes(id,name,cooking_minutes,created_at,updated_at) "
            "VALUES ('recipe','Bean soup',30,'now','now')"
        )
        connection.execute(
            "INSERT INTO recipe_ingredients(id,recipe_id,product_id,required_variant_id,"
            "quantity,unit,notes,sort_order) "
            "VALUES ('ingredient','recipe','product','variant',2,'tin','drained',3)"
        )
        connection.execute(
            "INSERT INTO schema_migrations(version,applied_at) VALUES (1,'now')"
        )
        connection.execute("PRAGMA user_version = 1")
        connection.commit()
    finally:
        connection.close()

    database = Database(database_path)
    await database.async_initialize()

    ingredient = await database.async_fetch_one(
        "SELECT id,recipe_id,product_id,ingredient_name,required_variant_id,"
        "quantity,unit,notes,sort_order "
        "FROM recipe_ingredients WHERE id='ingredient'"
    )
    assert ingredient == {
        "id": "ingredient",
        "recipe_id": "recipe",
        "product_id": "product",
        "ingredient_name": None,
        "required_variant_id": "variant",
        "quantity": 2.0,
        "unit": "tin",
        "notes": "drained",
        "sort_order": 3,
    }
    assert (await database.async_status())["schema_version"] == 2


async def test_foreign_key_and_unique_barcode_constraints(tmp_path):
    database = Database(tmp_path / "kitchen.sqlite3")
    await database.async_initialize()
    location = (await KitchenService(database).async_list_locations())[0]
    product = await database.async_execute(
        "INSERT INTO products(id,name,stock_unit,default_location_id,created_at,updated_at) "
        "VALUES ('p1','Rice','bag',?,?,?)",
        (location["id"], "now", "now"),
    )
    assert product == 1
    with pytest.raises(sqlite3.IntegrityError):
        await database.async_execute(
            "INSERT INTO product_variants(id,product_id,barcode,created_at,updated_at) "
            "VALUES ('v1','missing','001234','now','now')"
        )
    await database.async_execute(
        "INSERT INTO product_variants(id,product_id,barcode,created_at,updated_at) "
        "VALUES ('v1','p1','001234','now','now')"
    )
    with pytest.raises(sqlite3.IntegrityError):
        await database.async_execute(
            "INSERT INTO product_variants(id,product_id,barcode,created_at,updated_at) "
            "VALUES ('v2','p1','001234','now','now')"
        )


async def test_transaction_rolls_back_all_changes_on_error(tmp_path):
    database = Database(tmp_path / "kitchen.sqlite3")
    await database.async_initialize()

    def fail(connection):
        connection.execute(
            "INSERT INTO app_settings(key,value,updated_at) VALUES ('temporary','1','now')"
        )
        raise RuntimeError("abort")

    with pytest.raises(RuntimeError, match="abort"):
        await database.async_transaction(fail)
    assert (
        await database.async_fetch_one("SELECT key FROM app_settings WHERE key='temporary'") is None
    )


async def test_online_backup_and_validated_restore_preserve_data(tmp_path):
    original = Database(tmp_path / "live.sqlite3")
    await original.async_initialize()
    await original.async_execute(
        "INSERT INTO products(id,name,stock_unit,created_at,updated_at) "
        "VALUES ('p1','Beans','tin','now','now')"
    )
    backup = await original.async_backup(tmp_path / "backups" / "valid.sqlite3")

    restored = Database(tmp_path / "restore" / "kitchen.sqlite3")
    await restored.async_initialize()
    await restored.async_restore(backup)

    assert await restored.async_fetch_one("SELECT name FROM products WHERE id='p1'") == {
        "name": "Beans"
    }
    assert (await restored.async_status())["integrity"] == "ok"


async def test_restore_rejects_non_database_file_without_touching_live_store(tmp_path):
    database = Database(tmp_path / "live.sqlite3")
    await database.async_initialize()
    await database.async_execute(
        "INSERT INTO products(id,name,stock_unit,created_at,updated_at) "
        "VALUES ('p1','Milk','bottle','now','now')"
    )
    invalid_backup = tmp_path / "invalid.sqlite3"
    invalid_backup.write_text("not sqlite", encoding="utf-8")

    with pytest.raises(DatabaseError):
        await database.async_restore(invalid_backup)
    assert await database.async_fetch_one("SELECT name FROM products WHERE id='p1'") == {
        "name": "Milk"
    }


async def test_exports_are_bounded_to_application_tables(tmp_path):
    database = Database(tmp_path / "kitchen.sqlite3")
    await database.async_initialize()
    csv = await database.async_export_csv("storage_locations")
    exported = await database.async_export_json()

    assert csv.startswith("id,name,description,sort_order,active,created_at,updated_at")
    assert len(exported["storage_locations"]) == 4
    with pytest.raises(DatabaseError, match="not available"):
        await database.async_export_csv("sqlite_master")
