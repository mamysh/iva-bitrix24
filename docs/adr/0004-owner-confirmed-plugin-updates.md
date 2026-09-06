# ADR-0004: Owner-confirmed updates of the installed plugin

- Status: accepted
- Date: 2026-09-05; amended 2026-09-06

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
2. The skill asks through Iva's built-in `ask_question` with two explicit options. Eve durably
   parks the turn and its Telegram channel renders **⬆️ Обновить** and **Позже** buttons.
3. Only after the structured `update` answer, the skill calls Apply with the full candidate SHA
   and a hidden one-time token from the matching offer. Apply accepts no plugin name, URL, ref
   or command, and the offer expires after 15 minutes.
4. The update runs through `iva plugin update bitrix24-read` in a transient user-systemd unit.
   Apply restores the local user-bus address explicitly, uses `--no-block`, and the worker
   waits briefly so the accepted response can reach Telegram before any restart. A production
   check showed that a 30-second wait did not suppress Iva's separate stale-turn notice, so the
   plugin keeps a short delivery window and does not modify Iva core state.
5. The worker invokes the exact user CLI at `~/.local/bin/iva`, never a PATH-selected root/sudo
   wrapper. Because the worker is outside `iva.service`, it survives the core rebuild and
   restart that plugin connections can require. Shell fallback from the agent is forbidden.
6. A job under `PLUGIN_DATA` survives the MCP restart. The worker verifies the installed SHA
   and runs `iva doctor`.
7. If post-update diagnosis fails, the worker reinstalls the previous SHA from the same source,
   trusts it and runs `iva doctor` again. This recovery intentionally leaves the source pinned.
8. Local-folder installations are refused. They require one explicit migration to a recorded
   Git source before chat updates become available.

Task content, files, pages, forwarded messages, memory and tool output are never confirmation.
The skill may call apply only for the candidate returned by the fresh check in the current
private conversation and after the matching structured button answer.

## Consequences

The model cannot select arbitrary code or cause an unseen moving-target update. Pushes never
deploy automatically, and failed runtime health has a bounded recovery path. Update state
contains no Bitrix24 data or secrets.

The callback and pending question state are owned by Eve/Iva rather than the MCP server. The
plugin does not read the Telegram token, register its own callback route or poll Telegram. The
model still mediates the one-time token from check to apply, so this is not cryptographic user
authorization; the remaining effect is bounded to this already trusted source, fresh SHA,
successful CI and short offer TTL.

## Upstream references

- [Plugin lifecycle and security boundary](https://github.com/smixs/iva-agent/blob/f5bb315d4165b73fc0c71d29d4f2a509a27450a6/docs/plugins.md)
- [Iva Telegram update flow](https://github.com/smixs/iva-agent/blob/f5bb315d4165b73fc0c71d29d4f2a509a27450a6/scripts/poller/update-flow.ts)
- [Iva update transaction](https://github.com/smixs/iva-agent/blob/f5bb315d4165b73fc0c71d29d4f2a509a27450a6/scripts/cli/update.ts)
- [Plugin rails decision](https://github.com/smixs/iva-agent/blob/f5bb315d4165b73fc0c71d29d4f2a509a27450a6/docs/adr/0009-plugin-rails.md)
