# Task action contract (0.6.0-rc.1 preview)

This prerelease implementation is validated by synthetic tests; live portal and native
button verification are pending. Existing read tools keep their contract. No Iva core changes or public backend are required.

| Action | Required input | Bitrix method |
| --- | --- | --- |
| create | title, description, responsibleId, deadline with timezone | tasks.task.add, then task.checklistitem.add if requested |
| comment | taskId, message | im.message.add for linked task chat; task.commentitem.add only without a chat |
| upload | taskId, attachments-relative path; optional message | im.v2.File.upload with current task chat |
| complete | taskId | tasks.task.approve at awaiting control; otherwise tasks.task.complete |
| rework | taskId | tasks.task.disapprove at awaiting control; tasks.task.renew when completed |
| reassign | taskId, responsibleId | tasks.task.update; current assignee must be subordinate |
| deadline | taskId, deadline with timezone | tasks.task.update |

Creation optionally accepts auditors, accomplices, projectId, a flat checklist, priority,
parentId, tags, taskControl, allowChangeDeadline, allowTimeTracking, timeEstimate,
startDatePlan, endDatePlan and scalar/scalar-array customFields known to getFields.
File/CRM custom fields are excluded. This is a bounded set, not every feature of Bitrix24.
A maximum of 50 checklist entries is supported; each is added after the task exists. Checklist
failure returns a partial receipt with taskId and completedChecklistItems, never a rollback
claim. Custom values are checked by Bitrix24 against their actual field types.

Prepare performs no portal writes and returns a UUID, expiry and full approvalPrompt for
Iva's native ask_question. Exactly two buttons: confirm and cancel. A freeform correction
requires prepare again. One pending draft exists per webhook owner, across chats, with a
30 minute expiry. The complete displayed preview is capped at 3500 characters; larger
previews are refused instead of truncated. People names are resolved and shown with IDs.

Apply accepts only the UUID. It rechecks profile/portal, current rights and task snapshot
(title, assignee, deadline, status, changedDate, chat route and operation), and hashes upload
bytes again. Changes require a fresh preview. A subordinate is proved by walking from the
current responsible person's departments through parent departments until UF_HEAD matches
the webhook owner. Merely sharing a department does not suffice. Traversal is bounded to
20 memberships and 30 levels, with cycle detection and no positive cache. New assignees
must be active; Bitrix24 additionally enforces its object/group permissions.

All preview actions need task and user_brief/user_basic/user scopes. Projects additionally
need sonet_group; hierarchy needs department; task chat and upload need im. Local private
PLUGIN_DATA is mandatory for writes. Upload requires BITRIX24_ATTACHMENTS_ROOT, a regular
file under that root and at most 50 MiB. Absolute/traversal/escaped symlink paths are refused.
Legacy comment writes use positional numeric REST keys, as required by the official
[data-encoding contract](https://apidocs.bitrix24.com/settings/how-to-call-rest-api/data-encoding.html).
The native upload sends file and optional message together. Legacy tasks without chat do
not support this upload operation; there is no fallback to another entity.

Before the first mutation a durable receipt is written. No mutation retries automatically,
including timeouts or malformed responses. Receipt states: applied, failed, partial or
unknown. An apply replay returns that receipt, including after restart; action_status reads
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
changed rights/snapshots/routes, upload content changes and path escape. Before promotion to stable,
verify the full Iva button/correction flow and every status/write/upload operation against
synthetic tasks on a test portal. No business task was mutated during development.

Official API references: [task creation](https://apidocs.bitrix24.com/api-reference/tasks/tasks-task-add.html),
[task fields and action rights](https://apidocs.bitrix24.com/api-reference/tasks/fields.html),
[status operations](https://apidocs.bitrix24.com/api-reference/tasks/status/index.html),
[checklist](https://apidocs.bitrix24.com/api-reference/tasks/checklist-item/task-checklist-item-add.html),
[chat upload](https://apidocs.bitrix24.com/api-reference/chat-bots/chat-bots-v2/im.v2/files/file-upload.html).
