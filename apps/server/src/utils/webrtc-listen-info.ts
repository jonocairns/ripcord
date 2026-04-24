import type { TIpFamily, TResolvedIpAddresses } from '../helpers/ip-addresses';
import { isUnspecifiedBindAddress } from '../helpers/ip-addresses';

type TWebRtcFamilyConfig = {
  enabled: boolean;
  bindAddress: string;
  announcedAddress: string;
};

type TWebRtcConfig = {
  port: number;
  preferredFamily: TIpFamily;
  ipv4: TWebRtcFamilyConfig;
  ipv6: TWebRtcFamilyConfig;
};

type TWebRtcListenInfo = {
  protocol: 'udp' | 'tcp';
  ip: string;
  announcedAddress?: string;
  family: TIpFamily;
  port: number;
  flags?: {
    ipv6Only?: boolean;
  };
  sendBufferSize?: number;
  recvBufferSize?: number;
};

const UDP_BUFFER_SIZE_BYTES = 2_097_152;

const getDefaultBindAddress = (
  family: TIpFamily,
  isProduction: boolean
): string => {
  if (isProduction) {
    return family === 'ipv6' ? '::' : '0.0.0.0';
  }

  return family === 'ipv6' ? '::1' : '127.0.0.1';
};

const getFamilyConfig = (
  config: TWebRtcConfig,
  family: TIpFamily
): TWebRtcFamilyConfig => {
  return family === 'ipv6' ? config.ipv6 : config.ipv4;
};

const getListenInfoProtocolEntries = (
  family: TIpFamily,
  bindAddress: string,
  port: number,
  announcedAddress?: string
): TWebRtcListenInfo[] => {
  const ipv6Flags = family === 'ipv6' ? { ipv6Only: true } : undefined;

  return [
    {
      protocol: 'udp',
      ip: bindAddress,
      announcedAddress,
      family,
      port,
      flags: ipv6Flags,
      recvBufferSize: UDP_BUFFER_SIZE_BYTES,
      sendBufferSize: UDP_BUFFER_SIZE_BYTES
    },
    {
      protocol: 'tcp',
      ip: bindAddress,
      announcedAddress,
      family,
      port,
      flags: ipv6Flags
    }
  ];
};

const sortListenInfosByPreference = (
  listenInfos: TWebRtcListenInfo[],
  preferredFamily: TIpFamily
) => {
  return [...listenInfos].sort((left, right) => {
    if (left.family === right.family) {
      if (left.protocol === right.protocol) {
        return 0;
      }

      return left.protocol === 'udp' ? -1 : 1;
    }

    if (left.family === preferredFamily) {
      return -1;
    }

    if (right.family === preferredFamily) {
      return 1;
    }

    return 0;
  });
};

const buildWebRtcListenInfos = (
  config: TWebRtcConfig,
  options: {
    isProduction: boolean;
    publicIps: TResolvedIpAddresses;
  }
): TWebRtcListenInfo[] => {
  const listenInfos: TWebRtcListenInfo[] = [];

  for (const family of ['ipv4', 'ipv6'] satisfies TIpFamily[]) {
    const familyConfig = getFamilyConfig(config, family);

    if (!familyConfig.enabled) {
      continue;
    }

    const defaultBindAddress = getDefaultBindAddress(
      family,
      options.isProduction
    );
    const bindAddress = options.isProduction
      ? familyConfig.bindAddress || defaultBindAddress
      : !familyConfig.bindAddress ||
          isUnspecifiedBindAddress(familyConfig.bindAddress)
        ? defaultBindAddress
        : familyConfig.bindAddress;
    const resolvedAnnouncedAddress = options.isProduction
      ? familyConfig.announcedAddress || options.publicIps[family]
      : familyConfig.announcedAddress;
    const announcedAddress = resolvedAnnouncedAddress || undefined;

    if (
      options.isProduction &&
      isUnspecifiedBindAddress(bindAddress) &&
      !announcedAddress
    ) {
      continue;
    }

    listenInfos.push(
      ...getListenInfoProtocolEntries(
        family,
        bindAddress,
        config.port,
        announcedAddress
      )
    );
  }

  return sortListenInfosByPreference(listenInfos, config.preferredFamily);
};

const getPrimaryWebRtcListenInfo = (listenInfos: TWebRtcListenInfo[]) => {
  const primary = listenInfos[0];

  if (!primary) {
    return undefined;
  }

  return {
    ip: primary.ip,
    announcedAddress: primary.announcedAddress
  };
};

export { buildWebRtcListenInfos, getPrimaryWebRtcListenInfo };
export type { TWebRtcConfig, TWebRtcFamilyConfig, TWebRtcListenInfo };
