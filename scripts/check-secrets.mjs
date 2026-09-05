import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

function git(args, encoding = "utf8") {
  return execFileSync("git", args, {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

const rules = [
  {
    name: "Bitrix24 webhook URL with a concrete user and token",
    pattern:
      /https:\/\/[^\s"'<>]+\/rest\/[1-9][0-9]*\/[A-Za-z0-9_-]{8,}/giu,
  },
  {
    name: "private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu,
  },
  {
    name: "AWS access key",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  },
  {
    name: "GitHub token",
    pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/gu,
  },
  {
    name: "OpenAI API key",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/gu,
  },
  {
    name: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  },
  {
    name: "Google API key",
    pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/gu,
  },
  {
    name: "JWT",
    pattern:
      /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu,
  },
];

function isPlaceholder(value) {
  return /(?:example|invalid|placeholder|dummy|synthetic|WEBHOOK_SECRET|USER_ID)/iu.test(
    value,
  );
}

const publicBitrixDocumentationHosts = new Set([
  "helpdesk.bitrix24.com",
  "apidocs.bitrix24.com",
]);

function inspect(label, source, findings) {
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      if (!isPlaceholder(match[0])) findings.add(`${label}: ${rule.name}`);
    }
  }

  for (const match of source.matchAll(/https?:\/\/[^\s"'<>`)\\]+/giu)) {
    let url;
    try {
      url = new URL(match[0].replace(/[.,;:]$/u, ""));
    } catch {
      continue;
    }
    if (
      /bitrix24/iu.test(url.hostname) &&
      !isPlaceholder(url.hostname) &&
      !publicBitrixDocumentationHosts.has(url.hostname.toLowerCase())
    ) {
      findings.add(`${label}: non-example Bitrix24 hostname`);
    }
    if (url.username || url.password) {
      if (!isPlaceholder(match[0]))
        findings.add(`${label}: URL with embedded credentials`);
    }
  }

  if (!label.endsWith("package-lock.json") && !label.endsWith("server.mjs")) {
    const emailPattern =
      /\b[A-Z0-9._%+-]+@(?:[A-Z0-9.-]+\.[A-Z]{2,}|[A-Z0-9.-]+\.local)\b/giu;
    for (const match of source.matchAll(emailPattern)) {
      if (!isPlaceholder(match[0]) && !/users\.noreply\.github\.com$/iu.test(match[0]))
        findings.add(`${label}: non-example email address`);
    }
    if (/\/(?:Users|home)\/[A-Za-z0-9._-]+\//u.test(source)) {
      findings.add(`${label}: absolute user home path`);
    }
  }
}

const findings = new Set();
const workingFiles = git(["ls-files", "-co", "--exclude-standard", "-z"])
  .split("\0")
  .filter(Boolean);

for (const file of workingFiles) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch {
    continue;
  }
  if (source.includes("\0")) continue;
  inspect(file, source, findings);
}

const seenObjects = new Set();
const historyObjects = git(["rev-list", "--objects", "--all"])
  .split("\n")
  .filter(Boolean);

for (const entry of historyObjects) {
  const separator = entry.indexOf(" ");
  if (separator < 0) continue;
  const object = entry.slice(0, separator);
  const path = entry.slice(separator + 1);
  if (seenObjects.has(object)) continue;
  seenObjects.add(object);
  if (git(["cat-file", "-t", object]).trim() !== "blob") continue;
  const size = Number(git(["cat-file", "-s", object]).trim());
  if (!Number.isFinite(size) || size > 5_000_000) continue;
  const source = git(["cat-file", "blob", object], "buffer");
  if (source.includes(0)) continue;
  inspect(`history:${path}@${object.slice(0, 12)}`, source.toString("utf8"), findings);
}

if (findings.size > 0) {
  throw new Error(`possible secrets or private data found:\n${[...findings].join("\n")}`);
}

console.log(
  `secret and privacy patterns absent in ${workingFiles.length} files and ${seenObjects.size} historical objects`,
);
