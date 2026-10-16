import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCaddy, caddyVersion as defaultVersion } from "./build-caddy.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const caddyVersion = defaultVersion;
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;

const targets = {
  win32: {
    binary: "caddy.exe",
    archiveType: "zip",
    command: ".\\caddy.exe",
  },
  linux: {
    binary: "caddy",
    archiveType: "tar.gz",
    command: "./caddy",
  },
  darwin: {
    binary: "caddy",
    archiveType: "tar.gz",
    command: "./caddy",
  },
};

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

function versionedAssetName(version, platform, archiveType) {
  return `lasso-caddy-${version}-${platform}.${archiveType === "zip" ? "zip" : "tar.gz"}`;
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${JSON.stringify(packageRoot)}, ${JSON.stringify(outputPath)})`,
    ]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

// packageCaddy compiles the Service Lasso @caddy binary (Caddy + the
// admin API plugin) and wraps it in a Service Lasso-compatible platform archive.
export async function packageCaddy(platform = targetPlatform, version = caddyVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}`);
  }

  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Expected Caddy version like "2.11.7", got "${version}".`);
  }

  const outputRoot = path.join(repoRoot, "output", "package", version, platform);
  const packageRoot = path.join(outputRoot, "payload");
  const assetName = versionedAssetName(version, platform, target.archiveType);
  const outputPath = path.join(repoRoot, "dist", assetName);

  const builtBinary = await buildCaddy(platform, version);

  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });

  const packagedBinary = path.join(packageRoot, target.binary);
  await copyFile(builtBinary, packagedBinary);
  if (target.archiveType !== "zip") {
    await chmod(packagedBinary, 0o755);
  }

  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "@caddy",
        caddyVersion: version,
        plugins: ["github.com/service-lasso/lasso-caddy/plugin"],
        packagedBy: "service-lasso/lasso-caddy",
        platform,
        arch: "amd64",
        command: target.command,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-caddy] packaged ${outputPath}`);
  return outputPath;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageCaddy();
}
