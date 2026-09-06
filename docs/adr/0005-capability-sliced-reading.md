# ADR-0005: capability-sliced reading with optional webhook scopes

- Status: accepted for v0.4 release candidate
- Date: 2026-09-06

## Context

Task titles and descriptions alone are insufficient for routine work. Useful answers also need
discussion, project context, employee names, departments, attachment metadata, checklists and
immediate task relations. These areas use different Bitrix24 scopes and contain different
privacy and prompt-injection risks.

One universal REST tool would make the model responsible for method, filters and fields. A
permanently task-only integration would avoid optional scopes but leave the plugin unable to
answer ordinary questions. Bitrix24 also moved task comments to task chat in module
`tasks 25.700.0`, so implementing only `task.commentitem.getlist` would fail on current cards.

## Decision

Keep one Iva plugin and one isolated stdio MCP server. Expose one strict tool per user-facing
data slice and keep every REST method in a code-owned allowlist.

- `task` remains the only mandatory scope and preserves all v0.3 behavior.
- `im`, `sonet_group`, `user_brief`, `department` and `disk` enable only their corresponding
  read capabilities.
- A capability tool reads `scope` and reports only plugin-relevant permissions plus a fixed
  setup guide.
- Discussion auto mode selects task chat when `CHAT_ID` exists and legacy comments otherwise.
  It never masks a missing `im` scope by silently using the obsolete endpoint.
- Searches require an ID, bounded name query or parent. Directory-wide unfiltered calls are
  not exposed.
- File tools return metadata only. Download URLs and content are excluded.
- Task relations are one level deep and never recurse.
- Every text-bearing result is treated as untrusted content by the skill.

## Consequences

An existing `task`-only webhook upgrades without losing functionality. Users who need broader
reading add only named scopes and still see objects solely within the webhook employee's own
Bitrix24 rights. The model cannot invent a REST method, broaden `select`, download a file or
enumerate an unrestricted directory.

The new task-card discussion requires both task access and participation in the linked chat;
adding `im` alone does not grant object access. Legacy portals remain supported. File content
reading, recursive graph traversal and general REST 3.0 support require separate decisions.

## References

- [Iva plugin process and environment boundary](https://github.com/smixs/iva-agent/blob/f5bb315d4165b73fc0c71d29d4f2a509a27450a6/docs/plugins.md)
- [Bitrix24 new task card](https://github.com/bitrix24/b24restdocs/blob/df9b246cadda5160621e56f1a33bbd4f4ea4fb70/api-reference/tasks/tasks-new.md)
- [Bitrix24 scopes and user rights](https://github.com/bitrix24/b24restdocs/blob/df9b246cadda5160621e56f1a33bbd4f4ea4fb70/api-reference/scopes/index.md)
