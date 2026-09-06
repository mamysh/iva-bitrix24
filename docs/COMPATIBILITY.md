# Compatibility

Compatibility is claimed only for combinations that are exercised by automated checks or an
explicit live smoke test.

| Component | Version or mode | Evidence | Status |
| --- | --- | --- | --- |
| Iva | 0.3.34 | historical MCP lifecycle without the current native button flow | legacy; current button flow not supported |
| Iva | 0.4.0 | native Telegram HITL, plugin lifecycle, `iva doctor` and MCP proxy | supported |
| Node.js | 24 | CI typecheck, tests, build and stdio MCP smoke test | supported for development |
| Bitrix24 Tasks REST | current `tasks.task.*` API | official contract review and synthetic contract tests | release candidate; live task-output check pending |
| Bitrix24 REST 3.0 | `/rest/api/...` | no runtime adapter in this version | not supported |

The plugin uses the established `tasks.task.list`, `tasks.task.get`,
`tasks.task.history.list` and `tasks.task.getFields` endpoints. REST 3.0 has a different URL,
field and pagination contract and is not selected automatically.

New Iva or Bitrix24 releases are not considered supported merely because the plugin starts.
Before updating this matrix, run the full project check and the relevant clean-install,
upgrade, rollback and live read smoke tests.
