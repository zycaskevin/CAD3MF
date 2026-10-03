import { useApp } from "@modelcontextprotocol/ext-apps/react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import "./viewer.css";

type Validation = {
  pass?: boolean;
  is_valid?: boolean;
  single_solid?: boolean;
  solid_count?: number;
  volume_mm3?: number;
  bounding_box_mm?: { x?: number; y?: number; z?: number };
};

type ParametricSnapshot = {
  view_kind?: "parametric";
  project_id: string;
  revision_id: string;
  parent_revision_id: string | null;
  parameters: Record<string, number>;
  geometry_summary: Validation;
  viewer: { preview_url: string };
  artifact_urls: { step: string; stl: string; "3mf": string };
};

type EngineeringEnvelope = {
  id: string;
  semantic_role: string;
  component_role: string;
  shape: Record<string, unknown>;
  transform: Record<string, unknown>;
  clearance_mm: number | null;
};

type EngineeringSnapshot = {
  view_kind: "engineering";
  project_id: string;
  asset_revision_id: string;
  asset_type: string | null;
  target_dimensions: unknown[];
  visual_alignment: Record<string, unknown>;
  geometry_artifact: Record<string, unknown>;
  viewer: { preview_url: string };
  envelope_set: {
    revision_id: string | null;
    coordinate_frame: Record<string, unknown> | null;
    envelopes: EngineeringEnvelope[];
  } | null;
  interference_report: Record<string, unknown> | null;
  interference_report_stale: boolean;
  assembly: Record<string, unknown> | null;
  assembly_validation: Record<string, unknown> | null;
  assembly_validation_stale: boolean;
  evidence_note: string;
};

type ViewerSnapshot = ParametricSnapshot | EngineeringSnapshot;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseEngineeringEnvelope(value: unknown): EngineeringEnvelope | null {
  const envelope = asRecord(value);
  if (!envelope || typeof envelope.id !== "string") return null;
  const shape = asRecord(envelope.shape);
  const transform = asRecord(envelope.transform);
  if (!shape || !transform) return null;
  return {
    id: envelope.id,
    semantic_role:
      typeof envelope.semantic_role === "string" ? envelope.semantic_role : "other",
    component_role:
      typeof envelope.component_role === "string" ? envelope.component_role : "other",
    shape,
    transform,
    clearance_mm: finiteNumber(envelope.clearance_mm),
  };
}

function parseParametricSnapshot(value: unknown): ParametricSnapshot | null {
  const root = asRecord(value);
  if (!root) return null;
  const parameters = asRecord(root.parameters);
  const geometry = asRecord(root.geometry_summary);
  const viewer = asRecord(root.viewer);
  const artifacts = asRecord(root.artifact_urls);
  if (
    typeof root.project_id !== "string" ||
    typeof root.revision_id !== "string" ||
    !parameters ||
    !geometry ||
    !viewer ||
    typeof viewer.preview_url !== "string" ||
    !artifacts ||
    typeof artifacts.step !== "string" ||
    typeof artifacts.stl !== "string" ||
    typeof artifacts["3mf"] !== "string"
  ) {
    return null;
  }

  const numericParameters: Record<string, number> = {};
  for (const [name, raw] of Object.entries(parameters)) {
    if (typeof raw === "number" && Number.isFinite(raw)) numericParameters[name] = raw;
  }

  return {
    view_kind: "parametric",
    project_id: root.project_id,
    revision_id: root.revision_id,
    parent_revision_id: typeof root.parent_revision_id === "string" ? root.parent_revision_id : null,
    parameters: numericParameters,
    geometry_summary: geometry as Validation,
    viewer: { preview_url: viewer.preview_url },
    artifact_urls: {
      step: artifacts.step,
      stl: artifacts.stl,
      "3mf": artifacts["3mf"],
    },
  };
}

function parseEngineeringSnapshot(value: unknown): EngineeringSnapshot | null {
  const root = asRecord(value);
  if (!root || root.view_kind !== "engineering") return null;
  const viewer = asRecord(root.viewer);
  const geometryArtifact = asRecord(root.geometry_artifact);
  const visualAlignment = asRecord(root.visual_alignment);
  if (
    typeof root.project_id !== "string" ||
    typeof root.asset_revision_id !== "string" ||
    !viewer ||
    typeof viewer.preview_url !== "string" ||
    !geometryArtifact ||
    !visualAlignment
  ) {
    return null;
  }

  const rawEnvelopeSet = asRecord(root.envelope_set);
  const rawEnvelopes = rawEnvelopeSet?.envelopes;
  const envelopeSet =
    rawEnvelopeSet && Array.isArray(rawEnvelopes)
      ? {
          revision_id:
            typeof rawEnvelopeSet.revision_id === "string"
              ? rawEnvelopeSet.revision_id
              : null,
          coordinate_frame: asRecord(rawEnvelopeSet.coordinate_frame),
          envelopes: rawEnvelopes.flatMap((item) => {
            const parsed = parseEngineeringEnvelope(item);
            return parsed ? [parsed] : [];
          }),
        }
      : null;

  return {
    view_kind: "engineering",
    project_id: root.project_id,
    asset_revision_id: root.asset_revision_id,
    asset_type: typeof root.asset_type === "string" ? root.asset_type : null,
    target_dimensions: Array.isArray(root.target_dimensions) ? root.target_dimensions : [],
    visual_alignment: visualAlignment,
    geometry_artifact: geometryArtifact,
    viewer: { preview_url: viewer.preview_url },
    envelope_set: envelopeSet,
    interference_report: asRecord(root.interference_report),
    interference_report_stale: root.interference_report_stale === true,
    assembly: asRecord(root.assembly),
    assembly_validation: asRecord(root.assembly_validation),
    assembly_validation_stale: root.assembly_validation_stale === true,
    evidence_note: typeof root.evidence_note === "string" ? root.evidence_note : "",
  };
}

function parseSnapshot(value: unknown): ViewerSnapshot | null {
  return parseEngineeringSnapshot(value) ?? parseParametricSnapshot(value);
}

function envelopeVisualizable(envelope: EngineeringEnvelope): boolean {
  const rotateX = finiteNumber(envelope.transform.rotate_x) ?? 0;
  const rotateY = finiteNumber(envelope.transform.rotate_y) ?? 0;
  const rotateZ = finiteNumber(envelope.transform.rotate_z) ?? 0;
  const kind = envelope.shape.kind;
  if (kind === "box") return rotateX === 0 && rotateY === 0 && rotateZ === 0;
  if (kind === "cylinder") return rotateX === 0 && rotateY === 0;
  return false;
}

function engineeringPosition(transform: Record<string, unknown>): THREE.Vector3 {
  const x = finiteNumber(transform.x) ?? 0;
  const y = finiteNumber(transform.y) ?? 0;
  const z = finiteNumber(transform.z) ?? 0;
  return new THREE.Vector3(x, z, -y);
}

function envelopeColor(role: string): number {
  if (role === "keep_out") return 0xef4444;
  if (role === "motion_swept") return 0xf59e0b;
  if (role === "required_contact") return 0xa855f7;
  return 0x3b82f6;
}

function createEnvelopeObject(envelope: EngineeringEnvelope): THREE.Group | null {
  if (!envelopeVisualizable(envelope)) return null;
  const clearance = Math.max(envelope.clearance_mm ?? 0, 0);
  const group = new THREE.Group();
  let geometry: THREE.BufferGeometry | null = null;

  if (envelope.shape.kind === "box") {
    const x = finiteNumber(envelope.shape.x);
    const y = finiteNumber(envelope.shape.y);
    const z = finiteNumber(envelope.shape.z);
    if (x === null || y === null || z === null || x <= 0 || y <= 0 || z <= 0) return null;
    geometry = new THREE.BoxGeometry(x + clearance * 2, z + clearance * 2, y + clearance * 2);
  } else if (envelope.shape.kind === "cylinder") {
    const diameter = finiteNumber(envelope.shape.diameter);
    const height = finiteNumber(envelope.shape.height);
    if (diameter === null || height === null || diameter <= 0 || height <= 0) return null;
    geometry = new THREE.CylinderGeometry(
      diameter / 2 + clearance,
      diameter / 2 + clearance,
      height + clearance * 2,
      32,
    );
  }

  if (!geometry) return null;
  const color = envelopeColor(envelope.semantic_role);
  const surface = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.17,
      depthWrite: false,
    }),
  );
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(geometry),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }),
  );
  group.add(surface, edges);
  group.position.copy(engineeringPosition(envelope.transform));
  group.userData = { envelopeId: envelope.id };
  return group;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh) && !(child instanceof THREE.LineSegments)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => material.dispose());
  });
}

function ModelViewport({
  url,
  envelopes = [],
  visualAlignment = null,
}: {
  url: string;
  envelopes?: EngineeringEnvelope[];
  visualAlignment?: Record<string, unknown> | null;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    setLoadError(null);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 5000);
    camera.position.set(90, 70, 90);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = true;

    scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 3.0);
    key.position.set(80, 120, 60);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 1.4);
    fill.position.set(-80, 40, -60);
    scene.add(fill);

    const grid = new THREE.GridHelper(200, 20);
    grid.position.y = -0.01;
    scene.add(grid);

    const overlayGroup = new THREE.Group();
    for (const envelope of envelopes) {
      const overlay = createEnvelopeObject(envelope);
      if (overlay) overlayGroup.add(overlay);
    }
    scene.add(overlayGroup);

    let model: THREE.Object3D | null = null;
    const loader = new GLTFLoader();
    loader.load(
      url,
      (gltf) => {
        model = gltf.scene;

        if (
          visualAlignment?.mode === "normalize_longest_extent_center_ground" &&
          typeof visualAlignment.target_value_mm === "number" &&
          Number.isFinite(visualAlignment.target_value_mm) &&
          visualAlignment.target_value_mm > 0
        ) {
          const rawBox = new THREE.Box3().setFromObject(model);
          const rawSize = rawBox.getSize(new THREE.Vector3());
          const longest = Math.max(rawSize.x, rawSize.y, rawSize.z);
          if (longest > 0) {
            model.scale.multiplyScalar(visualAlignment.target_value_mm / longest);
            model.updateMatrixWorld(true);
            const scaledBox = new THREE.Box3().setFromObject(model);
            const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
            model.position.x -= scaledCenter.x;
            model.position.y -= scaledBox.min.y;
            model.position.z -= scaledCenter.z;
            model.updateMatrixWorld(true);
          }
        }

        scene.add(model);
        const box = new THREE.Box3().setFromObject(model);
        if (overlayGroup.children.length > 0) box.expandByObject(overlayGroup);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const radius = Math.max(size.length() * 0.5, 1);
        controls.target.copy(center);
        camera.near = Math.max(radius / 200, 0.01);
        camera.far = Math.max(radius * 100, 1000);
        camera.position
          .copy(center)
          .add(new THREE.Vector3(radius * 1.5, radius * 1.2, radius * 1.5));
        camera.updateProjectionMatrix();
        controls.update();
      },
      undefined,
      (error) => setLoadError(error instanceof Error ? error.message : "Unable to load GLB preview"),
    );

    const resize = () => {
      const width = Math.max(mount.clientWidth, 1);
      const height = Math.max(mount.clientHeight, 1);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    let frame = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };
    animate();

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      controls.dispose();
      if (model) disposeObject(model);
      disposeObject(overlayGroup);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [url, envelopes, visualAlignment]);

  return (
    <div className="viewport" ref={mountRef}>
      {loadError ? <div className="viewport-error">{loadError}</div> : null}
    </div>
  );
}

function formatNumber(value: number | undefined, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyParameter, setBusyParameter] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [displayMode, setDisplayMode] = useState("inline");

  const { app, error } = useApp({
    appInfo: { name: "CADDesk Viewer", version: "0.1.0" },
    capabilities: {},
    onAppCreated: (createdApp) => {
      createdApp.ontoolresult = (toolResult) => {
        const next = parseSnapshot(toolResult.structuredContent);
        if (next) setSnapshot(next);
      };
      createdApp.onhostcontextchanged = (context) => {
        if (context.displayMode) setDisplayMode(context.displayMode);
      };
      createdApp.onerror = (appError) => setMessage(appError.message);
    },
  });

  useEffect(() => {
    if (!snapshot) return;
    setDrafts(Object.fromEntries(Object.entries(snapshot.parameters).map(([key, value]) => [key, String(value)])));
  }, [snapshot]);

  const validation = snapshot?.geometry_summary;
  const bbox = validation?.bounding_box_mm;
  const parameterEntries = useMemo(
    () => Object.entries(snapshot?.parameters ?? {}).sort(([a], [b]) => a.localeCompare(b)),
    [snapshot],
  );

  async function applyParameter(name: string) {
    if (!app || !snapshot) return;
    const value = Number(drafts[name]);
    if (!Number.isFinite(value)) {
      setMessage(`${name} must be numeric`);
      return;
    }
    if (!app.getHostCapabilities()?.serverTools) {
      setMessage("This host does not allow widget-initiated server tool calls.");
      return;
    }

    setBusyParameter(name);
    setMessage(null);
    try {
      const toolResult = await app.callServerTool({
        name: "modify_design",
        arguments: {
          project_id: snapshot.project_id,
          base_revision_id: snapshot.revision_id,
          change: { operation: "set_parameter", name, value },
        },
      });
      const next = parseSnapshot(toolResult.structuredContent);
      if (!next) throw new Error("modify_design returned an invalid viewer snapshot");
      setSnapshot(next);
    } catch (toolError) {
      setMessage(toolError instanceof Error ? toolError.message : String(toolError));
    } finally {
      setBusyParameter(null);
    }
  }

  async function exportFormat(format: "step" | "stl" | "3mf") {
    if (!app || !snapshot) return;
    setMessage(null);
    try {
      const toolResult = await app.callServerTool({
        name: "export_design",
        arguments: { project_id: snapshot.project_id, revision_id: snapshot.revision_id, format },
      });
      const output = asRecord(toolResult.structuredContent);
      if (!output || typeof output.artifact_url !== "string") {
        throw new Error(`export_design did not return a ${format.toUpperCase()} URL`);
      }
      await app.openLink({ url: output.artifact_url });
    } catch (toolError) {
      setMessage(toolError instanceof Error ? toolError.message : String(toolError));
    }
  }

  async function toggleFullscreen() {
    if (!app) return;
    try {
      const nextMode = displayMode === "fullscreen" ? "inline" : "fullscreen";
      const result = await app.requestDisplayMode({ mode: nextMode });
      setDisplayMode(result.mode);
    } catch (requestError) {
      setMessage(requestError instanceof Error ? requestError.message : String(requestError));
    }
  }

  if (error) return <div className="empty-state">Viewer connection failed: {error.message}</div>;
  if (!app) return <div className="empty-state">Connecting CADDesk viewer…</div>;
  if (!snapshot) return <div className="empty-state">Waiting for a CAD revision…</div>;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">CADDesk · {snapshot.project_id}</div>
          <h1>Revision {snapshot.revision_id}</h1>
        </div>
        <div className="topbar-actions">
          <span className={validation?.pass ? "status pass" : "status fail"}>
            {validation?.pass ? "✓ Geometry PASS" : "⚠ Geometry check"}
          </span>
          <button className="ghost" onClick={() => void toggleFullscreen()}>
            {displayMode === "fullscreen" ? "Exit fullscreen" : "Fullscreen"}
          </button>
        </div>
      </header>

      <section className="workspace">
        <div className="viewer-card">
          <ModelViewport url={snapshot.viewer.preview_url} />
          <div className="metrics">
            <span>{formatNumber(bbox?.x)} × {formatNumber(bbox?.y)} × {formatNumber(bbox?.z)} mm</span>
            <span>{formatNumber(validation?.volume_mm3)} mm³</span>
            <span>{validation?.solid_count ?? "—"} solid</span>
          </div>
        </div>

        <aside className="panel">
          <section>
            <div className="section-title">Parameters</div>
            <div className="parameter-list">
              {parameterEntries.map(([name, current]) => (
                <div className="parameter-row" key={name}>
                  <label htmlFor={`parameter-${name}`}>{name}</label>
                  <div className="parameter-control">
                    <input
                      id={`parameter-${name}`}
                      inputMode="decimal"
                      value={drafts[name] ?? String(current)}
                      onChange={(event) => setDrafts((previous) => ({ ...previous, [name]: event.target.value }))}
                    />
                    <span>mm</span>
                    <button
                      disabled={busyParameter !== null || Number(drafts[name]) === current}
                      onClick={() => void applyParameter(name)}
                    >
                      {busyParameter === name ? "…" : "Apply"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <div className="section-title">Validation</div>
            <dl className="validation-grid">
              <div><dt>Valid</dt><dd>{validation?.is_valid ? "Yes" : "No"}</dd></div>
              <div><dt>Single solid</dt><dd>{validation?.single_solid ? "Yes" : "No"}</dd></div>
              <div><dt>Parent</dt><dd>{snapshot.parent_revision_id ?? "—"}</dd></div>
              <div><dt>Revision</dt><dd>{snapshot.revision_id}</dd></div>
            </dl>
          </section>

          <section>
            <div className="section-title">Export</div>
            <div className="export-row">
              <button onClick={() => void exportFormat("step")}>STEP</button>
              <button onClick={() => void exportFormat("stl")}>STL</button>
              <button className="primary" onClick={() => void exportFormat("3mf")}>3MF</button>
            </div>
          </section>

          {message ? <div className="message">{message}</div> : null}
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
