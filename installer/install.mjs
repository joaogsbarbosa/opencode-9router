#!/usr/bin/env node
// opencode-9router installer.
//
//   npx @joaogsbarbosa/opencode-9router-installer            # interactive menu
//   npx @joaogsbarbosa/opencode-9router-installer --project  # edit ./opencode.jsonc

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse, modify, applyEdits, printParseErrorCode } from "jsonc-parser";

const PACKAGE = "@joaogsbarbosa/opencode-9router@latest";
const DEFAULT_BASE_URL = "http://localhost:20128";
const DEFAULT_CACHE_TTL = 3 * 60 * 60 * 1000; // 3 h (default do plugin)
const DEFAULT_DISCOVERY_TIMEOUT = 30000;
const SCHEMA = "https://opencode.ai/config.json";

const project = process.argv.includes("--project");

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function ask(text, initial = "") {
  const canPrefill = rl.terminal && process.stdin.isTTY;
  const label = initial && !canPrefill ? `${text.replace(/:\s*$/, "")} [${initial}]: ` : text;
  const answer = await new Promise((resolve) => {
    let settled = false;
    let onClose;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (onClose) rl.removeListener("close", onClose);
      resolve(value);
    };
    onClose = () => finish(null);
    rl.once("close", onClose);
    rl.question(label).then(finish, () => finish(null));
    if (initial && canPrefill) {
      try { rl.write(String(initial)); } catch { /* ignore write errors */ }
    }
  });
  if (answer === "" && initial && !canPrefill) return initial;
  return answer;
}

async function askYesNo(label, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const raw = await ask(`${label} [${hint}]: `);
  if (raw === null) return defaultYes;
  const answer = raw.trim().toLowerCase();
  if (!answer) return defaultYes;
  return !answer.startsWith("n");
}

async function askNumber(label, defaultValue) {
  const raw = await ask(`${label}: `, String(defaultValue));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

function resolveConfigPath() {
  if (project) {
    const candidates = [
      path.join(process.cwd(), "opencode.jsonc"),
      path.join(process.cwd(), "opencode.json"),
      path.join(process.cwd(), ".opencode", "opencode.jsonc"),
      path.join(process.cwd(), ".opencode", "opencode.json"),
    ];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
    return path.join(process.cwd(), "opencode.jsonc");
  }
  const dir = process.env.XDG_CONFIG_HOME
    ? path.join(process.env.XDG_CONFIG_HOME, "opencode")
    : path.join(homedir(), ".config", "opencode");
  const jsonc = path.join(dir, "opencode.jsonc");
  const json = path.join(dir, "opencode.json");
  if (existsSync(jsonc)) return jsonc;
  if (existsSync(json)) return json;
  return jsonc;
}

function cacheDir() {
  const home = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(home, "opencode-9router");
}

function readConfig(cfgPath) {
  let text;
  try {
    text = readFileSync(cfgPath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { text: "", config: { $schema: SCHEMA, plugins: [] }, exists: false };
    }
    throw error;
  }
  if (!text.trim()) {
    return { text: "", config: { $schema: SCHEMA, plugins: [] }, exists: true };
  }
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new Error(`invalid JSONC in ${cfgPath}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`);
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config root is not an object");
  }
  return { text, config, exists: true };
}

function writeConfig(cfgPath, text) {
  mkdirSync(path.dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, text.endsWith("\n") ? text : text + "\n");
}

function editConfig(text, keyPath, value) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(text, keyPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol },
  });
  return applyEdits(text, edits);
}

function buildConfigText(text, plugins) {
  if (!text.trim()) {
    return JSON.stringify({ $schema: SCHEMA, plugins }, null, 2) + "\n";
  }
  return editConfig(text, ["plugins"], plugins);
}

function syncProviderSettings(cfgPath, providerKey, url, key) {
  const { text, config } = readConfig(cfgPath);
  const providers = config.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return false;
  const provider = providers[providerKey];
  if (!provider || typeof provider !== "object") return false;

  let updated = editConfig(text, ["providers", providerKey, "settings", "baseURL"], url);
  const settings = provider.settings;
  if (key) {
    updated = editConfig(updated, ["providers", providerKey, "settings", "apiKey"], key);
  } else if (settings && typeof settings === "object" && "apiKey" in settings) {
    updated = editConfig(updated, ["providers", providerKey, "settings", "apiKey"], undefined);
  }
  writeConfig(cfgPath, updated);
  return true;
}

function entryPackage(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.package === "string") return entry.package;
  return "";
}

function pkgName(spec) {
  if (typeof spec !== "string") return "";
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

function matches(spec, pkg = PACKAGE) {
  if (!spec) return false;
  const name = pkgName(spec);
  const target = pkgName(pkg);
  if (name === target) return true;
  const short = target.split("/").pop();
  return name === short || name.endsWith(`/${short}`);
}

function buildOptions(url, apikey, cache, cacheTTL, discoveryTimeout, providers) {
  const options = {};
  if (url) options.baseURL = url;
  if (apikey) options.apiKey = apikey;
  if (cache) options.cache = cache === "true";
  const ttl = Number(cacheTTL);
  if (Number.isFinite(ttl) && ttl > 0) options.cacheTTL = ttl;
  const timeout = Number(discoveryTimeout);
  if (Number.isFinite(timeout) && timeout > 0) options.discoveryTimeout = timeout;
  if (Array.isArray(providers) && providers.length > 0) options.providers = providers;
  return options;
}

function computePlugins(config, action, pkg, url, apikey, cache, cacheTTL, discoveryTimeout, providers) {
  const plugins = Array.isArray(config.plugins) ? config.plugins.slice() : [];
  if (action === "set") {
    const kept = plugins.filter((entry) => !matches(entryPackage(entry), pkg));
    kept.push({ package: pkg, options: buildOptions(url, apikey, cache, cacheTTL, discoveryTimeout, providers) });
    return kept;
  }
  if (action === "remove") {
    return plugins.filter((entry) => !matches(entryPackage(entry), pkg));
  }
  throw new Error(`unknown action: ${action}`);
}

function applyAction(cfgPath, action, pkg, url, apikey, cache, cacheTTL, discoveryTimeout, providers) {
  const { text, config, exists } = readConfig(cfgPath);
  const before = Array.isArray(config.plugins) ? config.plugins.length : 0;
  const plugins = computePlugins(config, action, pkg, url, apikey, cache, cacheTTL, discoveryTimeout, providers);
  if (action === "remove" && (!exists || plugins.length === before)) return 0;
  writeConfig(cfgPath, buildConfigText(text, plugins));
  return action === "remove" ? before - plugins.length : 0;
}

function findEntry(config) {
  return (Array.isArray(config.plugins) ? config.plugins : []).find((item) => matches(entryPackage(item)));
}

function resolveCurrent(cfgPath) {
  const defaults = {
    url: DEFAULT_BASE_URL,
    key: "",
    cache: true,
    cacheTTL: DEFAULT_CACHE_TTL,
    discoveryTimeout: DEFAULT_DISCOVERY_TIMEOUT,
    source: "options",
    providerKey: "",
    providers: [],
    installed: false,
    package: PACKAGE,
  };

  const { config } = readConfig(cfgPath);
  const entry = findEntry(config);
  const installed = !!entry;
  const pkg = entryPackage(entry) || PACKAGE;
  const options = entry && typeof entry === "object" ? entry.options || {} : {};
  const optProviders = Array.isArray(options.providers)
    ? options.providers.filter((item) => item && typeof item === "object")
    : [];

  if (optProviders.length > 0) {
    const provider = optProviders.find((item) => item.key === "9router" || item.id === "9router") || optProviders[0];
    const providerKey = String(provider.key || provider.id || "9router");
    return {
      url: provider.baseURL || defaults.url,
      key: provider.apiKey || "",
      cache: options.cache !== false,
      cacheTTL: Number(options.cacheTTL) || defaults.cacheTTL,
      discoveryTimeout: Number(options.discoveryTimeout) || defaults.discoveryTimeout,
      source: "options.providers",
      providerKey,
      providers: optProviders,
      installed,
      package: pkg,
    };
  }

  const providers = config.providers && typeof config.providers === "object" && !Array.isArray(config.providers)
    ? config.providers
    : {};
  const providerKey = Object.keys(providers).find((key) => key === "9router" || key.startsWith("9router"));
  if (providerKey) {
    const settings = providers[providerKey]?.settings;
    const resolved = settings && typeof settings === "object" ? settings : {};
    return {
      url: resolved.baseURL || defaults.url,
      key: resolved.apiKey || "",
      cache: options.cache !== false,
      cacheTTL: Number(options.cacheTTL) || defaults.cacheTTL,
      discoveryTimeout: Number(options.discoveryTimeout) || defaults.discoveryTimeout,
      source: "providers",
      providerKey,
      providers: [],
      installed,
      package: pkg,
    };
  }

  return {
    url: options.baseURL || defaults.url,
    key: options.apiKey || "",
    cache: options.cache !== false,
    cacheTTL: Number(options.cacheTTL) || defaults.cacheTTL,
    discoveryTimeout: Number(options.discoveryTimeout) || defaults.discoveryTimeout,
    source: "options",
    providerKey: "",
    providers: [],
    installed,
    package: pkg,
  };
}

function maskSecret(value) {
  if (!value) return "(not set)";
  const text = String(value);
  if (text.length <= 8) return "****";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function formatMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "?";
  if (n >= 3600000 && n % 3600000 === 0) return `${n / 3600000} h`;
  if (n >= 60000 && n % 60000 === 0) return `${n / 60000} min`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000} s`;
  return `${n} ms`;
}

function showStatus(cfgPath) {
  console.log("\nopencode-9router");
  try {
    const current = resolveCurrent(cfgPath);
    console.log(`  status:    ${current.installed ? "installed" : "not installed"}`);
    console.log(`  config:    ${cfgPath}`);
    if (!current.installed) return false;
    console.log(`  package:   ${current.package}`);
    console.log(`  baseURL:   ${current.url}`);
    console.log(`  apiKey:    ${maskSecret(current.key)}`);
    console.log(`  cache:     ${current.cache ? `enabled (TTL ${formatMs(current.cacheTTL)})` : "disabled"}`);
    console.log(`  discovery: ${formatMs(current.discoveryTimeout)}`);
    return true;
  } catch (error) {
    console.log(`  status:    config error (${error.message})`);
    return false;
  }
}

async function checkConnection(baseUrl, apiKey) {
  let url = baseUrl.replace(/\/+$/, "");
  if (!url.endsWith("/v1")) url += "/v1";
  url += "/models";
  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function promptOptions(current) {
  const urlAnswer = await ask("Base URL: ", current.url);
  const url = (urlAnswer === null ? "" : urlAnswer.trim()) || current.url;
  const keyAnswer = await ask("API key (optional): ", current.key);
  const key = keyAnswer === null ? current.key : keyAnswer.trim();
  const cache = await askYesNo("Enable cache?", current.cache);
  const cacheTTL = await askNumber("Cache TTL (ms)", current.cacheTTL);
  const discoveryTimeout = await askNumber("Discovery timeout (ms)", current.discoveryTimeout);
  return { url, key, cache: cache ? "true" : "false", cacheTTL, discoveryTimeout };
}

async function requireConnection(options) {
  if (!(await checkConnection(options.url, options.key))) {
    throw new Error(`could not connect to ${options.url}. Check the URL and API key.`);
  }
}

async function doSetup(cfgPath) {
  const current = resolveCurrent(cfgPath);
  const options = await promptOptions(current);
  await requireConnection(options);

  let providers;
  if (current.source === "options.providers") {
    const key = current.providerKey;
    const list = Array.isArray(current.providers) ? current.providers : [];
    const withUrl = (item) => {
      const { apiKey: _ignored, ...rest } = item;
      return { ...rest, baseURL: options.url, ...(options.key ? { apiKey: options.key } : {}) };
    };
    const updated = list.map((item) => {
      if (item && (item.key === key || item.id === key)) {
        return withUrl(item);
      }
      return item;
    });
    if (!updated.some((item) => item && (item.key === key || item.id === key))) {
      updated.push({ key, baseURL: options.url, ...(options.key ? { apiKey: options.key } : {}) });
    }
    providers = updated;
  }

  applyAction(cfgPath, "set", PACKAGE, options.url, options.key, options.cache, options.cacheTTL, options.discoveryTimeout, providers);

  if (current.source === "providers") {
    syncProviderSettings(cfgPath, current.providerKey, options.url, options.key);
  }

  console.log(`\nPlugin configured: ${PACKAGE}`);
  console.log(`Config: ${cfgPath}`);
  console.log("OpenCode installs the package automatically. Restart (or /reload).");
}

function doUninstall(cfgPath) {
  const { config } = readConfig(cfgPath);
  const installed = !!findEntry(config);
  const removed = applyAction(cfgPath, "remove", PACKAGE);
  if (!installed) {
    console.log("Plugin is not installed.");
  } else {
    console.log(`Entries removed from config: ${removed}`);
  }
  if (existsSync(cacheDir())) {
    rmSync(cacheDir(), { recursive: true, force: true });
    console.log(`Removed ${cacheDir()}`);
  }
  console.log("\nUninstalled. The package in ~/.config/opencode/node_modules is managed by OpenCode.");
}

async function chooseAction(installed) {
  while (true) {
    console.log("\nChoose an option:");
    console.log(installed
      ? "  1) configure  - change the current configuration"
      : "  1) install    - install the plugin");
    console.log("  2) uninstall  - remove entry and cache");
    console.log("  0) quit");
    const choice = await ask("> ");
    if (choice === null) return "";
    switch (choice.trim()) {
      case "1": return "setup";
      case "2": return "uninstall";
      case "0": case "q": case "Q": return "";
      default: console.log("invalid option");
    }
  }
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error("interactive terminal required. Run `npx @joaogsbarbosa/opencode-9router-installer` in a terminal.");
    process.exitCode = 1;
    return;
  }

  const cfgPath = resolveConfigPath();

  while (true) {
    const installed = showStatus(cfgPath);
    const action = await chooseAction(installed);
    if (!action) return;

    try {
      if (action === "setup") await doSetup(cfgPath);
      else doUninstall(cfgPath);
    } catch (error) {
      console.error(`error: ${error.message}`);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}