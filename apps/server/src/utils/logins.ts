import type { TIpInfo } from '@sharkord/shared';
import { isPrivateOrLocalIp } from '../helpers/ip-addresses';
import { ipCache } from './ip-cache';

const getIpInfo = async (ip: string) => {
	const cachedData = ipCache.get(ip);

	if (cachedData) {
		return cachedData;
	}

	const url = isPrivateOrLocalIp(ip) ? 'https://ipinfo.io/json' : `https://ipinfo.io/${ip}/json`;

	const response = await fetch(url);
	const data = (await response.json()) as TIpInfo;

	ipCache.set(ip, data);

	return data;
};

export { getIpInfo };
