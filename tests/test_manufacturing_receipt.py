from datetime import UTC, datetime

from cad3mf_manufacturing import Measurement, PhysicalPrintReceipt
from pydantic import ValidationError


def test_physical_print_receipt_passes_only_with_measurements_and_fit() -> None:
    receipt = PhysicalPrintReceipt(
        project_id="m0d-magnet-module-live",
        revision_id="r3",
        artifact_sha256="8f6b49c3c64b466ccdafdc54405735ea530d777400d8666df5d15bda3ea5630f",
        printer="Bambu H2C",
        material="PETG",
        slicer_profile="canonical-v0.1",
        printed_at=datetime(2026, 9, 5, tzinfo=UTC),
        measurements=[
            Measurement(
                name="overall_x",
                nominal_mm=64.0,
                measured_mm=64.08,
                tolerance_minus_mm=0.2,
                tolerance_plus_mm=0.2,
            ),
            Measurement(
                name="magnet_pocket_diameter",
                nominal_mm=4.0,
                measured_mm=4.05,
                tolerance_minus_mm=0.1,
                tolerance_plus_mm=0.1,
            ),
        ],
        fit_result="pass",
    )

    assert receipt.measurements[0].within_tolerance is True
    assert receipt.measurements[1].within_tolerance is True
    assert receipt.overall_pass is True


def test_physical_print_receipt_fails_on_dimension_or_untested_fit() -> None:
    out_of_tolerance = PhysicalPrintReceipt(
        project_id="m0d-magnet-module-live",
        revision_id="r3",
        artifact_sha256="8f6b49c3c64b466ccdafdc54405735ea530d777400d8666df5d15bda3ea5630f",
        printer="Bambu H2C",
        material="PETG",
        printed_at=datetime(2026, 9, 5, tzinfo=UTC),
        measurements=[
            Measurement(
                name="magnet_pocket_diameter",
                nominal_mm=4.0,
                measured_mm=3.7,
                tolerance_minus_mm=0.1,
                tolerance_plus_mm=0.1,
            )
        ],
        fit_result="pass",
    )
    assert out_of_tolerance.overall_pass is False

    untested_fit = out_of_tolerance.model_copy(
        update={
            "measurements": [
                Measurement(
                    name="magnet_pocket_diameter",
                    nominal_mm=4.0,
                    measured_mm=4.0,
                    tolerance_minus_mm=0.1,
                    tolerance_plus_mm=0.1,
                )
            ],
            "fit_result": "not_tested",
        }
    )
    assert untested_fit.overall_pass is False


def test_physical_print_receipt_rejects_unbound_artifact_hash() -> None:
    try:
        PhysicalPrintReceipt(
            project_id="m0d-magnet-module-live",
            revision_id="r3",
            artifact_sha256="not-a-sha256",
            printer="Bambu H2C",
            material="PETG",
            printed_at=datetime(2026, 9, 5, tzinfo=UTC),
            measurements=[
                Measurement(
                    name="overall_x",
                    nominal_mm=64.0,
                    measured_mm=64.0,
                    tolerance_minus_mm=0.2,
                    tolerance_plus_mm=0.2,
                )
            ],
            fit_result="not_applicable",
        )
    except ValidationError:
        return
    raise AssertionError("invalid artifact hash must be rejected")
