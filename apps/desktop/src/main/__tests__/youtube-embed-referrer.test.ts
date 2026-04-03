import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DESKTOP_YOUTUBE_EMBED_REFERRER,
  ensureYoutubeEmbedRefererHeader,
} from "../youtube-embed-referrer";

void describe("ensureYoutubeEmbedRefererHeader", () => {
  void it("injects the desktop referer when the request has no referer", () => {
    const headers = ensureYoutubeEmbedRefererHeader({
      Accept: "text/html",
    });

    assert.equal(headers.Referer, DESKTOP_YOUTUBE_EMBED_REFERRER);
    assert.equal(headers.Accept, "text/html");
  });

  void it("reuses an existing referer header without overriding it", () => {
    const headers = ensureYoutubeEmbedRefererHeader({
      referer: "https://example.com/chat",
    });

    assert.deepEqual(headers, {
      referer: "https://example.com/chat",
    });
  });

  void it("replaces empty referer headers with the desktop referer", () => {
    const headers = ensureYoutubeEmbedRefererHeader({
      Referer: "   ",
    });

    assert.equal(headers.Referer, DESKTOP_YOUTUBE_EMBED_REFERRER);
  });

  void it("removes mixed-case blank referer keys before injecting the fallback", () => {
    const headers = ensureYoutubeEmbedRefererHeader({
      referer: "   ",
      Accept: "text/html",
    });

    assert.equal(headers.Referer, DESKTOP_YOUTUBE_EMBED_REFERRER);
    assert.equal(headers.referer, undefined);
    assert.equal(headers.Accept, "text/html");
  });
});
