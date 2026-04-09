import fs from 'fs/promises';
import { parse, stringify } from 'ini';
import z from 'zod';
import { applyEnvOverrides } from './helpers/apply-env-overrides';
import { deepMerge } from './helpers/deep-merge';
import { ensureServerDirs } from './helpers/ensure-server-dirs';
import { getErrorMessage } from './helpers/get-error-message';
import { getPrivateIps, getPublicIps } from './helpers/network';
import { CONFIG_INI_PATH } from './helpers/paths';
import { IS_DEVELOPMENT } from './utils/env';

const [SERVER_PUBLIC_IPS, SERVER_PRIVATE_IPS] = await Promise.all([
  getPublicIps(),
  getPrivateIps()
]);

const zWebRtcFamilyConfig = z.object({
  enabled: z.coerce.boolean(),
  bindAddress: z.string(),
  announcedAddress: z.string()
});

const zWebRtcConfig = z
  .object({
    port: z.coerce.number().int().positive(),
    preferredFamily: z.enum(['ipv4', 'ipv6']),
    ipv4: zWebRtcFamilyConfig,
    ipv6: zWebRtcFamilyConfig,
    announcedAddress: z.string().optional()
  })
  .transform((webRtc) => {
    const legacyAnnouncedAddress = webRtc.announcedAddress ?? '';

    return {
      port: webRtc.port,
      preferredFamily: webRtc.preferredFamily,
      ipv4: {
        ...webRtc.ipv4,
        announcedAddress: webRtc.ipv4.announcedAddress || legacyAnnouncedAddress
      },
      ipv6: {
        ...webRtc.ipv6,
        announcedAddress: webRtc.ipv6.announcedAddress || legacyAnnouncedAddress
      }
    };
  });

const zConfig = z.object({
  server: z.object({
    port: z.coerce.number().int().positive(),
    debug: z.coerce.boolean(),
    autoupdate: z.coerce.boolean(),
    trustProxy: z.coerce.boolean(),
    corsOrigin: z.string()
  }),
  webRtc: zWebRtcConfig,
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
    corsOrigin: ''
  },
  webRtc: {
    port: 40000,
    preferredFamily: 'ipv4',
    ipv4: {
      enabled: true,
      bindAddress: '0.0.0.0',
      announcedAddress: ''
    },
    ipv6: {
      enabled: false,
      bindAddress: '::',
      announcedAddress: ''
    }
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
  'webRtc.preferredFamily': 'SHARKORD_WEBRTC_PREFERRED_FAMILY',
  'webRtc.ipv4.enabled': 'SHARKORD_WEBRTC_IPV4_ENABLED',
  'webRtc.ipv4.bindAddress': 'SHARKORD_WEBRTC_IPV4_BIND_ADDRESS',
  'webRtc.ipv4.announcedAddress': 'SHARKORD_WEBRTC_IPV4_ANNOUNCED_ADDRESS',
  'webRtc.ipv6.enabled': 'SHARKORD_WEBRTC_IPV6_ENABLED',
  'webRtc.ipv6.bindAddress': 'SHARKORD_WEBRTC_IPV6_BIND_ADDRESS',
  'webRtc.ipv6.announcedAddress': 'SHARKORD_WEBRTC_IPV6_ANNOUNCED_ADDRESS'
});

const legacyAnnouncedAddress = process.env.SHARKORD_WEBRTC_ANNOUNCED_ADDRESS;

if (legacyAnnouncedAddress) {
  config = {
    ...config,
    webRtc: {
      ...config.webRtc,
      ipv4: {
        ...config.webRtc.ipv4,
        announcedAddress:
          config.webRtc.ipv4.announcedAddress || legacyAnnouncedAddress
      },
      ipv6: {
        ...config.webRtc.ipv6,
        announcedAddress:
          config.webRtc.ipv6.announcedAddress || legacyAnnouncedAddress
      }
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

export { config, SERVER_PRIVATE_IPS, SERVER_PUBLIC_IPS };
