import fs from 'node:fs';
import type http from 'node:http';
import { Permission, UploadHeaders } from '@sharkord/shared';
import z from 'zod';
import { loadUserGrants } from '../db/queries/permissions';
import { getSettings } from '../db/queries/server';
import { getUserByToken } from '../db/queries/users';
import { logger } from '../logger';
import { fileManager, TemporaryFileCapacityError } from '../utils/file-manager';
import { hasGlobalPermission } from '../utils/permission-policy';
import { createRateLimiter, getRateLimitRetrySeconds } from '../utils/rate-limiters/rate-limiter';

const uploadLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60_000, retainActiveEntries: true });
const activeUploads = new Map<number, number>();
const MAX_CONCURRENT_UPLOADS = 4;

const zHeaders = z.object({
	[UploadHeaders.TOKEN]: z.string(),
	[UploadHeaders.ORIGINAL_NAME]: z.string(),
	[UploadHeaders.CONTENT_LENGTH]: z
		.string()
		.transform((val) => Number(val))
		.pipe(z.number().int().nonnegative()),
});

const uploadFileRouteHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
	const parsedHeaders = zHeaders.parse(req.headers);
	const [token, originalName, contentLength] = [
		parsedHeaders[UploadHeaders.TOKEN],
		parsedHeaders[UploadHeaders.ORIGINAL_NAME],
		parsedHeaders[UploadHeaders.CONTENT_LENGTH],
	];

	const user = await getUserByToken(token);

	if (!user) {
		req.resume();
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}

	if (user.banned) {
		req.resume();
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'User is banned' }));
		return;
	}

	const rateLimit = uploadLimiter.consume(`user:${user.id}`);
	const rejectUpload = (retryAfterSeconds: number) => {
		req.resume();
		res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': retryAfterSeconds });
		res.end(JSON.stringify({ error: 'Too many uploads. Please try again shortly.' }));
	};

	if (!rateLimit.allowed) {
		rejectUpload(getRateLimitRetrySeconds(rateLimit.retryAfterMs));
		return;
	}

	const hasUploadPermission = hasGlobalPermission(loadUserGrants(user.id), Permission.UPLOAD_FILES);

	if (!hasUploadPermission) {
		req.resume();
		res.writeHead(403, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'You do not have permission to upload files' }));
		return;
	}

	const settings = await getSettings();

	if (contentLength > settings.storageUploadMaxFileSize) {
		req.resume();
		req.on('end', () => {
			res.writeHead(413, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					error: `File ${originalName} exceeds the maximum allowed size`,
				}),
			);
		});

		return;
	}

	if (!settings.storageUploadEnabled) {
		req.resume();
		req.on('end', () => {
			res.writeHead(403, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'File uploads are disabled on this server' }));
		});

		return;
	}

	const safePath = await fileManager.getSafeUploadPath(originalName);
	// Check after the awaited setup so simultaneous requests cannot overbook slots.
	if (res.destroyed) return;
	const activeCount = activeUploads.get(user.id) ?? 0;
	if (activeCount >= MAX_CONCURRENT_UPLOADS) {
		rejectUpload(1);
		return;
	}

	activeUploads.set(user.id, activeCount + 1);
	res.once('close', () => {
		const remaining = (activeUploads.get(user.id) ?? 1) - 1;
		if (remaining === 0) activeUploads.delete(user.id);
		else activeUploads.set(user.id, remaining);
	});
	const fileStream = fs.createWriteStream(safePath);
	let streamedSize = 0;
	let abortedForSize = false;
	const cleanupStagedUpload = () =>
		fs.promises.unlink(safePath).catch(() => {
			// ignore cleanup errors
		});

	req.on('data', (chunk) => {
		streamedSize += chunk.length;

		if (streamedSize <= settings.storageUploadMaxFileSize) {
			return;
		}

		if (abortedForSize) {
			return;
		}

		abortedForSize = true;
		req.unpipe(fileStream);
		fileStream.destroy();

		cleanupStagedUpload();

		if (!res.headersSent) {
			res.writeHead(413, { 'Content-Type': 'application/json' });
			res.end(
				JSON.stringify({
					error: `File ${originalName} exceeds the maximum allowed size`,
				}),
			);
		}
	});

	req.on('aborted', () => {
		fileStream.destroy();
		cleanupStagedUpload();
	});

	req.pipe(fileStream);

	fileStream.on('finish', async () => {
		if (abortedForSize) {
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
						error: `File ${originalName} exceeds the maximum allowed size`,
					}),
				);
				return;
			}

			if (actualSize !== contentLength) {
				logger.warn('Upload size mismatch for %s: header=%d actual=%d', originalName, contentLength, actualSize);
			}

			const tempFile = await fileManager.addTemporaryFile({
				originalName,
				filePath: safePath,
				size: actualSize,
				userId: user.id,
			});

			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(tempFile));
		} catch (error) {
			await cleanupStagedUpload();

			if (error instanceof TemporaryFileCapacityError) {
				res.writeHead(429, { 'Content-Type': 'application/json' });
				res.end(
					JSON.stringify({
						error: error.message,
					}),
				);
				return;
			}

			logger.error('Error processing uploaded file:', error);
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'File processing failed' }));
		}
	});

	fileStream.on('error', (err) => {
		if (abortedForSize || res.headersSent) {
			return;
		}

		cleanupStagedUpload();
		logger.error('Error uploading file:', err);

		res.writeHead(500, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: 'File upload failed' }));
	});
};

export { uploadFileRouteHandler };
