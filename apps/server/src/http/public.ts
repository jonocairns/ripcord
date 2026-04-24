import { eq } from 'drizzle-orm';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { db } from '../db';
import { isFileOrphaned } from '../db/queries/files';
import { getMessageByFileId } from '../db/queries/messages';
import { channels, files } from '../db/schema';
import { verifyFileToken } from '../helpers/files-crypto';
import { PUBLIC_PATH } from '../helpers/paths';
import { logger } from '../logger';

const INLINE_ALLOWLIST = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
  'video/x-ms-wmv',
  'video/x-flv',
  'video/mpeg',
  'video/3gpp',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
  'audio/aac',
  'audio/x-m4a',
  'audio/x-ms-wma'
]);

type TParsedRange = {
  start: number;
  end: number;
};

// Parses a single-range Range header of the form `bytes=<start>-<end>`,
// `bytes=<start>-`, or `bytes=-<suffix>`. Returns null on invalid input and
// 'unsatisfiable' when parsable but outside file bounds.
const parseRange = (
  header: string,
  totalSize: number
): TParsedRange | 'unsatisfiable' | null => {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());

  if (!match) return null;

  const startStr = match[1] ?? '';
  const endStr = match[2] ?? '';

  if (startStr === '' && endStr === '') return null;

  let start: number;
  let end: number;

  if (startStr === '') {
    // Suffix form: bytes=-N → last N bytes
    const suffix = Number(endStr);

    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    if (totalSize === 0) return 'unsatisfiable';

    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(startStr);
    end = endStr === '' ? totalSize - 1 : Number(endStr);

    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start > end || start < 0) return 'unsatisfiable';
    if (start >= totalSize) return 'unsatisfiable';
    if (end >= totalSize) end = totalSize - 1;
  }

  return { start, end };
};

const publicRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!req.url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return;
  }

  const url = new URL(req.url!, `http://${req.headers.host}`);
  const fileName = decodeURIComponent(path.basename(url.pathname));

  const dbFile = await db
    .select()
    .from(files)
    .where(eq(files.name, fileName))
    .get();

  if (!dbFile) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
    return;
  }

  const isOrphaned = await isFileOrphaned(dbFile.id);

  if (isOrphaned) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found' }));
    return;
  }

  // it's gonna be defined if it's a message file
  // otherwise is something like an avatar or banner or something else
  // we can assume this because of the orphaned check above
  const associatedMessage = await getMessageByFileId(dbFile.id);

  if (associatedMessage) {
    const channel = await db
      .select()
      .from(channels)
      .where(eq(channels.id, associatedMessage.channelId))
      .get();

    if (channel && channel.private) {
      const accessToken = url.searchParams.get('accessToken');
      const isValidToken = verifyFileToken(
        dbFile.id,
        channel.fileAccessToken,
        accessToken || ''
      );

      if (!isValidToken) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }
    }
  }

  const filePath = path.join(PUBLIC_PATH, dbFile.name);

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File not found on disk' }));
    return;
  }

  const contentDisposition = INLINE_ALLOWLIST.has(dbFile.mimeType)
    ? 'inline'
    : 'attachment';
  const dispositionHeader = `${contentDisposition}; filename="${dbFile.originalName.replace(/[^\w. -]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(dbFile.originalName)}`;
  const etag = `"${dbFile.md5}"`;
  const isHeadRequest = req.method === 'HEAD';
  const rangeHeader = req.headers.range;

  // Range requests bypass the If-None-Match 304 shortcut — clients requesting a
  // byte range expect actual bytes, and If-Range (not implemented) is the header
  // meant to gate that.
  if (rangeHeader) {
    const parsed = parseRange(rangeHeader, dbFile.size);

    if (parsed === 'unsatisfiable') {
      res.writeHead(416, {
        'Content-Type': 'application/json',
        'Content-Range': `bytes */${dbFile.size}`
      });
      res.end(JSON.stringify({ error: 'Range Not Satisfiable' }));
      return;
    }

    if (parsed) {
      const chunkSize = parsed.end - parsed.start + 1;

      res.writeHead(206, {
        'Content-Type': dbFile.mimeType,
        'Content-Length': chunkSize,
        'Content-Range': `bytes ${parsed.start}-${parsed.end}/${dbFile.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': dispositionHeader,
        'Cache-Control': 'public, max-age=31536000, immutable',
        ETag: etag
      });

      if (isHeadRequest) {
        res.end();
        return res;
      }

      const rangeStream = fs.createReadStream(filePath, {
        start: parsed.start,
        end: parsed.end
      });

      rangeStream.pipe(res);

      rangeStream.on('error', (err) => {
        logger.error('Error serving file range:', err);

        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });

      res.on('close', () => {
        rangeStream.destroy();
      });

      return res;
    }

    // Invalid Range header → fall through to full-body response per RFC 7233.
  }

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': dbFile.mimeType,
    'Content-Length': dbFile.size,
    'Content-Disposition': dispositionHeader,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    ETag: etag
  });

  if (isHeadRequest) {
    res.end();
    return res;
  }

  const fileStream = fs.createReadStream(filePath);

  fileStream.pipe(res);

  fileStream.on('error', (err) => {
    logger.error('Error serving file:', err);

    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  });

  res.on('close', () => {
    fileStream.destroy();
  });

  fileStream.on('end', () => {
    res.end();
  });

  return res;
};

export { publicRouteHandler };
