import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const caddyBin =
  process.env.CADDY_BIN ??
  path.join(repoRoot, "output", "caddy-build", platform, platform === "win32" ? "caddy.exe" : "caddy");
const domain = "php-page.servicelasso.localhost";

const phpVersion = "8.3.32";
const phpReleaseTag = "2026.10.20-220191e";

async function resolvePhpCgi() {
  if (process.env.PHP_CGI_BIN) {
    return process.env.PHP_CGI_BIN;
  }
  if (process.platform !== "win32") {
    return null;
  }

  const asset = `lasso-php-${phpVersion}-win32.zip`;
  const cacheRoot = path.join(repoRoot, "output", "php", phpVersion, "win32");
  const archivePath = path.join(cacheRoot, asset);
  const phpCgiPath = path.join(cacheRoot, "php-cgi.exe");

  if (!existsSync(phpCgiPath)) {
    await mkdir(cacheRoot, { recursive: true });
    if (!existsSync(archivePath)) {
      const url = `https://github.com/service-lasso/lasso-php/releases/download/${phpReleaseTag}/${asset}`;
      console.error(`[lasso-caddy] downloading ${url}`);
      const response = await fetch(url, { headers: { "user-agent": "lasso-caddy-fastcgi-e2e" } });
      if (!response.ok) {
        throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
      }
      await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
    }
    const extracted = spawnSync("tar", ["-xf", archivePath, "-C", cacheRoot], { stdio: "inherit", shell: false });
    if (extracted.status !== 0 || !existsSync(phpCgiPath)) {
      throw new Error(`Failed to extract php-cgi from ${archivePath}`);
    }
  }

  return phpCgiPath;
}

function reserve() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function request({ port, method = "GET", urlPath = "/", host, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: urlPath,
        agent: false,
        headers: {
          ...(host ? { Host: host } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const postJson = (port, urlPath, payload) =>
  request({ port, method: "POST", urlPath, body: JSON.stringify(payload) });

async function waitFor(condition, message, timeoutMs = 20_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await wait(250);
  }
  throw new Error(message);
}

if (!existsSync(caddyBin)) {
  throw new Error(`Caddy binary not found at ${caddyBin}. Run scripts/build-caddy.mjs first.`);
}
const phpCgiBin = await resolvePhpCgi();
if (!phpCgiBin) {
  console.log("[lasso-caddy] fastcgi end-to-end verification skipped (set PHP_CGI_BIN on this platform).");
  process.exit(0);
}
if (!existsSync(phpCgiBin)) {
  throw new Error(`php-cgi not found at ${phpCgiBin}.`);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "lasso-caddy-fastcgi-e2e-"));
const docroot = path.join(tempRoot, "www");
await mkdir(docroot, { recursive: true });
await writeFile(path.join(docroot, "index.php"), "<?php header('Content-Type: text/plain'); echo 'hello from php-cgi via caddy';\n", "utf8");

const adminPort = await reserve();
const webPort = await reserve();
const phpPort = await reserve();

const baseConfig = {
  admin: { listen: `127.0.0.1:${adminPort}` },
  apps: {
    http: {
      servers: {
        lasso_ingress: {
          listen: [`127.0.0.1:${webPort}`],
          automatic_https: { disable: true },
          routes: [],
        },
      },
    },
  },
};
const configPath = path.join(tempRoot, "caddy.json");
await writeFile(configPath, `${JSON.stringify(baseConfig, null, 2)}\n`, "utf8");

const caddy = spawn(caddyBin, ["run", "--config", configPath], {
  cwd: tempRoot,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const php = spawn(phpCgiBin, ["-b", `127.0.0.1:${phpPort}`], {
  cwd: docroot,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let caddyOut = "";
let caddyErr = "";
caddy.stdout?.on("data", (chunk) => (caddyOut += chunk.toString()));
caddy.stderr?.on("data", (chunk) => (caddyErr += chunk.toString()));

async function adminReady() {
  if (caddy.exitCode !== null) {
    throw new Error(`Caddy exited early (${caddy.exitCode}). stdout=${caddyOut} stderr=${caddyErr}`);
  }
  try {
    return (await request({ port: adminPort, urlPath: "/config/" })).status === 200;
  } catch {
    return false;
  }
}

async function phpReady() {
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: phpPort });
      socket.setTimeout(1000, () => {
        socket.destroy();
        reject(new Error("timeout"));
      });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", reject);
    });
    return true;
  } catch {
    return false;
  }
}

try {
  await waitFor(adminReady, "Caddy admin did not become ready.");
  await waitFor(phpReady, `php-cgi did not listen on ${phpPort}.`);
  console.error("[step] caddy admin + php-cgi ready");

  const register = await postJson(adminPort, "/service-lasso/register", {
    id: "php-page",
    domain,
    ingress_port: webPort,
    type: "fastcgi",
    target: `127.0.0.1:${phpPort}`,
    root: docroot,
  });
  if (register.status !== 200) {
    throw new Error(`register failed: ${register.status} ${register.body}`);
  }
  console.error("[step] registered fastcgi route");

  const routed = await request({ port: webPort, urlPath: "/index.php", host: domain });
  if (routed.status !== 200 || routed.body.trim() !== "hello from php-cgi via caddy") {
    throw new Error(`fastcgi route did not return the PHP page: ${routed.status} ${JSON.stringify(routed.body)}`);
  }
  console.error("[step] caddy -> php-cgi -> php page ok");

  const unregister = await postJson(adminPort, "/service-lasso/unregister", { id: "php-page" });
  if (unregister.status !== 200) {
    throw new Error(`unregister failed: ${unregister.status} ${unregister.body}`);
  }
  const after = await request({ port: webPort, urlPath: "/index.php", host: domain });
  if (after.body.includes("hello from php-cgi via caddy")) {
    throw new Error("route still active after unregister");
  }

  console.log("[lasso-caddy] fastcgi end-to-end verification passed");
} catch (error) {
  console.error("[lasso-caddy] caddy stdout:", caddyOut);
  console.error("[lasso-caddy] caddy stderr:", caddyErr);
  console.error("[lasso-caddy] caddy exitCode:", caddy.exitCode);
  throw error;
} finally {
  for (const child of [caddy, php]) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  await wait(500);
  await rm(tempRoot, { recursive: true, force: true });
}
