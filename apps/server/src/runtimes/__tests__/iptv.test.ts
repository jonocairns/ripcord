import type { TIptvChannel } from '@sharkord/shared';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'events';

const mockAssertSafeIptvUrl = mock(async (_url: string): Promise<void> => {
  throw new Error('unsafe IPTV URL');
});
const mockFetchAndParsePlaylist = mock(
  async (): Promise<TIptvChannel[]> => [
    {
      name: 'News 24',
      url: 'https://stream.example/news.m3u8'
    }
  ]
);
const mockPublish = mock(() => undefined);
const mockPublishForChannel = mock(() => undefined);
const mockCreatePlainTransport = mock(async () => {
  throw new Error('createPlainTransport should not be called');
});
const mockCreateExternalStream = mock(() => 123);
const mockFindById = mock(() => ({
  getRouter: () => ({
    createPlainTransport: mockCreatePlainTransport
  }),
  createExternalStream: mockCreateExternalStream,
  getState: () => ({
    externalStreams: {},
    users: []
  }),
  removeExternalStream: mock(() => undefined),
  updateExternalStream: mock(() => undefined)
}));
const mockEventBusOn = mock(() => undefined);
type TSpawnScenario = {
  closeCode?: number | null;
  stderr?: string;
  stdout?: string;
};
const spawnScenarios: TSpawnScenario[] = [];
const mockSpawn = mock((command: string) => {
  const scenario = spawnScenarios.shift();
  const process = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    kill: ReturnType<typeof mock>;
    stderr: EventEmitter;
    stdout: EventEmitter;
  };

  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.exitCode = null;
  process.kill = mock(() => true);

  queueMicrotask(() => {
    if (scenario?.stdout) {
      process.stdout.emit('data', Buffer.from(scenario.stdout));
    }

    if (scenario?.stderr) {
      process.stderr.emit('data', Buffer.from(scenario.stderr));
    }

    if (scenario?.closeCode !== undefined) {
      process.exitCode = scenario.closeCode;
      process.emit('close', scenario.closeCode);
    }
  });

  if (command !== 'ffprobe') {
    throw new Error(`Unexpected spawn command: ${command}`);
  }

  return process;
});

mock.module('../../utils/iptv-playlist', () => ({
  assertSafeIptvUrl: mockAssertSafeIptvUrl,
  fetchAndParsePlaylist: mockFetchAndParsePlaylist
}));

mock.module('../../utils/pubsub', () => ({
  pubsub: {
    publish: mockPublish,
    publishForChannel: mockPublishForChannel
  }
}));

mock.module('../../plugins/event-bus', () => ({
  eventBus: {
    on: mockEventBusOn
  }
}));

mock.module('../voice', () => ({
  VoiceRuntime: {
    findById: mockFindById
  }
}));

mock.module('child_process', () => ({
  spawn: mockSpawn
}));

const { IptvSession } = await import('../iptv');

describe('IptvSession', () => {
  beforeEach(() => {
    mockAssertSafeIptvUrl.mockClear();
    mockFetchAndParsePlaylist.mockClear();
    mockPublish.mockClear();
    mockPublishForChannel.mockClear();
    mockCreatePlainTransport.mockClear();
    mockCreateExternalStream.mockClear();
    mockFindById.mockClear();
    mockEventBusOn.mockClear();
    mockSpawn.mockClear();
    spawnScenarios.length = 0;
  });

  test('fails URL re-check before creating transports or broadcasting stream state', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });

    await expect(session.startStream(0)).rejects.toThrow('unsafe IPTV URL');

    expect(mockFetchAndParsePlaylist).toHaveBeenCalledWith(
      'https://playlist.example/list.m3u'
    );
    expect(mockAssertSafeIptvUrl).toHaveBeenCalledWith(
      'https://stream.example/news.m3u8'
    );
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockCreatePlainTransport).not.toHaveBeenCalled();
    expect(mockCreateExternalStream).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(mockPublishForChannel).not.toHaveBeenCalled();
  });

  test('transcodes video when ffprobe cannot inspect the source stream', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const prepareChannelSource = Reflect.get(
      session,
      'prepareChannelSource'
    ) as (
      channel: TIptvChannel
    ) => Promise<{ shouldTranscodeVideo: boolean; videoCodec?: string }>;

    mockAssertSafeIptvUrl.mockImplementationOnce(async () => undefined);
    spawnScenarios.push({
      closeCode: 1,
      stderr: 'probe failed'
    });

    const result = await prepareChannelSource.call(session, {
      name: 'News 24',
      url: 'https://stream.example/news.m3u8'
    });

    expect(result).toEqual({
      shouldTranscodeVideo: true,
      videoCodec: undefined
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      'ffprobe',
      expect.any(Array),
      expect.any(Object)
    );
  });

  test('keeps video copy mode when ffprobe identifies an h264 source', async () => {
    const session = new IptvSession(42, {
      playlistUrl: 'https://playlist.example/list.m3u',
      enabled: true
    });
    const prepareChannelSource = Reflect.get(
      session,
      'prepareChannelSource'
    ) as (
      channel: TIptvChannel
    ) => Promise<{ shouldTranscodeVideo: boolean; videoCodec?: string }>;

    mockAssertSafeIptvUrl.mockImplementationOnce(async () => undefined);
    spawnScenarios.push({
      closeCode: 0,
      stdout: JSON.stringify({
        streams: [
          { codec_type: 'video', codec_name: 'h264' },
          { codec_type: 'audio', codec_name: 'aac' }
        ]
      })
    });

    const result = await prepareChannelSource.call(session, {
      name: 'News 24',
      url: 'https://stream.example/news.m3u8'
    });

    expect(result).toEqual({
      shouldTranscodeVideo: false,
      videoCodec: 'h264'
    });
  });
});
