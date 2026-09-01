from __future__ import annotations

from cad3mf_ir import DesignDocument


class RevisionError(ValueError):
    pass


def revise_parameter(
    design: DesignDocument,
    *,
    parameter: str,
    value: float,
    revision_id: str,
) -> DesignDocument:
    if parameter not in design.parameters:
        raise RevisionError(f"unknown parameter {parameter!r}")
    if revision_id == design.revision_id:
        raise RevisionError("new revision_id must differ from the parent revision")

    data = design.model_dump(mode="python")
    data["parent_revision_id"] = design.revision_id
    data["revision_id"] = revision_id
    data["parameters"] = dict(design.parameters)
    data["parameters"][parameter] = float(value)
    return DesignDocument.model_validate(data)
