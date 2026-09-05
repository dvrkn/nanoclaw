# Remove the xAI (Grok) agent provider

Reverses every change `/add-xai` makes and returns every group to the default provider. Safe to run when partially installed — skip any step whose target is already absent. The Codex payload xai runs on is left in place; remove it separately with `/add-codex`'s REMOVE.md if nothing else uses it.

## 1. Switch xai groups back to the default

List groups still on xai and switch each one (each group's `memory/` tree stays on disk and readable; run `/migrate-memory` per group if its memory should carry back — see [docs/provider-migration.md](../../docs/provider-migration.md)):

```bash
ncl groups list
# for each group whose config shows provider=xai:
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

If `.env` has `DEFAULT_AGENT_PROVIDER=xai`, set it back:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value claude
```

## 2. Delete the barrel imports

Delete (do not comment out) the `import './xai.js';` line from each of:

- `src/providers/index.ts`
- `container/agent-runner/src/providers/index.ts`
- `setup/providers/index.ts`

## 3. Delete every copied file

```bash
rm -f src/providers/xai.ts \
      src/providers/xai-oauth.ts \
      src/providers/xai-oauth-refresh.ts \
      src/providers/xai-registration.test.ts \
      src/providers/xai-host-contribution.test.ts \
      src/providers/xai-oauth.test.ts \
      src/providers/xai-oauth-refresh.test.ts \
      container/agent-runner/src/providers/xai.ts \
      container/agent-runner/src/providers/xai-registration.test.ts \
      container/agent-runner/src/providers/xai.config.test.ts \
      setup/providers/xai.ts \
      setup/providers/xai.test.ts \
      setup/providers/xai-registration.test.ts
```

This skill itself (`.claude/skills/add-xai/`) stays — it ships with trunk so the provider can be re-added later.

## 4. Remove the credential record and env lines

The OAuth refresh token lives only here; deleting it ends the host-side session:

```bash
rm -f data/xai-oauth.json
```

Remove the `XAI_BASE_URL`, `XAI_DEFAULT_MODEL` and `XAI_GROK_CLIENT_VERSION` lines from `.env`.

## 5. Vault secret (optional)

The `xAI` secret in the OneCLI vault grants nothing once the provider is gone, and the access token it holds expires on its own. To remove it: `onecli secrets list`, then `onecli secrets delete --id <id>` for the entry whose host pattern is `cli-chat-proxy.grok.com` or `api.x.ai`.

## 6. Rebuild and verify

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
pnpm test
cd container/agent-runner && bun test
```

All suites green and `ncl groups list` showing no xai groups means the removal is complete. Restart the service (`launchctl kickstart -k gui/$(id -u)/<label>` on macOS, `systemctl --user restart <unit>` on Linux).
