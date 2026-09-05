# ADR 0003: do not emulate an extension for Iva 0.3.32

## Status

Resolved upstream in Iva 0.3.34. The plugin-local workaround remains rejected.

## Context

Iva 0.3.32 correctly generates the connection for an enabled and trusted MCP-only plugin,
but its final `missingPluginCode` guard checks the extension mount unconditionally. The
generated connection is present in the active version while the deliberately absent mount
causes trust to be rolled back.

An empty `sh.iva` extension was evaluated as a plugin-local workaround. Its extension build
succeeds, but the subsequent Iva agent build on 0.3.32 fails while importing the generated
extension mount with `EISDIR`. Iva then correctly falls back to a stock build and disables
the plugin.

## Decision

Keep the plugin MCP-only. Do not ship a fake extension and do not patch an installed Iva
tree. All Bitrix24 access remains in the isolated stdio MCP server and its read-only
allowlist.

Iva 0.3.34 replaced the unconditional mount check with validation based on the artifacts
returned by `pluginArtifacts(plugin)`. It includes regression coverage for MCP-only,
extension-only and mixed plugins. Compatibility testing confirms that the plugin reaches
`enabled · trusted` without any Iva core modification.

## Removal condition

Keep Iva 0.3.34 as the minimum supported release until a later compatibility decision
supersedes it.
