from __future__ import annotations

import base64
import json
import os
import tempfile
from contextlib import nullcontext
from io import BytesIO
from threading import Lock
from typing import Annotated, Any

import numpy as np
import rembg
import torch
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import Response
from PIL import Image
from sf3d.system import SF3D
from sf3d.utils import get_device, remove_background, resize_foreground

MAX_IMAGE_BYTES = 20 * 1024 * 1024
MODEL_ID = os.getenv("CAD3MF_SF3D_MODEL", "stabilityai/stable-fast-3d")
FOREGROUND_RATIO = float(os.getenv("CAD3MF_SF3D_FOREGROUND_RATIO", "0.85"))
EXPECTED_TOKEN = os.getenv("CAD3MF_SF3D_API_TOKEN")

app = FastAPI(title="CAD3MF SF3D Mesh Worker", version="0.1.0")
_model: SF3D | None = None
_rembg_session: Any | None = None
_device: str | None = None
_load_lock = Lock()


def _authorize(authorization: str | None) -> None:
    if EXPECTED_TOKEN is None:
        return
    if authorization != f"Bearer {EXPECTED_TOKEN}":
        raise HTTPException(status_code=401, detail="invalid mesh-worker authorization")


def _load_runtime() -> tuple[SF3D, Any, str]:
    global _device, _model, _rembg_session
    if _model is not None and _rembg_session is not None and _device is not None:
        return _model, _rembg_session, _device
    with _load_lock:
        if _model is None:
            device = get_device()
            model = SF3D.from_pretrained(
                MODEL_ID,
                config_name="config.yaml",
                weight_name="model.safetensors",
            )
            model.to(device)
            model.eval()
            _model = model
            _device = device
        if _rembg_session is None:
            _rembg_session = rembg.new_session()
    assert _model is not None
    assert _rembg_session is not None
    assert _device is not None
    return _model, _rembg_session, _device


def _texture_resolution(quality_tier: str) -> int:
    if quality_tier == "preview":
        return 512
    if quality_tier == "standard":
        return 1024
    if quality_tier == "high":
        return 2048
    raise HTTPException(status_code=400, detail="invalid quality_tier")


def _decode_image(data: bytes, declared_type: str | None) -> Image.Image:
    if len(data) == 0 or len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="image is empty or exceeds worker limit")
    allowed = {"image/png", "image/jpeg", "image/webp", None}
    if declared_type not in allowed:
        raise HTTPException(status_code=415, detail="unsupported image media type")
    try:
        image = Image.open(BytesIO(data)).convert("RGBA")
        image.load()
    except Exception as exc:
        raise HTTPException(status_code=415, detail="invalid image content") from exc
    return image


def _scale_to_millimeters(mesh: Any, target_extent_mm: float) -> dict[str, Any]:
    if not np.isfinite(target_extent_mm) or target_extent_mm <= 0 or target_extent_mm > 10000:
        raise HTTPException(status_code=400, detail="target_extent_mm must be in (0, 10000]")
    bounds = np.asarray(mesh.bounds, dtype=np.float64)
    if bounds.shape != (2, 3) or not np.isfinite(bounds).all():
        raise HTTPException(status_code=502, detail="SF3D returned invalid mesh bounds")
    extents = bounds[1] - bounds[0]
    longest = float(np.max(extents))
    if not np.isfinite(longest) or longest <= 0:
        raise HTTPException(status_code=502, detail="SF3D returned zero-size geometry")
    scale = target_extent_mm / longest
    mesh.apply_scale(scale)
    scaled = np.asarray(mesh.bounds, dtype=np.float64)
    return {
        "scale_factor": scale,
        "min": {"x": float(scaled[0, 0]), "y": float(scaled[0, 1]), "z": float(scaled[0, 2])},
        "max": {"x": float(scaled[1, 0]), "y": float(scaled[1, 1]), "z": float(scaled[1, 2])},
    }


def _stats_header(mesh: Any, bbox: dict[str, Any], scale_dimension_name: str) -> str:
    vertices = np.asarray(mesh.vertices)
    faces = np.asarray(mesh.faces)
    payload = {
        "vertex_count": int(vertices.shape[0]),
        "triangle_count": int(faces.shape[0]),
        "bounding_box_mm": {"min": bbox["min"], "max": bbox["max"]},
        "topology": {
            "watertight": bool(mesh.is_watertight),
            "manifold": None,
            "self_intersections_detected": None,
            "notes": [
                "SF3D topology observations are pre-M1-004 and do not certify printability.",
                f"Uniform scale reference: {scale_dimension_name}; policy=longest_extent.",
            ],
        },
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    return encoded.rstrip("=")


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "cad3mf-sf3d-worker",
        "model": MODEL_ID,
        "model_loaded": _model is not None,
        "device": _device,
    }


@app.post("/v1/generate")
async def generate(
    image: Annotated[UploadFile, File()],
    view_name: Annotated[str, Form()],
    scale_policy: Annotated[str, Form()],
    scale_dimension_name: Annotated[str, Form()],
    target_extent_mm: Annotated[float, Form()],
    quality_tier: Annotated[str, Form()] = "standard",
    texture_policy: Annotated[str, Form()] = "pbr",
    target_triangle_count: Annotated[int | None, Form()] = None,
    authorization: Annotated[str | None, Header()] = None,
) -> Response:
    _authorize(authorization)
    if view_name not in {
        "front",
        "left",
        "right",
        "back",
        "three_quarter_front",
        "three_quarter_back",
    }:
        raise HTTPException(status_code=400, detail="invalid canonical view_name")
    if texture_policy != "pbr":
        raise HTTPException(
            status_code=400, detail="SF3D worker currently requires texture_policy=pbr"
        )
    if scale_policy != "longest_extent":
        raise HTTPException(status_code=400, detail="unsupported scale_policy")
    if not scale_dimension_name or len(scale_dimension_name) > 128:
        raise HTTPException(status_code=400, detail="invalid scale_dimension_name")
    texture_resolution = _texture_resolution(quality_tier)
    data = await image.read(MAX_IMAGE_BYTES + 1)
    pil_image = _decode_image(data, image.content_type)

    model, rembg_session, device = _load_runtime()
    prepared = remove_background(pil_image, rembg_session)
    prepared = resize_foreground(prepared, FOREGROUND_RATIO)
    remesh = "triangle" if target_triangle_count is not None else "none"
    vertex_count = target_triangle_count if target_triangle_count is not None else -1

    with torch.no_grad():
        autocast = (
            torch.autocast(device_type=device, dtype=torch.bfloat16)
            if "cuda" in device
            else nullcontext()
        )
        with autocast:
            mesh, _glob_dict = model.run_image(
                [prepared],
                bake_resolution=texture_resolution,
                remesh=remesh,
                vertex_count=vertex_count,
            )

    bbox = _scale_to_millimeters(mesh, target_extent_mm)
    with tempfile.TemporaryDirectory(prefix="cad3mf-sf3d-") as temp_dir:
        output_path = os.path.join(temp_dir, "mesh.glb")
        mesh.export(output_path, include_normals=True)
        with open(output_path, "rb") as handle:
            glb = handle.read()

    headers = {
        "x-cad3mf-used-view": view_name,
        "x-cad3mf-provider": "stable-fast-3d",
        "x-cad3mf-model": MODEL_ID,
        "x-cad3mf-scale-dimension": scale_dimension_name,
        "x-cad3mf-mesh-stats": _stats_header(mesh, bbox, scale_dimension_name),
    }
    return Response(content=glb, media_type="model/gltf-binary", headers=headers)
