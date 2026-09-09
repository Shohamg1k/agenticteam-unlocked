import fs from 'node:fs';
import path from 'node:path';
import type { Project, ProjectSettings } from '@agentic/core';
import { DEFAULT_PLAN_BUDGET, rid } from '@agentic/core';
import { ensureDir, projectPaths, readJson, writeJsonAtomic } from './paths.js';
import { defaultProjectSettings, projectState, saveProjects, state } from './store.js';
import { ensureRepo, pruneWorktrees } from './git.js';
import { describeError, log } from './log.js';

/**
 * Projects: binding the app to a folder on disk.
 *
 * The brief's rule is load-bearing — "all generated files are written there
 * (no hidden sandbox)". Everything an agent produces lands in the user's real
 * folder after they accept it. Worktrees are used for *isolation while
 * running*, never as a place output quietly lives instead.
 */

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ProjectError';
  }
}

export function listProjects(): Project[] {
  return [...state.projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

export function getProject(id: string): Project | undefined {
  return state.projects.find((p) => p.id === id);
}

/**
 * Open a folder as a project. Idempotent: opening the same folder twice
 * returns the existing project rather than creating a duplicate, because users
 * do that constantly and two projects on one folder would fight over locks.
 */
export async function openProject(root: string, name?: string): Promise<Project> {
  const abs = path.resolve(root);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (err) {
    throw new ProjectError(
      `Cannot open ${abs}: ${describeError(err)}`,
      'Check the path exists and is readable.',
    );
  }
  if (!stat.isDirectory()) {
    throw new ProjectError(`${abs} is not a folder`, 'Pick a project folder, not a file.');
  }
  try {
    fs.accessSync(abs, fs.constants.W_OK);
  } catch {
    throw new ProjectError(
      `${abs} is not writable`,
      'Agents write into your project folder, so it must be writable. Check the folder permissions.',
    );
  }

  const existing = state.projects.find((p) => path.resolve(p.root) === abs);
  if (existing) {
    existing.lastOpenedAt = Date.now();
    state.activeProjectId = existing.id;
    saveProjects();
    await prepareProject(existing);
    return existing;
  }

  const project: Project = {
    id: rid('proj'),
    name: name?.trim() || path.basename(abs) || 'Untitled project',
    root: abs,
    createdAt: Date.now(),
    lastOpenedAt: Date.now(),
    settings: loadProjectSettings(abs),
  };

  state.projects.push(project);
  state.activeProjectId = project.id;
  saveProjects();
  await prepareProject(project);
  log(`Opened project "${project.name}" at ${abs}`, 'info', { projectId: project.id });
  return project;
}

/**
 * One-time setup per open: make sure `.agentic-team/` exists, make sure the
 * folder is a git repo (checkpoints and rollback depend on it), and clear any
 * worktrees a previous crash left behind.
 */
async function prepareProject(project: Project): Promise<void> {
  ensureDir(projectPaths(project.root).base);
  try {
    const { created } = await ensureRepo(project.root);
    if (created) {
      log(
        `Created a git repository in "${project.name}" — this is what makes checkpoints and one-click rollback work`,
        'info',
        { projectId: project.id },
      );
    }
    await pruneWorktrees(project.root);
  } catch (err) {
    // A project without git still works for editing and chat; it loses
    // checkpoints and worktree-isolated verification. Say so plainly rather
    // than failing the open or pretending those features work.
    log(
      `Git is unavailable for "${project.name}" (${describeError(err)}). ` +
        'Checkpoints, rollback and isolated verification are disabled for this project.',
      'warn',
      { projectId: project.id },
    );
  }
  // Force the project state to load so plans are in memory for the snapshot.
  projectState(project.id);
}

export function closeProject(id: string): void {
  const idx = state.projects.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const [removed] = state.projects.splice(idx, 1);
  state.byProject.delete(id);
  if (state.activeProjectId === id) state.activeProjectId = state.projects[0]?.id;
  saveProjects();
  // The folder is untouched: closing a project removes it from the list, not
  // from the disk. Anything else would be a destructive surprise.
  log(`Closed project "${removed?.name ?? id}". Your files were not modified.`);
}

export function setActiveProject(id: string): void {
  const project = getProject(id);
  if (!project) throw new ProjectError(`No such project: ${id}`);
  project.lastOpenedAt = Date.now();
  state.activeProjectId = id;
  saveProjects();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadProjectSettings(root: string): ProjectSettings {
  const stored = readJson<Partial<ProjectSettings>>(projectPaths(root).config, {});
  return {
    ...defaultProjectSettings(),
    ...stored,
    budget: { ...DEFAULT_PLAN_BUDGET, ...(stored.budget ?? {}) },
    skills: stored.skills ?? [],
  };
}

export function saveProjectSettings(projectId: string, patch: Partial<ProjectSettings>): ProjectSettings {
  const project = getProject(projectId);
  if (!project) throw new ProjectError(`No such project: ${projectId}`);
  project.settings = { ...project.settings, ...patch };
  writeJsonAtomic(projectPaths(project.root).config, project.settings);
  saveProjects();
  return project.settings;
}

// ---------------------------------------------------------------------------
// Project introspection — what kind of project is this?
// ---------------------------------------------------------------------------

export interface ProjectProfile {
  /** Detected package manager, when there is one. */
  packageManager?: 'npm' | 'pnpm' | 'yarn' | 'bun';
  /** Detected ecosystem, for prompts and for check detection. */
  ecosystem: 'node' | 'python' | 'rust' | 'go' | 'java' | 'unknown';
  /** Scripts the project defines, for the verification tier-2 gate. */
  scripts: Record<string, string>;
  /** Commands tier 2 should run, resolved from settings or detection. */
  checks: { typecheck?: string; lint?: string; test?: string; build?: string };
  /** Dev server command and port, for the preview tab. */
  devServer?: { command: string; port: number };
  frameworks: string[];
}

/**
 * Work out how to build, test and run this project.
 *
 * Detection is conservative: a check that cannot be detected is left undefined
 * so tier 2 reports it as *skipped with a reason* rather than inventing a
 * command that fails and marks good work as broken.
 */
export function profileProject(root: string): ProjectProfile {
  const profile: ProjectProfile = { ecosystem: 'unknown', scripts: {}, checks: {}, frameworks: [] };
  const settings = state.projects.find((p) => path.resolve(p.root) === path.resolve(root))?.settings;

  const pkgPath = path.join(root, 'package.json');
  if (fs.existsSync(pkgPath)) {
    profile.ecosystem = 'node';
    const pkg = readJson<{
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }>(pkgPath, {});
    profile.scripts = pkg.scripts ?? {};

    profile.packageManager = fs.existsSync(path.join(root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : fs.existsSync(path.join(root, 'yarn.lock'))
        ? 'yarn'
        : fs.existsSync(path.join(root, 'bun.lockb'))
          ? 'bun'
          : 'npm';

    const run = (script: string) =>
      profile.packageManager === 'npm' ? `npm run ${script}` : `${profile.packageManager} ${script}`;

    // Only claim a check exists if the project actually defines the script.
    const pick = (...names: string[]) => names.find((n) => profile.scripts[n]);
    const typecheck = pick('typecheck', 'type-check', 'tsc');
    const lint = pick('lint');
    const test = pick('test');
    const build = pick('build');

    profile.checks = {
      typecheck: typecheck
        ? run(typecheck)
        : fs.existsSync(path.join(root, 'tsconfig.json'))
          ? 'npx tsc --noEmit'
          : undefined,
      lint: lint ? run(lint) : undefined,
      test: test ? run(test) : undefined,
      build: build ? run(build) : undefined,
    };

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, framework] of [
      ['next', 'Next.js'],
      ['react', 'React'],
      ['vue', 'Vue'],
      ['svelte', 'Svelte'],
      ['@angular/core', 'Angular'],
      ['vite', 'Vite'],
      ['express', 'Express'],
      ['fastify', 'Fastify'],
      ['prisma', 'Prisma'],
      ['tailwindcss', 'Tailwind CSS'],
    ] as const) {
      if (deps?.[name]) profile.frameworks.push(framework);
    }

    const devScript = pick('dev', 'start', 'serve');
    if (devScript) {
      profile.devServer = { command: run(devScript), port: guessDevPort(profile.frameworks) };
    }
  } else if (
    fs.existsSync(path.join(root, 'pyproject.toml')) ||
    fs.existsSync(path.join(root, 'requirements.txt'))
  ) {
    profile.ecosystem = 'python';
    profile.checks = {
      test:
        fs.existsSync(path.join(root, 'pytest.ini')) || fs.existsSync(path.join(root, 'tests'))
          ? 'pytest'
          : undefined,
      lint: fs.existsSync(path.join(root, 'ruff.toml')) ? 'ruff check .' : undefined,
    };
  } else if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    profile.ecosystem = 'rust';
    profile.checks = { typecheck: 'cargo check', test: 'cargo test', build: 'cargo build' };
  } else if (fs.existsSync(path.join(root, 'go.mod'))) {
    profile.ecosystem = 'go';
    profile.checks = { typecheck: 'go vet ./...', test: 'go test ./...', build: 'go build ./...' };
  }

  // Explicit settings always win over detection.
  if (settings?.checks) profile.checks = { ...profile.checks, ...settings.checks };
  if (settings?.devServer) profile.devServer = settings.devServer;

  return profile;
}

function guessDevPort(frameworks: string[]): number {
  if (frameworks.includes('Next.js')) return 3000;
  if (frameworks.includes('Vite')) return 5173;
  if (frameworks.includes('Angular')) return 4200;
  return 3000;
}
