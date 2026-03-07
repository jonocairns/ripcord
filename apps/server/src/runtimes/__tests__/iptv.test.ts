import type { TIptvChannel } from '@sharkord/shared';
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const mockAssertSafeIptvUrl = mock(async (_url: string) => {
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
});
