## Summary

Describe the user-visible change and its motivation.

## Security and permissions

- [ ] No webhook, private portal URL, personal data, real task content or raw API response is included.
- [ ] REST methods remain explicitly allowlisted; no generic call path was added.
- [ ] New Bitrix24 scopes or returned fields are documented, or this change requires none.
- [ ] Error paths do not expose upstream request or response data.

## Verification

- [ ] `npm run check`
- [ ] Documentation and CHANGELOG updated where needed
- [ ] Bundle rebuilt and committed when server code changed
