import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
	fetchPreviewResource,
	isUrlSafeForPreview,
	MAX_PREVIEW_BYTES,
	MAX_PREVIEW_REDIRECTS,
} from '../fetch-preview-resource';

// isUrlSafeForPreview is the synchronous per-hop guard: it blocks non-http(s)
// protocols and literal non-public IPs. Hostnames are vetted after DNS
// resolution by fetchPreviewResource (covered below).
describe('isUrlSafeForPreview', () => {
	test('allows public http(s) URLs', () => {
		expect(isUrlSafeForPreview('https://example.com/page')).toBe(true);
		expect(isUrlSafeForPreview('http://example.com')).toBe(true);
		expect(isUrlSafeForPreview('https://1.1.1.1/')).toBe(true);
		expect(isUrlSafeForPreview('http://[2606:4700:4700::1111]/')).toBe(true);
	});

	test('blocks non-http(s) protocols', () => {
		expect(isUrlSafeForPreview('file:///etc/passwd')).toBe(false);
		expect(isUrlSafeForPreview('ftp://example.com')).toBe(false);
		expect(isUrlSafeForPreview('gopher://example.com')).toBe(false);
		expect(isUrlSafeForPreview('data:text/html,hi')).toBe(false);
	});

	test('blocks literal loopback addresses', () => {
		expect(isUrlSafeForPreview('http://127.0.0.1/')).toBe(false);
		expect(isUrlSafeForPreview('http://127.0.0.1:8080/admin')).toBe(false);
		expect(isUrlSafeForPreview('http://[::1]/')).toBe(false);
	});

	test('blocks literal link-local addresses (cloud metadata)', () => {
		expect(isUrlSafeForPreview('http://169.254.169.254/latest/meta-data/')).toBe(false);
		expect(isUrlSafeForPreview('http://[fe80::1]/')).toBe(false);
	});

	test('blocks literal private-range addresses', () => {
		expect(isUrlSafeForPreview('http://10.0.0.5/')).toBe(false);
		expect(isUrlSafeForPreview('http://192.168.1.1/')).toBe(false);
		expect(isUrlSafeForPreview('http://172.16.0.1/')).toBe(false);
		expect(isUrlSafeForPreview('http://[fc00::1]/')).toBe(false);
	});

	test('blocks unparseable input', () => {
		expect(isUrlSafeForPreview('not a url')).toBe(false);
		expect(isUrlSafeForPreview('')).toBe(false);
	});

	test('blocks literal carrier-grade NAT and IPv4-mapped IPv6 addresses', () => {
		expect(isUrlSafeForPreview('http://100.64.0.1/')).toBe(false);
		expect(isUrlSafeForPreview('http://[::ffff:127.0.0.1]/')).toBe(false);
		expect(isUrlSafeForPreview('http://[::ffff:10.0.0.1]/')).toBe(false);
	});
});

// A local server stands in for the remote site. The injected network maps test
// hostnames to addresses so DNS answers and the allowed-address policy are explicit.
describe('fetchPreviewResource', () => {
	const requests: { path: string; host: string | null }[] = [];
	let server: ReturnType<typeof Bun.serve>;
	let port: number;

	beforeAll(() => {
		server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: (request) => {
				const { pathname } = new URL(request.url);
				requests.push({ path: pathname, host: request.headers.get('host') });

				if (pathname === '/to-internal') {
					return Response.redirect(`http://internal.test:${port}/secret`, 302);
				}

				if (pathname === '/loop') {
					return Response.redirect(`http://public.test:${port}/loop`, 302);
				}

				if (pathname === '/huge') {
					return new Response('a'.repeat(MAX_PREVIEW_BYTES * 2), { headers: { 'content-type': 'text/html' } });
				}

				return new Response('<html><head><title>ok</title></head></html>', {
					headers: { 'content-type': 'text/html' },
				});
			},
		});
		port = server.port ?? 0;
	});

	afterAll(() => {
		server.stop(true);
	});

	const network = (hosts: Record<string, string[]>, allowed: string[]) => ({
		resolveHost: async (hostname: string) => hosts[hostname] ?? [],
		isAllowedAddress: (address: string) => allowed.includes(address),
	});

	test('connects to the vetted address while keeping the original Host', async () => {
		requests.length = 0;

		// public.test does not exist in real DNS, so reaching the server proves the
		// request used the resolved address rather than resolving the name again.
		const resource = await fetchPreviewResource(
			`http://public.test:${port}/page`,
			network({ 'public.test': ['127.0.0.1'] }, ['127.0.0.1']),
		);

		expect(resource?.status).toBe(200);
		expect(resource?.url).toBe(`http://public.test:${port}/page`);
		expect(resource?.data).toContain('<title>ok</title>');
		expect(requests).toEqual([{ path: '/page', host: `public.test:${port}` }]);
	});

	test('refuses a host when any resolved address is not allowed', async () => {
		requests.length = 0;

		const resource = await fetchPreviewResource(
			`http://mixed.test:${port}/page`,
			network({ 'mixed.test': ['127.0.0.1', '127.0.0.2'] }, ['127.0.0.1']),
		);

		expect(resource).toBeUndefined();
		expect(requests).toEqual([]);
	});

	test('re-vets every redirect hop before requesting it', async () => {
		requests.length = 0;

		const resource = await fetchPreviewResource(
			`http://public.test:${port}/to-internal`,
			network({ 'public.test': ['127.0.0.1'], 'internal.test': ['127.0.0.2'] }, ['127.0.0.1']),
		);

		expect(resource).toBeUndefined();
		expect(requests.map((request) => request.path)).toEqual(['/to-internal']);
	});

	test('gives up after the redirect limit', async () => {
		requests.length = 0;

		const resource = await fetchPreviewResource(
			`http://public.test:${port}/loop`,
			network({ 'public.test': ['127.0.0.1'] }, ['127.0.0.1']),
		);

		expect(resource).toBeUndefined();
		expect(requests).toHaveLength(MAX_PREVIEW_REDIRECTS + 1);
	});

	test('caps the body it reads', async () => {
		const resource = await fetchPreviewResource(
			`http://public.test:${port}/huge`,
			network({ 'public.test': ['127.0.0.1'] }, ['127.0.0.1']),
		);

		expect(resource?.data.length).toBe(MAX_PREVIEW_BYTES);
	});

	test('refuses non-public addresses by default', async () => {
		expect(await fetchPreviewResource(`http://127.0.0.1:${port}/page`)).toBeUndefined();
		expect(await fetchPreviewResource(`http://localhost:${port}/page`)).toBeUndefined();
	});
});
