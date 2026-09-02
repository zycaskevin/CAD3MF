import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import type { VisualMediaType, VisualSourceRole } from "./visual-types.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface ChatGptFileParam {
  downloadUrl: string;
  fileId: string;
  mimeType?: string | null;
  fileName?: string | null;
  role: VisualSourceRole;
}

export interface DownloadedVisualFile {
  bytes: Uint8Array;
  mediaType: VisualMediaType;
  fileId: string;
  fileName: string | null;
  role: VisualSourceRole;
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

export function isPrivateNetworkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateIpv4(address);
  if (family === 6) return privateIpv6(address);
  return true;
}

async function validateRemoteUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Error("visual file download URL must use HTTPS");
  if (url.username || url.password) throw new Error("visual file download URL must not contain credentials");
  if (url.port && url.port !== "443") throw new Error("visual file download URL must use the standard HTTPS port");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("visual file download URL resolves to a forbidden host");
  }

  if (isIP(hostname)) {
    if (isPrivateNetworkAddress(hostname)) {
      throw new Error("visual file download URL resolves to a private network address");
    }
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("visual file download host did not resolve");
  if (addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new Error("visual file download host resolves to a private network address");
  }
}

function detectVisualMediaType(bytes: Uint8Array): VisualMediaType {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  throw new Error("visual file content is not a supported PNG, JPEG, or WebP image");
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isFinite(length) || length < 0 || length > MAX_IMAGE_BYTES) {
      throw new Error(`visual file exceeds ${MAX_IMAGE_BYTES} byte limit`);
    }
  }
  if (!response.body) throw new Error("visual file response has no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        throw new Error(`visual file exceeds ${MAX_IMAGE_BYTES} byte limit`);
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

export async function downloadChatGptVisualFile(
  input: ChatGptFileParam,
): Promise<DownloadedVisualFile> {
  if (!input.fileId || input.fileId.length > 512) throw new Error("invalid ChatGPT file_id");
  let current = new URL(input.downloadUrl);

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    await validateRemoteUrl(current);
    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "image/png,image/jpeg,image/webp" },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("visual file redirect is missing Location header");
      if (redirectCount === MAX_REDIRECTS) throw new Error("visual file redirect limit exceeded");
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) throw new Error(`visual file download failed with HTTP ${response.status}`);
    const bytes = await readBoundedBody(response);
    const mediaType = detectVisualMediaType(bytes);
    if (input.mimeType && input.mimeType !== mediaType) {
      throw new Error(`visual file MIME mismatch: declared ${input.mimeType}, detected ${mediaType}`);
    }
    return {
      bytes,
      mediaType,
      fileId: input.fileId,
      fileName: input.fileName ?? null,
      role: input.role,
    };
  }

  throw new Error("visual file redirect limit exceeded");
}
