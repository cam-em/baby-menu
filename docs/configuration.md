# Configuration

How a running Baby Menu install stores state, picks an agent, and can be tuned.

## Where state lives

The packaged app keeps everything mutable under `~/.baby-menu`: extensions, the local SQLite database, caches, agent sessions, the custom agent catalog, and preferences.
Upgrades preserve this directory, so generated widgets and extension state survive.

On launch, packaged Baby Menu refreshes bundled defaults (`AGENTS.md`, `babymenu-env.d.ts`, recipes, starter extensions) from the app template while leaving your own extension directories untouched.
If `~/.baby-menu/extensions` is a symlink, Baby Menu resolves it for seeding and packaged widget/layout CSS compilation, which supports managed symlinks into writable dotfiles directories such as home-manager `mkOutOfStoreSymlink`.
Read-only or otherwise invalid targets are skipped with a log message instead of blocking startup.

## Choosing an agent

Baby Menu detects supported agents in order: Gemini through Antigravity (`agy`), then GPT through Codex (`codex`).
Both run through bundled clean-room ACP adapters in the exact active extension workspace. Gemini uses Antigravity's verified autonomous permission mode; GPT uses Codex's non-interactive approval bypass inside Baby Menu's external Keep / Undo safety boundary. Their built-in ids are `gemini` and `gpt`.

| Mechanism | Effect |
| --- | --- |
| Settings | Persist an agent choice across launches; add, edit, or remove custom agents. |
| `BABY_MENU_AGENT=<name>` | Override auto-detection before a preference is saved. |
| `agents.json` | Append custom catalog entries manually; built-in Gemini/GPT routing is immutable. |

If a send fails, the popover shows bounded, actionable guidance instead of raw provider diagnostics or a generic unavailable hint.
For built-in agents, authentication failures prompt you to open Antigravity and sign in for Gemini or run `codex login` for GPT. Missing commands point to the required `agy` or `codex` install without showing raw provider diagnostics.
If the failed turn edited files before stopping, Baby Menu keeps those partial changes available for Keep or Undo; a failed turn with no file changes closes cleanly.

### Provider-specific clean-room behavior

The Antigravity adapter uses a temporary agent definition that opts out of ambient user customizations and MCP servers. It creates a fresh project at the exact extension workspace, disables slash-command expansion, grants no extra directory, suppresses account decoration and provider logs, and resumes the captured conversation id on later turns.

The Codex adapter ignores user configuration and rules. It reads only the top-level `model` from `$CODEX_HOME/config.toml` or `~/.codex/config.toml` and passes it as `--model`, because it otherwise runs Codex with `--ignore-user-config`.

## Custom ACP agents

Add agents from Settings (id, optional label, ACP launch command) or by editing `agents.json` directly.
Packaged mode reads `~/.baby-menu/agents.json`; source mode reads `agents.json` at the repo root.
Settings-added agents are editable and removable; built-in Gemini and GPT stay read-only.

Each custom entry requires `name`; `label`, `command`, `installHint`, and `launchCommand` are optional. `command` controls availability probing and defaults to the id. `launchCommand` controls execution; without it, execution uses `registryCommand` when present, otherwise acpx resolves the agent id. Migration may retain that original resolution in `registryCommand`. Built-in names cannot be overridden.
Entries with `launchCommand` register as custom [`acpx`](https://github.com/openclaw/acpx) overrides and show as available.

```json
[
  {
    "name": "pi",
    "label": "Pi",
    "launchCommand": "npx pi-acp"
  }
]
```

`launchCommand` is any Agent Client Protocol (ACP) server command.
The underlying CLI must be installed and authenticated.
Examples:

| Agent | `launchCommand` |
| --- | --- |
| Pi | `npx pi-acp` |
| Cursor | `cursor-agent acp` |
| GitHub Copilot | `copilot --acp --stdio` |
| Qwen Code | `qwen --acp` |
| OpenCode | `npx -y opencode-ai acp` |

### Existing selections and configuration recovery

On upgrade, historical built-in selections `claude` and `codex` become `gemini` and `gpt`, unless the original id names a current custom agent. Custom entries colliding with the new built-in ids are renamed to `custom-gemini` or `custom-gpt`, with a numeric suffix starting at `-2` if needed. Their labels, launch commands, availability probes, and original acpx command resolution are preserved.

Saved selections are resolved against the original catalog before renaming. If there is no saved selection, an environment-selected colliding custom agent is saved under its migrated id so subsequent launches keep selecting it.

Migration requires readable, valid catalog and preferences files; absent files use defaults. A temporary `agent-selection-migration.json` beside `preferences.json` stores only a version and target agent id so interrupted writes can converge on restart. It is removed after the catalog and selection converge. Configuration writes preserve existing symlinks and atomically replace their targets. See [migration recovery tests](../tests/agent-migration-recovery.test.ts) for recovery coverage.

If configuration cannot be loaded or migration cannot finish, the tray and widgets remain available, while agent turns, switching, and custom-agent editing are disabled. Check `agents.json` and `preferences.json` for valid JSON and read/write permissions, then restart Baby Menu. Existing configuration and pending recovery state are retained rather than replaced with defaults.

## Updates

Update with Homebrew:

```sh
brew update
brew upgrade --cask baby-menu
```

When a newer GitHub Release exists, Baby Menu shows an indicator in the popover header that opens a dialog with the same command and a link to the release notes.
If Baby Menu is running during a Cask upgrade, the cask quits the old app and relaunches the new one after replacement.
Fresh installs and upgrades while Baby Menu is closed do not launch the app automatically.

## Telemetry

Packaged release builds send anonymous, best-effort usage telemetry to a self-hosted Umami instance.

- **Records:** app startup, popover opens (`/popover` page views plus named events), agent turn outcomes, agent switches.
- **Never includes:** user/device id, prompts, file contents, generated code, extension data, or local paths.
- Network failures are ignored.

Set `BABY_MENU_TELEMETRY=0` in the launch environment to opt out.

## Environment flags

| Var                               | Effect                                                                                                                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BABY_MENU_KEEP_POPOVER_OPEN=1`   | Disables blur-to-hide so devtools / external windows stay up                                                                                                                                                      |
| `BABY_MENU_AGENT=<name>`          | Overrides agent auto-detection when no saved Settings choice exists                                                                                                                                               |
| `BABY_MENU_AGENT_TIMEOUT_MS=<ms>` | Overrides the embedded-agent request timeout                                                                                                                                                                      |
| `BABY_MENU_EXTENSIONS_DIR=<dir>`  | Overrides the active extension workspace in source/dev runs. Dev Tailwind scans only `extensions/` and `extensions-dev/`, so overrides outside those paths need matching `@source` coverage for widget utilities. |
| `CODEX_HOME=<dir>`                | When GPT is the selected built-in agent, points the Codex adapter at `<dir>/config.toml` for the top-level `model`; other Codex user config is still ignored.                                                         |
| `BABY_MENU_TELEMETRY=0`           | Disables packaged-release telemetry; `false` and `off` are also accepted                                                                                                                                          |
| `BABY_MENU_UMAMI_HOST=<url>`      | Overrides the self-hosted Umami endpoint used by telemetry. Source/dev/test builds are no-op unless a website id is also configured.                                                                               |
| `BABY_MENU_UMAMI_WEBSITE_ID=<id>` | Overrides or supplies the Umami website id used by telemetry. The release workflow reads this from the GitHub Actions `vars.*` context, not a secret.                                                             |
