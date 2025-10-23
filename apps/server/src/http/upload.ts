import { StorageOverflowAction, UploadHeaders } from '@sharkord/shared';
import fs from 'fs';
import http from 'http';
import { getUsedFileQuota } from '../db/queries/files/get-used-file-quota';
import { getSettings } from '../db/queries/others/get-settings';
import { getStorageUsageByUserId } from '../db/queries/users/get-storage-usage-by-user-id';
import { getUserByToken } from '../db/queries/users/get-user-by-token';
import { logger } from '../logger';
import { fileManager } from '../utils/file-manager';

const uploadFileRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const token = String(req.headers[UploadHeaders.TOKEN]);
  const originalName = String(req.headers[UploadHeaders.ORIGINAL_NAME]);
  const contentLength = Number(req.headers[UploadHeaders.CONTENT_LENGTH]);

  const user = await getUserByToken(token);

  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const [settings, userStorage, serverStorage] = await Promise.all([
    await getSettings(),
    await getStorageUsageByUserId(user.id),
    await getUsedFileQuota()
  ]);

  if (!settings.storageUploadEnabled) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: 'File uploads are disabled on this server' })
    );
    return;
  }

  const newTotalStorage = userStorage.usedStorage + contentLength;

  if (
    settings.storageSpaceQuotaByUser > 0 &&
    newTotalStorage > settings.storageSpaceQuotaByUser
  ) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'User storage limit exceeded' }));
    return;
  }

  const newServerStorage = serverStorage + contentLength;

  if (
    settings.storageUploadMaxFileSize > 0 &&
    newServerStorage > settings.storageUploadMaxFileSize
  ) {
    if (
      settings.storageOverflowAction === StorageOverflowAction.PREVENT_UPLOADS
    ) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error:
            'Server storage limit exceeded. Uploads are temporarily disabled.'
        })
      );
      return;
    }

    // TODO: delete oldest files to make space for new uploads here
  }

  const safePath = await fileManager.getSafeUploadPath(originalName);

  logger.debug(
    'Uploading file: %s (%d bytes) from %s',
    originalName,
    contentLength,
    user.name
  );

  const fileStream = fs.createWriteStream(safePath);

  req.pipe(fileStream);

  fileStream.on('finish', async () => {
    try {
      const tempFile = await fileManager.addTemporaryFile({
        originalName,
        filePath: safePath,
        size: contentLength,
        userId: user.id
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tempFile));
    } catch (error) {
      logger.error('Error processing uploaded file:', error);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File processing failed' }));
    }
  });

  fileStream.on('error', (err) => {
    logger.error('Error uploading file:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'File upload failed' }));
  });
};

export { uploadFileRouteHandler };
