import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { generateUUID, type TimeStamp } from '@flashcatcloud/browser-core';
import { app, crashReporter } from 'electron';
import { EventFormat, EventKind, EventManager, EventSource } from '../../../event';
import type { CrashReport } from '../../../wasm';
import type { RawRumError } from '../rawRumData.types';
import type { RumErrorEvent } from '../rumEvent.types';
import { displayError, displayInfo } from '../../../tools/display';
import { addError, monitor } from '../../telemetry';
import { toIntakeTimeStamp } from '../../../tools/intakeTimeStamp';

/**
 * Collect RUM error events for native crashes.
 * - Electron crashReporter store .dmp files on crashes
 * - At startup:
 *   - scans crash dump directory for .dmp files recursively
 *   - processes each sequentially through the WASM minidump-processor
 *   - emits RUM error events
 */
export class CrashCollection {
  private constructor(private readonly eventManager: EventManager) {}

  static start(eventManager: EventManager): CrashCollection {
    crashReporter.start({ uploadToServer: false, ignoreSystemCrashHandler: true });
    const collection = new CrashCollection(eventManager);
    // TODO(RUM-15046): wait for app to be stable (electron + browser windows)
    void app.whenReady().then(monitor(() => collection.processCrashFiles()));
    return collection;
  }

  private async processCrashFiles(): Promise<void> {
    const crashDumpsPath = app.getPath('crashDumps');
    const dmpFiles = await getFilesRecursive(crashDumpsPath, '.dmp');

    if (dmpFiles.length === 0) {
      return;
    }

    // Dynamic import to avoid loading the ~1.6MB WASM binary into memory when there are no dumps
    const { processMinidump } = await import('../../../wasm');
    displayInfo(`${dmpFiles.length} crash dumps to process`);

    for (const filePath of dmpFiles) {
      try {
        const fileStat = await fs.stat(filePath);
        // birthtimeMs can be 0 on Linux (ext4), fall back to mtimeMs.
        // Both carry sub-millisecond precision — `1785900421429.7532`, say — hence the rounding;
        // see `toIntakeTimeStamp` for what an unrounded one costs.
        const crashTime = toIntakeTimeStamp(fileStat.birthtimeMs || fileStat.mtimeMs);
        const bytes = new Uint8Array(await fs.readFile(filePath));
        const crashReport = await processMinidump(bytes);

        this.eventManager.notify({
          kind: EventKind.RAW,
          source: EventSource.MAIN,
          format: EventFormat.RUM,
          data: buildCrashErrorEvent(crashReport, crashTime),
          startTime: crashTime,
        });
      } catch (error) {
        addError(error);
        displayError('Failed to process crash dump:', filePath, error);
      } finally {
        await discardCrashFile(filePath);
      }
    }
    displayInfo(`Crash dump processing done.`);
  }
}

/**
 * Delete a crash dump once it has been handled.
 *
 * This runs whether or not the dump could be processed: a dump kept on disk is
 * picked up again on every startup, so a permanently failing dump would be
 * retried forever, let the crash dump directory grow without bound, and make
 * each startup slower since every dump loads the WASM processor.
 */
async function discardCrashFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    addError(error);
    displayError('Failed to delete crash dump:', filePath, error);
  }
}

/**
 * Format a memory address as a 64-bit hexadecimal string (16 hex digits with 0x prefix).
 * Example: '0x7fff5fc01000' → '0x00007fff5fc01000'
 */
function formatAddress64(address: string | undefined): string | undefined {
  if (!address) {
    return undefined;
  }
  const hexValue = address.toLowerCase().replace(/^0x/, '');
  return `0x${hexValue.padStart(16, '0')}`;
}

/**
 * Calculate max address (base + size) using BigInt for 64-bit safe arithmetic.
 */
function calculateMaxAddress(baseAddress: string | undefined, size: number | undefined): string | undefined {
  if (!baseAddress || !size) {
    return undefined;
  }
  const hexValue = baseAddress.toLowerCase().replace(/^0x/, '');
  const maxAddressBigInt = BigInt(`0x${hexValue}`) + BigInt(size);
  return formatAddress64(`0x${maxAddressBigInt.toString(16)}`);
}

/**
 * Build a RUM error event out of a processed minidump.
 *
 * `crash_info` is absent for dumps taken from a process that was terminated
 * without raising an exception. The event is still worth reporting: threads,
 * binary images and system info are all available, only the exception type, the
 * faulting address and the crashed thread are unknown.
 */
function buildCrashErrorEvent(crashReport: CrashReport, crashTime: TimeStamp): RawRumError {
  const threads = formatThreads(crashReport);
  const crashedThread = threads.find((t) => t.crashed);
  const exceptionType = crashReport.crash_info?.type;
  const fingerprint = computeCrashFingerprint(crashReport);
  // The faulting address, under the RUM schema's field for "CPU specific information about the
  // exception encoded into 64-bit hexadecimal number". It goes here rather than under a name of
  // our own because the intake decodes `error.meta` into a fixed set of fields and drops the rest,
  // so an invented key would never reach the console. It is often the only usable lead when the
  // exception type itself carries no name — a minidump written without a real exception record
  // reports its type as `unknown 0x00000000 / 0x00000000`, but still records where it faulted.
  const exceptionCodes = formatAddress64(crashReport.crash_info?.address);

  return {
    date: crashTime,
    type: 'error',
    error: {
      id: generateUUID(),
      message: 'Application crashed',
      source: 'source',
      handling: 'unhandled',
      is_crash: true,
      category: 'Exception',
      type: exceptionType,
      was_truncated: false,
      // Spread rather than `fingerprint` directly: an explicit `undefined` would still serialize
      // as an own property, and the backend treats any present fingerprint as authoritative.
      ...(fingerprint !== undefined ? { fingerprint } : {}),
      meta: {
        code_type: crashReport.system_info.cpu,
        process: app.getName(),
        exception_type: exceptionType,
        exception_codes: exceptionCodes,
      },
      source_type: mapOsToSourceType(crashReport.system_info.os),
      stack: crashedThread?.stack,
      threads,
      binary_images: formatBinaryImages(crashReport),
    },
  };
}

/**
 * Compute the Error Tracking fingerprint for a native crash.
 *
 * Backend contract: the intake stores `error.fingerprint` verbatim on the error row, issue
 * grouping prefers an event-provided fingerprint over any computed one, and similarity/embedding
 * grouping is skipped entirely when an event carries one. Without it every crash of the same
 * exception type lands in a single issue, no matter where the process faulted.
 *
 * Format: `{exceptionType}|{moduleBasename}|{normalizedModuleOffset}` — e.g.
 * `SIGSEGV|MyApp|0x12ab3c`. The site is the first non-system frame of the crashed thread
 * (falling back to the first frame when every frame is a system module), identified by module
 * and offset rather than instruction address: ASLR rebases modules on every launch, while an
 * offset is stable across runs of the same build. Offsets drift between builds, so a new app
 * version opens fresh issues — the same trade-off the Android NDK top-frame grouping makes.
 *
 * Returns undefined when there is nothing to pin a site to: no crash_info, no identified
 * crashing thread, or a crashed thread without usable frames. Such an event carries no stack
 * either, and the backend's frames==0 gate already keeps it out of issue grouping.
 */
function computeCrashFingerprint(crashReport: CrashReport): string | undefined {
  // `crashing_thread` is a thread_index, matched the same way `formatThreads` flags threads.
  // Absent crash_info gives undefined, an unidentified thread gives null — both find nothing.
  const crashingThread = crashReport.crash_info?.crashing_thread;
  const crashedThread = crashReport.threads.find((thread) => thread.thread_index === crashingThread);
  if (!crashedThread) {
    return undefined;
  }

  const candidates = crashedThread.frames.filter((frame) => frame.module);
  const frame = candidates.find((candidate) => !isSystemModule(candidate.module)) ?? candidates[0];
  const normalizedOffset = frame ? normalizeModuleOffset(frame.module_offset) : undefined;
  if (!frame || !normalizedOffset) {
    return undefined;
  }

  const exceptionType = crashReport.crash_info?.type ?? 'unknown';
  return `${exceptionType}|${path.basename(frame.module)}|${normalizedOffset}`;
}

/**
 * Normalize a module offset like `0x0012AB3C` to `0x12ab3c` — lowercase, no leading zeros —
 * so equivalent spellings of the same offset group into one issue. BigInt keeps this exact
 * for offsets beyond 2^53. Returns undefined for missing or non-hex input.
 */
function normalizeModuleOffset(moduleOffset: string | undefined): string | undefined {
  if (!moduleOffset) {
    return undefined;
  }
  const hex = moduleOffset.toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]+$/.test(hex)) {
    return undefined;
  }
  return `0x${BigInt(`0x${hex}`).toString(16)}`;
}

const OS_TO_SOURCE_TYPE: Record<string, RumErrorEvent['error']['source_type']> = {
  mac: 'macos',
  linux: 'linux',
  windows: 'windows',
};

function mapOsToSourceType(os: string): RumErrorEvent['error']['source_type'] {
  const sourceType = OS_TO_SOURCE_TYPE[os];
  if (!sourceType) {
    addError(new Error(`Unknown OS reported by minidump processor: ${os}`));
    return os as RumErrorEvent['error']['source_type'];
  }
  return sourceType;
}

/**
 * Format a thread's frames into a stack trace string.
 * Each line: `{threadId}  {moduleName} {instruction} {baseAddress} + {decimalOffset}`
 * Base address is looked up from modules, with a BigInt fallback from instruction - offset.
 */
function formatFrameStack(
  frames: CrashReport['threads'][number]['frames'],
  threadId: number,
  modules: CrashReport['modules']
): string {
  return frames
    .map((frame) => {
      const moduleName = frame.module ? path.basename(frame.module) : '???';

      let baseAddress: string | undefined = modules.find((m) => m.code_file === frame.module)?.base_address;

      if (!baseAddress && frame.instruction && frame.module_offset) {
        try {
          const instructionAddr = BigInt(`0x${frame.instruction.replace(/^0x/i, '')}`);
          const offsetValue = BigInt(`0x${frame.module_offset.replace(/^0x/i, '')}`);
          baseAddress = `0x${(instructionAddr - offsetValue).toString(16)}`;
        } catch {
          // If calculation fails, baseAddress remains undefined
        }
      }

      const address = formatAddress64(baseAddress);
      const offset = parseInt(frame.module_offset, 16);
      const instruction = formatAddress64(frame.instruction);

      return `${threadId}  ${moduleName} ${instruction} ${address} + ${offset}`;
    })
    .join('\n');
}

function formatThreads(crashReport: CrashReport): NonNullable<RawRumError['error']['threads']> {
  // Undefined when `crash_info` is missing, null when the processor could not
  // identify the crashing thread. Both compare false against every index.
  const crashingThread = crashReport.crash_info?.crashing_thread;

  return crashReport.threads.map((thread, threadId) => ({
    name: `Thread ${thread.thread_index}`,
    crashed: thread.thread_index === crashingThread,
    stack: formatFrameStack(thread.frames, threadId, crashReport.modules),
  }));
}

function formatBinaryImages(crashReport: CrashReport): RawRumError['error']['binary_images'] {
  return crashReport.modules.map((module) => ({
    uuid: module.debug_identifier ?? '',
    name: path.basename(module.code_file),
    is_system: isSystemModule(module.code_file),
    load_address: formatAddress64(module.base_address),
    max_address: calculateMaxAddress(module.base_address, module.size),
    arch: crashReport.system_info.cpu,
  }));
}

function isSystemModule(codeFile: string): boolean {
  return (
    // macOS
    codeFile.includes('/System/Library/') ||
    codeFile.includes('/usr/lib/') ||
    // Windows
    codeFile.includes('\\Windows\\') ||
    codeFile.includes('\\System32\\') ||
    // Linux
    codeFile.startsWith('/lib/') ||
    codeFile.startsWith('/usr/lib/')
  );
}

async function getFilesRecursive(dir: string, ext: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  let results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(await getFilesRecursive(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }

  return results;
}
