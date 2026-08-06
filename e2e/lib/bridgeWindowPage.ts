import type { Page, ElectronApplication } from '@playwright/test';

/** The bridge the SDK's preload script exposes to every renderer. */
interface BridgeWindow {
  DatadogEventBridge: {
    getCapabilities: () => string;
    getSessionId: () => string;
    getAnonymousId: () => string;
  };
}

/**
 * Page Object for bridge windows (bridge-window.html).
 * Use static factory methods to open a window and wait for it to be bridge-ready.
 */
export class BridgeWindowPage {
  constructor(readonly page: Page) {}

  static async waitForReady(electronApp: ElectronApplication): Promise<BridgeWindowPage> {
    const page = await electronApp.waitForEvent('window');
    await page.waitForSelector('#status');
    await page.waitForFunction('document.getElementById("status")?.textContent === "bridge-ready"');
    return new BridgeWindowPage(page);
  }

  async generateError(message: string) {
    await this.page.evaluate((msg) => {
      setTimeout(() => {
        throw new Error(msg);
      }, 0);
    }, message);
    await this.waitForIpcPropagation();
  }

  async generateResource() {
    await this.page.evaluate(() => fetch('/'));
    await this.waitForIpcPropagation();
  }

  /** Reads the bridge the way the Browser SDK does: from the page's own world. */
  async getSessionId(): Promise<string> {
    return await this.page.evaluate(() => (globalThis as unknown as BridgeWindow).DatadogEventBridge.getSessionId());
  }

  async getAnonymousId(): Promise<string> {
    return await this.page.evaluate(() => (globalThis as unknown as BridgeWindow).DatadogEventBridge.getAnonymousId());
  }

  async getCapabilities(): Promise<string> {
    return await this.page.evaluate(() => (globalThis as unknown as BridgeWindow).DatadogEventBridge.getCapabilities());
  }

  private async waitForIpcPropagation() {
    // Wait for event propagation: renderer → bridge IPC -> main → transport
    await this.page.waitForTimeout(1000);
  }
}
