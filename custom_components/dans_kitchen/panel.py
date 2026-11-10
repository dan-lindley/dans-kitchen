"""Register the bundled Kitchen Manager panel."""

from __future__ import annotations

from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant

from .const import DOMAIN
from .static_assets import PANEL_ASSET_URL, static_asset_paths

PANEL_URL = "dans-kitchen"
PANEL_ELEMENT = "dans-kitchen-panel"


async def async_register_panel(hass: HomeAssistant, frontend_dir: Path) -> None:
    """Serve the production bundle and register its sidebar panel."""
    assets = static_asset_paths(frontend_dir)
    registered = hass.data.setdefault(DOMAIN, {}).setdefault("static_paths", set())
    new_paths = [
        StaticPathConfig(url, str(path), cache_headers=True)
        for url, path in assets.items()
        if url not in registered
    ]
    if new_paths:
        await hass.http.async_register_static_paths(new_paths)
        registered.update(assets)
    await panel_custom.async_register_panel(
        hass,
        webcomponent_name=PANEL_ELEMENT,
        frontend_url_path=PANEL_URL,
        sidebar_title="Dan's Kitchen",
        sidebar_icon="mdi:food-apple",
        module_url=PANEL_ASSET_URL,
        require_admin=True,
    )


async def async_remove_panel(hass: HomeAssistant) -> None:
    """Remove the integration panel on unload."""
    frontend.async_remove_panel(hass, PANEL_URL, warn_if_unknown=False)
