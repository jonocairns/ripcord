import fs from 'fs/promises';
import { parse, stringify } from 'ini';
import z from 'zod';
import { applyEnvOverrides } from './helpers/apply-env-overrides';
import { deepMerge } from './helpers/deep-merge';
import { ensureServerDirs } from './helpers/ensure-server-dirs';
import { getErrorMessage } from './helpers/get-error-message';
import { getPrivateIp, getPublicIp } from './helpers/network';
import { CONFIG_INI_PATH } from './helpers/paths';
import { IS_DEVELOPMENT } from './utils/env';

const [SERVER_PUBLIC_IP, SERVER_PRIVATE_IP] = await Promise.all([
  getPublicIp(),
  getPrivateIp()
]);

const zConfig = z.object({
  server: z.object({
    port: z.coerce.number().int().positive(),
    debug: z.coerce.boolean(),
    autoupdate: z.coerce.boolean(),
    trustProxy: z.coerce.boolean(),
    corsOrigin: z.string(),
    clientErrorReportingSentryDsn: z.string(),
    clientErrorReportingIgnoreErrors: z.string()
  }),
  webRtc: z.object({
    port: z.coerce.number().int().positive(),
    announcedAddress: z.string()
  }),
  rateLimiters: z.object({
    sendAndEditMessage: z.object({
      maxRequests: z.coerce.number().int().positive(),
      windowMs: z.coerce.number().int().positive()
    }),
    joinVoiceChannel: z.object({
      maxRequests: z.coerce.number().int().positive(),
      windowMs: z.coerce.number().int().positive()
    }),
    joinServer: z.object({
      maxRequests: z.coerce.number().int().positive(),
      windowMs: z.coerce.number().int().positive()
    })
  })
});

type TConfig = z.infer<typeof zConfig>;

const defaultConfig: TConfig = {
  server: {
    port: 4991,
    debug: IS_DEVELOPMENT,
    autoupdate: false,
    trustProxy: false,
    // When empty, CORS reflects the request Origin (allows all origins).
    // Set to a specific origin (e.g. "https://app.example.com") to restrict.
    // Note: setting this will reject desktop (Electron) clients whose
    // file:// origin won't match. Leave empty if desktop clients are used.
    corsOrigin: '',
    clientErrorReportingSentryDsn: '',
    clientErrorReportingIgnoreErrors: [
      // Browser noise
      'ResizeObserver loop limit exceeded',
      'ResizeObserver loop completed with undelivered notifications',
      'Non-Error promise rejection captured',
      // Media / autoplay policy
      'NotAllowedError',
      'The play() request was interrupted',
      // Device / hardware (user environment, not app bugs)
      'NotReadableError',
      'NotFoundError',
      'OverconstrainedError',
      // WebRTC churn
      'ICE',
      'RTCPeerConnection',
      'RTCDataChannel',
      'InvalidStateError',
      // Fetch / network
      'AbortError',
      'NetworkError',
      'Failed to fetch',
      'Load failed'
    ].join(',')
  },
  webRtc: {
    port: 40000,
    announcedAddress: ''
  },
  rateLimiters: {
    sendAndEditMessage: {
      maxRequests: 60,
      windowMs: 60_000
    },
    joinVoiceChannel: {
      maxRequests: 60,
      windowMs: 60_000
    },
    joinServer: {
      maxRequests: 5,
      windowMs: 60_000
    }
  }
};

let config: TConfig = structuredClone(defaultConfig);

await ensureServerDirs();

const configExists = await fs
  .access(CONFIG_INI_PATH)
  .then(() => true)
  .catch(() => false);

if (!configExists) {
  // config does not exist, create it with the default config
  await fs.writeFile(CONFIG_INI_PATH, stringify(config));
} else {
  try {
    // config exists, we need to make sure it is up to date with the schema
    // to make this easy, we will read the existing config, merge it with the default config, and write it back to the file
    // this way we don't have to worry about migrating old config files when we add/remove config options
    const existingConfigText = await fs.readFile(CONFIG_INI_PATH, {
      encoding: 'utf-8'
    });

    const existingConfig = parse(existingConfigText) as Partial<TConfig>;
    const mergedConfig = deepMerge(config, existingConfig);

    config = zConfig.parse(mergedConfig);

    await fs.writeFile(CONFIG_INI_PATH, stringify(config));
  } catch (error) {
    // something went wrong, just log the error and overwrite the config file with the default config
    console.error(
      `Error reading or parsing config.ini. Overwriting with default config. Error: ${getErrorMessage(error)}`
    );

    await fs.writeFile(CONFIG_INI_PATH, stringify(config));
  }
}

config = applyEnvOverrides(config, {
  'server.port': 'SHARKORD_PORT',
  'server.debug': 'SHARKORD_DEBUG',
  'server.autoupdate': 'SHARKORD_AUTOUPDATE',
  'server.trustProxy': 'SHARKORD_TRUST_PROXY',
  'webRtc.port': 'SHARKORD_WEBRTC_PORT',
  'webRtc.announcedAddress': 'SHARKORD_WEBRTC_ANNOUNCED_ADDRESS'
});

// Applied separately: applyEnvOverrides skips falsy values, so an empty-string
// env var cannot disable a DSN already set in the INI — handle it manually.
if (process.env.RIPCORD_CLIENT_ERROR_REPORTING_SENTRY_DSN !== undefined) {
  config = {
    ...config,
    server: {
      ...config.server,
      clientErrorReportingSentryDsn: process.env.RIPCORD_CLIENT_ERROR_REPORTING_SENTRY_DSN
    }
  };
}

// Applied separately: applyEnvOverrides skips falsy values, but empty string
// is a valid corsOrigin (means "allow all origins"), so we handle it manually.
if (process.env.SHARKORD_CORS_ORIGIN !== undefined) {
  config = {
    ...config,
    server: { ...config.server, corsOrigin: process.env.SHARKORD_CORS_ORIGIN }
  };
}

// Normalize trailing slashes — browsers send Origin without a trailing slash
config = {
  ...config,
  server: {
    ...config.server,
    corsOrigin: config.server.corsOrigin.replace(/\/+$/, '')
  }
};

config = Object.freeze(config);

export { config, SERVER_PRIVATE_IP, SERVER_PUBLIC_IP };
