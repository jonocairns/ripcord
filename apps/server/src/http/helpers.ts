import http from 'http';
import { HttpPayloadTooLargeError } from './utils';

type TGetJsonBodyOptions = {
  maxBytes?: number;
};

const getHeaderNumber = (
  value: string | string[] | undefined
): number | undefined => {
  if (!value) return undefined;

  const parsed = Number(Array.isArray(value) ? value[0] : value);

  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  return parsed;
};

const getJsonBody = async <T = unknown>(
  req: http.IncomingMessage,
  options: TGetJsonBodyOptions = {}
): Promise<T> => {
  const { maxBytes } = options;
  const contentLength = getHeaderNumber(req.headers['content-length']);

  if (
    maxBytes !== undefined &&
    contentLength !== undefined &&
    contentLength > maxBytes
  ) {
    throw new HttpPayloadTooLargeError(maxBytes);
  }

  return new Promise((resolve, reject) => {
    let body = '';
    let bodyLength = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };

    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const resolveOnce = (data: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    const onData = (chunk: Buffer | string) => {
      const chunkLength = Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk);
      bodyLength += chunkLength;

      if (maxBytes !== undefined && bodyLength > maxBytes) {
        req.resume();
        rejectOnce(new HttpPayloadTooLargeError(maxBytes));
        return;
      }

      body += chunk;
    };

    const onEnd = () => {
      try {
        const json = body ? JSON.parse(body) : {};
        resolveOnce(json);
      } catch (err) {
        rejectOnce(err);
      }
    };

    const onError = (error: Error) => {
      rejectOnce(error);
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
};

export { getJsonBody };
