import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageCaddy } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const caddyVersion = process.env.CADDY_VERSION ?? "2.11.7";

const pluginModule = "github.com/service-lasso/lasso-caddy/plugin";
const testDomain = "e2e.servicelasso.localhost";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

function parseCommandlineArgs(commandline) {
  const args = [];
  let current = "";
  let quote = null;

  const trimmed = commandline.trim();
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index] ?? "";
    const nextChar = trimmed[index + 1];

    if (char === "\\" && quote === "\"" && (nextChar === "\"" || nextChar === "\\")) {
      current += nextChar;
      index += 1;
      continue;
    }

    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }

    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    throw new Error(`Unclosed quote in commandline: ${commandline}`);
  }

  if (current) {
    args.push(current);
  }

  return args;
}

function renderServiceText(value, { serviceRoot, httpPort, adminPort }) {
  return value
    .replaceAll("${SERVICE_ROOT}", serviceRoot)
    .replaceAll("${HTTP_PORT}", String(httpPort))
    .replaceAll("${endpoint.web.bind}", "127.0.0.1")
    .replaceAll("${endpoint.web.port}", String(httpPort))
    .replaceAll("${endpoint.admin.bind}", "127.0.0.1")
    .replaceAll("${endpoint.admin.port}", String(adminPort))
    .replaceAll("${endpoint.web_url.url}", `http://127.0.0.1:${httpPort}/`)
    .replaceAll("${endpoint.health.url}", `http://127.0.0.1:${httpPort}/health`);
}

function httpRequest({ port, hostname = "127.0.0.1", method = "GET", urlPath = "/", host, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname,
        port,
        method,
        path: urlPath,
        agent: false,
        headers: { ...headers, ...(host ? { Host: host } : {}) },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function postJson({ port, urlPath, payload }) {
  return httpRequest({
    port,
    method: "POST",
    urlPath,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function waitForAdmin(port, timeoutMs = 20_000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await httpRequest({ port, urlPath: "/config/" });
      if (response.status === 200) {
        return;
      }
      lastError = new Error(`admin /config/ returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError ?? new Error("Timed out waiting for the Caddy admin API.");
}

async function startStubUpstream(port) {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("stub-ok");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return server;
}

async function stopCaddy(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(10_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

const artifact = await packageCaddy(platform, caddyVersion);
const verifyRoot = path.join(repoRoot, "output", "verify", caddyVersion, platform);
const serviceRoot = path.join(verifyRoot, "service");
const extractRoot = path.join(serviceRoot, ".state", "extracted", "current");
const runtimeRoot = path.join(serviceRoot, "runtime");
const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
const command = serviceManifest.artifact.platforms[platform].command;
const binaryPath = path.resolve(extractRoot, command);
const metadataPath = path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json");

if (serviceManifest.id !== "@caddy" || serviceManifest.version !== caddyVersion) {
  throw new Error(`Unexpected service manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
}

if (!Array.isArray(serviceManifest.depend_on) || !serviceManifest.depend_on.includes("nextcloud")) {
  throw new Error(`Caddy service.json must declare a nextcloud dependency: ${JSON.stringify(serviceManifest.depend_on)}`);
}

if ("healthcheck" in serviceManifest) {
  throw new Error("Caddy service.json must use canonical healthchecks[] instead of singular healthcheck.");
}

if ("ports" in serviceManifest || "urls" in serviceManifest || "portmapping" in serviceManifest) {
  throw new Error("Caddy service.json must author service interfaces through canonical endpoints[] only.");
}

const expectedEndpoints = [
  {
    id: "web",
    kind: "network",
    label: "Web",
    direction: "inbound",
    transport: "tcp",
    protocol: "http",
    bind: "127.0.0.1",
    port: { default: 8080, strategy: "preferred" },
    exposure: "local",
    required: true,
    primary: true,
  },
  {
    id: "admin",
    kind: "network",
    label: "Admin API",
    direction: "inbound",
    transport: "tcp",
    protocol: "http",
    bind: "127.0.0.1",
    port: { default: 2019, strategy: "preferred" },
    exposure: "local",
    required: true,
  },
  {
    id: "web_url",
    kind: "url",
    label: "Web",
    target: "web",
    url: "http://127.0.0.1:${endpoint.web.port}/",
    exposure: "local",
    primary: true,
  },
  {
    id: "health",
    kind: "url",
    label: "Health",
    target: "web",
    url: "http://127.0.0.1:${endpoint.web.port}/health",
    exposure: "local",
    required: true,
  },
];

if (JSON.stringify(serviceManifest.endpoints) !== JSON.stringify(expectedEndpoints)) {
  throw new Error(`Caddy service.json endpoints drifted: ${JSON.stringify(serviceManifest.endpoints)}`);
}

if (
  !Array.isArray(serviceManifest.healthchecks) ||
  serviceManifest.healthchecks.length !== 1 ||
  serviceManifest.healthchecks[0]?.id !== "http-health" ||
  serviceManifest.healthchecks[0].type !== "http" ||
  serviceManifest.healthchecks[0].url !== "http://127.0.0.1:${endpoint.web.port}/health" ||
  serviceManifest.healthchecks[0].expected_status !== 200
) {
  throw new Error(`Caddy service.json must declare canonical HTTP /health readiness: ${JSON.stringify(serviceManifest.healthchecks)}`);
}

for (const [key, expectedValue] of Object.entries({
  CADDY_HTTP_PORT: "${endpoint.web.port}",
  CADDY_URL: "${endpoint.web_url.url}",
  CADDY_ADMIN_PORT: "${endpoint.admin.port}",
  CADDY_ADMIN_ADDR: "${endpoint.admin.bind}:${endpoint.admin.port}",
  CADDY_ROOT: "${SERVICE_ROOT}",
})) {
  if (serviceManifest.env?.[key] !== expectedValue || serviceManifest.globalenv?.[key] !== expectedValue) {
    throw new Error(`Caddy service.json env/globalenv ${key} drifted.`);
  }
}

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
run("tar", ["-xf", artifact, "-C", extractRoot]);

const packageMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
if (
  packageMetadata.serviceId !== "@caddy" ||
  packageMetadata.caddyVersion !== caddyVersion ||
  packageMetadata.packagedBy !== "service-lasso/lasso-caddy" ||
  packageMetadata.platform !== platform ||
  !Array.isArray(packageMetadata.plugins) ||
  !packageMetadata.plugins.includes(pluginModule)
) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(packageMetadata)}`);
}

run(binaryPath, ["version"]);

const httpPort = await reserveLoopbackPort();
const adminPort = await reserveLoopbackPort();
const ingressPort = await reserveLoopbackPort();
const stubPort = await reserveLoopbackPort();
const renderContext = { serviceRoot, httpPort, adminPort };

await mkdir(runtimeRoot, { recursive: true });
await writeFile(
  path.join(runtimeRoot, "caddy.json"),
  renderServiceText(serviceManifest.config.files[0].content, renderContext),
  "utf8",
);

const stub = await startStubUpstream(stubPort);

const commandline = serviceManifest.commandline?.[platform] ?? serviceManifest.commandline?.default;
const args = parseCommandlineArgs(renderServiceText(commandline, renderContext));
const caddy = spawn(binaryPath, args, {
  cwd: serviceRoot,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
caddy.stdout?.on("data", (chunk) => {
  stdout += chunk.toString();
});
caddy.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForAdmin(adminPort);
  console.error("[step] admin ready");

  const beforeRegister = await httpRequest({ port: httpPort, host: testDomain });
  if (beforeRegister.body.includes("stub-ok")) {
    throw new Error("domain was already routed before registration");
  }
  console.error("[step] pre-registration probe ok");

  const register = await postJson({
    port: adminPort,
    urlPath: "/service-lasso/register",
    payload: {
      id: "@e2e-stub",
      domain: testDomain,
      ingress_port: ingressPort,
      type: "http",
      target: `127.0.0.1:${stubPort}`,
    },
  });
  if (register.status !== 200 || !register.body.includes("success")) {
    throw new Error(`register failed: ${register.status} ${register.body}`);
  }
  console.error("[step] register ok");

  const routed = await httpRequest({ port: ingressPort, host: testDomain });
  if (routed.status !== 200 || routed.body.trim() !== "stub-ok") {
    throw new Error(`registered domain did not route to the upstream: ${routed.status} ${JSON.stringify(routed.body)}`);
  }
  console.error("[step] routed to upstream ok");

  const health = await httpRequest({ port: ingressPort, urlPath: "/health" });
  if (health.status !== 200 || health.body.trim() !== "ok") {
    throw new Error(`/health did not respond ok on the ingress listener: ${health.status} ${JSON.stringify(health.body)}`);
  }
  console.error("[step] health ok");

  const unregister = await postJson({
    port: adminPort,
    urlPath: "/service-lasso/unregister",
    payload: { id: "@e2e-stub" },
  });
  if (unregister.status !== 200 || !unregister.body.includes("success")) {
    throw new Error(`unregister failed: ${unregister.status} ${unregister.body}`);
  }

  const afterUnregister = await httpRequest({ port: ingressPort, host: testDomain });
  if (afterUnregister.body.includes("stub-ok")) {
    throw new Error("domain still routed after unregistration");
  }

  console.log("[lasso-caddy] verification passed");
} catch (error) {
  console.error("[lasso-caddy] stdout:");
  console.error(stdout);
  console.error("[lasso-caddy] stderr:");
  console.error(stderr);
  throw error;
} finally {
  await stopCaddy(caddy);
  await new Promise((resolve) => {
    stub.closeAllConnections?.();
    stub.close(() => resolve());
  });
}
