import { expect } from '@playwright/test';

/**
 * Asserts a main-process stack is in the frame format the FlashCat backend parses.
 *
 * `ParseJavaScript` requires ` @ ` between the function name and the frame URL. V8's native
 * `at fn (url:line:col)` shape parses to **zero** frames, which is what the main-process stacks
 * used to be — the error was ingested but unreadable and impossible to un-minify.
 * `ErrorCollection.formatError` now runs the stack through
 * `toStackTraceString(computeStackTrace(error))` to fix that, and this assertion pins it.
 */
export function expectBackendFrameFormat(stack: string | undefined, message: string): void {
  expect(stack).toBeDefined();

  const [header, ...frames] = stack!.split('\n');
  expect(header).toBe(`Error: ${message}`);
  expect(frames.length).toBeGreaterThan(0);

  for (const frame of frames) {
    expect(frame).toMatch(/^ {2}at .+ @ .+$/);
  }

  // At least one frame carries the `url:line:column` the sourcemap lookup keys on.
  expect(frames.some((frame) => /:\d+:\d+$/.test(frame))).toBe(true);
}
