import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  assertSafeIptvUrl,
  clearIptvPlaylistCache,
  fetchAndParsePlaylist,
  parsePlaylist
} from '../iptv-playlist';

describe('iptv-playlist parser', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    clearIptvPlaylistCache();
  });

  afterEach(() => {
    clearIptvPlaylistCache();
    globalThis.fetch = originalFetch;
  });

  test('parses multi-channel playlists with metadata', () => {
    const channels = parsePlaylist(`#EXTM3U
#EXTINF:-1 tvg-name="News 24" tvg-logo="https://img.local/news.png" group-title="News",News 24
https://stream.local/news.m3u8
#EXTINF:-1 tvg-name="Sports One" group-title="Sports",Sports One
https://stream.local/sports.m3u8`);

    expect(channels).toEqual([
      {
        name: 'News 24',
        logo: 'https://img.local/news.png',
        group: 'News',
        url: 'https://stream.local/news.m3u8'
      },
      {
        name: 'Sports One',
        group: 'Sports',
        url: 'https://stream.local/sports.m3u8'
      }
    ]);
  });

  test('parses single-channel playlists without optional metadata', () => {
    const channels = parsePlaylist(`#EXTM3U
#EXTINF:-1,Music TV
https://stream.local/music.m3u8`);

    expect(channels).toEqual([
      {
        name: 'Music TV',
        url: 'https://stream.local/music.m3u8'
      }
    ]);
  });

  test('skips malformed entries that do not provide stream URLs', () => {
    const channels = parsePlaylist(`#EXTM3U
#EXTINF:-1 tvg-name="Broken",Broken
#EXTINF:-1,Valid
https://stream.local/valid.m3u8`);

    expect(channels).toEqual([
      {
        name: 'Valid',
        url: 'https://stream.local/valid.m3u8'
      }
    ]);
  });

  test('blocks private IPTV URLs', async () => {
    await expect(
      assertSafeIptvUrl('http://127.0.0.1/private.m3u8')
    ).rejects.toThrow();
  });

  test('blocks non-http IPTV URLs', async () => {
    await expect(
      assertSafeIptvUrl('file:///tmp/playlist.m3u8')
    ).rejects.toThrow();
  });

  test('caches fetch results for the same playlist URL', async () => {
    let fetchCalls = 0;

    globalThis.fetch = (async () => {
      fetchCalls += 1;
      return new Response(
        '#EXTM3U\n#EXTINF:-1,Channel A\nhttps://8.8.4.4/a.m3u8',
        {
          status: 200
        }
      );
    }) as unknown as typeof fetch;

    const first = await fetchAndParsePlaylist('https://8.8.8.8/tv.m3u8');
    const second = await fetchAndParsePlaylist('https://8.8.8.8/tv.m3u8');

    expect(first).toEqual(second);
    expect(fetchCalls).toBe(1);
  });
});
