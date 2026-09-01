from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


Scalar = Union[float, int, str]
Point2D = tuple[Scalar, Scalar]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Transform(StrictModel):
    x: Scalar = 0.0
    y: Scalar = 0.0
    z: Scalar = 0.0
    rotate_x: Scalar = 0.0
    rotate_y: Scalar = 0.0
    rotate_z: Scalar = 0.0


class FeatureBase(StrictModel):
    id: str = Field(min_length=1)
    operation: Literal["new", "add", "cut"]
    transform: Transform = Field(default_factory=Transform)


class BoxFeature(FeatureBase):
    type: Literal["box"]
    width: Scalar
    depth: Scalar
    height: Scalar
    centered: bool = True


class CylinderFeature(FeatureBase):
    type: Literal["cylinder"]
    radius: Scalar
    height: Scalar
    centered: bool = True


class ExtrudeFeature(FeatureBase):
    type: Literal["extrude"]
    plane: Literal["XY", "YZ", "XZ"] = "XY"
    profile: list[Point2D] = Field(min_length=3)
    distance: Scalar


class HoleFeature(StrictModel):
    type: Literal["hole"]
    id: str = Field(min_length=1)
    diameter: Scalar
    depth: Scalar
    points: list[Point2D] = Field(min_length=1)
    face: Literal[">Z", "<Z"] = ">Z"


Feature = Annotated[
    Union[BoxFeature, CylinderFeature, ExtrudeFeature, HoleFeature],
    Field(discriminator="type"),
]


class Body(StrictModel):
    id: str = Field(min_length=1)
    features: list[Feature] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_feature_tree(self) -> "Body":
        ids = [feature.id for feature in self.features]
        if len(ids) != len(set(ids)):
            raise ValueError(f"body {self.id!r} contains duplicate feature ids")

        first = self.features[0]
        if isinstance(first, HoleFeature):
            raise ValueError("the first body feature cannot be a hole")
        if first.operation != "new":
            raise ValueError("the first body feature must use operation='new'")
        return self


class ManufacturingSpec(StrictModel):
    process: Literal["fdm"] = "fdm"
    material: str = "PETG"


class DesignDocument(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    project_id: str = Field(min_length=1)
    revision_id: str = Field(min_length=1)
    parent_revision_id: str | None = None
    units: Literal["mm"] = "mm"
    parameters: dict[str, float]
    manufacturing: ManufacturingSpec = Field(default_factory=ManufacturingSpec)
    bodies: list[Body] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_document(self) -> "DesignDocument":
        body_ids = [body.id for body in self.bodies]
        if len(body_ids) != len(set(body_ids)):
            raise ValueError("body ids must be unique")

        for name, value in self.parameters.items():
            if not name or name.startswith("$"):
                raise ValueError("parameter names must be non-empty and omit the '$' prefix")
            if not isinstance(value, (int, float)):
                raise ValueError(f"parameter {name!r} must be numeric in CAD-IR 0.1")
        return self
