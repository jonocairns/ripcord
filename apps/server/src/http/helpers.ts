import http from 'http';
import { HttpBodyTooLargeError } from './utils';

const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024; // 1 MB

type TGetJsonBodyOptions = {
  maxBytes?: number;
};

const getJsonBody = async <T = unknown>(
  req: http.IncomingMessage,
  options?: TGetJsonBodyOptions
): Promise<T> => {
  return new Promise((resolve, reject) => {
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let tooLarge = false;

    req.on('data', (chunk) => {
      if (tooLarge) {
        return;
      }

      const parsedChunk = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk));

      totalBytes += parsedChunk.length;

      if (totalBytes > maxBytes) {
        tooLarge = true;
        return;
      }

      chunks.push(parsedChunk);
    });

    req.on('end', () => {
      if (tooLarge) {
        reject(new HttpBodyTooLargeError(maxBytes));
        return;
      }

      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        const json = body ? JSON.parse(body) : {};
        resolve(json);
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
  });
};

export { getJsonBody };
