import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const pluginModule = "github.com/service-lasso/lasso-caddy/plugin";

const targets = {
  win32: { GOOS: "windows", GOARCH: "amd64", output: "caddy.exe" },
  linux: { GOOS: "linux", GOARCH: "amd64", output: "caddy" },
  darwin: { GOOS: "darwin", GOARCH: "amd64", output: "caddy" },
};

export const caddyVersion = process.env.CADDY_VERSION ?? "2.11.7";

function goHostEnv() {
  const env = { ...process.env };
  delete env.GOOS;
  delete env.GOARCH;
  return env;
}

// ensureXcaddy returns a host-native xcaddy invocation. Because xcaddy drives
// the target `go build` through GOOS/GOARCH, it must itself be a host binary;
// `go run` cannot be used for cross-compilation.
async function ensureXcaddy() {
  const onPath = spawnSync("xcaddy", ["version"], { stdio: "ignore", shell: false });
  if (onPath.status === 0) {
    return "xcaddy";
  }

  const toolsDir = path.join(repoRoot, "output", "tools");
  const exeName = process.platform === "win32" ? "xcaddy.exe" : "xcaddy";
  const xcaddyPath = path.join(toolsDir, exeName);

  if (!existsSync(xcaddyPath)) {
    const go = spawnSync("go", ["version"], { stdio: "ignore", shell: false });
    if (go.status !== 0) {
      throw new Error("xcaddy is not on PATH and no Go toolchain was found; install Go or run 'go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest'.");
    }
    await mkdir(toolsDir, { recursive: true });
    const result = spawnSync(
      "go",
      ["install", "github.com/caddyserver/xcaddy/cmd/xcaddy@latest"],
      { cwd: repoRoot, stdio: "inherit", shell: false, env: { ...goHostEnv(), GOBIN: toolsDir, CGO_ENABLED: "0" } },
    );
    if (result.status !== 0 || !existsSync(xcaddyPath)) {
      throw new Error(`failed to build xcaddy (exit code ${result.status}).`);
    }
  }

  return xcaddyPath;
}

// buildCaddy compiles Caddy with the Service Lasso admin API plugin for the
// requested platform and returns the path to the produced binary.
export async function buildCaddy(platform = process.platform, version = caddyVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}`);
  }

  const pluginDir = path.join(repoRoot, "plugin");
  if (!existsSync(path.join(pluginDir, "go.mod"))) {
    throw new Error(`Plugin module not found at ${pluginDir}`);
  }

  const outputDir = path.join(repoRoot, "output", "caddy-build", platform);
  const outputPath = path.join(outputDir, target.output);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const xcaddy = await ensureXcaddy();
  const args = [
    "build",
    `v${version}`,
    "--with",
    `${pluginModule}=${pluginDir}`,
    "--output",
    outputPath,
  ];

  console.log(`[lasso-caddy] building @caddy ${platform} via xcaddy`);
  const result = spawnSync(xcaddy, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      GOOS: target.GOOS,
      GOARCH: target.GOARCH,
      CGO_ENABLED: "0",
    },
  });

  if (result.status !== 0) {
    throw new Error(`xcaddy build failed with exit code ${result.status}`);
  }
  if (!existsSync(outputPath)) {
    throw new Error(`xcaddy build did not produce ${outputPath}`);
  }

  console.log(`[lasso-caddy] built ${outputPath}`);
  return outputPath;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildCaddy(process.env.TARGET_PLATFORM ?? process.platform, caddyVersion);
}
