"""Backend-mediated barcode validation and Open Food Facts lookup."""

from __future__ import annotations

import asyncio
import json
import re
from typing import Any
from urllib.parse import quote

from aiohttp import ClientError

from .const import VERSION
from .services.kitchen import DomainError

_GTIN_LENGTHS = {8, 12, 13, 14}
_PACKAGE_SIZE = re.compile(
    r"\s*(\d+(?:[.,]\d+)?)\s*(g|kg|ml|l|cl)(?:\s*e)?\s*",
    flags=re.IGNORECASE,
)


def normalize_barcode(value: Any) -> str:
    """Validate a GTIN barcode while preserving significant leading zeroes."""
    code = str(value).strip()
    if not code.isascii() or not code.isdigit() or len(code) not in _GTIN_LENGTHS:
        raise DomainError("Invalid barcode. Enter an 8, 12, 13, or 14 digit GTIN.")
    check_digit = int(code[-1])
    weighted_sum = sum(
        int(digit) * (3 if position % 2 == 0 else 1)
        for position, digit in enumerate(reversed(code[:-1]))
    )
    expected = (10 - weighted_sum % 10) % 10
    if check_digit != expected:
        raise DomainError("Invalid barcode check digit. Scan again or enter a valid GTIN.")
    return code


def _product_result(
    source: dict[str, Any], barcode: str, *, origin: str
) -> dict[str, Any]:
    name = source.get("name") or source.get("product_name") or source.get("product_name_en")
    brand = source.get("brand_name") or source.get("brands")
    brand = brand.split(",")[0].strip()[:100] or None if isinstance(brand, str) else None
    quantity = source.get("package_description") or source.get("quantity")
    image_url = source.get("image_url")
    product = {
        "name": name.strip()[:200] if isinstance(name, str) else "",
        "brand_name": brand,
        "barcode": barcode,
        "package_description": quantity if isinstance(quantity, str) else None,
        "image_url": image_url
        if isinstance(image_url, str) and image_url.startswith("https://")
        else None,
        "external_source": "open_food_facts",
        "external_source_id": barcode,
    }
    if isinstance(quantity, str):
        size_match = _PACKAGE_SIZE.fullmatch(quantity)
        if size_match:
            product["package_size"] = float(size_match.group(1).replace(",", "."))
            product["package_unit"] = size_match.group(2).lower()
    complete_name = bool(product["name"])
    has_product_details = bool(product["brand_name"] or product["package_description"])
    return {
        "matched": False,
        "source": origin,
        "lookup_status": "found" if complete_name and has_product_details else "incomplete",
        "lookup_message": (
            "Product details found. Review them before saving."
            if complete_name and has_product_details
            else "Barcode found, but product details are incomplete. Review or enter them manually."
        ),
        "product": product,
    }


async def lookup_barcode(
    barcode: Any,
    service: Any,
    session: Any,
    *,
    timeout_seconds: float = 10,
) -> dict[str, Any]:
    """Look up a valid barcode locally first, then through Open Food Facts."""
    code = normalize_barcode(barcode)
    local = await service.async_find_barcode(code)
    if local:
        return {
            "matched": True,
            "source": "local",
            "lookup_status": "matched",
            "lookup_message": "Recognised product. Stock was added to this variant.",
            "variant": local,
        }
    settings = await service.async_get_settings()
    if not settings["external_lookup_enabled"]:
        return {
            "matched": False,
            "source": "disabled",
            "lookup_status": "disabled",
            "lookup_message": "External lookup is disabled. Enter product details manually.",
            "product": None,
        }
    cached = await service.async_barcode_cache_get(code)
    if cached:
        return _product_result(cached, code, origin="cache")

    url = (
        f"https://world.openfoodfacts.org/api/v2/product/{quote(code)}.json"
        "?fields=code,product_name,product_name_en,brands,quantity,image_url"
    )
    headers = {
        "User-Agent": (
            f"DansKitchen/{VERSION} "
            "(https://github.com/dan-lindley/dans-kitchen)"
        )
    }
    try:
        async with asyncio.timeout(timeout_seconds):
            async with session.get(url, headers=headers) as response:
                if response.status == 404:
                    return _not_found(code, "Open Food Facts did not find this barcode.")
                if response.status != 200:
                    return _service_unavailable(
                        f"Open Food Facts returned HTTP {response.status}. "
                        "Try again or enter the product manually."
                    )
                payload = await response.json(content_type=None)
    except TimeoutError:
        return _service_unavailable(
            "Open Food Facts did not respond before the lookup timed out."
        )
    except (ClientError, OSError):
        return _service_unavailable(
            "Home Assistant could not connect to Open Food Facts. Check its network access "
            "or enter the product manually."
        )
    except (json.JSONDecodeError, UnicodeDecodeError):
        return _service_unavailable(
            "Open Food Facts returned an unreadable response. Try again or enter the product "
            "manually."
        )

    if not isinstance(payload, dict):
        return _service_unavailable(
            "Open Food Facts returned an unexpected response. Try again or enter the product "
            "manually."
        )
    if payload.get("status") != 1:
        return _not_found(code, "Barcode not found in Open Food Facts.")
    source = payload.get("product")
    if not isinstance(source, dict):
        return _product_result({}, code, origin="open_food_facts")
    result = _product_result(source, code, origin="open_food_facts")
    if result["lookup_status"] == "incomplete":
        await service.async_barcode_cache_set(code, result["product"])
        return result
    await service.async_barcode_cache_set(code, result["product"])
    return result


def _not_found(barcode: str, message: str) -> dict[str, Any]:
    return {
        "matched": False,
        "source": "open_food_facts",
        "lookup_status": "not_found",
        "lookup_message": f"{message} You can still add this product manually.",
        "product": {"name": "", "barcode": barcode},
    }


def _service_unavailable(message: str) -> dict[str, Any]:
    return {
        "matched": False,
        "source": "unavailable",
        "lookup_status": "unavailable",
        "lookup_message": message,
        "product": None,
    }
