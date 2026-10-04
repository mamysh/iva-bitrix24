# Task action contract (prerelease 0.7.0-rc.2; stable 0.6.0)

The stable 0.6.0 release is validated by synthetic tests. On 4 October 2026 the owner
reported successful task creation and completion on the current upstream Iva in real use.
The exact installed Iva version was not recorded; other operations have no separate live
verification claim. Existing read tools keep their contract. No Iva core changes or public backend are required.

| Action | Required input | Bitrix method |
| --- | --- | --- |
| create | title, description, responsibleId, deadline with timezone | tasks.task.add, then task.checklistitem.add if requested |
| update | taskId and at least one explicit edit | tasks.task.update and/or task.checklistitem.add/update |
| batch | 1–20 ordinary actions | one draft, one approval; ordered calls with durable progress |
| comment | taskId, message | im.message.add for linked task chat; task.commentitem.add only without a chat |
| upload | taskId, attachments-relative path; optional message | im.v2.File.upload with current task chat |
| complete | taskId | tasks.task.approve at awaiting control; otherwise tasks.task.complete |
| rework | taskId | tasks.task.disapprove at awaiting control; tasks.task.renew when completed |
| reassign | taskId, responsibleId | tasks.task.update; current assignee must be subordinate |
| deadline | taskId, deadline with timezone | tasks.task.update |

Creation optionally accepts auditors, accomplices, projectId, a flat checklist, priority,
parentId, tags, taskControl, allowChangeDeadline, allowTimeTracking, timeEstimate,
startDatePlan, endDatePlan and scalar/scalar-array customFields known to getFields.
Creation also accepts `comment` and up to ten `uploads: [{path, message?}]`: their full
preview and file hashes are part of the same draft. After creation, follow-ups resolve the
returned task ID and chat. A missing chat stops with partial progress; the task is never
recreated. The entire file selection is checked before tasks.task.add.
File/CRM custom fields are excluded. This is a bounded set, not every feature of Bitrix24.
A maximum of 50 checklist entries is supported; each is added after the task exists. Checklist
failure returns a partial receipt with taskId and completedChecklistItems, never a rollback
claim. Custom values are checked by Bitrix24 against their actual field types.

Update edits the existing task ID; it never calls tasks.task.add. It accepts title,
description (empty clears), deadline (null clears), auditors (replacement), addAuditors and
removeAuditors (deltas preserving other observers), accomplices, projectId (null detaches),
priority and tags. Auditors replacement cannot be mixed with deltas. `checklist` appends
entries; `checklistUpdates` accepts existing IDs with title and/or completed status. Checklist
replacement/deletion is not exposed. Missing fields stay untouched. Reassignment retains its
separate hierarchy check; update cannot bypass it. Edit rights are required.

Batch uploads are capped at 50 MiB in total to bound memory during preflight.
Batch contains 1–20 non-nested actions, including independent creates and operations on
known existing task IDs. New IDs cannot be referenced inside the same draft. All fields,
rights, snapshots and file hashes are checked before the first mutation. One combined prompt
has one pair of confirm/cancel buttons. Task context is displayed once per existing task;
all requested edits/messages/files stay visible. One update per task prevents stale observer
delta calculations; merge edits before prepare. Batch is sequential, not an upstream database
transaction. On the first failure it stops; already performed changes are preserved.

Tool discovery publishes an object schema with all action fields and a nested batch schema.
The server validates the strict discriminated action contract before prepare; fields from
other actions and incomplete inputs remain rejected.

Prepare performs no portal writes and returns a UUID, expiry and full approvalPrompt for
Iva's native ask_question. Exactly two buttons: confirm and cancel. A freeform correction
requires prepare again. One pending draft exists per webhook owner, across chats, with a
30 minute expiry. The complete displayed preview is capped at 3500 characters; larger
previews are refused instead of truncated. People names are resolved and shown with IDs.

The prompt is Markdown: an operation heading and bold field labels. Untrusted values are
escaped as literal text; escaping changes only display, never the frozen write payload.
Pass approvalPrompt unchanged to native ask_question. Do not collapse or hide approved
fields. Rendering, removal of the question buttons and the appended selection status are
owned by Iva’s Telegram channel. A selection status records a choice, not a successful write.

Apply accepts only the UUID. It rechecks profile/portal, current rights and task snapshot
(title, assignee, deadline, status, changedDate, chat route and operation), and hashes upload
bytes again. Changes require a fresh preview. A subordinate is proved by walking from the
current responsible person's departments through parent departments until UF_HEAD matches
the webhook owner. Merely sharing a department does not suffice. Traversal is bounded to
20 memberships and 30 levels, with cycle detection and no positive cache. New assignees
must be active; Bitrix24 additionally enforces its object/group permissions.

All preview actions need task and user_brief/user_basic/user scopes. Projects additionally
need sonet_group; hierarchy needs department; task chat and upload need im. Local private
PLUGIN_DATA is mandatory for writes. Upload uses BITRIX24_ATTACHMENTS_ROOT when configured, otherwise the verified Iva CLI
installation and its vault setting recover the attachments root at startup. Failure stays
closed with ATTACHMENTS_NOT_CONFIGURED. It requires a regular
file under that root and at most 50 MiB. Absolute/traversal/escaped symlink paths are refused.
Legacy comment writes use positional numeric REST keys, as required by the official
[data-encoding contract](https://apidocs.bitrix24.com/settings/how-to-call-rest-api/data-encoding.html).
The native upload sends file and optional message together. An applied result must include
file.id and messageId from Bitrix24; the normalized receipt exposes fileId and messageId.
A malformed success response remains uncertain and is never retried automatically. Legacy tasks without chat do
not support this upload operation; there is no fallback to another entity.

Before the first mutation a durable receipt is written. No mutation retries automatically,
including timeouts or malformed responses. Receipt states: applied, failed, partial or
unknown. Batch receipts include ordered operations, completedOperations, completedWrites,
currentOperation and each operation's state, task ID/link, checklist progress and safe error.
The current mutation is marked unknown durably before sending; each returned write updates
progress. A crash or response loss cannot replay a completed prefix. Partial/unknown results
require reconciliation, then a fresh preview for only the uncompleted points. An apply replay returns that receipt, including after restart; action_status reads
it after the preview expires or is replaced. unknown must be reconciled against task/chat
before any new request. Receipts intentionally do not store raw responses, file Base64 or
signed URLs. The active payload is removed after completion; historical receipts stay in
private plugin data. A process crash can leave a stale lock; operator recovery must inspect
the receipt and portal, not erase receipts and retry.

The model passes the structured native button answer to apply, as in the updater. The MCP
server cannot independently authenticate the button click or bind it to a chat session.
A model possessing the draft UUID can call apply without a click. This limitation is explicit:
independent human approval would require a trusted Iva-to-plugin callback contract. The skill
requires a private owner chat and exact matching structured confirmation, and rejects task,
file, forwarded-message and freeform text as approval.

Synthetic validation covers required inputs, buttons and MCP schemas, cancellation,
correction, expiry, replay, concurrency, partial creation, network loss, reporting chains,
changed rights/snapshots/routes, upload content changes and path escape. The owner authorized
promotion after reporting successful live creation and completion. For a new installation,
verify the relevant actions and the button/correction flow with synthetic tasks before
using them for business work. Other live scenarios remain unverified.

Official API references: [task creation](https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-add.html),
[task fields and action rights](https://apidocs.bitrix24.com/api-reference/tasks/fields.html),
[status operations](https://apidocs.bitrix24.com/api-reference/tasks/status/index.html),
[checklist](https://apidocs.bitrix24.com/api-reference/tasks/checklist-item/task-checklist-item-add.html),
[checklist editing](https://apidocs.bitrix24.com/api-reference/tasks/checklist-item/task-checklist-item-update.html),
[task editing](https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-update.html),
[chat upload](https://apidocs.bitrix24.com/api-reference/chat-bots/chat-bots-v2/im.v2/files/file-upload.html).


Example: existing card edits, a comment and a selected file share one native confirmation:

```json
{
  "action": "batch",
  "actions": [
    {"action": "update", "taskId": 101, "addAuditors": [8], "checklist": ["Подготовить", "Проверить", "Отправить"]},
    {"action": "comment", "taskId": 101, "message": "тест"},
    {"action": "upload", "taskId": 101, "path": "test.txt", "message": "Документ к задаче"}
  ]
}
```

For a new task put the comment in `create.comment` and selected files in `create.uploads`
alongside its title, description, responsibleId, deadline, observers and checklist.
