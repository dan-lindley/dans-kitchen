"""Frontend bundle registration tests."""

import pytest

from custom_components.dans_kitchen.static_assets import static_asset_paths


def test_static_paths_include_nested_vite_chunks(tmp_path):
    (tmp_path / "panel.js").write_text("import './chunks/shared.js';", encoding="utf-8")
    (tmp_path / "cards.js").write_text("import './chunks/shared.js';", encoding="utf-8")
    chunk = tmp_path / "chunks" / "shared.js"
    chunk.parent.mkdir()
    chunk.write_text("export {};", encoding="utf-8")

    assert static_asset_paths(tmp_path) == {
        "/dans_kitchen/panel.js": tmp_path / "panel.js",
        "/dans_kitchen/cards.js": tmp_path / "cards.js",
        "/dans_kitchen/chunks/shared.js": chunk,
    }


def test_static_paths_require_both_entry_bundles(tmp_path):
    (tmp_path / "panel.js").write_text("", encoding="utf-8")

    with pytest.raises(FileNotFoundError, match="cards.js"):
        static_asset_paths(tmp_path)
