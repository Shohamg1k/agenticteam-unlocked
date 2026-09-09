import { state } from './store.js';

/**
 * Command sandboxing.
 *
 * Agents and users both run commands from the app. The rule is the same for
 * both, and it is not "trust the model": a command outside the allow-list
 * requires an explicit human approval, and a command on the deny-list requires
 * one even in auto mode.
 *
 * This is a guard rail, not a security boundary. A determined command can
 * always find a way through a string check — `npm run` can execute anything a
 * package.json script says. What it does buy is that the *obvious* destructive
 * mistakes (a stray `rm -rf`, a `curl | sh`) stop and ask, which is the actual
 * failure mode in practice. Real isolation is the worktree and the human gate,
 * and this file does not pretend otherwise.
 */

export type CommandVerdict =
  | { allowed: true; reason: string }
  | { allowed: false; requiresApproval: true; reason: string; risk: 'destructive' | 'network' | 'unknown' };

/** Patterns that are never auto-approved, whatever the allow-list says. */
const ALWAYS_CONFIRM: { re: RegExp; reason: string; risk: 'destructive' | 'network' }[] = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, reason: 'recursive or forced delete', risk: 'destructive' },
  { re: /\b(rmdir|del|rd)\s+\/s/i, reason: 'recursive delete', risk: 'destructive' },
  {
    re: /\bgit\s+(push|reset\s+--hard|clean\s+-[a-zA-Z]*f|filter-branch|update-ref\s+-d)/,
    reason: 'rewrites or publishes history',
    risk: 'destructive',
  },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: 'shuts down the machine', risk: 'destructive' },
  { re: /\b(mkfs|fdisk|diskpart|format)\b/, reason: 'formats a disk', risk: 'destructive' },
  { re: /\bdd\s+.*\bof=/, reason: 'writes raw blocks to a device', risk: 'destructive' },
  { re: /\bchmod\s+(-R\s+)?0?777\b/, reason: 'makes files world-writable', risk: 'destructive' },
  {
    re: /\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(ba)?sh/i,
    reason: 'pipes a download into a shell',
    risk: 'network',
  },
  { re: /\b(npm|pnpm|yarn)\s+publish\b/, reason: 'publishes a package', risk: 'network' },
  {
    re: /\b(vercel|netlify|fly|heroku|railway)\s+(deploy|up)\b/,
    reason: 'deploys to production',
    risk: 'network',
  },
  { re: /\bdocker\s+(push|system\s+prune)/, reason: 'publishes or prunes docker state', risk: 'destructive' },
  { re: /:\(\)\s*\{.*\|.*&\s*\}\s*;/, reason: 'fork bomb', risk: 'destructive' },
  { re: /\bsudo\b|\brunas\b/i, reason: 'runs with elevated privileges', risk: 'destructive' },
];

/**
 * Shell metacharacters that chain a second command onto an allowed first one.
 * `npm test && rm -rf /` must not be approved because it starts with `npm`.
 */
const CHAINING = /[;&|]|\$\(|`|\n/;

/** The executable a command line starts with, ignoring env-var prefixes. */
export function commandBinary(command: string): string {
  const trimmed = command.trim().replace(/^(?:[A-Za-z_][\w]*=[^\s]*\s+)*/, '');
  const first = trimmed.split(/\s+/)[0] ?? '';
  // Strip a path and any extension: `./node_modules/.bin/tsc` is `tsc`.
  return (first.split(/[/\\]/).pop() ?? first).replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase();
}

export function evaluateCommand(command: string): CommandVerdict {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, requiresApproval: true, reason: 'Empty command', risk: 'unknown' };

  for (const rule of ALWAYS_CONFIRM) {
    if (rule.re.test(trimmed)) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `This command ${rule.reason}, so it needs your approval.`,
        risk: rule.risk,
      };
    }
  }

  const binary = commandBinary(trimmed);
  if (state.config.deniedCommands.includes(binary)) {
    return {
      allowed: false,
      requiresApproval: true,
      reason: `\`${binary}\` is on your deny-list, so it needs your approval.`,
      risk: 'destructive',
    };
  }

  if (CHAINING.test(trimmed)) {
    // Every segment must be individually allowed; anything else is approval.
    const segments = trimmed
      .split(/&&|\|\||;|\|/)
      .map((s) => s.trim())
      .filter(Boolean);
    const blocked = segments.find((seg) => !state.config.allowedCommands.includes(commandBinary(seg)));
    if (blocked) {
      return {
        allowed: false,
        requiresApproval: true,
        reason: `This chains several commands, and \`${commandBinary(blocked)}\` is not on your allow-list.`,
        risk: 'unknown',
      };
    }
    return { allowed: true, reason: 'Every command in the chain is on your allow-list.' };
  }

  if (state.config.allowedCommands.includes(binary)) {
    return { allowed: true, reason: `\`${binary}\` is on your allow-list.` };
  }

  return {
    allowed: false,
    requiresApproval: true,
    reason: `\`${binary}\` is not on your allow-list, so it needs your approval.`,
    risk: 'unknown',
  };
}

export function allowCommand(binary: string): void {
  const normalized = binary.trim().toLowerCase();
  if (!normalized || state.config.allowedCommands.includes(normalized)) return;
  state.config.allowedCommands.push(normalized);
}
