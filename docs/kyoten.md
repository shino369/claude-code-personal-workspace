# kyoten

kyoten (拠点, "base of operations") starts a coding agent inside a kyoten workspace: shared rules
(`AGENTS.md`), tasks that survive sessions, memory, skills, review roles, hooks, and a quality
gate, the same for Claude Code, Codex, and the DeepSeek harness.

```bash
npx kyoten            # Claude Code
npx kyoten codex      # OpenAI Codex CLI
npx kyoten dsh        # DeepSeek harness (dsh web)
npx kyoten dscc       # Claude Code on the DeepSeek API
```

No clone is needed. The first run offers to create your workspace (the "home", `~/.kyoten`), and
every later run starts the agent there.

## Requirements

- Node.js 24 or newer, git, and pnpm (`corepack enable`; without admin rights:
  `corepack enable --install-directory <a folder on your PATH you can write to>`).
- The agent CLIs you want to use: [Claude Code](https://code.claude.com/docs),
  [Codex](https://developers.openai.com/codex/cli), or
  [DSH](https://deepseekdocs.com/en/docs/user-guide/cli). kyoten does not install them.
  `kyoten doctor` lists what is missing.

macOS, Linux, and Windows (PowerShell, cmd, Git Bash) are supported.

## Start

```bash
npx kyoten init       # create ~/.kyoten and install it (pnpm install, pnpm workspace:setup)
npx kyoten doctor     # check Node, git, pnpm, each agent, and the home
npx kyoten            # start Claude Code in the home
```

Install it globally if you prefer a plain `kyoten` command: `pnpm add -g kyoten` (or
`npm i -g kyoten`). The examples below use `kyoten`.

## Command line

```text
kyoten [--home <dir>] [<agent>] [agent args…]
kyoten [--home <dir>] <command> [options]
```

Only the front of the command line belongs to kyoten: its options, then one word that picks the
agent or the command. Everything after that word goes to the agent unchanged, and kyoten adds no
permission flags.

| Agent    | Starts                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `claude` | `claude` (the default when the first word is not an agent or a command: `kyoten -c` is `claude -c`)                                       |
| `codex`  | `codex`                                                                                                                                   |
| `dsh`    | `dsh <profile> --patch .dsh/workspace.patch.yml`; the profile is the first argument if it is not an option, else `web` (`kyoten dsh tui`) |
| `dscc`   | `claude` with the DeepSeek profile (below)                                                                                                |

`--codex` is the same as `codex`. To give Claude a word that is also a kyoten command, name the
agent: `kyoten claude update`.

| Command                     | Does                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init [<dir>] [--no-setup]` | Create a home and install it. With `<dir>`, also make it the default home. An existing kyoten workspace is kept as it is and only installed again |
| `update [--no-setup]`       | Merge this kyoten's snapshot into a home kyoten created                                                                                           |
| `doctor`                    | Check prerequisites, agents, Codex trust, the dsh path, the dscc key, then `pnpm workspace:check`                                                 |
| `where`                     | Print the home on stdout and the rule that chose it on stderr (`cd "$(kyoten where)"`)                                                            |
| `help`, `version`           | Help and the version                                                                                                                              |

## The home

The home is the first match of:

1. `--home <dir>`
2. `$KYOTEN_HOME`
3. a kyoten workspace that contains the current directory (so `pnpm kyoten` in a clone uses the clone)
4. `"home"` in the config file
5. `~/.kyoten`

Every launch prints which one it used. The agent always runs with the home as its working
directory, so the workspace's hooks, tasks, and memory work as they do in a clone. To work on
another repository, start a task for it from the home: `pnpm task new <name> --repo <path>`.
kyoten passes the directory you started it from as `KYOTEN_CALLER_DIR`, and the session brief
mentions it when it is a git repository.

Already have a clone? Register it as the default home (nothing is copied):

```bash
kyoten init ~/src/kyoten
```

### Config file

`config.json` in `%APPDATA%\kyoten` (Windows), `$XDG_CONFIG_HOME/kyoten`, or `~/.config/kyoten`:

```json
{
  "home": "/absolute/path/to/home",
  "args": { "dscc": ["--dangerously-skip-permissions"] }
}
```

`args` adds default arguments for one agent, before the ones you type. That is the place for a
flag you always want, such as a permission mode: kyoten never adds one itself.

## dscc: Claude Code on the DeepSeek API

```bash
kyoten dscc --set-key   # paste the key from https://platform.deepseek.com/api_keys (hidden)
kyoten dscc --show      # print the profile, the key masked
kyoten dscc             # start
```

The profile is `dscc.env` in the config folder, or the file named by `$DSCC_PROFILE`. It is
outside every workspace, written with mode 0600 on macOS and Linux, and parsed, never executed:
one literal `KEY=value` per line, `#` comments. It sets the DeepSeek base URL, the key, and the
model mapping. An `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` inherited from your shell is
dropped, so it cannot pick the account or the endpoint.

`--set-key` reads one line from stdin when stdin is not a terminal (`kyoten dscc --set-key < key.txt`).
In Git Bash's mintty, which is not a terminal to Windows programs, pipe the key or run
`--set-key` from PowerShell or cmd.

## Updating

A home kyoten created is a git repository. Its `kyoten/upstream` branch holds the snapshots kyoten
installed; your branch (`main`) holds them plus your own commits.

```bash
npx kyoten@latest update
```

commits the new snapshot to `kyoten/upstream` and merges it into your branch: a fast-forward when
you changed nothing, a merge commit when you did, and ordinary git conflicts when both sides changed
the same lines (resolve them, `git commit`, then run `update` again). Nothing is overwritten.
`update` refuses to start with uncommitted changes to tracked files. A clone is updated with
`git pull`, not `kyoten update`.

When the home was made by another kyoten version, each launch prints a one-line hint.

## Notes per agent

- **Codex** reads the workspace's `.codex/` only when the home is trusted. Accept the trust prompt
  on the first `kyoten codex`, then run `/hooks` once to trust the hooks.
- **DSH** has no project config; kyoten adds the workspace patch. Install the Claude hooks bridge in
  each DSH profile you start, at the version `dsh --version` prints (see `docs/harness.md` in the
  home). DSH cannot run the hooks from a home path that contains `$`, a backtick, or `"` (or `\` on
  macOS and Linux); `kyoten doctor` reports it.
- **Windows:** an agent installed by npm is a `.cmd` shim, which cannot take arguments containing
  `"`, `%`, or `!` safely. kyoten refuses those arguments with an explanation: type that text inside
  the agent instead.

## Security

- The npm package holds a snapshot of one git commit, never a working tree: untracked and ignored
  files (tasks, memory, logs, local settings, secrets) cannot be in it. The pack step also checks
  every file against a deny list and the exact expected file list.
- The package has no install scripts. kyoten itself makes no network calls; `pnpm install` and
  `pnpm workspace:setup` make the ones they always make.
- Commands run without a shell. On Windows, `.cmd` shims go through `cmd.exe` with strict quoting.

## Remove

Delete the home (`kyoten where` prints it) and the config folder. A global install is removed with
`pnpm remove -g kyoten`.

## Developing kyoten

The code is in `utils/kyoten/` of the kyoten repository (https://github.com/shino369/kyoten).

```bash
pnpm kyoten doctor          # run the CLI from the clone (the clone is the home)
pnpm kyoten:pack            # build dist/kyoten-<version>.tgz from HEAD and check it
npx --yes --package ./dist/kyoten-<version>.tgz -- kyoten doctor   # the npx path, before publishing
```

`kyoten:pack` packs the HEAD commit, so commit first. Publishing is a manual step.
