from __future__ import annotations

import argparse
import json
from pathlib import Path

from .build import build_file, load_design
from .revisions import revise_parameter


def _parse_assignment(raw: str) -> tuple[str, float]:
    if "=" not in raw:
        raise argparse.ArgumentTypeError("expected PARAMETER=NUMBER")
    name, value = raw.split("=", 1)
    if not name:
        raise argparse.ArgumentTypeError("parameter name cannot be empty")
    try:
        number = float(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("parameter value must be numeric") from exc
    return name, number


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cad3mf")
    subparsers = parser.add_subparsers(dest="command", required=True)

    build = subparsers.add_parser("build", help="compile, validate, and export a CAD-IR document")
    build.add_argument("spec", type=Path)
    build.add_argument("--out", type=Path, required=True)

    revise = subparsers.add_parser("revise", help="create a new revision by changing one parameter")
    revise.add_argument("spec", type=Path)
    revise.add_argument("--set", dest="assignment", type=_parse_assignment, required=True)
    revise.add_argument("--revision", required=True)
    revise.add_argument("--out", type=Path, required=True)

    return parser


def main() -> int:
    args = _build_parser().parse_args()

    if args.command == "build":
        manifest = build_file(args.spec, args.out)
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0

    if args.command == "revise":
        name, value = args.assignment
        design = load_design(args.spec)
        revised = revise_parameter(design, parameter=name, value=value, revision_id=args.revision)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(revised.model_dump_json(indent=2), encoding="utf-8")
        print(args.out)
        return 0

    raise AssertionError(f"unhandled command {args.command!r}")


if __name__ == "__main__":
    raise SystemExit(main())
