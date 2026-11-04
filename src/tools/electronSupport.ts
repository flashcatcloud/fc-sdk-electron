import { displayWarn } from './display';

/**
 * Oldest Electron major the SDK runs on. Must match the `electron` peer dependency in package.json.
 */
export const MIN_ELECTRON_MAJOR = 30;

/**
 * Whether the SDK can run on this Electron, warning when it cannot.
 *
 * Below the floor the SDK must stay out of the way entirely rather than start half-working. The
 * main process of an older Electron runs a Node without a global `fetch`, so nothing it collects is
 * ever uploaded — and its bridge would still divert the renderers' events to it, silencing a Browser
 * SDK that reports fine on its own, while unsent batches pile up on disk. Both the instrumentation
 * entry point and `init` check this, since an application may use either without the other.
 */
export function isElectronSupported(version: string | undefined = process.versions.electron): boolean {
  const major = Number.parseInt(version ?? '', 10);
  if (major >= MIN_ELECTRON_MAJOR) {
    return true;
  }

  displayWarn(
    `Electron ${version ?? '(unknown)'} is not supported: the SDK requires Electron ${MIN_ELECTRON_MAJOR} or later ` +
      'and stays disabled. No renderer bridge is installed, so the Browser SDK in renderers keeps reporting directly.'
  );
  return false;
}
