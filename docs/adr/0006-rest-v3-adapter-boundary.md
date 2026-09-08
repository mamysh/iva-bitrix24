# ADR-0006: REST 3.0 adapter boundary

- Status: accepted for v0.4
- Date: 2026-09-08

## Context

Bitrix24 REST 3.0 uses a separate `/rest/api/` address, the `tasks` scope, JSON request
bodies, unified response envelopes and a different task field model. It coexists with the
established REST API; only migrated methods are available through the new address.

The published plugin contract needs bounded task lists filtered by responsible user, status
and deadline. In the reviewed official documentation, REST 3.0 `tasks.task.list` supports
task filtering only by `id`. It therefore cannot replace the current list queries without
removing useful behaviour. Moving only `tasks.task.get` would require a second task scope and
a second field/error model without completing a user scenario.

The current new-card discussion flow is also an officially documented combination: obtain
`CHAT_ID` through established `tasks.task.get`, then read the linked chat with
`im.dialog.messages.get`.

## Decision

Keep the current allowlisted REST implementation and the explicit task-chat hybrid. Do not
add a general REST 3.0 runtime adapter in v0.4 and do not silently retry a failed request
through another API version.

The normalized MCP contract remains independent from raw Bitrix24 envelopes. Any later API
adapter must have an explicit selection and visible diagnostics, preserve the published
filters and privacy limits, and distinguish adapter-specific errors in contract tests.

## Consequences

- Existing `task` webhooks continue to work without an unnecessary scope migration.
- The plugin retains responsible/status/deadline filtering instead of claiming superficial
  REST 3.0 support.
- REST 3.0 idempotency is recorded as relevant to mutation design, but does not justify
  changing the read path.
- Compatibility is re-evaluated from official documentation and a portal's OpenAPI before
  any adapter is enabled.

## Sources reviewed

- [REST 3.0 overview](https://github.com/bitrix24/b24restdocs/blob/df9b246cadda5160621e56f1a33bbd4f4ea4fb70/api-reference/rest-v3.md)
- [REST 3.0 task list](https://github.com/bitrix24/b24restdocs/blob/df9b246cadda5160621e56f1a33bbd4f4ea4fb70/api-reference/tasks/tasks-task-list-rest-v3.md)
- [New task card migration](https://github.com/bitrix24/b24restdocs/blob/df9b246cadda5160621e56f1a33bbd4f4ea4fb70/api-reference/tasks/tasks-new.md)
