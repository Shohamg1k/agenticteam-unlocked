import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ConnectorDef, InstalledPlugin, PluginManifest } from '@agentic/core';
import { ensureDir, nodePaths, readJson, writeJsonAtomic } from './paths.js';
import { changed, state } from './store.js';
import { describeError, log } from './log.js';

/**
 * Plugins: bundles of skills, agent profiles and connectors, installed from a
 * local folder or a git URL.
 *
 * A plugin is data, not code. It contributes Markdown files and connector
 * manifests — it never contributes JavaScript that this process executes.
 * That is the whole reason installing one from a git URL is a reasonable thing
 * to offer: the worst a malicious plugin can do is add a skill with bad
 * instructions or a connector that requires approval before it writes.
 *
 * Layout:
 *
 *     my-plugin/
 *       plugin.json        name, version, what it contributes
 *       skills/<name>/SKILL.md
 *       agents/<name>/AGENT.md
 */

function pluginsDir(): string {
  const dir = nodePaths().plugins;
  ensureDir(dir);
  return dir;
}

function registryFile(): string {
  return path.join(pluginsDir(), 'installed.json');
}

export function loadPlugins(): InstalledPlugin[] {
  const stored = readJson<InstalledPlugin[]>(registryFile(), []);
  // Drop entries whose folder is gone, rather than leaving rows that error.
  state.plugins = stored.filter((p) => fs.existsSync(p.root));
  if (state.plugins.length !== stored.length) saveRegistry();
  syncConnectors();
  return state.plugins;
}

function saveRegistry(): void {
  writeJsonAtomic(registryFile(), state.plugins);
  changed();
}

export function listPlugins(): InstalledPlugin[] {
  return state.plugins;
}

/**
 * Install from a local folder or a git URL.
 *
 * A git URL is cloned with `--depth 1`; a local folder is copied, not linked,
 * so editing the source afterwards does not silently change installed
 * behaviour.
 */
export async function installPlugin(source: string): Promise<InstalledPlugin> {
  const isGit = /^(https?:\/\/|git@|git:\/\/)/.test(source);
  const staging = path.join(pluginsDir(), `.staging-${Date.now().toString(36)}`);

  try {
    if (isGit) {
      await clone(source, staging);
    } else {
      const abs = path.resolve(source);
      if (!fs.existsSync(abs)) throw new Error(`No such folder: ${abs}`);
      fs.cpSync(abs, staging, { recursive: true });
    }

    const manifestPath = path.join(staging, 'plugin.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('That folder has no plugin.json, so it is not a plugin.');
    }

    const manifest = readJson<Partial<PluginManifest>>(manifestPath, {});
    const name = String(manifest.name ?? '').trim();
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error('plugin.json needs a "name" using only letters, numbers, dot, dash and underscore.');
    }

    const finalRoot = path.join(pluginsDir(), name);
    fs.rmSync(finalRoot, { recursive: true, force: true });
    fs.renameSync(staging, finalRoot);

    const installed: InstalledPlugin = {
      manifest: {
        name,
        version: String(manifest.version ?? '0.0.0'),
        description: manifest.description,
        author: manifest.author,
        skills: manifest.skills,
        agents: manifest.agents,
        connectors: manifest.connectors,
      },
      root: finalRoot,
      source: { kind: isGit ? 'git' : 'folder', location: source },
      enabled: true,
      installedAt: Date.now(),
    };

    state.plugins = [...state.plugins.filter((p) => p.manifest.name !== name), installed];
    saveRegistry();
    syncConnectors();

    log(
      `Installed plugin "${name}" v${installed.manifest.version} — ` +
        `${countContributions(finalRoot, installed.manifest)}`,
    );
    return installed;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function countContributions(root: string, manifest: PluginManifest): string {
  const count = (dir: string) => {
    try {
      return fs.readdirSync(path.join(root, dir)).length;
    } catch {
      return 0;
    }
  };
  const parts = [
    count('skills') ? `${count('skills')} skill(s)` : '',
    count('agents') ? `${count('agents')} agent profile(s)` : '',
    manifest.connectors?.length ? `${manifest.connectors.length} connector(s)` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'no contributions found';
}

export function uninstallPlugin(name: string): boolean {
  const plugin = state.plugins.find((p) => p.manifest.name === name);
  if (!plugin) return false;

  fs.rmSync(plugin.root, { recursive: true, force: true });
  state.plugins = state.plugins.filter((p) => p.manifest.name !== name);
  saveRegistry();
  syncConnectors();
  log(`Removed plugin "${name}"`);
  return true;
}

export function setPluginEnabled(name: string, enabled: boolean): boolean {
  const plugin = state.plugins.find((p) => p.manifest.name === name);
  if (!plugin) return false;
  plugin.enabled = enabled;
  saveRegistry();
  syncConnectors();
  return true;
}

/**
 * Skill and agent directories contributed by enabled plugins. `skills.ts`
 * reads these alongside the project's own.
 */
export function pluginContentDirs(): { skills: string[]; agents: string[] } {
  const skills: string[] = [];
  const agents: string[] = [];
  for (const plugin of state.plugins) {
    if (!plugin.enabled) continue;
    const skillDir = path.join(plugin.root, 'skills');
    const agentDir = path.join(plugin.root, 'agents');
    if (fs.existsSync(skillDir)) skills.push(skillDir);
    if (fs.existsSync(agentDir)) agents.push(agentDir);
  }
  return { skills, agents };
}

/** Rebuild the connector list from enabled plugins plus the built-ins. */
function syncConnectors(): void {
  const fromPlugins: ConnectorDef[] = [];
  for (const plugin of state.plugins) {
    if (!plugin.enabled) continue;
    for (const connector of plugin.manifest.connectors ?? []) {
      fromPlugins.push({
        ...connector,
        // Plugin-supplied connectors always require approval to write. A
        // manifest cannot opt itself out of the human gate.
        writeRequiresApproval: true,
      });
    }
  }

  const builtin = state.connectors.filter((c) => c.transport === 'builtin');
  state.connectors = [...builtin, ...fromPlugins];
  changed();
}

function clone(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', '--depth', '1', '--', url, dest], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d.toString()));

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Cloning ${url} timed out after 60 seconds`));
    }, 60_000);
    timer.unref?.();

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not run git: ${describeError(err)}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git clone failed: ${stderr.trim().slice(-400)}`));
    });
  });
}
