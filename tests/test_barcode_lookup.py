"""Open Food Facts barcode lookup and response handling tests."""

import asyncio

import pytest
from aiohttp import ClientError

from custom_components.dans_kitchen.barcode_lookup import lookup_barcode
from custom_components.dans_kitchen.services import DomainError

VALID_BARCODE = "3017620422003"


class FakeResponse:
    def __init__(self, status=200, payload=None, delay=0):
        self.status = status
        self.payload = payload
        self.delay = delay

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def json(self, *, content_type=None):
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.payload


class FakeSession:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    def get(self, url, *, headers):
        self.calls.append((url, headers))
        if self.error:
            raise self.error
        return self.response


class FakeService:
    def __init__(self, *, local=None, enabled=True, cached=None):
        self.local = local
        self.enabled = enabled
        self.cached = cached
        self.lookup_calls = []
        self.saved_cache = []

    async def async_find_barcode(self, barcode):
        self.lookup_calls.append(barcode)
        return self.local

    async def async_get_settings(self):
        return {"external_lookup_enabled": self.enabled}

    async def async_barcode_cache_get(self, _barcode):
        return self.cached

    async def async_barcode_cache_set(self, barcode, product):
        self.saved_cache.append((barcode, product))


def response(payload, status=200):
    return FakeSession(response=FakeResponse(status, payload))


async def test_lookup_matches_local_variant_before_network():
    variant = {"id": "variant-1"}
    service = FakeService(local=variant)
    session = FakeSession()

    result = await lookup_barcode(VALID_BARCODE, service, session)

    assert result["lookup_status"] == "matched"
    assert result["variant"] == variant
    assert session.calls == []


async def test_lookup_rejects_bad_gtin_and_check_digit_before_lookup():
    service = FakeService()

    with pytest.raises(DomainError, match="check digit"):
        await lookup_barcode("3017620422004", service, FakeSession())

    with pytest.raises(DomainError, match="8, 12, 13, or 14"):
        await lookup_barcode("123456789", service, FakeSession())

    assert service.lookup_calls == []


async def test_lookup_reports_disabled_external_lookup():
    result = await lookup_barcode(
        VALID_BARCODE, FakeService(enabled=False), FakeSession()
    )

    assert result["lookup_status"] == "disabled"


async def test_lookup_parses_open_food_facts_product_and_e_marked_quantity():
    session = response(
        {
            "status": 1,
            "product": {
                "product_name": "Nutella",
                "brands": "Ferrero, Nutella",
                "quantity": "400 g e",
                "image_url": "https://images.example/product.jpg",
            },
        }
    )
    service = FakeService()

    result = await lookup_barcode(VALID_BARCODE, service, session)

    assert result["lookup_status"] == "found"
    assert result["product"]["name"] == "Nutella"
    assert result["product"]["brand_name"] == "Ferrero"
    assert result["product"]["package_size"] == 400
    assert result["product"]["package_unit"] == "g"
    assert session.calls[0][0].endswith(
        "?fields=code,product_name,product_name_en,brands,quantity,image_url"
    )
    assert "github.com/dan-lindley/dans-kitchen" in session.calls[0][1]["User-Agent"]
    assert service.saved_cache


async def test_lookup_distinguishes_not_found_and_incomplete_product():
    not_found = await lookup_barcode(
        VALID_BARCODE,
        FakeService(),
        response({"status": 0, "status_verbose": "product not found"}),
    )
    incomplete = await lookup_barcode(
        VALID_BARCODE,
        FakeService(),
        response({"status": 1, "product": {"brands": "Unknown brand"}}),
    )

    assert not_found["lookup_status"] == "not_found"
    assert incomplete["lookup_status"] == "incomplete"
    assert incomplete["product"]["name"] == ""


@pytest.mark.parametrize(
    ("session", "timeout", "message"),
    [
        (FakeSession(error=ClientError("offline")), 10, "could not connect"),
        (FakeSession(response=FakeResponse(status=503)), 10, "HTTP 503"),
        (FakeSession(response=FakeResponse(delay=0.02)), 0.001, "timed out"),
    ],
)
async def test_lookup_reports_external_service_failures(session, timeout, message):
    result = await lookup_barcode(
        VALID_BARCODE, FakeService(), session, timeout_seconds=timeout
    )

    assert result["lookup_status"] == "unavailable"
    assert message in result["lookup_message"]
