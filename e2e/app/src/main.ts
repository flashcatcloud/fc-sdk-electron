import '@flashcatcloud/electron-sdk/instrument';
import { app, BrowserWindow, ipcMain, net } from 'electron';
import * as http from 'node:http';
import * as fs from 'node:fs';
import { join } from 'node:path';
import {
  init,
  addError,
  _generateTelemetryError,
  _flushTransport,
  stopSession,
  setUser,
  getUser,
  clearUser,
  startOperation,
  succeedOperation,
  failOperation,
  type FailureReason,
  type User,
  type FeatureOperationOptions,
  type InitConfiguration,
} from '@flashcatcloud/electron-sdk';

const isDebugMode = process.env.PWDEBUG === '1';
let mainWindow: BrowserWindow | null = null;
let rendererHttpServer: http.Server | null = null;
// Last window opened through one of the `openBridge*Window` handlers. Kept so a test can kill
// that renderer without taking down the window it drives the app from.
let lastBridgeWindow: BrowserWindow | null = null;

const noop = () => undefined;

function startRendererHttpServer(): Promise<number> {
  return new Promise((resolve) => {
    rendererHttpServer = http.createServer((_req, res) => {
      const htmlPath = join(__dirname, 'bridge-window.html');
      const jsPath = join(__dirname, 'bridge-window.js');

      if (_req.url === '/' || _req.url?.endsWith('.html')) {
        const html = fs.readFileSync(htmlPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
      } else if (_req.url?.endsWith('.js')) {
        const js = fs.readFileSync(jsPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(js);
      } else if (_req.url?.endsWith('.js.map')) {
        const mapPath = join(__dirname, 'bridge-window.js.map');
        try {
          const map = fs.readFileSync(mapPath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(map);
        } catch {
          res.writeHead(404);
          res.end();
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    rendererHttpServer.listen(0, () => {
      const addr = rendererHttpServer!.address() as { port: number };
      resolve(addr.port);
    });
  });
}

void app.whenReady().then(async () => {
  const config = getConfiguration();
  const initMode = getInitMode();
  console.log('Initializing SDK with config:', config, 'mode:', initMode);

  // `race` and `skip` reproduce applications that get the initialization order wrong: the window is
  // opened before the SDK is ready, or `init()` never runs at all. The bridge preload asks the main
  // process for its configuration over a *synchronous* IPC channel, so in both cases it asks before
  // `BridgeHandler` exists — and Electron leaves a synchronous request that nobody answers blocked
  // for good. Either mode must still produce a window that loads.
  if (initMode === 'race') {
    // Waiting for the window to finish loading is what makes this deterministic rather than a
    // genuine race: the preload has certainly run, and been answered by the fallback listener, by
    // the time `init()` starts. Only the catch-up push can give that window its identifiers.
    createWindow();
    await new Promise<void>((resolve) => mainWindow!.webContents.once('did-finish-load', () => resolve()));
  }

  if (initMode !== 'skip') {
    console.log('SDK initialized:', await init(config));
  }

  ipcMain.handle('generateTelemetryErrors', (_event, count: number) => {
    for (let i = 0; i < count; i++) {
      _generateTelemetryError();
    }
  });

  ipcMain.handle('stopSession', () => {
    stopSession();
  });

  ipcMain.handle('setUser', (_event, user: User) => {
    setUser(user);
  });

  ipcMain.handle('getUser', () => getUser());

  ipcMain.handle('clearUser', () => {
    clearUser();
  });

  ipcMain.handle('generateUncaughtException', () => {
    setTimeout(() => {
      throw new Error('test uncaught exception');
    });
  });

  ipcMain.handle('generateUnhandledRejection', () => {
    void Promise.reject(new Error('test unhandled rejection'));
  });

  ipcMain.handle('generateManualError', (_event, startTime?: number) => {
    addError(new Error('test manual error'), { context: { foo: 'bar' }, startTime });
  });

  ipcMain.handle('startOperation', (_event, name: string, options?: FeatureOperationOptions) => {
    startOperation(name, options);
  });

  ipcMain.handle('succeedOperation', (_event, name: string, options?: FeatureOperationOptions) => {
    succeedOperation(name, options);
  });

  ipcMain.handle(
    'failOperation',
    (_event, name: string, failureReason: FailureReason, options?: FeatureOperationOptions) => {
      failOperation(name, failureReason, options);
    }
  );

  ipcMain.handle('mainFetch', async (_event, url: string) => {
    const res = await fetch(url);
    await res.text();
    return res.status;
  });

  /**
   * Two requests in one IPC handler, one of which never comes back.
   *
   * dd-trace groups both under the handler's span, and a trace is only exported once every span in
   * it is finished — unless partial flushing is on. This is the shape that used to take the
   * completed request's resource event down with the pending one.
   */
  ipcMain.handle('mainFetchWithPendingSibling', async (_event, url: string, pendingUrl: string) => {
    void fetch(pendingUrl).catch(noop);
    const res = await fetch(url);
    await res.text();
    return res.status;
  });

  ipcMain.handle(
    'mainHttpRequest',
    (_event, url: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(url, (res) => {
          res.on('data', noop);
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('error', reject);
        req.end();
      })
  );

  ipcMain.handle(
    'mainNetRequest',
    (_event, url: string) =>
      new Promise<number>((resolve, reject) => {
        const req = net.request(url);
        req.on('response', (res) => {
          res.on('data', noop);
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.end();
      })
  );

  ipcMain.handle('flushTransport', async () => {
    await _flushTransport();
  });

  ipcMain.handle('ping', () => 'pong');

  ipcMain.handle('crash', () => {
    process.crash();
  });

  ipcMain.handle('openBridgeFileWindow', () => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: isDebugMode,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    lastBridgeWindow = win;
    void win.loadFile(join(__dirname, 'bridge-window.html'));
  });

  ipcMain.handle('openBridgeFileWindowNoIsolation', () => {
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: isDebugMode,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: false,
      },
    });
    lastBridgeWindow = win;
    void win.loadFile(join(__dirname, 'bridge-window.html'));
  });

  ipcMain.handle('openBridgeHttpWindow', async () => {
    const port = await startRendererHttpServer();
    const win = new BrowserWindow({
      width: 800,
      height: 600,
      show: isDebugMode,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    lastBridgeWindow = win;
    void win.loadURL(`http://localhost:${port}`);
  });

  /**
   * SIGKILL the last bridge window's renderer process. Electron reports this as
   * `render-process-gone` with reason `killed`, which Crashpad does not turn into a minidump —
   * exactly the dump-less class of termination `ProcessGoneCollection` exists to report.
   */
  ipcMain.handle('killBridgeWindowRenderer', () => {
    const pid = lastBridgeWindow?.webContents.getOSProcessId();
    if (!pid) {
      throw new Error('No bridge window to kill — open one first');
    }
    process.kill(pid, 'SIGKILL');
  });

  if (initMode !== 'race') {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: isDebugMode, // Hidden by default, visible in debug mode
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void mainWindow.loadFile(join(__dirname, 'main-window.html'));
}

/**
 * How the app sequences `init()` against window creation:
 * - `await` (default): the documented order — initialize fully, then create windows.
 * - `race`: create the window without waiting for `init()` to resolve.
 * - `skip`: never call `init()`, as when its configuration is rejected or the call is forgotten.
 */
function getInitMode(): 'await' | 'race' | 'skip' {
  const mode = process.env.FC_ELECTRON_SDK_INIT_MODE ?? 'await';
  if (mode !== 'await' && mode !== 'race' && mode !== 'skip') {
    throw new Error(`Unknown FC_ELECTRON_SDK_INIT_MODE: ${mode}`);
  }
  return mode;
}

function getConfiguration(): InitConfiguration {
  if (process.env.FC_ELECTRON_SDK_CONFIG) {
    return JSON.parse(process.env.FC_ELECTRON_SDK_CONFIG) as InitConfiguration;
  }
  throw new Error('FC_ELECTRON_SDK_CONFIG environment variable is not set');
}
