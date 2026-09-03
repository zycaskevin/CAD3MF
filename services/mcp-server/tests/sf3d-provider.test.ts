import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { Sf3dHttpMeshProvider } from "../src/sf3d-provider.js";
import type { MeshProviderContext } from "../src/mesh-types.js";

function glbFixture(): Buffer {
  const glb = Buffer.alloc(12);
  glb.write("glTF", 0, "ascii");
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(12, 8);
  return glb;
}

function statsHeader(): string {
  return Buffer.from(
    JSON.stringify({
      vertex_count: 1234,
      triangle_count: 2345,
      bounding_box_mm: {
        min: { x: -20, y: -30, z: 0 },
        max: { x: 20, y: 30, z: 120 },
      },
      topology: {
        watertight: false,
        manifold: null,
        self_intersections_detected: null,
        notes: ["fixture"],
      },
    }),
  ).toString("base64url");
}

function context(withTarget = true): MeshProviderContext {
  return {
    request: {
      projectId: "sf3d-test",
      turnaroundRevisionId: "turnaround-r1",
      assetKind: "figurine",
      qualityTier: "standard",
      outputFormat: "glb",
      texturePolicy: "pbr",
      targetDimensions: withTarget
        ? [{ name: "target_height", value: 120, unit: "mm" }]
        : [],
    },
    turnaround: {},
    views: [
      {
        view: "front",
        sha256: "a".repeat(64),
        mediaType: "image/png",
        bytes: new Uint8Array([1, 2, 3]),
      },
      {
        view: "three_quarter_front",
        sha256: "b".repeat(64),
        mediaType: "image/png",
        bytes: new Uint8Array([4, 5, 6]),
      },
    ],
  };
}

test("SF3D adapter uses three-quarter view and sends metric scaling contract", async () => {
  let requestBody = "";
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requestBody = Buffer.concat(chunks).toString("latin1");
      const glb = glbFixture();
      response.writeHead(200, {
        "content-type": "model/gltf-binary",
        "content-length": String(glb.byteLength),
        "x-cad3mf-used-view": "three_quarter_front",
        "x-cad3mf-provider": "stable-fast-3d",
        "x-cad3mf-mesh-stats": statsHeader(),
      });
      response.end(glb);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === "object");

  try {
    const provider = new Sf3dHttpMeshProvider({
      baseUrl: `http://127.0.0.1:${address.port}`,
      timeoutMs: 5000,
    });
    assert.equal(provider.requiresTargetDimension, true);
    const output = await provider.generate(context());
    assert.deepEqual(output.consumedViews, ["three_quarter_front"]);
    assert.equal(output.format, "glb");
    assert.equal(output.vertexCount, 1234);
    assert.equal(output.boundingBoxMm.max.z, 120);
    assert.match(requestBody, /name="view_name"\r\n\r\nthree_quarter_front/);
    assert.match(requestBody, /name="scale_policy"\r\n\r\nlongest_extent/);
    assert.match(requestBody, /name="scale_dimension_name"\r\n\r\ntarget_height/);
    assert.match(requestBody, /name="target_extent_mm"\r\n\r\n120/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("SF3D adapter refuses generation without metric scale reference", async () => {
  const provider = new Sf3dHttpMeshProvider({
    baseUrl: "http://127.0.0.1:9",
    timeoutMs: 1000,
  });
  await assert.rejects(
    provider.generate(context(false)),
    /MESH_SCALE_REFERENCE_REQUIRED/,
  );
});
