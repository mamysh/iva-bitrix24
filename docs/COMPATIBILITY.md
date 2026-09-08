# Compatibility

Compatibility is claimed only for combinations that are exercised by automated checks or an
explicit live smoke test.

| Component | Version or mode | Evidence | Status |
| --- | --- | --- | --- |
| Iva | 0.3.34 | historical MCP lifecycle without the current native button flow | legacy; current button flow not supported |
| Iva | 0.4.0 | native Telegram HITL, plugin lifecycle, `iva doctor` and MCP proxy | supported |
| Node.js | 24 | CI typecheck, tests, build and stdio MCP smoke test | supported for development |
| Bitrix24 Tasks REST | current task, comment, checklist and attachment APIs | official contract review and synthetic contract tests | supported for documented read-only tools |
| Bitrix24 new task card | module `tasks 25.700.0+` discussion model | `CHAT_ID` discovery, official `im.dialog.messages.get` contract, synthetic system-event test and owner live canary | supported for bounded discussion and change-event reading |
| Bitrix24 REST 3.0 | `/rest/api/...` | official docs review at `b24restdocs@de91707`; task list filtering is documented only for `id` | evaluated and deliberately not selected for the current read contract |

The plugin uses an explicit allowlist across Tasks, IM, workgroups, users, departments and
Drive. The new-card discussion adapter uses the `CHAT_ID` exposed by established
`tasks.task.get`, then reads the linked chat with `im.dialog.messages.get`. It does not switch
the general task contract to `/rest/api/`; REST 3.0 has a different URL, field and pagination
contract and is not selected automatically. The adapter decision is recorded in
[ADR-0006](adr/0006-rest-v3-adapter-boundary.md).

New Iva or Bitrix24 releases are not considered supported merely because the plugin starts.
Before updating this matrix, run the full project check and the relevant clean-install,
upgrade, rollback and live read smoke tests.
