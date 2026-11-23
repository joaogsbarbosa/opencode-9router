#!/usr/bin/env node
// opencode-9router installer (zero dependencies).
//
//   node install.mjs                 # interactive menu
//   node install.mjs install         # install/configure
//   node install.mjs update          # re-apply config
//   node install.mjs configure       # merge options
//   node install.mjs uninstall       # remove entry + cache
//   node install.mjs list            # show plugin entries
//   node install.mjs path            # print config path
//
// Flags: --project (edit ./opencode.jsonc instead of the global config)

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import path from "node:path";

const PACKAGE = "@joaogsbarbosa/opencode-9router@latest";
const DEFAULT_BASE_URL = "http://localhost:20128";
const DEFAULT_CACHE_TTL = 3 * 60 * 60 * 1000; // 3 h (default do plugin)
const DEFAULT_DISCOVERY_TIMEOUT = 30000;
const SCHEMA = "https://opencode.ai/config.json";

const argv = process.argv.slice(2);
const project = argv.includes("--project");
const command = argv.find((arg) => !arg.startsWith("-")) || "";

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(text) {
  return new Promise((resolve) => {
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
    rl.question(text).then(finish, () => finish(null));
  });
}

async function askValue(label, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const raw = await ask(`${label}${suffix}: `);
  if (raw === null) return defaultValue;
  return raw.trim() || defaultValue;
}

async function askYesNo(label, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const raw = await ask(`${label} [${hint}]: `);
  if (raw === null) return defaultYes;
  const answer = raw.trim().toLowerCase();
  if (!answer) return defaultYes;
  return !answer.startsWith("n");
}

async function askPositiveInt(label, defaultValue) {
  const raw = await askValue(label, String(defaultValue));
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

// ── JSONC parsing / surgical editing ────────────────────────────────────────

function parseJsonc(text) {
  let input = text;
  if (input.charCodeAt(0) === 0xfeff) input = input.slice(1);
  let out = "", inString = false, escaped = false, inLine = false, inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i], n = input[i + 1];
    if (inLine) { if (c === "\n") { inLine = false; out += c; } continue; }
    if (inBlock) { if (c === "*" && n === "/") { inBlock = false; i++; } continue; }
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    if (c === ",") {
      const j = skipWsComments(input, i + 1);
      const after = input[j];
      if (after === "}" || after === "]") continue;
      out += c;
      continue;
    }
    out += c;
  }
  const cleaned = out.trim();
  if (!cleaned) return {};
  return JSON.parse(out);
}

function isWs(c) {
  return c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === "\uFEFF";
}

function skipWsComments(text, i) {
  const n = text.length;
  while (i < n) {
    const c = text[i], c2 = text[i + 1];
    if (isWs(c)) { i++; continue; }
    if (c === "/" && c2 === "/") { i += 2; while (i < n && text[i] !== "\n") i++; continue; }
    if (c === "/" && c2 === "*") { i += 2; while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 2; continue; }
    break;
  }
  return i;
}

function findValueEnd(text, start) {
  const n = text.length;
  let i = skipWsComments(text, start);
  const firstChar = text[i];
  if (firstChar === "{" || firstChar === "[") {
    const close = firstChar === "{" ? "}" : "]";
    let depth = 0;
    let inString = false, escaped = false, inLine = false, inBlock = false;
    for (; i < n; i++) {
      const c = text[i], c2 = text[i + 1];
      if (inLine) { if (c === "\n") inLine = false; continue; }
      if (inBlock) { if (c === "*" && c2 === "/") { inBlock = false; i++; } continue; }
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; continue; }
      if (c === "/" && c2 === "/") { inLine = true; i++; continue; }
      if (c === "/" && c2 === "*") { inBlock = true; i++; continue; }
      if (c === firstChar) depth++;
      else if (c === close) { depth--; if (depth === 0) return i + 1; }
    }
    throw new Error("unbalanced value");
  }
  if (firstChar === '"') {
    let j = i + 1;
    let escaped = false;
    for (; j < n; j++) {
      const c = text[j];
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === '"') return j + 1;
    }
    throw new Error("unterminated string");
  }
  let j = i;
  while (j < n) {
    const c = text[j];
    if (c === "," || c === "}" || c === "]" || isWs(c)) break;
    j++;
  }
  return j;
}

function findTopLevelObjectEnd(text) {
  const n = text.length;
  let i = skipWsComments(text, 0);
  if (text[i] !== "{") return -1;
  let depth = 0;
  let inString = false, escaped = false, inLine = false, inBlock = false;
  for (; i < n; i++) {
    const c = text[i], c2 = text[i + 1];
    if (inLine) { if (c === "\n") inLine = false; continue; }
    if (inBlock) { if (c === "*" && c2 === "/") { inBlock = false; i++; } continue; }
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === "/" && c2 === "/") { inLine = true; i++; continue; }
    if (c === "/" && c2 === "*") { inBlock = true; i++; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function findTopLevelProperty(text, key) {
  const n = text.length;
  let i = 0;
  let curly = 0, square = 0;
  let inString = false, escaped = false, inLine = false, inBlock = false;
  let stringStart = -1;
  let expectingKey = false;

  while (i < n) {
    const c = text[i], c2 = text[i + 1];
    if (inLine) { if (c === "\n") inLine = false; i++; continue; }
    if (inBlock) { if (c === "*" && c2 === "/") { inBlock = false; i += 2; } else i++; continue; }
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') {
        inString = false;
        if (expectingKey && curly === 1 && square === 0 && stringStart >= 0) {
          const raw = text.slice(stringStart, i + 1);
          let name;
          try { name = JSON.parse(raw); } catch { name = undefined; }
          if (name === key) {
            const colon = skipWsComments(text, i + 1);
            if (text[colon] === ":") {
              const valueStart = skipWsComments(text, colon + 1);
              const valueEnd = findValueEnd(text, valueStart);
              return { keyStart: stringStart, keyEnd: i + 1, valueStart, valueEnd };
            }
          }
        }
      }
      i++;
      continue;
    }
    if (c === '"') { inString = true; escaped = false; stringStart = i; i++; continue; }
    if (c === "/" && c2 === "/") { inLine = true; i += 2; continue; }
    if (c === "/" && c2 === "*") { inBlock = true; i += 2; continue; }
    if (c === "{") { curly++; if (curly === 1) expectingKey = true; i++; continue; }
    if (c === "}") { curly--; if (curly === 0) expectingKey = false; i++; continue; }
    if (c === "[") { square++; i++; continue; }
    if (c === "]") { square--; i++; continue; }
    if (c === ",") { if (curly === 1 && square === 0) expectingKey = true; i++; continue; }
    if (c === ":") { if (curly === 1 && square === 0) expectingKey = false; i++; continue; }
    i++;
  }
  return null;
}

function getObjectInfo(text) {
  const open = skipWsComments(text, 0);
  if (text[open] !== "{") return null;
  const close = findTopLevelObjectEnd(text);
  if (close === -1) return null;

  let i = open + 1;
  let lastValueEnd = -1;
  let sawAny = false;

  while (i < close) {
    i = skipWsComments(text, i);
    if (i >= close || text[i] === "}") break;
    if (text[i] !== '"') return null;
    let j = i + 1;
    let escaped = false;
    while (j < close) {
      const c = text[j];
      if (escaped) { escaped = false; j++; continue; }
      if (c === "\\") { escaped = true; j++; continue; }
      if (c === '"') { j++; break; }
      j++;
    }
    if (j > close || text[j - 1] !== '"') return null;
    j = skipWsComments(text, j);
    if (text[j] !== ":") return null;
    j = skipWsComments(text, j + 1);
    if (j >= close) return null;
    const valueEnd = findValueEnd(text, j);
    if (valueEnd <= j) return null;
    lastValueEnd = valueEnd;
    sawAny = true;
    i = skipWsComments(text, valueEnd);
    if (i < close && text[i] === ",") { i++; continue; }
    if (i >= close || text[i] === "}") break;
    return null;
  }
  return { open, close, lastValueEnd, isEmpty: !sawAny };
}

function entryPackage(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.package === "string") return entry.package;
  return "";
}

function matches(spec, pkg = PACKAGE) {
  if (!spec) return false;
  return /opencode-9router/i.test(spec) || spec === pkg;
}

function buildOptions(url, apikey, cache, cacheTTL, discoveryTimeout) {
  const options = {};
  if (url) options.baseURL = url;
  if (apikey) options.apiKey = apikey;
  if (cache) options.cache = cache === "true";
  const ttl = Number(cacheTTL);
  if (Number.isFinite(ttl) && ttl > 0) options.cacheTTL = ttl;
  const timeout = Number(discoveryTimeout);
  if (Number.isFinite(timeout) && timeout > 0) options.discoveryTimeout = timeout;
  return options;
}

function computePlugins(config, action, pkg, url, apikey, cache, cacheTTL, discoveryTimeout) {
  const plugins = Array.isArray(config.plugins) ? config.plugins.slice() : [];
  if (action === "set") {
    const kept = plugins.filter((entry) => !matches(entryPackage(entry), pkg));
    kept.push({ package: pkg, options: buildOptions(url, apikey, cache, cacheTTL, discoveryTimeout) });
    return kept;
  }
  if (action === "configure") {
    const options = buildOptions(url, apikey, cache, cacheTTL, discoveryTimeout);
    const index = plugins.findIndex((entry) => matches(entryPackage(entry), pkg));
    if (index === -1) {
      plugins.push({ package: pkg, options });
    } else {
      let entry = plugins[index];
      if (typeof entry !== "object" || entry === null) {
        entry = plugins[index] = { package: entry, options: {} };
      }
      entry.options = { ...(entry.options || {}), ...options };
    }
    return plugins;
  }
  if (action === "remove") {
    return plugins.filter((entry) => !matches(entryPackage(entry), pkg));
  }
  throw new Error(`unknown action: ${action}`);
}

function indentBlock(serialized, indent) {
  return serialized.split("\n").map((line, idx) => (idx === 0 ? line : indent + line)).join("\n");
}

function block(serialized, indent, eol) {
  return indentBlock(serialized, indent).replace(/\n/g, eol);
}

function buildConfigText(text, plugins) {
  const serialized = JSON.stringify(plugins, null, 2);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const range = findTopLevelProperty(text, "plugins");
  if (range) {
    const lineStart = text.lastIndexOf("\n", range.keyStart - 1) + 1;
    const match = text.slice(lineStart, range.keyStart).match(/^[ \t]*/);
    const leading = match ? match[0] : "";
    return text.slice(0, range.valueStart) + block(serialized, leading, eol) + text.slice(range.valueEnd);
  }

  const info = getObjectInfo(text);
  if (!info) {
    const body = JSON.stringify({ $schema: SCHEMA, plugins }, null, 2);
    const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
    if (!withoutBom.trim()) return (text.startsWith("\uFEFF") ? "\uFEFF" : "") + body + "\n";
    return text.replace(/\s+$/, "") + eol + body + "\n";
  }

  const lineStart = text.lastIndexOf("\n", info.open - 1) + 1;
  const match = text.slice(lineStart, info.open).match(/^[ \t]*/);
  const baseIndent = match ? match[0] : "";
  const propIndent = baseIndent + "  ";
  const propertyText = `"plugins": ` + block(serialized, propIndent, eol);

  if (info.isEmpty) {
    const interior = text.slice(info.open + 1, info.close).trim();
    if (interior) {
      return text.slice(0, info.open + 1) + eol + propIndent + propertyText + eol + baseIndent + interior + eol + baseIndent + text.slice(info.close);
    }
    return text.slice(0, info.open + 1) + eol + propIndent + propertyText + eol + baseIndent + text.slice(info.close);
  }
  return text.slice(0, info.lastValueEnd) + "," + eol + propIndent + propertyText + text.slice(info.lastValueEnd);
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
  const config = parseJsonc(text);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config root is not an object");
  }
  return { text, config, exists: true };
}

function writeConfig(cfgPath, text) {
  mkdirSync(path.dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, text.endsWith("\n") ? text : text + "\n");
}

function applyAction(cfgPath, action, pkg, url, apikey, cache, cacheTTL, discoveryTimeout) {
  const { text, config, exists } = readConfig(cfgPath);
  const before = Array.isArray(config.plugins) ? config.plugins.length : 0;
  const plugins = computePlugins(config, action, pkg, url, apikey, cache, cacheTTL, discoveryTimeout);
  if (action === "remove" && (!exists || plugins.length === before)) return 0;
  writeConfig(cfgPath, buildConfigText(text, plugins));
  return action === "remove" ? before - plugins.length : 0;
}

function getOptionValue(cfgPath, key) {
  const { config } = readConfig(cfgPath);
  const entry = (Array.isArray(config.plugins) ? config.plugins : []).find((item) => matches(entryPackage(item)));
  const options = entry && typeof entry === "object" ? entry.options : undefined;
  return options && options[key] !== undefined ? String(options[key]) : "";
}

// ── Connection / commands ───────────────────────────────────────────────────

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

async function promptOptions(cfgPath, defaultUrl, defaultKey, defaultCache, defaultCacheTTL, defaultDiscoveryTimeout) {
  const url = await askValue("Base URL", defaultUrl || DEFAULT_BASE_URL);
  const key = await askValue("API key (optional)", defaultKey || "");
  const cache = await askYesNo("Enable cache?", (defaultCache || "Y") === "Y");
  const cacheTTL = await askPositiveInt("Cache TTL (ms)", defaultCacheTTL || DEFAULT_CACHE_TTL);
  const discoveryTimeout = await askPositiveInt("Discovery timeout (ms)", defaultDiscoveryTimeout || DEFAULT_DISCOVERY_TIMEOUT);
  return { url, key, cache: cache ? "true" : "false", cacheTTL, discoveryTimeout };
}

async function requireConnection(options) {
  if (!(await checkConnection(options.url, options.key))) {
    throw new Error(`could not connect to ${options.url}. Check the URL and API key.`);
  }
}

async function doInstall(cfgPath) {
  const options = await promptOptions(cfgPath, "", "", "Y", DEFAULT_CACHE_TTL, DEFAULT_DISCOVERY_TIMEOUT);
  await requireConnection(options);
  applyAction(cfgPath, "set", PACKAGE, options.url, options.key, options.cache, options.cacheTTL, options.discoveryTimeout);
  console.log(`\nPlugin configured: ${PACKAGE}`);
  console.log(`Config: ${cfgPath}`);
  console.log("OpenCode installs the package automatically. Restart (or /reload).");
}

async function doUpdate(cfgPath) {
  const options = await promptOptions(
    cfgPath,
    getOptionValue(cfgPath, "baseURL"),
    getOptionValue(cfgPath, "apiKey"),
    getOptionValue(cfgPath, "cache") === "false" ? "N" : "Y",
    Number(getOptionValue(cfgPath, "cacheTTL")) || DEFAULT_CACHE_TTL,
    Number(getOptionValue(cfgPath, "discoveryTimeout")) || DEFAULT_DISCOVERY_TIMEOUT
  );
  await requireConnection(options);
  applyAction(cfgPath, "set", PACKAGE, options.url, options.key, options.cache, options.cacheTTL, options.discoveryTimeout);
  console.log("\nConfiguration updated. Restart OpenCode (or /reload).");
}

async function doConfigure(cfgPath) {
  const options = await promptOptions(
    cfgPath,
    getOptionValue(cfgPath, "baseURL"),
    getOptionValue(cfgPath, "apiKey"),
    getOptionValue(cfgPath, "cache") === "false" ? "N" : "Y",
    Number(getOptionValue(cfgPath, "cacheTTL")) || DEFAULT_CACHE_TTL,
    Number(getOptionValue(cfgPath, "discoveryTimeout")) || DEFAULT_DISCOVERY_TIMEOUT
  );
  await requireConnection(options);
  applyAction(cfgPath, "configure", PACKAGE, options.url, options.key, options.cache, options.cacheTTL, options.discoveryTimeout);
  console.log(`\nOptions updated in ${cfgPath}. Restart OpenCode (or /reload).`);
}

function doUninstall(cfgPath) {
  const removed = applyAction(cfgPath, "remove", PACKAGE);
  console.log(`Entries removed from config: ${removed}`);
  if (existsSync(cacheDir())) {
    rmSync(cacheDir(), { recursive: true, force: true });
    console.log(`Removed ${cacheDir()}`);
  }
  console.log("\nUninstalled. The package in ~/.config/opencode/node_modules is managed by OpenCode.");
}

function doList(cfgPath) {
  const { config } = readConfig(cfgPath);
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  if (plugins.length === 0) {
    console.log("No plugins configured.");
    return;
  }
  for (const entry of plugins) {
    const pkg = entryPackage(entry) || "(inline)";
    const hasOptions = entry && typeof entry === "object" && entry.options;
    console.log(`${pkg}${hasOptions ? " (with options)" : ""}`);
  }
}

async function chooseAction() {
  while (true) {
    console.log("\nChoose an option:");
    console.log("  1) install    - install/configure (npm package)");
    console.log("  2) update     - update config");
    console.log("  3) configure  - change options");
    console.log("  4) uninstall  - remove entry and cache");
    console.log("  0) quit");
    const choice = await ask("> ");
    if (choice === null) return "";
    switch (choice.trim()) {
      case "1": return "install";
      case "2": return "update";
      case "3": return "configure";
      case "4": return "uninstall";
      case "0": case "q": case "Q": return "";
      default: console.log("invalid option");
    }
  }
}

function help() {
  console.log(`opencode-9router installer

Usage:
  node install.mjs [command] [--project]

Commands:
  install      Install/configure the plugin (npm package)
  update       Re-apply the configuration
  configure    Merge options into the existing entry
  uninstall    Remove the entry and cache
  list         List plugins in the config
  path         Print the config file being used
  help         Show this help

Without a command, opens an interactive menu.
`);
}

async function main() {
  if (command === "help" || argv.includes("--help") || argv.includes("-h")) {
    help();
    return;
  }

  const cfgPath = resolveConfigPath();

  if (command === "path") {
    console.log(cfgPath);
    return;
  }
  if (command === "list") {
    doList(cfgPath);
    return;
  }

  const action = command || (await chooseAction());
  if (!action) return;

  switch (action) {
    case "install": await doInstall(cfgPath); break;
    case "update": await doUpdate(cfgPath); break;
    case "configure": await doConfigure(cfgPath); break;
    case "uninstall": doUninstall(cfgPath); break;
    default: throw new Error(`unknown command: ${action}`);
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