/**
 * Turning model output into files on disk.
 *
 * Every path that reaches the filesystem passes through `sanitizeRelPath`.
 * That function is the entire boundary between "a model said something" and
 * "we wrote to the user's machine", so it refuses far more than it needs to:
 * absolute paths, drive letters, UNC prefixes, traversal, reserved Windows
 * device names, and anything with a control character.
 */

export interface FileArtifact {
  /** Workspace-relative, forward-slashed, validated. */
  path: string;
  content: string;
}

/** Belt-and-braces caps so a runaway model cannot exhaust memory or the disk. */
export const MAX_ARTIFACTS = 60;
export const MAX_ARTIFACT_BYTES = 1_000_000;
export const MAX_PATH_LENGTH = 200;

/**
 * Windows refuses these as filenames regardless of extension. Rejecting them
 * everywhere (not only on win32) keeps a repo built on macOS from being
 * un-checkout-able on Windows.
 */
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/**
 * Reject anything that could escape the workspace or break a checkout.
 * Returns the normalised path, or null when the path is not acceptable.
 */
export function sanitizeRelPath(input: string): string | null {
  if (typeof input !== 'string') return null;
  const norm = input.trim().replaceAll('\\', '/').replace(/^\.\//, '');

  if (!norm || norm.length > MAX_PATH_LENGTH) return null;
  // Absolute (POSIX), drive-letter or UNC (Windows), or home-relative.
  if (/^([a-zA-Z]:|\/|~|\/\/)/.test(norm)) return null;
  // Control characters and the characters Windows refuses in a filename.
  // Checked by code point rather than a regex class so no control byte ever
  // has to appear literally in this source file.
  for (const ch of norm) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return null;
  }
  if (/[<>:"|?*]/.test(norm)) return null;

  const segments = norm.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (RESERVED_WINDOWS_NAMES.test(seg)) return null;
    // Trailing dots and spaces are silently stripped by Windows, which turns
    // two distinct paths into one file.
    if (/[ .]$/.test(seg)) return null;
  }
  // Writing into .git corrupts the repo and can execute code via hooks.
  if (segments[0] === '.git') return null;

  return segments.join('/');
}

/**
 * The canonical artifact format agents are asked to emit:
 *
 *     FILE: src/components/Login.tsx
 *     ```tsx
 *     ...contents...
 *     ```
 *
 * Tolerant of the decorations models add unprompted — heading hashes, bold
 * markers, backticks or quotes around the path, `File:` in any case, and a
 * language tag on the fence. Not tolerant of anything that changes the path.
 */
const FILE_BLOCK_RE =
  /^[#*\s>]*(?:file|path)\s*:\s*[`"']?([^\r\n`"']+?)[`"']?[*\s]*$\r?\n+[ \t]*(`{3,}|~{3,})[^\n]*\r?\n([\s\S]*?)^[ \t]*\2[ \t]*$/gim;

export function extractFiles(output: string): FileArtifact[] {
  const files: FileArtifact[] = [];
  const seen = new Set<string>();
  FILE_BLOCK_RE.lastIndex = 0;

  let m: RegExpExecArray | null;
  while ((m = FILE_BLOCK_RE.exec(output)) !== null) {
    if (files.length >= MAX_ARTIFACTS) break;
    const rel = sanitizeRelPath(m[1] ?? '');
    if (!rel) continue;
    const content = m[3] ?? '';
    if (content.length > MAX_ARTIFACT_BYTES) continue;

    // A model that re-emits a file after a correction means the later one.
    if (seen.has(rel)) {
      const idx = files.findIndex((f) => f.path === rel);
      if (idx >= 0) files[idx] = { path: rel, content };
      continue;
    }
    seen.add(rel);
    files.push({ path: rel, content });
  }
  return files;
}

/**
 * Instructions appended to every execution prompt. Kept here, next to the
 * parser, so the format and its parser can never drift apart.
 */
export const ARTIFACT_FORMAT_INSTRUCTIONS = `## Output format

Emit every file you create or change as a complete file, in this exact form:

FILE: relative/path/from/project/root.ext
\`\`\`language
<the entire file contents>
\`\`\`

Rules:
- Paths are relative to the project root. Never absolute, never \`..\`.
- Emit the COMPLETE file every time. Never a diff, never a fragment, never
  "... rest unchanged". A truncated file fails the syntax gate and is sent back.
- One FILE: block per file. Re-emitting a path replaces the earlier block.
- Prose outside the blocks is fine and is shown to the user, but only the
  blocks are written to disk.`;

/**
 * Detect the fenced-block language a path should use, for prompts and for the
 * diff viewer's syntax highlighting.
 */
export function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    css: 'css',
    scss: 'scss',
    html: 'html',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    rb: 'ruby',
    php: 'php',
    sh: 'shell',
    bash: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    sql: 'sql',
    prisma: 'prisma',
  };
  return map[ext] ?? 'text';
}

/**
 * Files a task produced that were not in its declared `expectedFiles`.
 * Not an error — planners under-declare constantly — but the file-lock manager
 * needs to know, and a task writing far outside its lane is worth surfacing.
 */
export function undeclaredFiles(produced: FileArtifact[], expected: string[] | undefined): string[] {
  if (!expected?.length) return [];
  const declared = new Set(
    expected.map((f) => sanitizeRelPath(f)?.toLowerCase()).filter(Boolean) as string[],
  );
  return produced.map((f) => f.path).filter((p) => !declared.has(p.toLowerCase()));
}
