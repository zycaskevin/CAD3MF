# CAD3MF SF3D Mesh Worker

This worker isolates Stable Fast 3D GPU inference from the Node/MCP process.

## Preconditions

1. Linux GPU host with a CUDA-capable PyTorch build that can see the GPU.
2. Access accepted for `stabilityai/stable-fast-3d` on Hugging Face.
3. A Hugging Face read token available through `HF_TOKEN` or an authenticated Hugging Face CLI session.
4. The Stability AI Community License terms reviewed for the intended commercial use.

## GB10 validated baseline

The first physical M1-003P benchmark passed on 2026-09-03 with:

- NVIDIA GB10;
- Linux `aarch64`;
- NVIDIA driver `595.84`;
- system CUDA runtime reported by `nvidia-smi`: `13.2`;
- Python `3.11.15`;
- PyTorch `2.12.0+cu130`;
- torchvision `0.27.0+cu130`;
- CUDA compute capability `12.1` / `sm_121`.

Do not let SF3D dependencies replace a known-working CUDA PyTorch build with a CPU wheel.

Verify first:

```bash
python - <<'PY'
import torch
print(torch.__version__)
print(torch.version.cuda)
print(torch.cuda.is_available())
if torch.cuda.is_available():
    print(torch.cuda.get_device_name())
    print(torch.cuda.get_device_capability())
PY
```

For GB10 native extension compilation:

```bash
export TORCH_CUDA_ARCH_LIST=12.1
```

## GB10/aarch64 install

Keep the SF3D runtime isolated from ComfyUI and other GPU applications. The example below assumes a dedicated environment under `~/cad3mf-sf3d`.

```bash
mkdir -p ~/cad3mf-sf3d/vendor
python3.11 -m venv ~/cad3mf-sf3d/.venv
source ~/cad3mf-sf3d/.venv/bin/activate

python -m pip install -U pip setuptools wheel cmake ninja packaging
python -m pip install \
  torch==2.12.0 \
  torchvision==0.27.0 \
  --index-url https://download.pytorch.org/whl/cu130

git clone \
  https://github.com/Stability-AI/stable-fast-3d.git \
  ~/cad3mf-sf3d/vendor/stable-fast-3d
```

### Install the core SF3D dependencies

Upstream `requirements.txt` contains two local native extensions and two optional remesh dependencies. Install the core dependencies separately so platform-specific failures do not hide the actual dependency being built.

```bash
cd ~/cad3mf-sf3d/vendor/stable-fast-3d
source ~/cad3mf-sf3d/.venv/bin/activate

# gpytoolbox and pynanoinstantmeshes are only needed for optional remesh modes.
grep -vE \
  '^(pynanoinstantmeshes==|gpytoolbox==|\./texture_baker/|\./uv_unwrapper/)' \
  requirements.txt > /tmp/sf3d-core-requirements.txt

python -m pip install -r /tmp/sf3d-core-requirements.txt
```

### Compile `texture_baker` and `uv_unwrapper`

Both extension setup scripts import PyTorch while preparing their build. pip build isolation therefore cannot see the already-installed CUDA PyTorch package. Use `--no-build-isolation` deliberately:

```bash
cd ~/cad3mf-sf3d/vendor/stable-fast-3d
source ~/cad3mf-sf3d/.venv/bin/activate
export TORCH_CUDA_ARCH_LIST=12.1

python -m pip install --no-build-isolation -v ./texture_baker
python -m pip install --no-build-isolation -v ./uv_unwrapper
```

On the validated GB10 host both extensions compiled successfully for Linux `aarch64`; `texture_baker` compiled CUDA code with `-gencode=arch=compute_121,code=sm_121`.

### Optional-remesh compatibility patch

On the validated GB10 host, `pynanoinstantmeshes==0.0.3` and `gpytoolbox==0.2.0` did not build cleanly. SF3D only uses them for `quad` / `triangle` remesh, but upstream imports them at module import time.

For the default CAD3MF `remesh=none` path, apply the repository compatibility patch so those optional packages become lazy imports:

```bash
cd /path/to/CAD3MF
source ~/cad3mf-sf3d/.venv/bin/activate

python services/mesh-worker/patch_sf3d_optional_remesh.py \
  ~/cad3mf-sf3d/vendor/stable-fast-3d
```

This patch does not alter SF3D inference or texture generation. It only defers optional remesh imports until a remesh method is actually requested.

If triangle/quad remeshing is required on that host, install and validate the corresponding optional native dependency separately rather than silently falling back.

### Install the CAD3MF worker dependencies

From the CAD3MF repository root:

```bash
source ~/cad3mf-sf3d/.venv/bin/activate
python -m pip install -r services/mesh-worker/requirements-worker.txt
export PYTHONPATH="$HOME/cad3mf-sf3d/vendor/stable-fast-3d:${PYTHONPATH:-}"
```

## Hugging Face model access

`stabilityai/stable-fast-3d` is gated. Accept the model terms on Hugging Face, authenticate the host, and verify access before starting production inference.

A minimal access check is:

```bash
python - <<'PY'
from huggingface_hub import hf_hub_download

path = hf_hub_download(
    repo_id="stabilityai/stable-fast-3d",
    filename="config.yaml",
)
print(path)
PY
```

The first validated GB10 deployment downloaded `model.safetensors` successfully and loaded the full model onto CUDA before benchmark inference.

## Start

```bash
source ~/cad3mf-sf3d/.venv/bin/activate
export PYTHONPATH="$HOME/cad3mf-sf3d/vendor/stable-fast-3d:${PYTHONPATH:-}"
export CAD3MF_SF3D_MODEL=stabilityai/stable-fast-3d
export CAD3MF_SF3D_API_TOKEN='replace-with-a-local-worker-token'

python -m uvicorn sf3d_worker:app \
  --app-dir services/mesh-worker \
  --host 127.0.0.1 \
  --port 8791
```

Check health:

```bash
curl http://127.0.0.1:8791/healthz
```

The model is loaded lazily on the first generation request so `/healthz` can succeed before the gated weights are downloaded.

## Connect CAD3MF

Configure the MCP service process:

```bash
export CAD3MF_MESH_PROVIDER=sf3d-http
export CAD3MF_SF3D_URL=http://127.0.0.1:8791
export CAD3MF_SF3D_API_TOKEN='replace-with-a-local-worker-token'
```

With this provider selected, `generate_mesh` defaults to GLB + PBR. It never silently falls back to the deterministic CI cube.

## Metric scale contract

SF3D reconstructs shape from one image but does not provide trustworthy physical millimeter scale. CAD3MF therefore requires a Design Intent dimension whose source is `user` or `measured_reference` before production inference.

Current scaling policy is uniform `longest_extent` scaling:

- figurine / character: prefer confirmed height;
- vehicle / tank: prefer confirmed length;
- if the preferred semantic dimension is unavailable, use another explicitly supplied/measured mm dimension;
- `inferred` and `default` dimensions do not qualify as manufacturing scale truth.

The worker scales actual mesh vertices, exports the scaled GLB, then measures the resulting bounding box. It does not merely relabel normalized model units as millimeters.

## First physical benchmark

The first GB10 real-model benchmark completed on 2026-09-03:

- stylized figurine, target longest extent `120 mm`: real GLB generated;
- three-quarter tank, target longest extent `160 mm`: real GLB generated;
- both preview runs used texture resolution `512` and `remesh=none`;
- observed peak PyTorch CUDA allocation was `6.044 GiB` in both runs.

The raw SF3D outputs were not watertight. That observation is expected to flow into M1-004; it is not a failure of M1-003P and does not certify printability.

Do not call either output printable until M1-004 validates and repairs the mesh.
