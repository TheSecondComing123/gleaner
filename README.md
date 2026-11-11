<div align="center">
  <img src="media/icon.png" width="128" height="128" alt="Gleaner icon">
  <h1>Gleaner</h1>
  <p>errors from any command you run in the terminal, right in the problems panel.<br>no tasks.json, no problem matchers, no setup.</p>

![VS Code 1.93+](https://img.shields.io/badge/vs%20code-1.93%2B-007ACC?style=flat-square)
![License: MIT](https://img.shields.io/badge/license-MIT-a6e3a1?style=flat-square)
![Runs locally](https://img.shields.io/badge/runs-locally-f9e2af?style=flat-square)
</div>

<br>

![Gleaner turning tsc output into problems](docs/screenshot.png)

you type `tsc`, `cargo build` or `pytest` in the terminal like you always do. gleaner reads what scrolls by, finds the errors, and puts them in the problems panel with squiggles in your code. click one and you're on the line.

vs code can already do this, but only through tasks.json and regex problem matchers that almost nobody writes. gleaner skips that part.

## what it does

- **works on the commands you already type.** no tasks to define and no special terminal. it uses vs code's shell integration to see each command and its output.
- **reads 20+ tools out of the box.** compilers, type checkers, linters, test runners, and crash traces. see the list below.
- **understands commands in context.** `npx tsc`, `pnpm exec tsc`, `uv run pytest`, `python -m pytest` and `cd app && cargo build` all work.
- **keeps problems fresh.** run a command again and its old problems are replaced, so fixed errors disappear. other commands keep theirs.
- **never guesses at files.** a problem only shows up if its file exists. paths are tried against the folder the command ran in, any folder it `cd`'d into, and your workspace.
- **related info included.** tsc's "declared here", clang's notes, python's call frames and rust's notes show up under each problem.
- **stays local.** nothing leaves your machine. no network, no telemetry, no account.

## supported tools

| language               | tools                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| typescript, javascript | `tsc`, `vue-tsc`, `tsgo`, `eslint`, `biome`, `esbuild`, `vite`, `jest`, `vitest`, `bun test`, `deno`   |
| js runtimes            | crashes from `node`, `tsx`, `ts-node`, `bun`, `deno`                                                   |
| c, c++, swift, zig     | `gcc`, `g++`, `clang`, `clang++`, `cc`, `swiftc`, `swift build`, `cppcheck`, `zig` (errors and panics) |
| build files            | `make` (its own errors), `cmake`, compiler errors from `cmake --build`                                 |
| rust                   | `cargo build`, `cargo check`, `cargo clippy`, `cargo test`, `rustc`                                    |
| go                     | `go build`, `go vet`, `go test`, `go run` panics                                                       |
| python                 | tracebacks, `pytest`, `pyright`, `mypy`, `ruff`, `flake8`, `pylint`                                    |
| java                   | `javac`, uncaught exceptions from `java`                                                               |
| c#                     | `dotnet build`, `msbuild`                                                                              |
| ruby, lua              | crashes and syntax errors from `ruby`, `ruby -c`, `lua`, `luajit`                                      |
| shell                  | `shellcheck`                                                                                           |

package scripts like `npm run build` or `pnpm test` are read through `package.json` to the commands they run. a command gleaner doesn't know goes through every parser. matches still have to point at a file that exists, so random output doesn't turn into problems.

## install

gleaner isn't on the marketplace yet. build it and install the `.vsix`:

```bash
git clone https://github.com/TheSecondComing123/gleaner.git
cd gleaner
pnpm install
pnpm package
code --install-extension gleaner-*.vsix
```

## use it

open a terminal in vs code and run your build, linter or tests. that's it.

- the status bar shows how many problems came from the terminal. click it to open the problems panel.
- rerunning a command replaces its problems. a run that fails without printing anything gleaner can read (say you hit ctrl+c) keeps the last list; a clean exit clears it.
- **gleaner: clear problems** in the command palette clears everything gleaner added.
- if a terminal has no shell integration, the status bar says so and links to vs code's docs on turning it on.

### settings

| setting                   | default                               | what it does                                                                                                                                                 |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gleaner.enable`          | `true`                                | turn gleaner on or off                                                                                                                                       |
| `gleaner.ignoredCommands` | `ls`, `cat`, `grep`, `rg`, `git`, ... | commands gleaner never reads, even when their output looks like errors (`grep -n` prints `file:12:` too). only applies to commands gleaner has no parser for |

## faq

**which shells work?**
anything vs code's shell integration supports: zsh, bash, fish and powershell on macos, linux and windows, plus git bash, remote ssh and wsl. `cmd`, `tmux`, and a plain `ssh` you typed yourself don't report commands, so gleaner can't see them. tested on zsh with oh-my-zsh and starship.

**does it work with watch mode?**
not yet. `tsc --watch` and friends never finish, and gleaner reads a command's output when it ends. closing the terminal still flushes what it saw.

**it missed an error.**
open an issue with the command and its raw output (copy it from the terminal). every parser is tested against real output from the real tool, so a new sample becomes a new test.

**why not just use tasks.json?**
if you already have tasks with problem matchers, keep them. gleaner is for everything else you type.

## how it works

1. vs code's shell integration api reports each command, the folder it ran in, and its raw output.
2. gleaner strips colors and terminal redraws, then picks parsers by command name.
3. each parser is a small function that turns lines into problems. multi-line formats like rust's and python's are tiny state machines.
4. file paths are resolved against the real filesystem, then published as diagnostics, grouped by terminal and command.

## build

```bash
pnpm install
pnpm test        # parsers against real tool output in test/fixtures
pnpm lint        # biome
pnpm typecheck
pnpm e2e         # drives a real vs code window and checks the problems panel
```

press <kbd>F5</kbd> in vs code to run it in an extension host. `pnpm fixture test/fixtures/<tool>/<case>.txt` records what a parser returns for a new sample. read the result before committing it.

## license

[MIT](LICENSE)
