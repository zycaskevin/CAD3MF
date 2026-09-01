from pathlib import Path

import pytest

from cad3mf_compiler import ParameterResolutionError, resolve_scalar
from cad3mf_ir import DesignDocument


GOLDEN = Path(__file__).parent / "golden-models" / "magnet_module.v1.json"


def test_golden_ir_validates() -> None:
    design = DesignDocument.model_validate_json(GOLDEN.read_text(encoding="utf-8"))
    assert design.project_id == "parametric-magnet-module"
    assert design.parameters["magnet_diameter"] == pytest.approx(6.2)


def test_parameter_resolver_allows_only_exact_references() -> None:
    parameters = {"width": 60.0}
    assert resolve_scalar(12, parameters) == 12.0
    assert resolve_scalar("$width", parameters) == 60.0

    with pytest.raises(ParameterResolutionError):
        resolve_scalar("$width / 2", parameters)
    with pytest.raises(ParameterResolutionError):
        resolve_scalar("__import__('os').system('echo nope')", parameters)
    with pytest.raises(ParameterResolutionError):
        resolve_scalar("$missing", parameters)
