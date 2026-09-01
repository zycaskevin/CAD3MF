# M0-D named-tunnel deployment

This deployment keeps the CAD3MF MCP origin private on host loopback and exposes it only through a Cloudflare Named Tunnel.

## Boundaries

- The MCP origin binds to `127.0.0.1:${CAD3MF_ORIGIN_PORT}`.
- `/mcp` keeps the configured Host and Origin allowlist.
- Immutable `/artifacts/<project>/<revision>/<kind>` downloads require a valid Host, allow opaque or non-allowlisted widget origins, and return `Access-Control-Allow-Origin: *`.
- Cloudflare credentials and the host-specific environment file stay outside the repository with mode `0600`.
- Both containers use `restart: unless-stopped`, a read-only root filesystem, dropped capabilities, and `no-new-privileges`.

## Required external files

Create a host environment file from `deploy/m0d.env.example`. The persistent Cloudflare home must contain `.cloudflared/cad3mf-m0d.yml` and the credential JSON referenced by that file.

The tunnel ingress must route the selected hostname to the private origin and finish with a fail-closed catch-all:

```yaml
ingress:
  - hostname: cad3mf.example.com
    service: http://127.0.0.1:18787
  - service: http_status:404
```

## Start and inspect

```sh
docker compose --env-file /path/to/cad3mf-m0d.env \
  -f deploy/m0d.compose.yml up -d

docker compose --env-file /path/to/cad3mf-m0d.env \
  -f deploy/m0d.compose.yml ps
```

## Acceptance

1. Both services are running and the MCP healthcheck is healthy.
2. An allowlisted ChatGPT Origin can initialize `/mcp` through HTTPS.
3. A non-allowlisted Origin receives `403` from `/mcp`.
4. The r2 preview requested with `Origin: null` returns `200`, `model/gltf-binary`, `Access-Control-Allow-Origin: *`, and matches the stored GLB hash.
5. The r2 3MF requested from a non-allowlisted sandbox Origin returns `200`, `model/3mf`, `Access-Control-Allow-Origin: *`, and matches the stored 3MF hash.
6. Restart both services and repeat the health, MCP, and artifact checks.

Do not delete the prior route until the new hostname passes the complete acceptance flow. Rollback stops the two new services and restores the prior MCP process without modifying the CAD3MF data directory.
