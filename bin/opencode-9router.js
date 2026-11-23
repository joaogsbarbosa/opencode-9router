#!/usr/bin/env node
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_PACKAGE = "github:joaogsbarbosa/opencode-9router";
const PLUGIN_MATCH = /opencode-9router/i;
const SCHEMA = "https://opencode.ai/config.json";

const HELP = `opencode-9router - manage the 9router plugin in opencode.json(c)

Usage:
  opencode-9router <command> [flags]

Commands:
  install      Add (or replace) the plugin entry in the config
  configure    Merge options into the existing plugin entry
  uninstall    Remove the plugin entry from the config
  list         List plugin entries
  path         Print the config file that would be edited

Flags:
  --global             Edit the global config (default)
  --project            Edit the project config (./opencode.jsonc)
  --package <spec>     Package spec to use (default: ${DEFAULT_PACKAGE})
  --set <key=value>    Set a plugin option (repeatable). Values are parsed as
                       JSON when possible (true/false/numbers/objects), else string.
  -h, --help           Show this help

Examples:
  npx github:joaogsbarbosa/opencode-9router install
  npx github:joaogsbarbosa/opencode-9router configure --set cache=false --set cacheTTL=60000
  npx github:joaogsbarbosa/opencode-9router uninstall
`;

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function parseArgs(argv) {
  const args = {
    _: [],
    set: {},
    package: DEFAULT_PACKAGE,
    scope: "global",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = () => {
      if (i + 1 >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[++i];
    };
    const applySet = (entry) => {
      const idx = entry.indexOf("=");
      if (idx === -1) {
        throw new Error(`--set expects key=value, got: ${entry}`);
      }
      args.set[entry.slice(0, idx)] = parseValue(entry.slice(idx + 1));
    };

    if (arg === "--global") args.scope = "global";
    else if (arg === "--project") args.scope = "project";
    else if (arg === "--package") args.package = takeValue();
    else if (arg.startsWith("--package=")) args.package = arg.slice("--package=".length);
    else if (arg === "--set") applySet(takeValue());
    else if (arg.startsWith("--set=")) applySet(arg.slice("--set=".length));
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
    else args._.push(arg);
  }
  return args;
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function resolveConfigPath(scope) {
  if (scope === "project") {
    const base = process.cwd();
    const candidates = [
      path.join(base, "opencode.jsonc"),
      path.join(base, "opencode.json"),
      path.join(base, ".opencode", "opencode.jsonc"),
      path.join(base, ".opencode", "opencode.json"),
    ];
    for (const candidate of candidates) {
      if (await exists(candidate)) return candidate;
    }
    return path.join(base, "opencode.jsonc");
  }

  const dir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(os.homedir(), ".config", "opencode");
  const jsonc = path.join(dir, "opencode.jsonc");
  const json = path.join(dir, "opencode.json");
  if (await exists(jsonc)) return jsonc;
  if (await exists(json)) return json;
  return jsonc;
}

// Tolerant JSONC reader: strips comments and trailing commas outside strings.
function parseJsonc(text) {
  let input = text;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);

  let out = "";
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (char === ",") {
      // Drop trailing commas before a closing bracket/brace, ignoring strings.
      let lookahead = i + 1;
      while (lookahead < input.length && /\s/.test(input[lookahead])) lookahead++;
      const after = input[lookahead];
      if (after === "}" || after === "]") {
        continue;
      }
      out += char;
      continue;
    }
    out += char;
  }

  return JSON.parse(out);
}

async function loadConfig(configPath) {
  if (!(await exists(configPath))) {
    return { $schema: SCHEMA, plugins: [] };
  }
  const text = await readFile(configPath, "utf8");
  if (!text.trim()) {
    return { $schema: SCHEMA, plugins: [] };
  }
  try {
    const parsed = parseJsonc(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("root is not an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Could not parse ${configPath}: ${error.message}`);
  }
}

async function saveConfig(configPath, config) {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function ensurePlugins(config) {
  if (!Array.isArray(config.plugins)) {
    config.plugins = [];
  }
  return config.plugins;
}

function entryPackage(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.package === "string") return entry.package;
  return undefined;
}

function matches(pkg, spec) {
  if (!pkg) return false;
  if (pkg === spec) return true;
  return spec === DEFAULT_PACKAGE && PLUGIN_MATCH.test(pkg);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.help || !command) {
    process.stdout.write(HELP);
    process.exit(args.help ? 0 : 1);
  }

  const configPath = await resolveConfigPath(args.scope);

  if (command === "path") {
    process.stdout.write(`${configPath}\n`);
    return;
  }

  const config = await loadConfig(configPath);

  if (command === "list") {
    const plugins = ensurePlugins(config);
    if (plugins.length === 0) {
      process.stdout.write("No plugins configured.\n");
      return;
    }
    for (const entry of plugins) {
      const pkg = entryPackage(entry) ?? "(inline)";
      const hasOptions = entry && typeof entry === "object" && entry.options;
      process.stdout.write(`${pkg}${hasOptions ? " (with options)" : ""}\n`);
    }
    return;
  }

  if (command === "install") {
    const plugins = ensurePlugins(config);
    const removed = [];
    config.plugins = plugins.filter((entry) => {
      const pkg = entryPackage(entry);
      if (matches(pkg, args.package)) {
        removed.push(pkg);
        return false;
      }
      return true;
    });

    const entry = { package: args.package };
    if (Object.keys(args.set).length > 0) {
      entry.options = { ...args.set };
    }
    config.plugins.push(entry);

    await saveConfig(configPath, config);
    for (const pkg of removed) {
      process.stdout.write(`Replaced existing entry: ${pkg}\n`);
    }
    process.stdout.write(`Installed ${args.package} in ${configPath}\n`);
    if (Object.keys(args.set).length === 0) {
      process.stdout.write("No options set. Use 'configure' to add them.\n");
    }
    return;
  }

  if (command === "configure") {
    if (Object.keys(args.set).length === 0) {
      throw new Error("configure requires at least one --set key=value");
    }
    const plugins = ensurePlugins(config);
    let index = -1;
    for (let i = 0; i < plugins.length; i++) {
      if (matches(entryPackage(plugins[i]), args.package)) {
        index = i;
        break;
      }
    }
    if (index === -1) {
      throw new Error(`No ${args.package} entry found in ${configPath}. Run install first.`);
    }
    let entry = plugins[index];
    if (typeof entry === "string") {
      entry = plugins[index] = { package: entry };
    }
    entry.options = { ...(entry.options ?? {}), ...args.set };

    await saveConfig(configPath, config);
    process.stdout.write(`Updated options for ${entry.package} in ${configPath}\n`);
    return;
  }

  if (command === "uninstall") {
    const plugins = ensurePlugins(config);
    const removed = [];
    config.plugins = plugins.filter((entry) => {
      const pkg = entryPackage(entry);
      if (matches(pkg, args.package)) {
        removed.push(pkg);
        return false;
      }
      return true;
    });
    if (removed.length === 0) {
      process.stdout.write(`No matching entry for ${args.package} in ${configPath}\n`);
      return;
    }
    await saveConfig(configPath, config);
    for (const pkg of removed) {
      process.stdout.write(`Removed ${pkg}\n`);
    }
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  process.stderr.write(`opencode-9router: ${error.message}\n`);
  process.exit(1);
});