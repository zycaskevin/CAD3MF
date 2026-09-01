from pathlib import Path

from cad3mf_worker.build import load_design
from cad3mf_worker.revisions import revise_parameter

GOLDEN_DIR = Path(__file__).parent / "golden-models"


def test_parameter_revision_matches_golden_v2() -> None:
    v1 = load_design(GOLDEN_DIR / "magnet_module.v1.json")
    expected_v2 = load_design(GOLDEN_DIR / "magnet_module.v2.json")

    actual_v2 = revise_parameter(
        v1,
        parameter="magnet_diameter",
        value=8.0,
        revision_id="r2",
    )

    assert actual_v2 == expected_v2
    assert actual_v2.parent_revision_id == "r1"
    assert v1.parameters["magnet_diameter"] == 6.2
    assert actual_v2.parameters["magnet_diameter"] == 8.0
