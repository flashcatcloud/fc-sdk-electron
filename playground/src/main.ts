// Must be imported before 'electron' — instruments electron for tracing and preload injection.
import '@flashcatcloud/electron-sdk/instrument';

import { app, BrowserWindow, ipcMain, net } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as https from 'node:https';
import {
  init,
  stopSession,
  _generateTelemetryError,
  startOperation,
  succeedOperation,
  failOperation,
  type FailureReason,
  type FeatureOperationOptions,
} from '@flashcatcloud/electron-sdk';
import { loadWindowState, saveWindowState } from './main/windowState';
import { setupHotReload } from './main/hotReload';

let mainWindow: BrowserWindow | null = null;

function getSessionFilePath(): string {
  return path.join(app.getPath('userData'), '_dd_s');
}

function createWindow() {
  const savedState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: savedState?.width ?? 1024,
    height: savedState?.height ?? 768,
    x: savedState?.x,
    y: savedState?.y,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  void mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Save window state before reload or close
  mainWindow.on('close', () => {
    if (mainWindow) {
      saveWindowState(mainWindow);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC handler to get session file content
ipcMain.handle('get-session-file', () => {
  const sessionFilePath = getSessionFilePath();
  try {
    if (fs.existsSync(sessionFilePath)) {
      const content = fs.readFileSync(sessionFilePath, 'utf-8');
      return content;
    }
    return null;
  } catch (error) {
    console.error('Error reading session file:', error);
    return null;
  }
});

ipcMain.handle('stop-session', () => {
  stopSession();
});

ipcMain.handle('generateTelemetryError', () => {
  _generateTelemetryError();
});

// IPC handler to generate uncaught exception
ipcMain.handle('generateUncaughtException', () => {
  setTimeout(() => {
    throw new Error('test uncaught exception');
  });
});

// IPC handler to generate unhandled rejection
ipcMain.handle('generateUnhandledRejection', () => {
  void Promise.reject(new Error('test unhandled rejection'));
});
// --- IPC demo handlers (each one becomes a captured IPC resource) ---

ipcMain.handle('main:fetch-api', async () => {
  const data = await new Promise<string>((resolve, reject) => {
    https
      .get('https://httpbin.org/json', (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      })
      .on('error', reject);
  });
  return JSON.parse(data) as unknown;
});

ipcMain.handle('main:fetch-api-fetch', async () => {
  const res = await fetch('https://httpbin.org/json');
  return (await res.json()) as unknown;
});

ipcMain.handle('main:fetch-api-net', async () => {
  const res = await net.fetch('https://httpbin.org/json');
  return (await res.json()) as unknown;
});

// IPC handler to crash the main process
ipcMain.handle('crash', () => {
  process.crash();
});

// IPC handler to forcefully terminate the calling renderer process.
// Exercises `render-process-gone`: macOS reports this as `killed`, other platforms as `crashed`.
ipcMain.handle('kill-renderer', (event) => {
  event.sender.forcefullyCrashRenderer();
});

// --- Operation Monitoring demo handlers ---

ipcMain.handle('main:start-operation', (_event, name: string, options?: FeatureOperationOptions) => {
  startOperation(name, options);
});

ipcMain.handle('main:succeed-operation', (_event, name: string, options?: FeatureOperationOptions) => {
  succeedOperation(name, options);
});

ipcMain.handle(
  'main:fail-operation',
  (_event, name: string, failureReason: FailureReason, options?: FeatureOperationOptions) => {
    failOperation(name, failureReason, options);
  }
);

void app.whenReady().then(async () => {
  // Initialize SDK on app ready (before window creation)
  console.log('Initializing SDK from main process...');
  const CONF = {
    staging: {
      applicationId: 'mKESnRV4wGs5nwcbTwotmW',
      clientToken: '6d12421358ed581683d6593ca6492068131',
      site: 'jira.flashcat.cloud',
    },
    prod: {
      applicationId: 'mKESnRV4wGs5nwcbTwotmW',
      clientToken: '6d12421358ed581683d6593ca6492068131',
      site: 'browser.flashcat.cloud',
    },
  };
  const result = await init({
    ...CONF.staging,
    service: 'electron-playground',
    env: 'dev',
    // Required for stack symbolication to run at all. The console only requests
    // symbolication for an error that carries a version, and the intake rejects a request
    // without one, so stacks stay unresolved until this is set. Keep it in step with
    // playground/package.json and with the renderer below -- both are one app to RUM.
    version: '0.1.0',
  });
  console.log('SDK init result:', result);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Enable hot reload (playground is dev-only)
setupHotReload();
