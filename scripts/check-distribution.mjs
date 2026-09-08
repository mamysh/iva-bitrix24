import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const root = resolve(".");
const pluginRoot = resolve("plugin");
const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const [packageJson, packageLock, manifest, marketplace, changelog] =
  await Promise.all([
    json("package.json"),
    json("package-lock.json"),
    json("plugin/plugin.json"),
    json(".agents/plugins/marketplace.json"),
    readFile("CHANGELOG.md", "utf8"),
  ]);

assert.match(packageJson.version, semver, "package version must be strict SemVer");
assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.packages?.[""]?.version, packageJson.version);
assert.equal(manifest.version, packageJson.version);
assert.equal(packageJson.license, "MIT");
assert.equal(manifest.name, "bitrix24-read");
assert.match(
  changelog,
  new RegExp(`^## ${packageJson.version.replaceAll(".", "\\.")} — `, "mu"),
  "CHANGELOG must contain the published version",
);

assert.equal(marketplace.name, "iva-bitrix24");
assert.equal(marketplace.plugins?.length, 1);
const offer = marketplace.plugins[0];
assert.equal(offer.name, manifest.name);
assert.equal(offer.description, manifest.description);
assert.deepEqual(offer.source, {
  source: "git-subdir",
  url: "https://github.com/mamysh/iva-bitrix24.git",
  path: "plugin",
  ref: "stable",
});

let count = 0;
let bytes = 0;
let deepest = 0;
const queue = [pluginRoot];
while (queue.length > 0) {
  const directory = queue.pop();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `${relative(root, path)} is a symlink`);
    if (info.isDirectory()) {
      queue.push(path);
      continue;
    }
    assert.equal(info.isFile(), true, `${relative(root, path)} is not a regular file`);
    count += 1;
    bytes += info.size;
    deepest = Math.max(deepest, relative(pluginRoot, path).split(sep).length);
  }
}

assert.ok(count <= 2_000, `plugin has ${count} files; Iva limit is 2000`);
assert.ok(bytes <= 50 * 1024 * 1024, `plugin has ${bytes} bytes; Iva limit is 50 MiB`);
assert.ok(deepest <= 16, `plugin depth is ${deepest}; Iva limit is 16`);

console.log(
  `distribution ok: v${packageJson.version}, marketplace ${marketplace.name}, ${count} plugin files, ${bytes} bytes, depth ${deepest}`,
);

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function changed(args) {
  try {
    execFileSync("git", ["diff", "--quiet", ...args, "--", "plugin"], {
      stdio: "ignore",
    });
    return false;
  } catch (error) {
    if (error?.status === 1) return true;
    throw error;
  }
}

let comparison = null;
if (changed([])) {
  comparison = { label: "working tree", version: JSON.parse(git(["show", "HEAD:plugin/plugin.json"])).version };
} else {
  try {
    git(["rev-parse", "--verify", "HEAD^"]);
    if (changed(["HEAD^", "HEAD"])) {
      comparison = { label: "parent commit", version: JSON.parse(git(["show", "HEAD^:plugin/plugin.json"])).version };
    }
  } catch (error) {
    if (!String(error?.stderr ?? error).includes("unknown revision")) throw error;
  }
}
if (comparison !== null) {
  assert.notEqual(
    manifest.version,
    comparison.version,
    `plugin content changed from ${comparison.label} without a version change`,
  );
}
