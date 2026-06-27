import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	validateDesktopQuitFlushResultArgs,
	validateListAppAudioTargetsArgs,
	validatePrepareScreenShareArgs,
	validateSetGlobalPushKeybindsArgs,
	validateSetServerUrlArgs,
	validateStartAppAudioCaptureArgs,
	validateStartAppAudioRtpArgs,
	validateStopAppAudioCaptureArgs,
} from '../ipc-validators';

void describe('validateSetServerUrlArgs', () => {
	void it('accepts empty string (clears the setting)', () => {
		assert.deepEqual(validateSetServerUrlArgs(['']), ['']);
		assert.deepEqual(validateSetServerUrlArgs(['   ']), ['   ']);
	});

	void it('accepts http and https urls', () => {
		assert.deepEqual(validateSetServerUrlArgs(['https://chat.example.com']), ['https://chat.example.com']);
		assert.deepEqual(validateSetServerUrlArgs(['http://localhost:3000']), ['http://localhost:3000']);
		assert.deepEqual(validateSetServerUrlArgs(['  https://chat.example.com  ']), ['https://chat.example.com']);
	});

	void it('rejects non-http(s) protocols', () => {
		assert.throws(() => validateSetServerUrlArgs(['file:///etc/passwd']), /http or https/);
		assert.throws(() => validateSetServerUrlArgs(['javascript:alert(1)']), /valid URL|http or https/);
	});

	void it('rejects malformed urls, non-strings, and overlong input', () => {
		assert.throws(() => validateSetServerUrlArgs(['not a url']), /valid URL/);
		assert.throws(() => validateSetServerUrlArgs([42]), /must be a string/);
		assert.throws(() => validateSetServerUrlArgs([`https://x/${'a'.repeat(2048)}`]), /exceeds/);
	});
});

void describe('validateDesktopQuitFlushResultArgs', () => {
	void it('accepts valid quit flush results', () => {
		assert.deepEqual(validateDesktopQuitFlushResultArgs([{ status: 'succeeded' }]), [
			{ status: 'succeeded', reason: undefined },
		]);
		assert.deepEqual(validateDesktopQuitFlushResultArgs([{ status: 'skipped', reason: 'voice-leave-failed' }]), [
			{ status: 'skipped', reason: 'voice-leave-failed' },
		]);
	});

	void it('rejects malformed quit flush results', () => {
		assert.throws(
			() => validateDesktopQuitFlushResultArgs([{ status: 'done' }]),
			/status must be succeeded or skipped/,
		);
		assert.throws(
			() => validateDesktopQuitFlushResultArgs([{ status: 'skipped', reason: 1 }]),
			/reason must be a string/,
		);
		assert.throws(() => validateDesktopQuitFlushResultArgs([null]), /must be an object/);
	});
});

void describe('validateListAppAudioTargetsArgs / validateStopAppAudioCaptureArgs', () => {
	void it('allows undefined and bounded strings', () => {
		assert.deepEqual(validateListAppAudioTargetsArgs([]), [undefined]);
		assert.deepEqual(validateListAppAudioTargetsArgs(['source-1']), ['source-1']);
		assert.deepEqual(validateStopAppAudioCaptureArgs([undefined]), [undefined]);
		assert.deepEqual(validateStopAppAudioCaptureArgs(['session-1']), ['session-1']);
	});

	void it('rejects non-string and overlong ids', () => {
		assert.throws(() => validateListAppAudioTargetsArgs([{}]), /must be a string/);
		assert.throws(() => validateStopAppAudioCaptureArgs(['a'.repeat(513)]), /exceeds/);
	});
});

void describe('validateStartAppAudioCaptureArgs', () => {
	void it('keeps only sourceId and appAudioTargetId, dropping injected fields', () => {
		const result = validateStartAppAudioCaptureArgs([
			{
				sourceId: 'source-1',
				appAudioTargetId: 'target-1',
				selfExcludePid: 999,
			},
		]);

		assert.deepEqual(result, [{ sourceId: 'source-1', appAudioTargetId: 'target-1' }]);
		assert.equal('selfExcludePid' in result[0], false);
	});

	void it('rejects missing/empty sourceId and non-object input', () => {
		assert.throws(() => validateStartAppAudioCaptureArgs([{ sourceId: '' }]), /must not be empty/);
		assert.throws(() => validateStartAppAudioCaptureArgs([{}]), /must be a string/);
		assert.throws(() => validateStartAppAudioCaptureArgs(['nope']), /must be an object/);
		assert.throws(() => validateStartAppAudioCaptureArgs([null]), /must be an object/);
	});
});

void describe('validateStartAppAudioRtpArgs', () => {
	void it('accepts bounded RTP target fields and a 7-bit payload type', () => {
		assert.deepEqual(validateStartAppAudioRtpArgs([{ ip: '127.0.0.1', port: 50_000, ssrc: 1234, payloadType: 127 }]), [
			{ ip: '127.0.0.1', port: 50_000, ssrc: 1234, payloadType: 127 },
		]);
		assert.deepEqual(validateStartAppAudioRtpArgs([{ ip: '127.0.0.1', port: 50_000, ssrc: 1234 }]), [
			{ ip: '127.0.0.1', port: 50_000, ssrc: 1234 },
		]);
	});

	void it('rejects payload types outside the 7-bit RTP range', () => {
		assert.throws(
			() => validateStartAppAudioRtpArgs([{ ip: '127.0.0.1', port: 50_000, ssrc: 1234, payloadType: 128 }]),
			/integer between 0 and 127/,
		);
		assert.throws(
			() => validateStartAppAudioRtpArgs([{ ip: '127.0.0.1', port: 50_000, ssrc: 1234, payloadType: -1 }]),
			/integer between 0 and 127/,
		);
	});
});

void describe('validatePrepareScreenShareArgs', () => {
	void it('accepts a valid selection', () => {
		assert.deepEqual(
			validatePrepareScreenShareArgs([
				{
					sourceId: 'screen-1',
					audioMode: 'system',
					appAudioTargetId: 'app-1',
				},
			]),
			[
				{
					sourceId: 'screen-1',
					audioMode: 'system',
					appAudioTargetId: 'app-1',
				},
			],
		);
	});

	void it('rejects invalid audio modes and empty source ids', () => {
		assert.throws(
			() => validatePrepareScreenShareArgs([{ sourceId: 'screen-1', audioMode: 'everything' }]),
			/audioMode must be one of/,
		);
		assert.throws(() => validatePrepareScreenShareArgs([{ sourceId: '', audioMode: 'none' }]), /must not be empty/);
		assert.throws(() => validatePrepareScreenShareArgs([[]]), /must be an object/);
	});
});

void describe('validateSetGlobalPushKeybindsArgs', () => {
	void it('allows undefined and partial keybind objects', () => {
		assert.deepEqual(validateSetGlobalPushKeybindsArgs([undefined]), [undefined]);
		assert.deepEqual(validateSetGlobalPushKeybindsArgs([{ pushToTalkKeybind: 'F1' }]), [
			{ pushToTalkKeybind: 'F1', pushToMuteKeybind: undefined },
		]);
	});

	void it('rejects non-string and overlong keybinds', () => {
		assert.throws(() => validateSetGlobalPushKeybindsArgs([{ pushToTalkKeybind: 123 }]), /must be a string/);
		assert.throws(() => validateSetGlobalPushKeybindsArgs([{ pushToMuteKeybind: 'a'.repeat(129) }]), /exceeds/);
	});
});
