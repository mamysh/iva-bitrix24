# Separate plugin settings menu and enforced local policy

Status: implemented in prerelease 0.7.1-rc.1; live Telegram test pending.

## Decision

Keep the menu entirely in this plugin. A server-generated final rich response uses Iva's
existing private Telegram-poll callbacks; each click enters the next model turn. The plugin
has no direct Telegram sender, token, core /menu entry or host patch. Other transports use
native question fallback for confirmation. The authorization boundary remains model-mediated.

One strict object-schema MCP tool navigates fixed sections and prepares/commits settings.
No arbitrary paths, methods, env keys or webhook secrets are accepted. Each change returns
a full before/after preview, random exact confirm/cancel replies, TTL10 minutes and revision.
Offers bind to configured webhook owner/portal, single pending offer; apply/cancel consumes it.

Settings schema1 persists in private PLUGIN_DATA with atomic/fsynced 0600 files. Mode is
read_only or confirmed_write, upload/delete flags independent, employee mode ids/names/work,
email separate and permitted only in work. Existing configured installations without the
installer marker keep prior defaults; new terminal onboarding marks restricted defaults.
Saved settings override env defaults. Missing private data restricts writes and fields;
invalid persisted settings fail closed. No heuristic age detection or automatic deletion.

Settings commits and task actions share task-writes/lock, so a confirmed settings change
cannot race an executing batch. Commit invalidates active task preview before persisting
policy; task schema5 also stores revision. Prepare/apply/each mutation enforce policy;
completed receipts remain readable and prevent replay under any policy.

Structured employee fields are minimized before MCP output, rechecking current policy after
upstream read. Optional SELECT and preview display honor the policy; IDs/ACTIVE remain for
addressing and employee validation. Task/chat text, history values, filenames/documents and
existing Iva memory are not anonymized. Read-only concerns portal mutations, not downloads
or independently confirmed plugin maintenance updates. Webhook scopes and portal object rights
remain separate from local policy.

## Consequences

No core update is required. Menu availability/latency depends on model turns; old cards remain
visible and require fresh offers/revisions to change settings. This is not independent server
proof of a human click. New installs made manually must set restricted marker explicitly;
update preserves the legacy contract and the installer never silently expands saved policy.
Stale locks require operator inspection, never auto-reset. Live UI/portal certification remains
separate from synthetic tests and stdio MCP discovery.
