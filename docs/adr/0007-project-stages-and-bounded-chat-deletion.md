# ADR 0007: Project stages, chat deletion and portal assignment permissions

Status: accepted for prerelease 0.7.0-rc.4; not live verified.

## Context

Multi-part task requests need one complete preview. Task stages and selected chat deletion
were missing. A local hierarchy gate rejected reassignment even before the portal could
check permissions. Native Iva questions display literal text, so Markdown previews were
unreadable. Checklist update success is documented as result:null, which the generic write
adapter incorrectly treated as response loss and interrupted approved batches.

## Decision

Use plain text for native approval cards while preserving rich replies for reports.
Accept explicit null only for task.checklistitem.update, never missing result or response
loss. Preserve one frozen batch and ordered durable progress; no automatic mutation retry.

Reassignment checks task access and active target, then delegates permission enforcement
to Bitrix24. No department scope or local subordinate requirement is imposed.

Read project G stages through a dedicated tool. Bind movement to the task's current project
and selected stage, recheck canmovetask, then use task.stages.movetask. Stage and task status
remain distinct; do not create, edit or delete stage definitions.

Expose file/message deletion only inside the current task chat. Resolve and freeze the
selected message and file in a bounded 200-message scan. Never accept caller-provided chat
IDs or arbitrary Drive targets. For im.disk.file.delete check the sender and verify removal
because true can also mean no change. An incomplete history scan cannot prove removal.
Message deletion leaves author/admin authorization to im.message.delete. All new operations
use the existing preview, expiry, snapshot, lock and durable receipt contracts.

## Consequences

No core changes, generic REST tool or independent human-click authentication is introduced.
A local error must not be described as a portal refusal. Batch failure preserves completed
changes; uncertainty needs reconciliation and a new preview for remaining work.

References: [checklist update](https://apidocs.bitrix24.com/api-reference/tasks/checklist-item/task-checklist-item-update.html),
[task stages](https://apidocs.bitrix24.com/api-reference/tasks/stages/index.html),
[file deletion](https://apidocs.bitrix24.com/api-reference/chats/files/im-disk-file-delete.html),
[message deletion](https://apidocs.bitrix24.com/api-reference/chats/messages/im-message-delete.html).
