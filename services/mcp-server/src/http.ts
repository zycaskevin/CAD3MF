import { createServer, type IncomingMessage } from "node:http";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { CadDeskRuntime, type ArtifactKind } from "./runtime.js";
import { createCadDeskServer } from "./server.js";

const host = process.env.CAD3MF_HOST ?? "127.0.0.1";
const port = Number(process.env.CAD3MF_PORT ?? "8787");
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error("CAD3MF_PORT must be an integer between 0 and 65535");
}

const publicBaseUrl = process.env.CAD3MF_PUBLIC_BASE_URL ?? `http://${host}:${port}`;
const publicUrl = new URL(publicBaseUrl);
const runtime = new CadDeskRuntime();
const mcpHandler = createMcpHandler(() => createCadDeskServer(runtime, { publicBaseUrl }));
const nodeMcpHandler = toNodeHandler(mcpHandler, {
  onerror: (error) => console.error("MCP HTTP adapter error", error),
});

function commaList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const allowedHosts = new Set([
  publicUrl.host.toLowerCase(),
  `${host}:${port}`.toLowerCase(),
  `127.0.0.1:${port}`,
  `localhost:${port}`,
  ...commaList(process.env.CAD3MF_ALLOWED_HOSTS).map((value) => value.toLowerCase()),
]);
const allowedOrigins = new Set([
  publicUrl.origin,
  `http://127.0.0.1:${port}`,
  `http://localhost:${port}`,
  ...commaList(process.env.CAD3MF_ALLOWED_ORIGINS),
]);

function requestAllowed(headers: { host?: string; origin?: string }): boolean {
  const requestHost = headers.host?.toLowerCase();
  if (!requestHost || !allowedHosts.has(requestHost)) return false;
  if (headers.origin && !allowedOrigins.has(headers.origin)) return false;
  return true;
}

function hasMethod(request: IncomingMessage): request is IncomingMessage & { method: string } {
  return typeof request.method === "string" && request.method.length > 0;
}

function artifactContentType(kind: ArtifactKind, path: string): string {
  if (kind === "preview") {
    return extname(path).toLowerCase() === ".glb" ? "model/gltf-binary" : "application/json";
  }
  if (kind === "step") return "model/step";
  if (kind === "stl") return "model/stl";
  return "model/3mf";
}

function isArtifactKind(value: string): value is ArtifactKind {
  return value === "preview" || value === "step" || value === "stl" || value === "3mf";
}

const httpServer = createServer((req, res) => {
  const requestUrl = new URL(req.url ?? "/", publicBaseUrl);

  if (requestUrl.pathname === "/healthz" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "cad3mf", mcp: "/mcp" }));
    return;
  }

  if (
    !requestAllowed({
      ...(req.headers.host === undefined ? {} : { host: req.headers.host }),
      ...(req.headers.origin === undefined ? {} : { origin: req.headers.origin }),
    })
  ) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("Forbidden\n");
    return;
  }

  if (requestUrl.pathname === "/mcp") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": req.headers.origin ?? "*",
        "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
        "access-control-allow-headers":
          "content-type,mcp-protocol-version,mcp-session-id,last-event-id",
      });
      res.end();
      return;
    }
    if (!hasMethod(req)) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      res.end("Missing HTTP method\n");
      return;
    }
    void nodeMcpHandler(req, res);
    return;
  }

  if (req.method === "GET" && requestUrl.pathname.startsWith("/artifacts/")) {
    const parts = requestUrl.pathname.split("/").filter(Boolean);
    if (parts.length !== 4) {
      res.writeHead(404).end();
      return;
    }
    const [, rawProjectId, rawRevisionId, rawKind] = parts;
    if (!rawProjectId || !rawRevisionId || !rawKind || !isArtifactKind(rawKind)) {
      res.writeHead(404).end();
      return;
    }

    try {
      const projectId = decodeURIComponent(rawProjectId);
      const revisionId = decodeURIComponent(rawRevisionId);
      const artifact = runtime.artifactLocation(projectId, rawKind, revisionId);
      const body = readFileSync(artifact.path);
      const headers: Record<string, string> = {
        "access-control-allow-origin": "*",
        "cache-control": "private, max-age=31536000, immutable",
        "content-length": String(body.byteLength),
        "content-type": artifactContentType(rawKind, artifact.path),
        "x-content-type-options": "nosniff",
      };
      if (rawKind !== "preview") {
        const suffix = rawKind === "3mf" ? "3mf" : rawKind;
        headers["content-disposition"] =
          `attachment; filename="${artifact.projectId}-${artifact.revisionId}.${suffix}"`;
      }
      res.writeHead(200, headers);
      res.end(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: message }));
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found\n");
});

httpServer.listen(port, host, () => {
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  console.error(
    `CAD3MF HTTP server listening on ${host}:${boundPort}; MCP endpoint ${publicBaseUrl}/mcp`,
  );
});

async function shutdown(): Promise<void> {
  httpServer.close();
  await mcpHandler.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
