"""Generic product, variant, stock batch, and transaction tests."""

import asyncio

import pytest

from custom_components.dans_kitchen.database import Database
from custom_components.dans_kitchen.services import DomainError, KitchenService


@pytest.fixture
async def kitchen(tmp_path):
    database = Database(tmp_path / "kitchen.sqlite3")
    await database.async_initialize()
    return KitchenService(database)


async def test_leading_zero_barcode_identifies_one_exact_variant(kitchen):
    product = await kitchen.async_create_product(name="Beans", stock_unit="tin")
    variant = await kitchen.async_create_variant(
        product["id"], brand_name="Brand", barcode="00012345"
    )

    found = await kitchen.async_find_barcode("00012345")

    assert found["id"] == variant["id"]
    assert found["product_id"] == product["id"]
    assert await kitchen.async_find_barcode("12345") is None
    with pytest.raises(DomainError, match="already assigned"):
        await kitchen.async_create_variant(product["id"], brand_name="Other", barcode="00012345")


async def test_add_and_use_stock_are_idempotent_and_auditable(kitchen):
    product = await kitchen.async_create_product(name="Rice", stock_unit="bag")
    variant = await kitchen.async_create_variant(product["id"])
    added = await kitchen.async_add_stock(variant["id"], 3, request_key="add-rice-once")
    repeated_add = await kitchen.async_add_stock(variant["id"], 3, request_key="add-rice-once")

    assert added["batch_id"] == repeated_add["batch_id"]
    assert (await kitchen.async_product_stock(product["id"]))["quantity"] == 3
    used = await kitchen.async_use_stock(product["id"], 1, request_key="use-rice-once")
    repeated_use = await kitchen.async_use_stock(product["id"], 1, request_key="use-rice-once")

    assert used == repeated_use
    assert (await kitchen.async_product_stock(product["id"]))["quantity"] == 2
    history = await kitchen.async_transactions(product_id=product["id"])
    assert [record["transaction_type"] for record in history] == ["use", "add"]
    assert history[0]["quantity_before"] == 3
    assert history[0]["quantity_after"] == 2


async def test_use_stock_prefers_earliest_expiry_and_never_goes_negative(kitchen):
    product = await kitchen.async_create_product(name="Oats", stock_unit="bag")
    variant = await kitchen.async_create_variant(product["id"])
    later = await kitchen.async_add_stock(variant["id"], 2, best_before_date="2027-01-01")
    earlier = await kitchen.async_add_stock(variant["id"], 2, best_before_date="2026-12-01")

    used = await kitchen.async_use_stock(product["id"], 3)

    assert used["batches"][0]["batch_id"] == earlier["batch_id"]
    assert used["batches"][0]["used"] == 2
    assert used["batches"][1]["batch_id"] == later["batch_id"]
    with pytest.raises(DomainError, match="not enough stock"):
        await kitchen.async_use_stock(product["id"], 2)


async def test_correct_stock_and_transfer_keep_transaction_balances(kitchen):
    locations = await kitchen.async_list_locations()
    product = await kitchen.async_create_product(
        name="Coffee", stock_unit="jar", default_location_id=locations[0]["id"]
    )
    variant = await kitchen.async_create_variant(product["id"])
    batch = await kitchen.async_add_stock(variant["id"], 3)
    moved = await kitchen.async_transfer_stock(batch["batch_id"], 1, locations[1]["id"])
    await kitchen.async_correct_stock(moved["target_batch_id"], 0.5)

    history = await kitchen.async_transactions(product_id=product["id"])
    assert {row["transaction_type"] for row in history} == {
        "add",
        "transfer_in",
        "transfer_out",
        "correct",
    }
    assert (await kitchen.async_product_stock(product["id"]))["quantity"] == 2.5


async def test_product_stock_aggregates_variants_and_low_stock_uses_generic_total(kitchen):
    product = await kitchen.async_create_product(name="Lentils", stock_unit="tin", reorder_level=5)
    first = await kitchen.async_create_variant(product["id"], brand_name="A")
    second = await kitchen.async_create_variant(product["id"], brand_name="B")
    await kitchen.async_add_stock(first["id"], 2)
    await kitchen.async_add_stock(second["id"], 3)

    inventory = await kitchen.async_list_inventory()
    assert len(inventory) == 1
    assert inventory[0]["stock_quantity"] == 5
    assert inventory[0]["low_stock"] is True
    assert (await kitchen.async_refresh_low_stock_suggestions())["added"] == 1
    assert (await kitchen.async_refresh_low_stock_suggestions())["added"] == 0


async def test_barcode_registration_and_first_stock_are_one_idempotent_operation(kitchen):
    first = await kitchen.async_register_barcode_product(
        barcode="00008888",
        product_name="Peas",
        stock_unit="tin",
        brand_name="Green",
        quantity=2,
        request_key="scan-1",
    )
    again = await kitchen.async_register_barcode_product(
        barcode="00008888",
        product_name="Peas",
        stock_unit="tin",
        brand_name="Green",
        quantity=2,
        request_key="scan-1",
    )

    assert first["variant"]["id"] == again["variant"]["id"]
    assert (await kitchen.async_product_stock(first["product"]["id"]))["quantity"] == 2
    assert len(await kitchen.async_list_variants(first["product"]["id"])) == 1


async def test_concurrent_stock_additions_do_not_lose_updates(kitchen):
    product = await kitchen.async_create_product(name="Flour", stock_unit="kg")
    variant = await kitchen.async_create_variant(product["id"])
    await asyncio.gather(
        *(
            kitchen.async_add_stock(variant["id"], 1, request_key=f"flour-{index}")
            for index in range(10)
        )
    )

    assert (await kitchen.async_product_stock(product["id"]))["quantity"] == 10


async def test_location_rename_keeps_ids_and_used_locations_cannot_be_deleted(kitchen):
    location = (await kitchen.async_list_locations())[0]
    product = await kitchen.async_create_product(
        name="Tea", stock_unit="box", default_location_id=location["id"]
    )
    renamed = await kitchen.async_update_location(location["id"], name="Tea cupboard")
    assert renamed["id"] == location["id"]
    assert (await kitchen.async_product(product["id"]))["default_location_name"] == "Tea cupboard"
    with pytest.raises(DomainError, match="Reassign"):
        await kitchen.async_delete_location(location["id"])


async def test_location_reordering_is_stable_and_uses_managed_locations(kitchen):
    locations = await kitchen.async_list_locations()
    await kitchen.async_reorder_location(locations[1]["id"], -1)
    reordered = await kitchen.async_list_locations()
    assert reordered[0]["id"] == locations[1]["id"]


async def test_transfer_rejects_insufficient_or_same_location_stock(kitchen):
    locations = await kitchen.async_list_locations()
    product = await kitchen.async_create_product(name="Salt", stock_unit="pack")
    variant = await kitchen.async_create_variant(product["id"])
    batch = await kitchen.async_add_stock(variant["id"], 1, location_id=locations[0]["id"])
    with pytest.raises(DomainError, match="different destination"):
        await kitchen.async_transfer_stock(batch["batch_id"], 1, locations[0]["id"])
    with pytest.raises(DomainError, match="does not contain enough"):
        await kitchen.async_transfer_stock(batch["batch_id"], 2, locations[1]["id"])
