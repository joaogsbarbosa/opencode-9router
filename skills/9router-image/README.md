# 9router-image skill

Two platform variants of the `9router-image` skill, with the same gateway behavior and platform-specific commands. Copy the matching one to
`<config dir>/skills/9router-image/SKILL.md` on the target machine.

| Folder | Shell | Endpoint source |
|---|---|---|
| `linux/SKILL.md` | POSIX `sh`/`bash`, `curl`, Node 18+ | `$NINEROUTER_URL` / `$NINEROUTER_KEY`, then `~/.config/opencode/opencode.jsonc` (or `$XDG_CONFIG_HOME`) |
| `windows/SKILL.md` | PowerShell 5.1+, `curl.exe`, Node 18+ | `$env:NINEROUTER_URL` / `$env:NINEROUTER_KEY`, then `%USERPROFILE%\.config\opencode\opencode.jsonc` |

Both variants share provider routing, JSONC configuration resolution (including project files, environment/file references and multi-provider selection), exact model discovery, bounded HTTP requests, response validation and edit/img2img guidance. Binary mode is for a single image; multiple images use JSON and one file per returned entry. Only the shell-specific command blocks differ.

Both files keep the same frontmatter (`name: 9router-image`); install only one per machine.

`install.mjs` picks the variant with `process.platform` (`win32` → `windows`, otherwise `linux`) and writes it to
`<config dir>/skills/9router-image/SKILL.md` (`./.opencode/skills/...` with `--project`).

Configuration resolution also supports `OPENCODE_CONFIG`, `$XDG_CONFIG_HOME` on both platforms, `.json` fallback, and active project configuration. Select the active project config before running the snippet; do not assume global credentials apply to a project install.

Run the regression checks directly, without a build: `node installer/skills/9router-image/test-skills.mjs` from the repository root. They use synthetic configuration and a local HTTP mock; no live image generation is performed.
