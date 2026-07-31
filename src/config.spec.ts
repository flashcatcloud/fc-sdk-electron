import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildConfiguration, DEFAULT_SITE } from './config';
import type { InitConfiguration } from './config';

import * as display from './tools/display';
vi.mock('./tools/display', () => ({
  displayError: vi.fn(),
}));

describe('buildConfiguration', () => {
  // Default valid config used as base for all tests
  const DEFAULT_CONFIG: InitConfiguration = {
    site: 'browser.flashcat.cloud',
    service: 'test-service',
    clientToken: 'test-token',
    applicationId: 'test-app-id',
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe.each([
    { fieldName: 'service' as const },
    { fieldName: 'clientToken' as const },
    { fieldName: 'applicationId' as const },
  ])('required field validation: $fieldName', ({ fieldName }) => {
    it.each([
      { value: undefined, description: 'missing' },
      { value: '', description: 'empty string' },
      { value: 123, description: 'not a string' },
    ])('returns undefined when $description', ({ value }) => {
      const config = {
        ...DEFAULT_CONFIG,
        [fieldName]: value,
      } as unknown as InitConfiguration;

      expect(buildConfiguration(config)).toBeUndefined();
    });

    it('logs error to console when validation fails', () => {
      const config = {
        ...DEFAULT_CONFIG,
        [fieldName]: '',
      };

      buildConfiguration(config);

      expect(display.displayError).toHaveBeenCalledWith(expect.stringContaining(fieldName));
    });
  });

  describe.each([{ fieldName: 'env' as const }, { fieldName: 'version' as const }])(
    'optional field validation: $fieldName',
    ({ fieldName }) => {
      it('preserves provided value', () => {
        const config = {
          ...DEFAULT_CONFIG,
          [fieldName]: fieldName === 'env' ? 'production' : '1.0.0',
        };

        const result = buildConfiguration(config);

        expect(result?.[fieldName]).toBe(fieldName === 'env' ? 'production' : '1.0.0');
      });

      it.each([
        { value: '', description: 'empty string' },
        { value: null, description: 'null' },
        { value: undefined, description: 'undefined' },
        { value: 123, description: 'non-string value' },
      ])('treats $description as undefined', ({ value }) => {
        const config = {
          ...DEFAULT_CONFIG,
          [fieldName]: value,
        } as unknown as InitConfiguration;

        const result = buildConfiguration(config);

        expect(result?.[fieldName]).toBeUndefined();
      });
    }
  );

  describe('successful configuration', () => {
    it('builds config with required fields only', () => {
      const config = {
        ...DEFAULT_CONFIG,
      };

      const result = buildConfiguration(config);

      expect(result).toBeDefined();
      expect(result?.service).toBe('test-service');
      expect(result?.clientToken).toBe('test-token');
    });

    it('builds config with all fields', () => {
      const config = {
        ...DEFAULT_CONFIG,
        env: 'production',
        version: '1.0.0',
      };

      const result = buildConfiguration(config);

      expect(result).toBeDefined();
      expect(result?.service).toBe('test-service');
      expect(result?.clientToken).toBe('test-token');
      expect(result?.env).toBe('production');
      expect(result?.version).toBe('1.0.0');
    });

    it('builds config with some optional fields', () => {
      const config = {
        ...DEFAULT_CONFIG,
        env: 'staging',
      };

      const result = buildConfiguration(config);

      expect(result).toBeDefined();
      expect(result?.service).toBe('test-service');
      expect(result?.clientToken).toBe('test-token');
      expect(result?.env).toBe('staging');
      expect(result?.version).toBeUndefined();
    });
  });

  describe('site validation', () => {
    it.each([
      { value: '', description: 'empty string' },
      { value: 123, description: 'number' },
      { value: {}, description: 'object' },
    ])('returns undefined and logs error when site is $description', ({ value }) => {
      const config = {
        ...DEFAULT_CONFIG,
        site: value,
      } as unknown as InitConfiguration;

      expect(buildConfiguration(config)).toBeUndefined();
      expect(display.displayError).toHaveBeenCalledWith("Configuration error: 'site' must be a non-empty string");
    });

    it.each([
      { value: undefined, description: 'omitted' },
      { value: null, description: 'null' },
    ])('falls back to the default site when site is $description', ({ value }) => {
      const config = {
        ...DEFAULT_CONFIG,
        site: value,
      } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result).toBeDefined();
      expect(result?.site).toBe(DEFAULT_SITE);
      expect(display.displayError).not.toHaveBeenCalled();
    });

    it('accepts an omitted site without the key being present at all', () => {
      const withoutSite: InitConfiguration = {
        service: 'test-service',
        clientToken: 'test-token',
        applicationId: 'test-app-id',
      };

      const result = buildConfiguration(withoutSite);

      expect(result?.site).toBe(DEFAULT_SITE);
    });

    // The whitelist was removed so self-hosted deployments can use their own intake.
    it.each([
      { site: 'browser.flashcat.cloud', description: 'production' },
      { site: 'jira.flashcat.cloud', description: 'staging' },
      { site: 'rum.acme.internal', description: 'a self-hosted host' },
      { site: 'localhost:8080', description: 'a host with a port' },
    ])('accepts $description: $site', ({ site }) => {
      const config = { ...DEFAULT_CONFIG, site };

      const result = buildConfiguration(config);

      expect(result).toBeDefined();
      expect(result?.site).toBe(site);
      expect(display.displayError).not.toHaveBeenCalled();
    });
  });

  describe('error logging', () => {
    it('logs error for missing service', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: undefined,
      } as unknown as InitConfiguration;

      buildConfiguration(config);

      expect(display.displayError).toHaveBeenCalledWith("Configuration error: 'service' must be a non-empty string");
    });

    it('logs error for empty clientToken', () => {
      const config = {
        ...DEFAULT_CONFIG,
        clientToken: '',
      };

      buildConfiguration(config);

      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'clientToken' must be a non-empty string"
      );
    });

    it('includes field name in error message', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: 123,
      } as unknown as InitConfiguration;

      buildConfiguration(config);

      expect(display.displayError).toHaveBeenCalledWith(expect.stringContaining('service'));
    });

    it('logs multiple errors when multiple fields are invalid', () => {
      const config = {
        ...DEFAULT_CONFIG,
        service: '',
        clientToken: '',
      };

      buildConfiguration(config);

      expect(display.displayError).toHaveBeenCalledTimes(2);
      expect(display.displayError).toHaveBeenCalledWith("Configuration error: 'service' must be a non-empty string");
      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'clientToken' must be a non-empty string"
      );
    });
  });

  describe('defaultPrivacyLevel validation', () => {
    it('defaults to mask when not provided', () => {
      const config = { ...DEFAULT_CONFIG };

      const result = buildConfiguration(config);

      expect(result?.defaultPrivacyLevel).toBe('mask');
    });

    it.each(['mask', 'allow', 'mask-user-input'] as const)('accepts valid value: %s', (value) => {
      const config = { ...DEFAULT_CONFIG, defaultPrivacyLevel: value };

      const result = buildConfiguration(config);

      expect(result?.defaultPrivacyLevel).toBe(value);
    });

    it.each([
      { value: 'invalid', description: 'invalid string' },
      { value: 123, description: 'number' },
      { value: {}, description: 'object' },
    ])('logs error and uses default when $description', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, defaultPrivacyLevel: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.defaultPrivacyLevel).toBe('mask');
      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'defaultPrivacyLevel' must be one of: mask, allow, mask-user-input"
      );
    });

    it.each([
      { value: null, description: 'null' },
      { value: undefined, description: 'undefined' },
    ])('defaults to mask when $description (no error)', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, defaultPrivacyLevel: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.defaultPrivacyLevel).toBe('mask');
      expect(display.displayError).not.toHaveBeenCalled();
    });
  });

  describe('allowedWebViewHosts validation', () => {
    it('defaults to empty array when not provided', () => {
      const config = { ...DEFAULT_CONFIG };

      const result = buildConfiguration(config);

      expect(result?.allowedWebViewHosts).toEqual([]);
    });

    it('accepts valid array of strings', () => {
      const config = { ...DEFAULT_CONFIG, allowedWebViewHosts: ['example.com', 'other.com'] };

      const result = buildConfiguration(config);

      expect(result?.allowedWebViewHosts).toEqual(['example.com', 'other.com']);
    });

    it.each([
      { value: 'not-an-array', description: 'string' },
      { value: 123, description: 'number' },
      { value: [123, 456], description: 'array of non-strings' },
      { value: ['valid', 123], description: 'mixed array' },
    ])('logs error and uses default when $description', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, allowedWebViewHosts: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.allowedWebViewHosts).toEqual([]);
      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'allowedWebViewHosts' must be an array of strings"
      );
    });

    it.each([
      { value: null, description: 'null' },
      { value: undefined, description: 'undefined' },
    ])('defaults to empty array when $description (no error)', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, allowedWebViewHosts: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.allowedWebViewHosts).toEqual([]);
      expect(display.displayError).not.toHaveBeenCalled();
    });
  });

  describe('correctPrewarmedViewTimings validation', () => {
    it('defaults to true when not provided', () => {
      const result = buildConfiguration({ ...DEFAULT_CONFIG });

      expect(result?.correctPrewarmedViewTimings).toBe(true);
    });

    it('accepts false', () => {
      const result = buildConfiguration({ ...DEFAULT_CONFIG, correctPrewarmedViewTimings: false });

      expect(result?.correctPrewarmedViewTimings).toBe(false);
    });

    it('logs an error and keeps the default when not a boolean', () => {
      const config = { ...DEFAULT_CONFIG, correctPrewarmedViewTimings: 'yes' } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.correctPrewarmedViewTimings).toBe(true);
      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'correctPrewarmedViewTimings' must be a boolean"
      );
    });
  });

  describe('telemetrySampleRate validation', () => {
    it('defaults to 20 when not provided', () => {
      const config = { ...DEFAULT_CONFIG };

      const result = buildConfiguration(config);

      expect(result?.telemetrySampleRate).toBe(20);
    });

    it.each([0, 50, 100])('accepts valid value: %d', (value) => {
      const config = { ...DEFAULT_CONFIG, telemetrySampleRate: value };

      const result = buildConfiguration(config);

      expect(result?.telemetrySampleRate).toBe(value);
    });

    it.each([
      { value: -1, description: 'negative number' },
      { value: 101, description: 'greater than 100' },
      { value: 'fifty', description: 'non-number string' },
      { value: {}, description: 'object' },
    ])('logs error and uses default when $description', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, telemetrySampleRate: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.telemetrySampleRate).toBe(20);
      expect(display.displayError).toHaveBeenCalledWith(
        "Configuration error: 'telemetrySampleRate' must be a number between 0 and 100"
      );
    });

    it.each([
      { value: null, description: 'null' },
      { value: undefined, description: 'undefined' },
    ])('defaults to 20 when $description (no error)', ({ value }) => {
      const config = { ...DEFAULT_CONFIG, telemetrySampleRate: value } as unknown as InitConfiguration;

      const result = buildConfiguration(config);

      expect(result?.telemetrySampleRate).toBe(20);
      expect(display.displayError).not.toHaveBeenCalled();
    });
  });
});
