from __future__ import annotations

from collections.abc import Mapping

from cad3mf_ir import Scalar


class ParameterResolutionError(ValueError):
    pass


def resolve_scalar(value: Scalar, parameters: Mapping[str, float]) -> float:
    """Resolve a CAD-IR scalar without evaluating code or expressions.

    CAD-IR 0.1 accepts only numeric literals or an exact `$parameter_name` reference.
    Expressions such as `$width / 2`, Python, templates, and function calls are rejected.
    """

    if isinstance(value, bool):
        raise ParameterResolutionError("boolean values are not valid CAD scalars")
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str) or not value.startswith("$"):
        raise ParameterResolutionError(
            f"unsupported scalar {value!r}; expected a number or exact '$parameter' reference"
        )

    name = value[1:]
    if not name or any(token in name for token in (" ", "+", "-", "*", "/", "(", ")", "[", "]")):
        raise ParameterResolutionError(f"expressions are forbidden in parameter reference {value!r}")
    if name not in parameters:
        raise ParameterResolutionError(f"unknown parameter {name!r}")
    return float(parameters[name])


def resolve_point(point: tuple[Scalar, Scalar], parameters: Mapping[str, float]) -> tuple[float, float]:
    return resolve_scalar(point[0], parameters), resolve_scalar(point[1], parameters)
