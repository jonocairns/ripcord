const readline = require('node:readline');

let activeSession = null;
let intervalId = null;
const crashAfterMs = Number(process.env.FAKE_SIDECAR_CRASH_MS || 0);

const send = (payload) => {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

const sendResponse = (id, result) => {
  send({
    id,
    ok: true,
    result
  });
};

const sendError = (id, message) => {
  send({
    id,
    ok: false,
    error: {
      message
    }
  });
};

const stopSession = () => {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }

  if (!activeSession) {
    return;
  }

  send({
    event: 'audio_capture.ended',
    params: {
      sessionId: activeSession.sessionId,
      targetId: activeSession.targetId,
      reason: 'capture_stopped',
      protocolVersion: 1
    }
  });

  activeSession = null;
};

const startSession = (targetId) => {
  stopSession();

  const sessionId = `session-${Date.now()}`;
  const sampleRate = 48000;
  const channels = 2;
  const frameCount = 960;
  const samples = new Float32Array(frameCount * channels);
  const pcmBase64 = Buffer.from(samples.buffer).toString('base64');
  let sequence = 0;

  activeSession = {
    sessionId,
    targetId
  };

  intervalId = setInterval(() => {
    send({
      event: 'audio_capture.frame',
      params: {
        sessionId,
        targetId,
        sequence: sequence++,
        sampleRate,
        channels,
        frameCount,
        pcmBase64,
        protocolVersion: 1,
        encoding: 'f32le_base64',
        droppedFrameCount: 0
      }
    });
  }, 10);

  return {
    sessionId,
    targetId,
    sampleRate,
    channels,
    framesPerBuffer: frameCount,
    protocolVersion: 1,
    encoding: 'f32le_base64'
  };
};

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
});

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params = {} } = request;

  if (method === 'health.ping') {
    sendResponse(id, {
      status: 'ok'
    });
    return;
  }

  if (method === 'audio_targets.list') {
    sendResponse(id, {
      targets: [
        {
          id: 'pid:1234',
          label: 'Fake App (1234)',
          pid: 1234,
          processName: 'fake.exe'
        }
      ],
      suggestedTargetId: params?.sourceId ? 'pid:1234' : undefined
    });
    return;
  }

  if (method === 'audio_capture.start') {
    const targetId = params?.appAudioTargetId || 'pid:1234';
    const session = startSession(targetId);
    sendResponse(id, session);
    return;
  }

  if (method === 'audio_capture.stop') {
    stopSession();
    sendResponse(id, {
      stopped: true
    });
    return;
  }

  if (method === 'capabilities.get') {
    sendResponse(id, {
      platform: process.platform,
      perAppAudio: 'supported'
    });
    return;
  }

  sendError(id, `Unknown method: ${method}`);
});

rl.on('close', () => {
  stopSession();
  process.exit(0);
});

if (crashAfterMs > 0) {
  setTimeout(() => {
    process.exit(1);
  }, crashAfterMs);
}
