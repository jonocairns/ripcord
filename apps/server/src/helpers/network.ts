import { isIP } from 'net';
import os from 'os';
import type { TIpFamily, TResolvedIpAddresses } from './ip-addresses';

const isMatchingFamily = (value: unknown, family: TIpFamily): boolean => {
  if (family === 'ipv4') {
    return value === 'IPv4' || value === 4;
  }

  return value === 'IPv6' || value === 6;
};

const parsePublicIpResponse = (
  ip: string,
  family: TIpFamily
): string | undefined => {
  const normalized = ip.trim();
  const expectedFamily = family === 'ipv4' ? 4 : 6;

  return isIP(normalized) === expectedFamily ? normalized : undefined;
};

const getPrivateIps = async (): Promise<TResolvedIpAddresses> => {
  const interfaces = os.networkInterfaces();
  const addresses: TResolvedIpAddresses = {};

  for (const family of ['ipv4', 'ipv6'] satisfies TIpFamily[]) {
    const address = Object.values(interfaces)
      .flat()
      .find((iface) => {
        return (
          iface && isMatchingFamily(iface.family, family) && !iface.internal
        );
      })?.address;

    if (address) {
      addresses[family] = address;
    }
  }

  return addresses;
};

const getPublicIpFromJsonEndpoint = async (
  url: string,
  family: TIpFamily
): Promise<string | undefined> => {
  try {
    const response = await fetch(url);
    const data = (await response.json()) as { ip?: string };

    return data.ip ? parsePublicIpResponse(data.ip, family) : undefined;
  } catch {
    return undefined;
  }
};

const getPublicIpFromTextEndpoint = async (
  url: string,
  family: TIpFamily
): Promise<string | undefined> => {
  try {
    const response = await fetch(url);
    const ip = await response.text();

    return parsePublicIpResponse(ip, family);
  } catch {
    return undefined;
  }
};

const getPublicIp = async (family: TIpFamily): Promise<string | undefined> => {
  const jsonEndpoints =
    family === 'ipv4'
      ? ['https://api.ipify.org?format=json']
      : ['https://api6.ipify.org?format=json'];
  const textEndpoints =
    family === 'ipv4'
      ? ['https://ipv4.icanhazip.com', 'https://ifconfig.me/ip']
      : ['https://ipv6.icanhazip.com', 'https://ifconfig.me/ip'];

  for (const endpoint of textEndpoints) {
    const ip = await getPublicIpFromTextEndpoint(endpoint, family);

    if (ip) {
      return ip;
    }
  }

  for (const endpoint of jsonEndpoints) {
    const ip = await getPublicIpFromJsonEndpoint(endpoint, family);

    if (ip) {
      return ip;
    }
  }

  return undefined;
};

const getPublicIps = async (): Promise<TResolvedIpAddresses> => {
  const [ipv4, ipv6] = await Promise.all([
    getPublicIp('ipv4'),
    getPublicIp('ipv6')
  ]);

  return {
    ...(ipv4 ? { ipv4 } : {}),
    ...(ipv6 ? { ipv6 } : {})
  };
};

export { getPrivateIps, getPublicIps };
