import type { RumInitConfiguration } from '@flashcatcloud/browser-rum';

declare global {
  interface Window {
    e2eConfig?: {
      // `site` is not part of the FlashCat browser SDK's public init configuration.
      rumBrowserSdk: Omit<RumInitConfiguration, 'site'>;
    };
    electronAPI: {
      generateTelemetryErrors: (count: number) => Promise<void>;
      stopSession: () => Promise<void>;
      generateUncaughtException: () => Promise<void>;
      generateUnhandledRejection: () => Promise<void>;
      generateManualError: (startTime?: number) => Promise<void>;
      crash: () => Promise<void>;
      ping: () => Promise<string>;
      openBridgeFileWindow: () => Promise<void>;
      openBridgeFileWindowNoIsolation: () => Promise<void>;
      openBridgeHttpWindow: () => Promise<void>;
      killBridgeWindowRenderer: () => Promise<void>;
    };
  }
}

export {};
