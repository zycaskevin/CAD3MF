# CAD3MF ChatGPT App Widget

Status: **M0-C App Contract/Runtime PASS**.

This package is the ChatGPT-facing CADDesk viewer. It is a React + Three.js MCP App bundled as one HTML document and served by the MCP server as:

`ui://caddesk/viewer/v1.html`

MIME type:

`text/html;profile=mcp-app`

## Responsibility

The widget owns presentation and user interaction only:

- rotate / zoom / pan the GLB preview
- show project and revision state
- show parameters and geometry validation
- edit a numeric parameter
- request STEP / STL / 3MF exports
- request inline/fullscreen display mode

The widget **does not compile or mutate CAD geometry in the browser**. Parameter changes call the server-side `modify_design` tool, which creates an immutable revision and returns a new authoritative snapshot.

## MCP Apps bridge

The widget uses the MCP Apps bridge through `@modelcontextprotocol/ext-apps/react`:

- `useApp()` establishes the host bridge
- `ontoolresult` receives authoritative tool results
- `callServerTool()` invokes `modify_design` / `export_design`
- `requestDisplayMode()` requests fullscreen/inline mode
- `openLink()` opens controlled export URLs

There is no `window.openai` dependency in the primary implementation.

## Data contract

The HTTP App transport returns a public snapshot shaped around:

```json
{
  "project_id": "...",
  "revision_id": "r2",
  "parent_revision_id": "r1",
  "parameters": { "magnet_diameter": 8 },
  "geometry_summary": { "pass": true },
  "viewer": {
    "preview_url": "https://.../artifacts/.../preview"
  },
  "artifact_urls": {
    "step": "https://.../step",
    "stl": "https://.../stl",
    "3mf": "https://.../3mf"
  }
}
```

Raw server filesystem paths are not part of the public App contract.

## Build

```bash
npm install
npm run build
npm run check
```

Output:

`dist/caddesk-viewer.html`

The Vite single-file build inlines the React/Three.js runtime and CSS into the HTML resource. CI also runs TypeScript checking and bundle-integrity checks.

## Current validation

CI verifies:

- dependency installation
- production Vite build
- TypeScript check
- expected viewer marker in the single-file artifact
- no root-relative external JavaScript dependency
- HTTP MCP resource returns the built viewer with `text/html;profile=mcp-app`

The remaining visual acceptance is to deploy the MCP server to a reachable HTTPS origin, connect it in ChatGPT Developer Mode, and visually verify the real iframe/viewer interaction.
