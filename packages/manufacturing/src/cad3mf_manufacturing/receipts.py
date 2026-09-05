from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, computed_field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Measurement(StrictModel):
    name: str = Field(min_length=1)
    nominal_mm: float
    measured_mm: float
    tolerance_minus_mm: float = Field(ge=0)
    tolerance_plus_mm: float = Field(ge=0)

    @computed_field
    @property
    def deviation_mm(self) -> float:
        return self.measured_mm - self.nominal_mm

    @computed_field
    @property
    def within_tolerance(self) -> bool:
        lower = self.nominal_mm - self.tolerance_minus_mm
        upper = self.nominal_mm + self.tolerance_plus_mm
        return lower <= self.measured_mm <= upper


class PhysicalPrintReceipt(StrictModel):
    schema_version: Literal["0.1"] = "0.1"
    project_id: str = Field(min_length=1)
    revision_id: str = Field(min_length=1)
    artifact_format: Literal["3mf"] = "3mf"
    artifact_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    printer: str = Field(min_length=1)
    material: str = Field(min_length=1)
    slicer_profile: str | None = None
    printed_at: datetime
    measurements: list[Measurement] = Field(min_length=1)
    fit_result: Literal["pass", "fail", "not_applicable", "not_tested"] = "not_tested"
    notes: str | None = None

    @computed_field
    @property
    def overall_pass(self) -> bool:
        measurements_pass = all(item.within_tolerance for item in self.measurements)
        fit_pass = self.fit_result in {"pass", "not_applicable"}
        return measurements_pass and fit_pass
