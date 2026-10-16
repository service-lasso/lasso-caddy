# Changelog

## 0.1.0
- initialize `lasso-caddy` as the release-backed core `@caddy` service repo
- add the Service Lasso admin API plugin (`admin.api.lasso`) with `POST /service-lasso/register` and `POST /service-lasso/unregister`
- support simplified FastCGI and HTTP upstream registration with dynamically allocated `ingress_port`
- mutate the managed `lasso_ingress` server listener and host-matched routes, then hot-reload via `caddy.Load` (fail-closed on rejection)
- build the custom Caddy binary with `xcaddy` (`scripts/build-caddy.mjs`) and package it per platform (`scripts/package.mjs`)
- declare the `nextcloud` dependency and the `web` / `admin` endpoints with `CADDY_*` outputs
- add `scripts/verify.mjs` exercising register, routing, `/health`, and unregister end-to-end
- add the multi-OS release workflow that publishes `lasso-caddy-2.11.7-*` archives
