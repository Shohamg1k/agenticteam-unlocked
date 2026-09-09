import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import express from 'express';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@agentic/core';
import { PROTOCOL_VERSION } from '@agentic/core';
import { buildRouter } from './routes.js';
import { buildSnapshot } from './snapshot.js';
import { buildRegistry, probeAll, setAgentPermissions, startProbeLoop } from './providers/index.js';
import { loadQuota, startQuotaAutosave } from './quota.js';
import { initVault } from './vault.js';
import { loadNodeState, onChange, state, flushWrites, projectState } from './store.js';
import { loadPlugins } from './plugins.js';
import { disconnectAll, loadConnectors, refreshConnectors } from './connectors/index.js';
import { onRunEvent } from './orchestrator.js';
import { closeAllTerminals, subscribeTerminal, resizeTerminal, writeTerminal } from './pty.js';
import { stopAllPreviews } from './preview.js';
import { stopAllWatchers, watchProject } from './fsapi.js';
import { loadSkills, loadAgents } from './skills.js';
import { loadMemory } from './memory.js';
import { loadReliability } from './router.js';
import { describeError, log } from './log.js';

/**
 * The local core service.
 *
 * Binds 127.0.0.1 only. It is the only process that holds credentials or calls
 * a model; the renderer talks to it over HTTP and one WebSocket and holds
 * nothing sensitive.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.AGENTIC_PORT ?? 4400);
const HOST = '127.0.0.1';

export async function startServer(): Promise<{ port: number; close: () => Promise<void> }> {
  await initVault();
  loadQuota();
  loadNodeState();
  loadPlugins();
  loadConnectors();
  buildRegistry();
  setAgentPermissions('yolo');

  // Warm the active project so the first snapshot is complete.
  if (state.activeProjectId) {
    const ps = projectState(state.activeProjectId);
    if (ps) {
      loadSkills(ps.projectId);
      loadAgents(ps.projectId);
      loadMemory(ps.projectId);
      loadReliability(ps.projectId);
    }
  }

  const app = express();
  app.use(express.json({ limit: '25mb' }));

  // The renderer runs on the Vite dev server in development and from a file://
  // origin in the packaged app. Both are local; nothing else may reach this.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use('/api', buildRouter());

  // In the packaged app the built web UI is served from here; in development
  // Vite serves it and this is simply absent.
  const webDist = path.resolve(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  /**
   * Last-resort error handler.
   *
   * Registered last, and with four parameters so Express recognises it as an
   * error handler. Without it, anything that throws before a route runs — a
   * malformed JSON body is the common one — falls through to Express's default
   * handler, which returns an HTML page. A client that only ever parses JSON
   * then fails on the error itself and reports something unrelated.
   */
  app.use(
    (
      err: Error & { status?: number; type?: string },
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (res.headersSent) return next(err);

      const malformedBody = err.type === 'entity.parse.failed';
      const tooLarge = err.type === 'entity.too.large';
      const status = malformedBody ? 400 : tooLarge ? 413 : (err.status ?? 500);

      if (!malformedBody && !tooLarge) {
        log(`${req.method} ${req.path} failed: ${describeError(err)}`, 'error');
      }

      res.status(status).json({
        error: malformedBody
          ? 'That request body was not valid JSON.'
          : tooLarge
            ? 'That request body is too large.'
            : describeError(err),
        hint: malformedBody
          ? 'Check the escaping — a Windows path needs its backslashes doubled in JSON.'
          : undefined,
      });
    },
  );

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // `ws` re-emits the http server's errors on itself. Without a handler here,
  // a failed listen (a second copy of the app, most commonly) becomes an
  // unhandled 'error' event and Node exits with a raw stack trace — throwing
  // away the actionable message the listen path below is written to produce.
  wss.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') return; // The listen handler reports this one.
    log(`WebSocket server error: ${describeError(err)}`, 'error');
  });

  // -------------------------------------------------------------------------
  // WebSocket: one snapshot channel plus high-frequency run and terminal data
  // -------------------------------------------------------------------------

  interface Session {
    socket: WebSocket;
    projectId?: string;
    /** Task ids whose model output this client is following. */
    watching: Set<string>;
    terminalUnsubs: Map<string, () => void>;
  }

  const sessions = new Set<Session>();

  const send = (session: Session, message: ServerMessage) => {
    if (session.socket.readyState !== session.socket.OPEN) return;
    try {
      session.socket.send(JSON.stringify(message));
    } catch (err) {
      log(`Could not send to a client: ${describeError(err)}`, 'warn');
    }
  };

  /**
   * Snapshot broadcasts are coalesced. A running plan mutates state on every
   * streamed chunk; serialising the whole snapshot each time would spend more
   * CPU on JSON than on the work.
   */
  let broadcastTimer: NodeJS.Timeout | undefined;
  const scheduleBroadcast = () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = undefined;
      for (const session of sessions) {
        send(session, { type: 'snapshot', snapshot: buildSnapshot(session.projectId) });
      }
    }, 120);
    broadcastTimer.unref?.();
  };

  const offChange = onChange(scheduleBroadcast);

  // Per-token model output goes on its own path, only to clients watching it.
  const offRunEvent = onRunEvent((taskId, event) => {
    for (const session of sessions) {
      if (session.watching.has(taskId)) send(session, { type: 'run:event', taskId, event });
    }
  });

  wss.on('connection', (socket) => {
    const session: Session = { socket, watching: new Set(), terminalUnsubs: new Map() };
    sessions.add(session);
    send(session, { type: 'snapshot', snapshot: buildSnapshot() });

    socket.on('message', (raw) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return send(session, { type: 'error', message: 'Malformed message' });
      }

      switch (message.type) {
        case 'hello':
          if (message.protocolVersion !== PROTOCOL_VERSION) {
            send(session, {
              type: 'error',
              message: `This client speaks protocol v${message.protocolVersion}; the server speaks v${PROTOCOL_VERSION}. Restart the app to update.`,
            });
          }
          break;

        case 'subscribe':
          session.projectId = message.projectId;
          send(session, { type: 'snapshot', snapshot: buildSnapshot(message.projectId) });
          break;

        case 'run:subscribe':
          session.watching.add(message.taskId);
          break;

        case 'run:unsubscribe':
          session.watching.delete(message.taskId);
          break;

        case 'terminal:input': {
          if (!session.terminalUnsubs.has(message.terminalId)) {
            const unsub = subscribeTerminal(
              message.terminalId,
              (data) => send(session, { type: 'terminal:data', terminalId: message.terminalId, data }),
              (code) => send(session, { type: 'terminal:exit', terminalId: message.terminalId, code }),
            );
            if (unsub) session.terminalUnsubs.set(message.terminalId, unsub);
          }
          writeTerminal(message.terminalId, message.data);
          break;
        }

        case 'terminal:resize':
          resizeTerminal(message.terminalId, message.cols, message.rows);
          break;

        case 'ping':
          send(session, { type: 'pong' });
          break;
      }
    });

    socket.on('close', () => {
      for (const unsub of session.terminalUnsubs.values()) unsub();
      sessions.delete(session);
    });

    socket.on('error', () => {
      for (const unsub of session.terminalUnsubs.values()) unsub();
      sessions.delete(session);
    });
  });

  // -------------------------------------------------------------------------
  // File watching — an editor tab reloads when an agent writes the file
  // -------------------------------------------------------------------------

  const watchActiveProject = () => {
    if (!state.activeProjectId) return;
    const ps = projectState(state.activeProjectId);
    if (!ps) return;
    watchProject(ps.projectId, ps.root, (paths) => {
      for (const session of sessions) {
        send(session, { type: 'fs:changed', projectId: ps.projectId, paths });
      }
    });
  };
  watchActiveProject();
  const offWatchSync = onChange(watchActiveProject);

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------

  await probeAll();
  void refreshConnectors();
  const stopProbing = startProbeLoop();
  const stopQuotaAutosave = startQuotaAutosave();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (err.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${PORT} is already in use. Another copy of Agentic Team is probably running. ` +
              `Close it, or set AGENTIC_PORT to a different port.`,
          ),
        );
      } else {
        reject(err);
      }
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(PORT, HOST);
  });

  const ready = [
    `Agentic Team core service on http://${HOST}:${PORT}`,
    `${state.projects.length} project(s), ${state.plugins.length} plugin(s)`,
  ].join(' — ');
  log(ready);

  const close = async () => {
    offChange();
    offRunEvent();
    offWatchSync();
    stopProbing();
    stopQuotaAutosave();
    if (broadcastTimer) clearTimeout(broadcastTimer);

    closeAllTerminals();
    stopAllPreviews();
    stopAllWatchers();
    await disconnectAll();
    flushWrites();

    for (const session of sessions) session.socket.close();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    log('Core service stopped');
  };

  return { port: PORT, close };
}

// Started directly (`npm run dev -w @agentic/server`) rather than embedded in
// the desktop shell.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  let closer: (() => Promise<void>) | undefined;

  startServer()
    .then(({ close }) => {
      closer = close;
    })
    .catch((err) => {
      log(`Could not start: ${describeError(err)}`, 'error');
      process.exit(1);
    });

  const shutdown = (signal: string) => {
    log(`Received ${signal}, shutting down`);
    void (closer?.() ?? Promise.resolve()).finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
