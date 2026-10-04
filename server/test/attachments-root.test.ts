import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAttachmentsRoot } from "../src/attachments-root.ts";

test("old plugin installations recover default and custom vaults from verified wrapper without rewriting secrets", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "bitrix-root-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data");
  await mkdir(join(data, "plugin-data", "bitrix24-read"), { recursive: true });
  await mkdir(join(root, "current"));
  const wrapper = join(root, "iva");
  await writeFile(wrapper, `IVA_ROOT="${root}"\nIVA_DATA="${data}"\n`);
  const env = { PLUGIN_DATA: join(data, "plugin-data", "bitrix24-read") };
  await writeFile(join(root, ".env"), "OTHER_SETTING=private\n");
  assert.equal(
    await resolveAttachmentsRoot(env, wrapper),
    join(root, "vault", "attachments"),
  );
  await writeFile(join(root, ".env"), "ASSISTANT_VAULT_DIR=custom-vault\n");
  assert.equal(
    await resolveAttachmentsRoot(env, wrapper),
    join(root, "custom-vault", "attachments"),
  );
  await writeFile(join(root, ".env"), `ASSISTANT_VAULT_DIR=${root}/external\n`);
  assert.equal(
    await resolveAttachmentsRoot(env, wrapper),
    join(root, "external", "attachments"),
  );
  await writeFile(wrapper, `IVA_ROOT="${root}"\nIVA_DATA="${root}/other"\n`);
  assert.equal(await resolveAttachmentsRoot(env, wrapper), undefined);
});

test("explicit root wins and unsafe or unverifiable roots never use cwd as a fallback", async () => {
  assert.equal(
    await resolveAttachmentsRoot(
      { BITRIX24_ATTACHMENTS_ROOT: "/tmp/files" },
      "/missing",
    ),
    "/tmp/files",
  );
  for (const path of ["relative", "/tmp/a\nsecret", ""])
    assert.equal(
      await resolveAttachmentsRoot({ BITRIX24_ATTACHMENTS_ROOT: path }),
      undefined,
    );
  assert.equal(
    await resolveAttachmentsRoot({ PLUGIN_DATA: "/tmp/unknown" }, "/missing"),
    undefined,
  );
  assert.equal(await resolveAttachmentsRoot({}), undefined);
});
