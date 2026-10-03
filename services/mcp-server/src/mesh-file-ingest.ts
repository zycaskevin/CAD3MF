import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { MeshFormat } from "./mesh-types.js";

const MAX_MESH_BYTES = 50 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export type ReferenceMeshFormat = Extract<MeshFormat, "glb" | "obj">;

export interface ReferenceMeshFileParam {
  downloadUrl: string;
  fileId: string;
  format: ReferenceMeshFormat;
  mimeType?: string | null;
  fileName?: string | null;
}

export interface DownloadedReferenceMesh {
  bytes: Uint8Array;
  sha256: string;
  format: ReferenceMeshFormat;
  mediaType: "model/gltf-binary" | "model/obj";
  fileId: string;
  fileName: string | null;
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith("ff")) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) === 4 ? privateIpv4(mapped) : true;
  }
  return false;
}

export function isPrivateMeshNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateIpv4(address);
  if (family === 6) return privateIpv6(address);
  return true;
}

async function validateRemoteUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("reference mesh download URL must use HTTPS");
  if (url.username || url.password) {
    throw new Error("reference mesh download URL must not contain credentials");
  }
  if (url.port && url.port !== "443") {
    throw new Error("reference mesh download URL must use the standard HTTPS port");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("reference mesh download URL resolves to a forbidden host");
  }

  if (isIP(hostname)) {
    if (isPrivateMeshNetworkAddress(hostname)) {
      throw new Error("reference mesh download URL resolves to a private network address");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("reference mesh download host did not resolve");
  if (addresses.some(({ address }) => isPrivateMeshNetworkAddress(address))) {
    throw new Error("reference mesh download host resolves to a private network address");
  }
}

function validateMeshContent(format: ReferenceMeshFormat, bytes: Uint8Array): void {
  if (bytes.byteLength === 0) throw new Error("reference mesh is empty");
  if (format === "glb") {
    if (bytes.byteLength < 12 || new TextDecoder().decode(bytes.slice(0, 4)) !== "glTF") {
      throw new Error("reference mesh content is not a valid GLB header");
    }
    return;
  }

  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 4096)));
  if (!/(^|\n)\s*(v|o|g|f)\s+/.test(prefix)) {
    throw new Error("reference mesh content is not recognizable OBJ text");
  }
}

function canonicalMediaType(format: ReferenceMeshFormat): DownloadedReferenceMesh["mediaType"] {
  return format === "glb" ? "model/gltf-binary" : "model/obj";
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0 || length > MAX_MESH_BYTES) {
      throw new Error(`reference mesh exceeds ${MAX_MESH_BYTES} byte limit`);
    }
  }
  if (!response.body) throw new Error("reference mesh response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_MESH_BYTES) {
        throw new Error(`reference mesh exceeds ${MAX_MESH_BYTES} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function downloadReferenceMeshFile(
  input: ReferenceMeshFileParam,
): Promise<DownloadedReferenceMesh> {
  if (!input.fileId || input.fileId.length > 512) throw new Error("invalid reference mesh file_id");

  let current = new URL(input.downloadUrl);
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await validateRemoteUrl(current);
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        accept:
          input.format === "glb"
            ? "model/gltf-binary,application/octet-stream"
            : "model/obj,text/plain,application/octet-stream",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("reference mesh redirect is missing Location header");
      if (redirectCount === MAX_REDIRECTS) {
        throw new Error("reference mesh redirect limit exceeded");
      }
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) {
      throw new Error(`reference mesh download failed with HTTP ${response.status}`);
    }

    const bytes = await readBoundedBody(response);
    validateMeshContent(input.format, bytes);
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      format: input.format,
      mediaType: canonicalMediaType(input.format),
      fileId: input.fileId,
      fileName: input.fileName ?? null,
    };
  }

  throw new Error("reference mesh redirect limit exceeded");
}
