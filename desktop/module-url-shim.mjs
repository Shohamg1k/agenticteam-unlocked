/**
 * Stands in for `import.meta.url` when the ESM server is bundled into
 * Electron's CommonJS main process. `__filename` is the bundle itself, which
 * is the correct answer for every use of it in this codebase: they all resolve
 * a directory next to the running module.
 */
import { pathToFileURL } from 'node:url';

export const __agenticModuleUrl = pathToFileURL(__filename).href;
