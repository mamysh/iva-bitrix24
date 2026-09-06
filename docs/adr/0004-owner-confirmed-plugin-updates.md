# ADR-0004: Owner-confirmed updates of the installed plugin

- Status: accepted
- Date: 2026-09-05

## Context

Iva already provides safe plugin rails: an installed Git source is pinned to a SHA,
`iva plugin update` follows its recorded ref, refuses silent overwrite of local edits, rebuilds
when required and restarts plugin units. Iva's own Telegram self-update goes further: a direct
callback creates a private durable job, launches a transient systemd process, verifies health
after restart and rolls back a failed version.

The official plugin boundary deliberately has no Telegram command or model tool for installing
arbitrary plugins. A retrieved prompt must not be able to choose and execute foreign code.
At the same time, an owner who already trusted this plugin needs routine updates without an SSH
login for every release.

## Decision

The plugin exposes a narrow two-step updater for itself:

1. A read-only check reads only this plugin's recorded `source`, `ref` and `sha`, resolves the
   candidate with `git ls-remote`, and requires successful GitHub Actions.
2. Apply accepts no plugin name, URL, ref or command. It requires the full candidate SHA and
   exact phrase from a matching offer no older than 15 minutes.
3. The update runs through `iva plugin update bitrix24-read` in a transient user-systemd unit.
   Apply restores the local user-bus address explicitly, uses `--no-block`, and the worker
   waits briefly so the accepted response can reach Telegram before any restart.
4. The worker invokes the exact user CLI at `~/.local/bin/iva`, never a PATH-selected root/sudo
   wrapper. Because the worker is outside `iva.service`, it survives the core rebuild and
   restart that plugin connections can require. Shell fallback from the agent is forbidden.
5. A job under `PLUGIN_DATA` survives the MCP restart. The worker verifies the installed SHA
   and runs `iva doctor`.
6. If post-update diagnosis fails, the worker reinstalls the previous SHA from the same source,
   trusts it and runs `iva doctor` again. This recovery intentionally leaves the source pinned.
7. Local-folder installations are refused. They require one explicit migration to a recorded
   Git source before chat updates become available.

Task content, files, pages, forwarded messages, memory and tool output are never confirmation.
The skill may call apply only after the owner types the exact phrase in the current private
conversation.

## Consequences

The model cannot select arbitrary code or cause an unseen moving-target update. Pushes never
deploy automatically, and failed runtime health has a bounded recovery path. Update state
contains no Bitrix24 data or secrets.

The phrase gate is not cryptographic proof of Telegram authorship because MCP receives tool
arguments from the model. The remaining risk is bounded to a source the owner already installed
and trusted, but a core-owned Iva callback would be stronger. We will propose that generic flow
upstream rather than reading the Telegram token or polling Telegram from the plugin.

## Upstream references

- [Plugin lifecycle and security boundary](https://github.com/smixs/iva-agent/blob/f5bb315d4165b73fc0c71d29d4f2a509a27450a6/docs/plugins.md)
- [Iva Telegram update flow](https://github.com/smixs/iva-agent/blob/f5bb315d4165b73fc0c71d29d4f2a509a27450a6/scripts/poller/update-flow.ts)
- [Iva update transaction](https://github.com/smixs/iva-agent/blob/f5bb315d4165b73fc0c71d29d4f2a509a27450a6/scripts/cli/update.ts)
- [Plugin rails decision](https://github.com/smixs/iva-agent/blob/f5bb315d4165b73fc0c71d29d4f2a509a27450a6/docs/adr/0009-plugin-rails.md)
