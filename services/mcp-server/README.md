# CAD3MF MCP Server

Status: **M0-B MCP Runtime PASS** and **M0-C HTTP/App Contract PASS**.

The MCP service is the Agent-facing project/runtime boundary for CAD3MF. It validates and versions CAD-IR, delegates deterministic geometry work to the Python worker, persists project state, and exposes controlled CAD artifacts.

## Tool contract

The server exposes six M0 tools:

- `create_design`
- `modify_design`
- `inspect_design`
- `render_design`
- `validate_design`
- `export_design`

`prepare_print` is intentionally not exposed until the slicing/Bambu runtime exists.

The canonical CAD-IR schema is exposed as:

`caddesk://schema/cad-ir/0.1`

The schema is generated from the Python `DesignDocument` model at runtime. There is no second hand-maintained TypeScript CAD schema.

For ChatGPT/App hosts the service also exposes:

`ui://caddesk/viewer/v1.html`

with MIME type `text/html;profile=mcp-app`.

## Safety model

The MCP process never executes Python supplied by a user or model. `create_design` accepts JSON CAD-IR only. The document is passed to the Python worker, validated by Pydantic, compiled through the allowlisted CAD-IR compiler, checked by OpenCascade, and only then persisted.

M0 `modify_design` supports only `set_parameter`. Feature mutation operations remain closed until their invariants and revision semantics are tested.

Project IDs are path-safe. HTTP artifact routes resolve persisted revision metadata and never translate URL path segments directly into filesystem paths.

## Persistence

Local MVP state is stored in SQLite through Node's built-in `node:sqlite` module:

- `projects` stores project metadata and the latest revision pointer.
- `revisions` stores immutable CAD-IR, validation, and artifact manifests.

Artifacts live under:

`$CAD3MF_DATA_DIR/projects/<project>/revisions/<revision>/`

Default data root: `.cad3mf-data`.

## Runtime requirements

- Node.js >= 22.13
- Python 3.11
- CAD3MF Python dependencies from the repository root
- built ChatGPT widget for HTTP/App mode

## stdio development

```bash
cd services/mcp-server
npm install
CAD3MF_PYTHON=python npm run start:stdio
```

stdio remains available for local development and regression testing. Protocol data is written to stdout; diagnostics go to stderr.

## HTTP / ChatGPT App development

Build the widget first:

```bash
cd apps/chatgpt-plugin
npm install
npm run build
```

Then start the HTTP server:

```bash
cd ../../services/mcp-server
npm install
CAD3MF_PYTHON=python \
CAD3MF_HOST=127.0.0.1 \
CAD3MF_PORT=8787 \
CAD3MF_PUBLIC_BASE_URL=http://127.0.0.1:8787 \
npm run start:http
```

Endpoints:

- `GET /healthz`
- MCP Streamable HTTP: `/mcp`
- immutable artifacts: `/artifacts/<project>/<revision>/<preview|step|stl|3mf>`

Optional deployment controls:

- `CAD3MF_ALLOWED_HOSTS` — comma-separated additional allowed HTTP Host values
- `CAD3MF_ALLOWED_ORIGINS` — comma-separated additional allowed Origin values

For a real ChatGPT Developer Mode connection, `CAD3MF_PUBLIC_BASE_URL` must be the externally reachable HTTPS origin.

## Public vs local artifact contract

stdio development responses may contain local `file://` artifact information for local tooling compatibility.

HTTP/App responses deliberately contain only controlled public URLs. For example, `export_design(format=3mf)` returns `artifact_url`; it does not expose `artifact_path`.

## Verification

```bash
npm run typecheck
CAD3MF_PYTHON=python npm test
CAD3MF_PYTHON=python npm run test:http
```

The stdio E2E verifies the MCP v2 modern protocol, CAD-IR schema resource, r1 → r2 modification, validation/export, SQLite persistence across process restarts, and security regressions.

The HTTP E2E additionally verifies:

- Streamable HTTP modern protocol negotiation
- ChatGPT viewer resource retrieval
- `text/html;profile=mcp-app` MIME
- public snapshots do not expose server paths
- a controlled preview URL returns a real GLB (`glTF` magic)
- `modify_design` creates revision 2
- a controlled 3MF URL returns a real ZIP-based 3MF (`PK` magic)
