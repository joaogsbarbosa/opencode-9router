# @joaogsbarbosa/opencode-9router-installer

Interactive installer for the [opencode-9router](https://www.npmjs.com/package/@joaogsbarbosa/opencode-9router) plugin.

```bash
npx @joaogsbarbosa/opencode-9router-installer
```

Use `--project` to edit the project config instead of the global config:

```bash
npx @joaogsbarbosa/opencode-9router-installer --project
```

Installing also registers the `9router-image` skill. The skill now ships inside the plugin package and is registered automatically by the plugin on load, so there is no separate skill file to copy and it stays in sync with the plugin version.

Requires Node 18+.