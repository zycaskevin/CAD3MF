from __future__ import annotations

from typing import Any

import cadquery as cq


class GeometryValidationError(RuntimeError):
    pass


def inspect_geometry(shape: cq.Workplane) -> dict[str, Any]:
    solids = shape.solids().vals()
    root = shape.val()
    bbox = root.BoundingBox()
    volume = float(root.Volume())
    is_valid = bool(root.isValid())

    report: dict[str, Any] = {
        "is_valid": is_valid,
        "solid_count": len(solids),
        "single_solid": len(solids) == 1,
        "volume_mm3": volume,
        "bounding_box_mm": {
            "x": float(bbox.xlen),
            "y": float(bbox.ylen),
            "z": float(bbox.zlen),
        },
    }
    report["pass"] = bool(
        report["is_valid"]
        and report["single_solid"]
        and volume > 0
        and bbox.xlen > 0
        and bbox.ylen > 0
        and bbox.zlen > 0
    )
    return report


def require_valid_geometry(shape: cq.Workplane) -> dict[str, Any]:
    report = inspect_geometry(shape)
    if not report["pass"]:
        raise GeometryValidationError(f"geometry validation failed: {report}")
    return report
