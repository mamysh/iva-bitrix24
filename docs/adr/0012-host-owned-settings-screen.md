# Settings screens through the Iva Bridge

Status: experimental implementation, 2026-10-04.

Settings rendering and policy changes already belong to the plugin. Message ownership
and direct callback dispatch belong to the host. Declare a separate `/bitrix` command
through the proposed `sh.iva.telegramScreen` API and reuse the existing SettingsMenu
for both the Bridge handler and conversational tool.

The handler returns structured buttons rather than Telegram callback data. Iva creates
opaque callback references, validates ownership and revision and edits one message.
The handler is a normal MCP tool, so this is not a new sandbox or independent business
authorization boundary. Policy revision, expiring confirmation offers, task preview
invalidation and existing MCP confirmation rules remain mandatory.

Keep `bitrix24_settings` and the skill fallback for released Iva. The current stable
host does not implement this proposal, and installing the plugin alone cannot add it.
Reverting the experimental host requires no policy migration or deletion of plugin data.
