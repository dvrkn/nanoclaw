---
name: add-xai
description: Use xAI's Grok as a full agent provider — sign in with a SuperGrok subscription through xAI OAuth (device code, no localhost callback; the same login openclaw ships as `xai-device-code`) or paste an xAI API key. Vault-only via OneCLI with host-side token refresh. Runs on the Codex app-server runtime; per group via `ncl groups config update --provider xai`.
---

# xAI (Grok) agent provider

> Shortcut: `pnpm exec tsx setup/index.ts --step provider-auth xai` performs this whole install (the Codex payload it runs on, then the xai payload: files, barrels, image rebuild) plus the sign-in in one command. The steps below are the same operations, for agent-driven or manual application.

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the `xai` provider: Grok on the Codex app-server runtime. Both xAI backends — the Grok CLI proxy a SuperGrok subscription unlocks (`cli-chat-proxy.grok.com`) and the pay-per-use API (`api.x.ai`) — speak the OpenAI Responses API, which is the Codex app-server's native wire protocol. So `xai` composes the Codex payload rather than shipping a second agent loop: same turn loop, MCP tools, server-side history, memory hook and conversation archive; the one difference is a `[model_providers.xai]` block spliced into Codex's `config.toml` before every spawn (backend URL, Responses wire API, a placeholder bearer, and — proxy only — the Grok CLI identity headers the proxy requires).

Credentials are **vault-only**: the Grok access token (OAuth) or the xAI API key lives in the OneCLI vault as an `Authorization: Bearer` rewrite keyed to the backend host, and the container only ever carries a `placeholder` bearer. The OAuth *refresh* token is host-only — `data/xai-oauth.json`, mode 0600, never mounted, removed by uninstall. The host refreshes the access token ten minutes before it expires and rotates the vault copy; running containers pick the new token up on their next request. Nothing secret lands in `.env`.

The mechanical steps under **Install** carry `nc:` directive fences: an agent reads the prose and applies them, and a parser can apply them deterministically from the same document. Every directive is idempotent, so the whole skill is safe to re-run; anything a parser can't apply falls back to the prose beside it.

## Install

### Pre-flight

Requires `src/project-doc-compose.ts` on trunk. If it is missing, stop and tell the operator to run `/update-nanoclaw` first.

Requires the Codex payload — `xai` runs on it. Check for `src/providers/codex.ts`, `container/agent-runner/src/providers/codex.ts`, `container/agent-runner/src/providers/codex-app-server.ts`, `setup/providers/codex.ts`, the `import './codex.js';` line in all three provider barrels, and an `@openai/codex` entry in `container/cli-tools.json`. If any is missing, apply `/add-codex` first (its **Install** section only — its Authenticate step is not needed for Grok), then come back here.

```nc:run effect:check
test -f src/providers/codex.ts && test -f container/agent-runner/src/providers/codex-app-server.ts && test -f setup/providers/codex.ts
```

Check whether the xai payload is already wired (a prior apply, or a trunk that still carries it). All of these present means installed — skip to **Authenticate**:

- `src/providers/xai.ts`, `src/providers/xai-oauth.ts`, `src/providers/xai-oauth-refresh.ts` and `src/providers/xai-vault.ts`
- `container/agent-runner/src/providers/xai.ts`
- `setup/providers/xai.ts`
- `import './xai.js';` in `src/providers/index.ts`, `container/agent-runner/src/providers/index.ts`, and `setup/providers/index.ts`

### 1. Fetch and copy the payload

Fetch the `providers` branch and copy the xai payload into all three trees (additive — overwrite each file, never merge the branch). The host files are the provider contribution (composes codex's, adds the xAI backend env), the OAuth client (discovery, device code, refresh, credential record) and the refresher, plus their guards; the container file is the provider (Codex runtime + the `config.toml` splice) plus its guards; the setup file is the picker entry, the sign-in walk-through and the install check, plus their guards.

```nc:copy from-branch:providers
src/providers/xai.ts
src/providers/xai-oauth.ts
src/providers/xai-oauth-refresh.ts
src/providers/xai-vault.ts
src/providers/xai-registration.test.ts
src/providers/xai-host-contribution.test.ts
src/providers/xai-oauth.test.ts
src/providers/xai-oauth-refresh.test.ts
src/providers/xai-vault.test.ts
container/agent-runner/src/providers/xai.ts
container/agent-runner/src/providers/xai-registration.test.ts
container/agent-runner/src/providers/xai.config.test.ts
setup/providers/xai.ts
setup/providers/xai.test.ts
setup/providers/xai-registration.test.ts
```

### 2. Wire the barrels

Append the self-registration import to each of the three provider barrels (skipped if the line is already present). Each barrel-registration test imports its real barrel and asserts `xai` is registered — they go red the moment a barrel line is missing or drifts.

```nc:append to:src/providers/index.ts
import './xai.js';
```
```nc:append to:container/agent-runner/src/providers/index.ts
import './xai.js';
```
```nc:append to:setup/providers/index.ts
import './xai.js';
```

No CLI manifest entry of its own: the agent's global CLI is Codex's (`@openai/codex` in `container/cli-tools.json`, pinned by `/add-codex`).

### 3. Build

```nc:run effect:build
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### 4. Validate

```nc:run effect:test
pnpm vitest run src/providers/xai-registration.test.ts src/providers/xai-host-contribution.test.ts src/providers/xai-oauth.test.ts src/providers/xai-oauth-refresh.test.ts src/providers/xai-vault.test.ts setup/providers/
```
```nc:run effect:test
cd container/agent-runner && bun test src/providers/xai
```

The registration tests import only the real barrels — they go red if a barrel line is missing, a barrel fails to evaluate, or the payload (or the codex payload under it) is broken. The container config test parses the spliced `config.toml` with a real TOML parser.

## Authenticate

```nc:run effect:external
pnpm exec tsx setup/index.ts --step provider-auth xai
```

The same walk-through fresh installs get from the setup picker, landed in the OneCLI vault:

- **Sign in with my xAI account** (recommended with SuperGrok). xAI's OAuth device-code flow: a verification URL and a one-time code appear (the browser is opened when there is one; over SSH, open the URL in any browser). Approve, and the tokens come back to the host — no localhost callback. xAI may label the consent app "Grok Build": NanoClaw uses xAI's shared OAuth client, the same one openclaw and Grok's own CLI sign in with. After sign-in the walk-through reads the models this subscription can use and asks which one new xai groups should default to.
- **Paste an xAI API key** (`xai-…`, pay-per-use via console.x.ai). Vaulted for `api.x.ai`.

Idempotent — it short-circuits when an xAI vault secret already exists, unless the host has marked the OAuth session dead (see Troubleshooting), in which case it re-runs the sign-in and updates the existing secret. It finishes with the install check.

What it writes: the vault secret (`onecli secrets list` shows it as `xAI`), `data/xai-oauth.json` (OAuth only), and two non-secret lines in `.env` — `XAI_BASE_URL` (which backend the credential is valid for) and `XAI_DEFAULT_MODEL`.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider xai
ncl groups restart --id <group-id>
```

Switching is an operator action — run it from the host. Every provider uses the
same `memory/` tree, so memory carries across automatically. Run
`/migrate-memory` only when upgrading a group that still has legacy `.seed.md`,
`CLAUDE.local.md`, or unindexed imported memory. See
[docs/provider-migration.md](../../docs/provider-migration.md).

### Models

The model a group runs is `container_configs.model` (`ncl groups config update --id <group-id> --model grok-4.3`), falling back to `XAI_DEFAULT_MODEL` in `.env`, then to `grok-4.3`. Use xAI's bare model ids (`grok-4.3`, `grok-4.5`, `grok-build-0.1`, …); an openclaw-style `xai/grok-4.3` is accepted and stripped. With OAuth the id must be one the subscription's catalog lists — the sign-in shows that list; with an API key any `api.x.ai` model works. Reasoning effort is Codex's (`--effort low|medium|high|xhigh`); Grok models that don't support `reasoning_effort` ignore it.

### Default new groups to xai (optional)

New groups are created on the **instance default** (`DEFAULT_AGENT_PROVIDER` in `.env`, or `claude` when unset). Installing this skill wires xai in but does NOT change that default — "installed" is not "authenticated", so the default stays claude until you opt in explicitly.

After install, ask the operator before flipping it:

> "Grok is installed. Default new agent groups to xai? Existing groups keep their current provider."

On yes — set it, then restart the host so it takes effect:

```bash
pnpm exec tsx setup/index.ts --step set-env -- --key DEFAULT_AGENT_PROVIDER --value xai
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS; Linux: systemctl --user restart nanoclaw
```

## How the OAuth session stays alive

The host process starts a refresher with the other host modules (`src/providers/xai-oauth-refresh.ts`). Every minute it re-reads `data/xai-oauth.json`; ten minutes before the access token expires it runs the refresh grant, writes the rotated pair back to the file first (xAI rotates refresh tokens — a consumed one that never reached disk is a dead session), then rotates the vault copy through the OneCLI gateway API (`PATCH /v1/secrets/:id` at `ONECLI_URL`, the same URL and key the host already uses). The host needs no `onecli` binary at runtime — relevant when the host itself runs in a container; the CLI is used only when no gateway URL is configured. A vault push that fails is retried on the next tick without another grant.

**Host running in Docker:** keep `data/` (credential record, tripwire marker) and `.env` (`XAI_*` lines) on persistent volumes; the host container needs egress to `auth.x.ai` for the refresh grant; run the sign-in step where the checkout, the OneCLI gateway URL and a Docker daemon are reachable, since it also rebuilds the agent image. A grant xAI rejects outright (`invalid_grant`) marks the record `needsRelogin`, logs once every 30 minutes, and waits for a re-run of the sign-in. Nothing is logged but the secret id and expiry — never a token.

Env the host passes into xai containers (all non-secret, read from `.env` at spawn): `XAI_BASE_URL` (default: the Grok proxy), `XAI_DEFAULT_MODEL` (default `grok-4.3`), `XAI_GROK_CLIENT_VERSION` (the `x-grok-client-version` the proxy is told; default `1.0.4`).

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason. `Unknown provider: xai. Registered: claude, codex` means the container barrel isn't wired in the running build; `Unknown provider: codex` (or an import error naming `codex-app-server`) means the Codex payload under xai is missing — apply `/add-codex`'s Install section.
- **In-channel `Error: spawn codex ENOENT` on every message:** the image predates the `@openai/codex` manifest entry — re-run `./container/build.sh`.
- **401 / "auth" errors mid-conversation:** the vault has no xAI secret, or its token is stale. `onecli secrets list` should show `xAI`; if the agent is in `selective` secret mode, grant it (`onecli agents grants attach-secret`, or the web UI at `http://127.0.0.1:10254`). For OAuth, check `logs/nanoclaw.error.log` for `xAI OAuth session is dead` and re-run `pnpm exec tsx setup/index.ts --step provider-auth xai` — it updates the existing secret in place.
- **`Couldn't complete the Grok sign-in: xAI device code expired`:** the one-time code is valid for a few minutes — re-run and approve promptly. Over SSH nothing opens automatically; copy the URL into any browser.
- **`xAI returned an HTML/Cloudflare challenge`:** xAI is challenging the automated refresh. The refresher retries on its own; if it persists, re-run the sign-in.
- **Model errors from the proxy (`model not found`, `x-grok-model-override`):** with OAuth the model must be one the subscription lists. Re-run the sign-in to see the catalog, then `ncl groups config update --id <group-id> --model <id>` and restart the group.
- **Requests going to the wrong backend:** `XAI_BASE_URL` in `.env` must match the credential — `https://cli-chat-proxy.grok.com/v1` for OAuth, `https://api.x.ai/v1` for an API key. The sign-in writes it; switching methods rewrites it.
- **Sign-in "already connected" but you want a different account:** `onecli secrets delete --id <id>` for the `xAI` entry, `rm data/xai-oauth.json`, then re-run the sign-in.

To remove this provider, see [REMOVE.md](REMOVE.md).
