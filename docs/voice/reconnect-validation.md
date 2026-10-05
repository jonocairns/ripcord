# Automated voice audio isolation

This follow-up starts from stage 7 head
`052332b67a90f6d667746813e80269e2be02187e`, above open PRs #339, #340, #342 and
#343. It changes the browser test harness, with application and server behavior
unchanged. The isolated worktree is `/tmp/ripcord-voice-recovery-coverage`.

## Long-offline investigation

The existing reconnect test takes the browser offline for 65 seconds and expects
`Connected` within 45 seconds after returning online. On the original harness it
remains `Connecting`, even though authentication and channels recover. The same
failure was reproduced on untouched main `cfe0f366` and the exact stage 7 base
`6834c8d4`; the earlier validation records retain those failures.

Temporary timing logs on stage 7 head identify the pending await as native
microphone acquisition: `microphone-pipeline-controller.ts` awaits
`ports.getUserMedia`, which calls `navigator.mediaDevices.getUserMedia`. Cleanup
and remote producer synchronization complete. The microphone uses volume 100
with WASM processing disabled, so neither gain nor WASM pipeline teardown can
account for the hang. Server logs show successful restore requests.

A direct browser reproduction, without joining voice or creating peer
connections, also hangs after 65 seconds offline. It acquires the fake microphone
and camera, waits offline, returns online, stops the microphone and acquires it
again. Microphone constraints retain echo cancellation, automatic gain and noise
suppression with a 48 kHz sample rate. The native promise remains pending after
10 seconds; the online control completes in 2.9 ms.

| Output configuration | Direct offline acquisition | Original reconnect test |
| --- | --- | --- |
| Original host output | Pending after 10 seconds | Failed at unchanged Connected assertion |
| Fake output stream | Completed in 2.9 ms | Passed; microphone acquired in 26 ms and camera RTP resumed |
| Host output restored | Pending after 10 seconds again | Earlier failure retained |

HMR suppression is the same in the fake-output and final host-output controls.
All runs use zero retries. The WSLg environment points PulseAudio at
`unix:/mnt/wslg/PulseServer`; browser stderr reports large audio delays and a
PulseAudio-to-ALSA fallback in the online control. The comparison implicates the
Chromium/host output path, but does not identify its exact blocked native call or
establish a specific upstream defect.

## Harness change and limits

The existing fake microphone/camera and permission flags remain. The harness
adds `--disable-audio-output`. Chromium's
[audio manager implementation](https://github.com/chromium/chromium/blob/149.0.7827.55/media/audio/audio_manager_base.cc)
selects a fake output stream for this switch; muting alone still uses OS output.
The application continues to acquire, process, publish, signal and consume
media through its production paths. No capture promise is mocked to succeed,
microphone setting changed, timeout extended or reconnect assertion weakened.

The original three reconnect tests remain the regression coverage for this
layer. Direct reproduction artifacts and timing logs are retained under
`/tmp/ripcord-reconnect-evidence`. Physical devices, OS permissions, native capture
and packaged desktop behavior are not covered. No test tone or desktop takeover
is used. The screen baseline's video-only canvas capture is unchanged.

The old test title overstated server grace coverage: observed server grace
ages are approximately 24–25 seconds, below the 60-second limit, and restores use
the existing-session path. Browser offline duration does not establish when the
server observed socket loss. The separate coverage layer described below verifies
actual server grace expiry and microphone media, retaining the existing
long-offline assertions.

## Repeatable host-output comparison

Use a fresh isolated checkout of the coverage branch, from its repository root,
on the affected WSLg host. Install with the frozen lockfile and confirm ports
4991/5173 are free. Inspect any occupied process's command and working directory;
do not stop unrelated processes. The normal development database is never used.
The script preserves the original configuration and saves each run's result,
server log and failure artifacts before the next isolated server reset.

```sh
nix develop -c bun install --frozen-lockfile
ss -ltnp '( sport = :4991 or sport = :5173 )'
comparison_dir=$(mktemp -d /tmp/ripcord-voice-output.XXXXXX)
cp apps/client/playwright.config.ts "$comparison_dir/fake-output.config.ts"
trap 'cp "$comparison_dir/fake-output.config.ts" apps/client/playwright.config.ts' EXIT
for output in host-first fake host-second; do
  cp "$comparison_dir/fake-output.config.ts" apps/client/playwright.config.ts
  if [ "$output" != fake ]; then
    python3 - <<'PYTHON'
from pathlib import Path
path = Path('apps/client/playwright.config.ts')
text = path.read_text()
flag = "\t'--disable-audio-output',\n"
assert text.count(flag) == 1
path.write_text(text.replace(flag, ''))
PYTHON
  fi
  if (cd apps/client && nix develop -c bun run test:e2e \
      e2e/tests/reconnect.spec.ts \
      --grep 'voice returns to a coherent session after a long offline interval') \
      > "$comparison_dir/$output.log" 2>&1; then
    result=0
  else
    result=$?
  fi
  printf '%s exit status: %s\n' "$output" "$result"
  cp apps/client/e2e/.runtime/data/logs/app.log "$comparison_dir/$output-server.log"
  cp -a apps/client/test-results/e2e "$comparison_dir/$output-artifacts"
done
printf 'Evidence: %s\n' "$comparison_dir"
```

The affected host is expected to fail the unchanged Connected assertion with
host output and pass with fake output; this is an environment-specific control,
not a promise of failure on every machine. Compare successful server restores,
missing restored microphone acquisition, the assertion trace and browser audio
backend diagnostics. All three runs retain zero retries, identical capture
constraints and the same application/server code. Do not commit the temporary
configuration change. The direct acquisition experiment above is a further
control; it is not required to reproduce the original voice regression.

## Grace expiry and received microphone coverage

The existing long-offline test is renamed to describe its actual trigger. It
retains the 65-second offline interval, 45-second Connected and camera flow
timeouts, Leave voice and error assertions. It now also requires microphone RTP
to advance. The short WebSocket reconnect similarly checks microphone RTP.

A new two-peer case makes the producer browser offline and closes its real
server WebSocket through a Playwright route, withholding the close notification
to model a half-open connection. The production heartbeat detects the loss later,
so the client recovery deadline starts after the server's grace clock. Closing
both ends immediately would synchronize the two existing 60-second deadlines
and correctly exhaust client recovery at server expiry. Neither policy changes.
Replacement messages are held until the browser is online and recovery is
released; admitted signaling is forwarded verbatim. This controls fault timing
and the routed socket surface, rather than reproducing native TCP timing. No server
response, voice controller, acquisition result or production timer is mocked.
The offline state retains the existing recovery bookkeeping beyond the normal
20-second online app teardown deadline.

The test reads only `e2e/.runtime/data/logs/app.log`. It matches the producer's
production client instance ID, verifies `grace_scheduled` with a 60-second TTL,
then waits for `grace_expired` with age at least 60 seconds and zero TTL. The
watcher's microphone subscription must disappear before releasing the outage.
The succeeding server attempt must use the `fresh` path and is correlated to the
actual outgoing `voice.restoreOrJoin` reconnect attempt ID. A successful restore
of the old seat cannot satisfy these assertions.

Microphone checks sample live sender/receiver `getStats()` identities. RTP bytes
and packet counts must advance for the same peer connection, track and RTP
report; frozen or retired counters cannot satisfy the poll. Received audio must
be attached to the app's unmuted, playing audio element, and non-concealed samples
must advance. As specified by [WebRTC statistics](https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-totalsamplesreceived),
`totalSamplesReceived` includes concealment, so the assertion subtracts
`concealedSamples` to exclude locally synthesized loss recovery.

After fresh restore, microphone sender and receiver track identities must differ
from the pre-fault identities, the sender uses a replacement peer connection,
camera RTP resumes, and the session UI remains coherent. Browser audio processing
and received samples are exercised with synthetic capture and fake OS output;
physical audibility is outside this coverage. HTML reports (`CI=true`) retain
the server-event and microphone-identity attachments with starting and advancing
counters. The local list reporter shows
assertion results but does not persist attachment bodies; save the HTML report
before the next run.
The screen fixture is unchanged.

During fixture development, closing both ends while online correctly triggered
the existing 20-second app teardown. Immediate close while offline synchronized
the client intent and server grace deadlines and exhausted recovery. A later
half-open fixture stalled because a routed replacement closed before its open
event, and client-initiated close lacked acknowledgement after the server side
had closed. These failed runs are retained under
`/tmp/ripcord-recovery-evidence`; the fixture now holds replacement messages and
acknowledges client-initiated closure. Application deadlines and assertions are
unchanged.

## Validation

The frozen dependency install passes through Nix and leaves `bun.lock` unchanged.
Scoped Biome formatting and `git diff --check` pass. All commands run from the
repository root unless marked client:

| Command | Result |
| --- | --- |
| `nix develop -c bun run check-types` | Pass: client, server and desktop |
| `nix develop -c bun run lint` | Pass: no lint warnings |
| `nix develop -c bun run knip` | Pass: unchanged 11 configuration hints |
| Client: `nix develop -c bun test ./src/components/voice-provider ./src/features/server/voice` | 742 passed across 62 files; 2,300 assertions |
| Client: `CI=true nix develop -c bun run test:e2e e2e/tests/screen-share.spec.ts e2e/tests/screen-share-lifecycle.spec.ts` | 6 passed, 36.3 seconds |
| Client: `nix develop -c bun run test:e2e e2e/tests/reconnect.spec.ts e2e/tests/remote-media.spec.ts e2e/tests/recovery-faults.spec.ts e2e/tests/session-conflict.spec.ts` | 25 passed, 4.5 minutes |

Every browser run has zero retries. The output-isolation layer independently
passed the original, unchanged three reconnect cases (1.5 minutes). The coverage
layer's focused grace-expiry case passed (1.3 minutes); its server recorded expiry
at 60,194 ms and a succeeding `fresh` restore. The full suite recorded 60,203 ms,
followed by a successful `fresh` restore correlated to the producer's request.
A further focused run with the HTML reporter passed (1.2 minutes), recording
expiry at 60,209 ms. It preserves successful attachment bodies; this is an
evidence capture run, not a retry after suite failure. Its restored sender
advanced from 21 to 36 RTP bytes and 7 to 12 packets. The watcher advanced from
33 to 51 received bytes, 11 to 17 packets and 8,640 to 14,400 non-concealed
samples. Sender peer connection index changed from 2 to 6, and both microphone
track IDs changed. These are sampled observations, not fixed expected counters.

Command output, isolated server logs, failure-fixture runs and successful reports
are retained under `/tmp/ripcord-recovery-evidence`. Concurrent Nix checks emitted
an ignored evaluation-cache SQLite busy diagnostic; all command exits were zero.
Port identities and working directories were checked. No normal development
server/database or unrelated process was stopped. The screen fixture and
`voice-session-runner-boundary.test.ts` are unchanged, and all existing voice
unit coverage remains.

The original stage 7 validation record remains 6 screen E2E passes and 23 recovery
passes with one long-offline failure under host output. This follow-up isolates
that host dependency and closes the automated grace-expiry/microphone evidence
gap. It does not repair or identify the precise blocked Chromium/WSLg native
operation. No production capture timeout or fallback is introduced.

T3 preview navigation and a read-only DOM evaluation succeeded on the login
screen; snapshot calls reported a preview automation execution error. No
interactive media inspection is claimed from that preview. Browser scenarios use
real signaling, WebRTC and received media behind controlled synthetic acquisition
and fault timing. Physical microphone/camera/screen/display audio, OS permission
flows, native sidecar RTP and packaged desktop stop/reconnect behavior remain
unavailable. No tone was played and no desktop test took over the user's screen.

Stage 7's ownership refactor remains complete. `VoiceProvider` is still 359 lines,
with the same controller/runtime/session-machine/runner ownership and public API.
The original untracked sequencing plan remains untouched, SHA-256
`480ad3b7d16213cab640a7b643f8ab5e39f0510b3a215d519df238be3904a5c9`.
