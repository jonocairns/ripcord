import { OWNER_ROLE_ID, Permission, UploadHeaders } from '@sharkord/shared';
import fs from 'fs';
import http from 'http';
import z from 'zod';
import { getSettings } from '../db/queries/server';
import { getUserByToken } from '../db/queries/users';
import { logger } from '../logger';
import { getUserRoles } from '../routers/users/get-user-roles';
import { fileManager } from '../utils/file-manager';

const zHeaders = z.object({
  [UploadHeaders.TOKEN]: z.string(),
  [UploadHeaders.ORIGINAL_NAME]: z.string(),
  [UploadHeaders.CONTENT_LENGTH]: z
    .string()
    .transform((val) => Number(val))
    .pipe(z.number().int().nonnegative())
});

const uploadFileRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const parsedHeaders = zHeaders.parse(req.headers);
  const [token, originalName, contentLength] = [
    parsedHeaders[UploadHeaders.TOKEN],
    parsedHeaders[UploadHeaders.ORIGINAL_NAME],
    parsedHeaders[UploadHeaders.CONTENT_LENGTH]
  ];

  const user = await getUserByToken(token);

  if (!user) {
    req.resume();
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const roles = await getUserRoles(user.id);
  const hasOwnerRole = roles.some((role) => role.id === OWNER_ROLE_ID);
  const hasUploadPermission =
    hasOwnerRole ||
    roles.some((role) => role.permissions.includes(Permission.UPLOAD_FILES));

  if (!hasUploadPermission) {
    req.resume();
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: 'You do not have permission to upload files' })
    );
    return;
  }

  const settings = await getSettings();

  if (contentLength > settings.storageUploadMaxFileSize) {
    req.resume();
    req.on('end', () => {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: `File ${originalName} exceeds the maximum allowed size`
        })
      );
    });

    return;
  }

  if (!settings.storageUploadEnabled) {
    req.resume();
    req.on('end', () => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: 'File uploads are disabled on this server' })
      );
    });

    return;
  }

  const maxUserTempBytes =
    settings.storageSpaceQuotaByUser > 0
      ? Math.min(
          settings.storageSpaceQuotaByUser,
          settings.storageUploadMaxFileSize
        )
      : settings.storageUploadMaxFileSize;
  const maxTotalTempBytes =
    settings.storageQuota > 0
      ? Math.min(settings.storageQuota, settings.storageUploadMaxFileSize * 4)
      : settings.storageUploadMaxFileSize * 4;

  let reservationId: string | undefined;
  let reservationReleased = false;
  const releaseReservation = () => {
    if (!reservationId || reservationReleased) {
      return;
    }

    fileManager.releaseTemporaryUploadReservation(reservationId);
    reservationReleased = true;
  };

  try {
    reservationId = fileManager.reserveTemporaryUpload({
      userId: user.id,
      size: contentLength,
      maxUserBytes: maxUserTempBytes,
      maxTotalBytes: maxTotalTempBytes
    });
  } catch (error) {
    req.resume();
    req.on('end', () => {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            error instanceof Error
              ? error.message
              : 'Temporary upload capacity exceeded'
        })
      );
    });

    return;
  }

  const safePath = await fileManager.getSafeUploadPath(originalName);
  const fileStream = fs.createWriteStream(safePath);
  let streamedSize = 0;
  let abortedUpload = false;

  const abortUpload = (statusCode: number, error: string) => {
    if (abortedUpload) {
      return;
    }

    abortedUpload = true;
    releaseReservation();
    req.unpipe(fileStream);
    fileStream.destroy();

    fs.promises.unlink(safePath).catch(() => {
      // ignore cleanup errors
    });

    if (!res.headersSent) {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
    }
  };

  req.on('aborted', () => {
    releaseReservation();
  });

  req.on('error', () => {
    releaseReservation();
  });

  req.on('data', (chunk) => {
    streamedSize += chunk.length;

    try {
      if (reservationId) {
        fileManager.resizeTemporaryUploadReservation({
          reservationId,
          size: streamedSize,
          maxUserBytes: maxUserTempBytes,
          maxTotalBytes: maxTotalTempBytes
        });
      }
    } catch (error) {
      abortUpload(
        413,
        error instanceof Error
          ? error.message
          : 'Temporary upload capacity exceeded'
      );
      return;
    }

    if (streamedSize <= settings.storageUploadMaxFileSize) {
      return;
    }

    abortUpload(413, `File ${originalName} exceeds the maximum allowed size`);
  });

  req.pipe(fileStream);

  fileStream.on('finish', async () => {
    if (abortedUpload) {
      releaseReservation();
      return;
    }

    try {
      const stats = await fs.promises.stat(safePath);
      const actualSize = stats.size;

      if (actualSize > settings.storageUploadMaxFileSize) {
        await fs.promises.unlink(safePath).catch(() => {
          // ignore cleanup errors
        });

        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: `File ${originalName} exceeds the maximum allowed size`
          })
        );
        return;
      }

      if (actualSize !== contentLength) {
        logger.warn(
          'Upload size mismatch for %s: header=%d actual=%d',
          originalName,
          contentLength,
          actualSize
        );
      }

      const tempFile = await fileManager.addTemporaryFile({
        originalName,
        filePath: safePath,
        size: actualSize,
        userId: user.id
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tempFile));
    } catch (error) {
      logger.error('Error processing uploaded file:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File processing failed' }));
    } finally {
      releaseReservation();
    }
  });

  fileStream.on('error', (err) => {
    releaseReservation();

    if (abortedUpload || res.headersSent) {
      return;
    }

    logger.error('Error uploading file:', err);

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File upload failed' }));
  });
};

export { uploadFileRouteHandler };
