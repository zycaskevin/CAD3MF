from __future__ import annotations

from collections.abc import Mapping

import cadquery as cq
from cad3mf_compiler import resolve_point, resolve_scalar
from cad3mf_ir import (
    BoxFeature,
    CylinderFeature,
    DesignDocument,
    ExtrudeFeature,
    HoleFeature,
    Transform,
)


class CadQueryCompileError(RuntimeError):
    pass


def _apply_transform(
    shape: cq.Workplane, transform: Transform, parameters: Mapping[str, float]
) -> cq.Workplane:
    rx = resolve_scalar(transform.rotate_x, parameters)
    ry = resolve_scalar(transform.rotate_y, parameters)
    rz = resolve_scalar(transform.rotate_z, parameters)
    tx = resolve_scalar(transform.x, parameters)
    ty = resolve_scalar(transform.y, parameters)
    tz = resolve_scalar(transform.z, parameters)

    if rx:
        shape = shape.rotate((0, 0, 0), (1, 0, 0), rx)
    if ry:
        shape = shape.rotate((0, 0, 0), (0, 1, 0), ry)
    if rz:
        shape = shape.rotate((0, 0, 0), (0, 0, 1), rz)
    if tx or ty or tz:
        shape = shape.translate((tx, ty, tz))
    return shape


def _combine(
    current: cq.Workplane | None,
    feature_shape: cq.Workplane,
    operation: str,
    feature_id: str,
) -> cq.Workplane:
    if operation == "new":
        if current is not None:
            raise CadQueryCompileError(
                f"feature {feature_id!r} uses operation='new' after a body already exists"
            )
        return feature_shape
    if current is None:
        raise CadQueryCompileError(f"feature {feature_id!r} cannot {operation} before a base solid")
    if operation == "add":
        return current.union(feature_shape)
    if operation == "cut":
        return current.cut(feature_shape)
    raise CadQueryCompileError(f"unsupported operation {operation!r}")


def _compile_feature(feature: object, parameters: Mapping[str, float]) -> cq.Workplane:
    if isinstance(feature, BoxFeature):
        centered = (True, True, True) if feature.centered else (False, False, False)
        shape = cq.Workplane("XY").box(
            resolve_scalar(feature.width, parameters),
            resolve_scalar(feature.depth, parameters),
            resolve_scalar(feature.height, parameters),
            centered=centered,
        )
        return _apply_transform(shape, feature.transform, parameters)

    if isinstance(feature, CylinderFeature):
        shape = cq.Workplane("XY").cylinder(
            resolve_scalar(feature.height, parameters),
            resolve_scalar(feature.radius, parameters),
            centered=feature.centered,
        )
        return _apply_transform(shape, feature.transform, parameters)

    if isinstance(feature, ExtrudeFeature):
        points = [resolve_point(point, parameters) for point in feature.profile]
        shape = (
            cq.Workplane(feature.plane)
            .polyline(points)
            .close()
            .extrude(resolve_scalar(feature.distance, parameters))
        )
        return _apply_transform(shape, feature.transform, parameters)

    raise CadQueryCompileError(f"feature type {type(feature).__name__!r} is not a solid primitive")


def compile_design(design: DesignDocument) -> dict[str, cq.Workplane]:
    """Compile validated CAD-IR into deterministic CadQuery body workplanes."""

    compiled: dict[str, cq.Workplane] = {}
    parameters = design.parameters

    for body in design.bodies:
        current: cq.Workplane | None = None

        for feature in body.features:
            if isinstance(feature, HoleFeature):
                if current is None:
                    raise CadQueryCompileError(f"hole {feature.id!r} has no target solid")
                points = [resolve_point(point, parameters) for point in feature.points]
                diameter = resolve_scalar(feature.diameter, parameters)
                depth = resolve_scalar(feature.depth, parameters)
                if diameter <= 0 or depth <= 0:
                    raise CadQueryCompileError(
                        f"hole {feature.id!r} requires positive diameter/depth"
                    )
                current = (
                    current.faces(feature.face).workplane().pushPoints(points).hole(diameter, depth)
                )
                continue

            primitive = _compile_feature(feature, parameters)
            current = _combine(current, primitive, feature.operation, feature.id)

        if current is None:
            raise CadQueryCompileError(f"body {body.id!r} did not produce geometry")
        compiled[body.id] = current.clean()

    return compiled
