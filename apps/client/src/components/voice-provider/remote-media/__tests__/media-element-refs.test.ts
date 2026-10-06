import { describe, expect, it } from 'bun:test';
import { createMediaElementRefCache } from '../media-element-refs';

describe('private media element ref cache', () => {
	it('initializes all six element refs and preserves their identity on repeated lookup', () => {
		const cache = createMediaElementRefCache();
		const refs = cache.getOrCreateRefs(7);
		expect(Object.values(refs)).toHaveLength(6);
		for (const ref of Object.values(refs)) expect(ref.current).toBeNull();
		expect(cache.getOrCreateRefs(7)).toBe(refs);
		expect(cache.getOrCreateRefs(8)).not.toBe(refs);
	});
	it('retains current users and external ids while evicting departed entries', () => {
		const cache = createMediaElementRefCache();
		const user = cache.getOrCreateRefs(7);
		const external = cache.getOrCreateRefs(99);
		const departed = cache.getOrCreateRefs(8);
		cache.prune(5, { 7: {} }, { 99: {} });
		expect(cache.getOrCreateRefs(7)).toBe(user);
		expect(cache.getOrCreateRefs(99)).toBe(external);
		expect(cache.getOrCreateRefs(8)).not.toBe(departed);
	});
	it('preserves a shared id until both membership sources lose it', () => {
		const cache = createMediaElementRefCache();
		const refs = cache.getOrCreateRefs(7);
		cache.prune(5, { 7: {} }, { 7: {} });
		cache.prune(5, undefined, { 7: {} });
		expect(cache.getOrCreateRefs(7)).toBe(refs);
		cache.prune(5, undefined, undefined);
		expect(cache.getOrCreateRefs(7)).not.toBe(refs);
	});
	it('prunes by the replacement channel membership rather than keeping old channel ids', () => {
		const cache = createMediaElementRefCache();
		const departing = cache.getOrCreateRefs(7);
		const surviving = cache.getOrCreateRefs(8);
		cache.prune(6, { 8: {} }, undefined);
		expect(cache.getOrCreateRefs(8)).toBe(surviving);
		expect(cache.getOrCreateRefs(7)).not.toBe(departing);
	});
	it('clears on leave even with old membership snapshots and on explicit terminal cleanup', () => {
		const cache = createMediaElementRefCache();
		const beforeLeave = cache.getOrCreateRefs(7);
		cache.prune(undefined, { 7: {} }, { 7: {} });
		const afterLeave = cache.getOrCreateRefs(7);
		expect(afterLeave).not.toBe(beforeLeave);
		cache.clear();
		cache.clear();
		expect(cache.getOrCreateRefs(7)).not.toBe(afterLeave);
	});
	it('keeps replacement provider caches independent of old cleanup', () => {
		const oldCache = createMediaElementRefCache();
		const newCache = createMediaElementRefCache();
		const refs = newCache.getOrCreateRefs(7);
		expect(oldCache.getOrCreateRefs(7)).not.toBe(refs);
		oldCache.clear();
		expect(newCache.getOrCreateRefs(7)).toBe(refs);
	});
});
