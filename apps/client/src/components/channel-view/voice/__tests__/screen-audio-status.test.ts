import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getScreenAudioStatus } from '../screen-audio-status';

describe('getScreenAudioStatus', () => {
	it('reports live whenever an audio stream is playable, even if the slot lags', () => {
		assert.equal(getScreenAudioStatus(true, undefined), 'live');
		assert.equal(getScreenAudioStatus(true, { desired: true, status: 'pending', producerPresent: true }), 'live');
	});

	it('reports connecting while wanted audio is not yet playable', () => {
		assert.equal(
			getScreenAudioStatus(false, { desired: true, status: 'pending', producerPresent: true }),
			'connecting',
		);
		assert.equal(
			getScreenAudioStatus(false, { desired: true, status: 'retrying', producerPresent: true }),
			'connecting',
		);
	});

	it('reports failed when wanted audio failed', () => {
		assert.equal(getScreenAudioStatus(false, { desired: true, status: 'failed', producerPresent: true }), 'failed');
	});

	it('reports stopped when the sharer has audio but the viewer turned it off', () => {
		assert.equal(getScreenAudioStatus(false, { desired: false, status: 'closing', producerPresent: true }), 'stopped');
	});

	it('reports none when the sharer stopped audio, even though the viewer still wants it', () => {
		assert.equal(getScreenAudioStatus(false, { desired: true, status: 'failed', producerPresent: false }), 'none');
	});

	it('reports none when the share has no audio', () => {
		assert.equal(getScreenAudioStatus(false, undefined), 'none');
		assert.equal(getScreenAudioStatus(false, { desired: false, status: 'closing', producerPresent: false }), 'none');
	});
});
