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
    // A missing folder is by far the most common failure here — usually a typo
    // or a pasted path with a stray quote — so it gets a sentence rather than
    // a raw errno.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ProjectError(
        `There is no folder at ${abs}`,
        'Check the path for a typo. On Windows you can paste it from the address bar in Explorer.',
      );
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new ProjectError(
        `You do not have permission to read ${abs}`,
        'Pick a folder your user account owns.',
      );
    }
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

  // A patch cannot express "unset this" by omission — omission is how it says
  // "leave it alone" — so `null` is the word for it. Every optional setting
  // here has a meaningful absent state (route freely, use every agent, detect
  // the dev server), and a UI that can turn a preference on but never off is
  // not a preference.
  const next: Record<string, unknown> = { ...project.settings };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  project.settings = next as unknown as ProjectSettings;
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
  /**
   * How to run this project for the preview.
   *
   * `support` is for the halves of an app that are not the one you look at. A
   * MERN project with no root script has a `client` and a `server` and no
   * `concurrently` to tie them together — starting only the client gives you a
   * UI whose every request fails, which is a worse kind of broken than no
   * preview at all, because it looks like the app is at fault.
   */
  devServer?: { command: string; port: number; support?: string[] };
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
    } else {
      // No script, but a server all the same. A generated Express app is
      // frequently a package.json with dependencies and a server.js, and
      // nothing else — refusing to preview it because the author did not think
      // to add a `start` script is a technicality the user has to solve for us.
      const entry = ['server.js', 'app.js', 'index.js', 'main.js', 'src/server.js', 'src/index.js'].find(
        (candidate) => fs.existsSync(path.join(root, candidate)),
      );
      if (entry) {
        profile.devServer = { command: `node ${entry}`, port: guessDevPort(profile.frameworks) };
      } else {
        // Still nothing, so look one level down. A MERN app frequently keeps
        // its dev script in `client/package.json` and leaves the root as a
        // holder for `concurrently` — or has no root manifest worth running at
        // all. Reading only the root made the whole project look like a folder
        // of static files, which is how a React shell ended up being served as
        // a plain page and failing its own verification.
        const sub = findSubProjectDevServer(root);
        if (sub) profile.devServer = sub;
      }
    }
  } else if (
    fs.existsSync(path.join(root, 'pyproject.toml')) ||
    fs.existsSync(path.join(root, 'requirements.txt')) ||
    fs.existsSync(path.join(root, 'manage.py'))
  ) {
    profile.ecosystem = 'python';
    profile.checks = {
      test:
        fs.existsSync(path.join(root, 'pytest.ini')) || fs.existsSync(path.join(root, 'tests'))
          ? 'pytest'
          : undefined,
      lint: fs.existsSync(path.join(root, 'ruff.toml')) ? 'ruff check .' : undefined,
    };

    /**
     * Python web apps, in the order they are worth guessing.
     *
     * Django is unambiguous — `manage.py` exists or it does not. Flask and
     * FastAPI are told apart by what the entry file imports, because both are
     * a single module with an `app` in it and the run command differs
     * completely between them.
     *
     * No virtualenv is created or activated. Doing that well means owning
     * Python environments, which is a project of its own, so the command runs
     * against whatever `python` is on PATH and a missing dependency surfaces as
     * the dev server's own error rather than as something invented here.
     */
    if (fs.existsSync(path.join(root, 'manage.py'))) {
      profile.frameworks.push('Django');
      profile.devServer = { command: 'python manage.py runserver', port: 8000 };
    } else {
      const entry = ['main.py', 'app.py', 'server.py', 'src/main.py', 'app/main.py'].find((candidate) =>
        fs.existsSync(path.join(root, candidate)),
      );
      if (entry) {
        const source = readTextFile(path.join(root, entry));
        const moduleName = entry.replace(/\.py$/, '').split(/[\\/]/).join('.');
        if (/\bfrom\s+fastapi\b|\bimport\s+fastapi\b/.test(source)) {
          profile.frameworks.push('FastAPI');
          profile.devServer = { command: `uvicorn ${moduleName}:app --reload --port 8000`, port: 8000 };
        } else if (/\bfrom\s+flask\b|\bimport\s+flask\b/i.test(source)) {
          profile.frameworks.push('Flask');
          profile.devServer = { command: `python ${entry}`, port: 5000 };
        }
      }
    }
  } else if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    profile.ecosystem = 'rust';
    profile.checks = { typecheck: 'cargo check', test: 'cargo test', build: 'cargo build' };
  } else if (fs.existsSync(path.join(root, 'go.mod'))) {
    profile.ecosystem = 'go';
    profile.checks = { typecheck: 'go vet ./...', test: 'go test ./...', build: 'go build ./...' };
    if (fs.existsSync(path.join(root, 'main.go'))) {
      profile.devServer = { command: 'go run .', port: 8080 };
    }
  }

  /**
   * Last resort: a project that is only its sub-projects.
   *
   * A MERN app with no root package.json is a completely ordinary layout —
   * just `client/` and `server/`, each self-contained — and every branch above
   * asks about the root. So this one found no ecosystem, no dev server, and a
   * `client/index.html`, concluded it was a folder of static files, and served
   * a React shell as a plain page.
   *
   * The check that catches it has to run outside the chain, because the whole
   * chain is conditioned on a root manifest that is not there.
   */
  if (!profile.devServer) {
    const sub = findSubProjectDevServer(root);
    if (sub) {
      profile.devServer = sub;
      if (profile.ecosystem === 'unknown') profile.ecosystem = 'node';
    }
  }

  // Explicit settings always win over detection.
  if (settings?.checks) profile.checks = { ...profile.checks, ...settings.checks };
  if (settings?.devServer) profile.devServer = settings.devServer;

  return profile;
}

/**
 * A dev server in a conventional sub-project.
 *
 * Runs it from the sub-project's own directory, because that is where its
 * package.json and its node_modules are. The client is preferred over the
 * server: it is the half a person wants to look at, and landing on the API
 * would show a JSON endpoint and read as a broken preview.
 */
function findSubProjectDevServer(
  root: string,
): { command: string; port: number; support?: string[] } | undefined {
  const found: { name: string; command: string; port: number }[] = [];

  for (const name of ['client', 'frontend', 'web', 'ui', 'app', 'server', 'api', 'backend']) {
    const dir = path.join(root, name);
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { scripts?: Record<string, string> };
      const script = ['dev', 'start', 'serve'].find((s) => pkg.scripts?.[s]);
      if (!script) continue;

      const frameworks: string[] = [];
      const source = readTextFile(manifest);
      if (/"vite"/.test(source)) frameworks.push('Vite');
      if (/"next"/.test(source)) frameworks.push('Next.js');

      found.push({
        name,
        // `--prefix` so it runs in the sub-project, where its package.json and
        // its node_modules are.
        command: `npm --prefix ${name} run ${script}`,
        port: guessDevPort(frameworks),
      });
    } catch {
      // An unreadable manifest is not a dev server.
    }
  }

  if (!found.length) return undefined;

  // The first match is the one to look at — the list is ordered front end
  // first, because landing on the API shows a JSON endpoint and reads as a
  // broken preview. Everything else starts alongside it, unwatched.
  const [primary, ...support] = found;
  return {
    command: primary!.command,
    port: primary!.port,
    support: support.length ? support.map((s) => s.command) : undefined,
  };
}

/** Read a small source file, or nothing. Used only to tell frameworks apart. */
function readTextFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, 8_000);
  } catch {
    return '';
  }
}

function guessDevPort(frameworks: string[]): number {
  if (frameworks.includes('Next.js')) return 3000;
  if (frameworks.includes('Vite')) return 5173;
  if (frameworks.includes('Angular')) return 4200;
  return 3000;
}
