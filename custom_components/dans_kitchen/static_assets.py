"""Map Vite output files to Home Assistant static paths."""

from __future__ import annotations

from pathlib import Path

from .const import DOMAIN, VERSION

PANEL_ASSET_URL = f"/{DOMAIN}/panel.js?v={VERSION}"
CARD_ASSET_URL = f"/{DOMAIN}/cards.js"


def static_asset_paths(frontend_dir: Path) -> dict[str, Path]:
    """Return URL-to-file mappings for every generated frontend asset."""
    required_assets = {
        PANEL_ASSET_URL: frontend_dir / "panel.js",
        CARD_ASSET_URL: frontend_dir / "cards.js",
    }
    missing = [str(path) for path in required_assets.values() if not path.is_file()]
    if missing:
        raise FileNotFoundError(
            f"Dan's Kitchen frontend bundle is missing: {', '.join(missing)}; build the frontend."
        )
    return {
        f"/{DOMAIN}/{path.relative_to(frontend_dir).as_posix()}": path
        for path in frontend_dir.rglob("*")
        if path.is_file()
    }
