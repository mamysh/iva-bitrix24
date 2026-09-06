# Task read contract

The plugin never forwards a raw Bitrix24 task object. It requests an explicit field set and
returns a bounded normalized representation.

`bitrix24_connection_check` reports `contractVersion: "0.3"` and
`apiFamily: "tasks-rest"`, allowing diagnostics to identify this contract without exposing
the portal or webhook. It also returns `taskContentChecked: false`: the check verifies the
profile and Tasks field metadata but deliberately reads no task row.

## Task fields

`bitrix24_list_tasks` and `bitrix24_get_task` return:

- positive safe-integer identifiers as decimal strings;
- `title` up to 1,000 characters;
- `description` only for the single-task tool, up to 20,000 characters;
- ISO 8601 dates with an explicit UTC offset, or `null`;
- numeric `status` together with a stable `statusName`;
- numeric `priority` together with a stable `priorityName`;
- `mark` together with `markName`;
- creator, assignee and group identifiers plus nullable display names;
- a portal task link that contains no webhook path or secret.

The display names come only from the `creator`, `responsible` and `group` objects returned by
the same `tasks.task.*` request. The plugin does not call `user.get` or `sonet_group.get`, so
this enrichment does not require broader `user` or `sonet` webhook scopes. A missing embedded
object produces a `null` name, not an additional lookup.

A list task without a valid ID is skipped as malformed. The single-task tool additionally
requires the returned ID to equal the requested ID; a mismatched response is never presented
as the requested task.

## Status and priority semantics

The stable task statuses are:

| `status` | `statusName` |
| ---: | --- |
| 2 | `pending` |
| 3 | `in_progress` |
| 4 | `awaiting_control` |
| 5 | `completed` |
| 6 | `deferred` |

Task list filtering uses `REAL_STATUS`. Bitrix24 documents `STATUS` as a substatus filter that
also has negative meta-values for almost-overdue, unviewed and overdue tasks, so it is not
used for the public status argument.

`overdueOnly: true` uses Bitrix24's documented overdue filter: `DEADLINE` is earlier than the
server's current instant and `REAL_STATUS` is neither 4 nor 5. It cannot be combined with an
explicit status or deadline range. The result contains that instant as `asOf`; other list
queries return `asOf: null`. The filter follows Bitrix24's official
[overdue-task example](https://apidocs.bitrix24.com/tutorials/chat-bots/index.html#reply-with-a-list-of-overdue-tasks).

Priorities are `0/low`, `1/medium` and `2/high`. Marks are `N/negative`, `P/positive` or
`null/unrated`. Unknown upstream values remain visible as a numeric code where possible and
receive the semantic name `unknown`.

See the official Bitrix24 documentation for
[task fields](https://apidocs.bitrix24.com/api-reference/tasks/fields.html) and
[`tasks.task.list`](https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-list.html).

## Pagination and partial results

`start` is an offset, not a page number. `nextStart` is either the only valid continuation
cursor or `null`. `truncated` tells whether another page exists.

If a page contains malformed individual entries, the plugin skips them and returns
`partial: true` with `skippedMalformed`. A malformed result envelope causes
`INVALID_RESPONSE`; it is never silently reported as an empty task list.

Invalid dates and identifiers, unknown enum values and inconsistent embedded entity IDs are
replaced or ignored and named in the task's bounded `dataWarnings` array. Unknown object
fields, profile links, avatar URLs, email addresses and custom task fields are discarded.

## Safe errors

MCP errors contain only a normalized code, category, retry flag and action identifier. Raw
Bitrix24 descriptions are never returned. Untrusted or malformed upstream error codes become
`UPSTREAM_ERROR`, preventing portal URLs or other response data from being reflected through
the error channel.

History event types are restricted to the documented allowlist. Unknown types become `null`
with a bounded warning, and the raw event name is not reflected. History actors expose only
their bounded ID, first name and last name; login and middle name are discarded.

Bitrix24 may use error code `0` for either an unavailable task or denied access. For task get
and history calls the plugin reports `TASK_NOT_FOUND_OR_DENIED` and never inspects or reflects
the raw description to guess which case occurred.
