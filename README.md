# lasso-caddy

`lasso-caddy` is the canonical Service Lasso service repo for the core `@caddy` service. It compiles a custom Caddy build (Caddy + the Service Lasso admin API plugin) and publishes it as a release-backed Service Lasso service.

In the baseline routing stack it runs as a foreground **HTTP-to-FastCGI protocol translator sidecar** with a **Service Lasso admin API**:

```text
Traefik  --HTTP-->  Caddy  --FastCGI-->  Nextcloud (php-cgi / php-fpm)
                       ^
        Service Lasso --|  POST /service-lasso/register  (127.0.0.1:2019)
```

This resolves the Traefik FastCGI proxy limitation while keeping `lasso-nextcloud` as a single managed process. Caddy terminates plain HTTP from Traefik and translates it into the binary FastCGI protocol expected by the Nextcloud PHP backend.

## Custom build

The binary is not stock Caddy. `scripts/build-caddy.mjs` uses [`xcaddy`](https://github.com/caddyserver/xcaddy) to compile Caddy with the in-repo plugin:

```text
github.com/caddyserver/caddy/v2   +   github.com/service-lasso/lasso-caddy/plugin
```

A Go toolchain is required. If `xcaddy` is not on `PATH` it is installed into `output/tools` automatically.

## Service Lasso admin API

The plugin registers the `admin.api.lasso` module and mounts two endpoints on the Caddy admin listener (loopback only):

### `POST /service-lasso/register`

```json
{
  "id": "@nextcloud",
  "domain": "nextcloud.servicelasso.localhost",
  "ingress_port": 50123,
  "type": "fastcgi",
  "target": "127.0.0.1:61124",
  "root": "/absolute/path/to/lasso-nextcloud/src"
}
```

`type` is `fastcgi` (requires `root`) or `http`. Registration:

- points the managed server (`lasso_ingress`) listener at the dynamically allocated `ingress_port` (bound to `127.0.0.1` so the OS does not prompt for a host firewall exception);
- injects or replaces the route keyed by `@id` = `lasso:<id>`, matched on `domain`, with the upstream set to `target`;
- disables automatic HTTPS on the server so no certificates are provisioned;
- hot-reloads the running config via `caddy.Load`, so there is zero downtime.

Re-registering an existing `id` updates that route in place without duplicating the route array.

### `POST /service-lasso/unregister`

```json
{ "id": "@nextcloud" }
```

Removes the route for `id`. Removing an unknown id is a no-op.

Both endpoints return `{"status":"success"}` on success. Validation failures return `400`, mutation failures `422`, and a rejected `caddy.Load` returns `500` while leaving the previous routing state untouched (fail-closed).

## Service Lasso contract

The service manifest declares:

- service id `@caddy`
- a `web` HTTP endpoint (loopback, preferred port `8080`) that Traefik routes into
- an `admin` HTTP endpoint (loopback, preferred port `2019`) for the admin API
- a manifest-owned `runtime/caddy.json` base config generated during the `config` action
- a `/health` readiness responder
- `CADDY_HTTP_PORT`, `CADDY_URL`, `CADDY_ADMIN_PORT`, `CADDY_ADMIN_ADDR`, and `CADDY_ROOT` outputs

## Release assets

Each release publishes Caddy `2.11.7` archives built from this repo:

- `lasso-caddy-2.11.7-win32.zip`
- `lasso-caddy-2.11.7-linux.tar.gz`
- `lasso-caddy-2.11.7-darwin.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

Each archive contains the custom Caddy binary plus a `SERVICE-LASSO-PACKAGE.json` metadata file recording the Caddy version and the compiled plugin.

## Local verification

```powershell
npm test
```

This builds the custom binary, packages and extracts it, runs `caddy version`, starts Caddy against a temporary base config, then exercises the admin API end-to-end: registers an HTTP upstream, confirms the domain routes to it, checks `/health`, unregisters, and confirms the route is gone.

## Packaging

```powershell
npm run package
```

Override the target platform or upstream Caddy version when needed:

```powershell
$env:TARGET_PLATFORM = "linux"; $env:CADDY_VERSION = "2.11.7"; npm run package
```
