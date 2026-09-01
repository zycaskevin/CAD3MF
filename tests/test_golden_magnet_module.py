from pathlib import Path
from zipfile import is_zipfile

import pytest

from cad3mf_worker.build import build_file


GOLDEN_DIR = Path(__file__).parent / "golden-models"


def _assert_artifacts(manifest: dict[str, object]) -> None:
    artifacts = manifest["artifacts"]
    assert isinstance(artifacts, dict)
    for name in ("step", "stl", "3mf", "preview", "validation", "manifest"):
        path = Path(str(artifacts[name]))
        assert path.exists(), name
        assert path.stat().st_size > 0, name
    assert is_zipfile(Path(str(artifacts["3mf"])))


def test_golden_magnet_module_builds_both_revisions(tmp_path: Path) -> None:
    v1 = build_file(GOLDEN_DIR / "magnet_module.v1.json", tmp_path / "r1")
    v2 = build_file(GOLDEN_DIR / "magnet_module.v2.json", tmp_path / "r2")

    _assert_artifacts(v1)
    _assert_artifacts(v2)

    validation_v1 = v1["validation"]
    validation_v2 = v2["validation"]
    assert isinstance(validation_v1, dict)
    assert isinstance(validation_v2, dict)
    assert validation_v1["pass"] is True
    assert validation_v2["pass"] is True
    assert validation_v1["solid_count"] == 1
    assert validation_v2["solid_count"] == 1

    bbox = validation_v1["bounding_box_mm"]
    assert isinstance(bbox, dict)
    assert bbox["x"] == pytest.approx(64.0, abs=1e-6)
    assert bbox["y"] == pytest.approx(40.0, abs=1e-6)
    assert bbox["z"] == pytest.approx(8.0, abs=1e-6)

    assert float(validation_v2["volume_mm3"]) < float(validation_v1["volume_mm3"])
    assert v1["revision_id"] == "r1"
    assert v2["revision_id"] == "r2"
    assert v2["parent_revision_id"] == "r1"
    assert v1["parameters"]["magnet_diameter"] == pytest.approx(6.2)
    assert v2["parameters"]["magnet_diameter"] == pytest.approx(8.0)
