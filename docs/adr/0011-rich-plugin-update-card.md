# Rich plugin update card

Status: implemented in prerelease0.7.1-rc.2; live Telegram verification pending.

## Context

Native ask_question renders literal text. Putting Markdown headings or fences into that
prompt cannot provide formatted block headings or a copyable Telegram command.
The plugin already uses Iva rich replies for task approval and its settings menu.

## Decision

Update check accepts presentation=rich|native, default native for existing callers.
Private Telegram-poll uses the complete server-generated rich markdown with escaped
source/host/path data, bold section headings, blank block gaps and a fenced bash command.
The verified command remains advice for the owner to execute on the VPS.

The offer retains schema v3 with an optional random confirmationReply. Rich apply
requires that exact reply and the existing hidden approvalToken. Native apply refuses
a rich reply; rich apply refuses a missing reply. A fresh native check replaces the old
rich offer. New checks supersede old rich buttons; TTL/source/CI/SHA/job checks remain.
The skill relays only a subsequent actual owner message; later does not call apply.

## Consequences

No core change, direct Telegram API or system package execution. Native structured
ask_question remains available on other channels. Existing native v3 offers remain
compatible. This is the existing model-mediated approval boundary, not independent
server authentication of a human click. The installed version renders an update offer:
the first update from an old version can still have its old plain card.

This extends [ADR0004](0004-owner-confirmed-plugin-updates.md).
