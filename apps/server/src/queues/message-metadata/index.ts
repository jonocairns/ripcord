import Queue from 'queue';
import { logger } from '../../logger';
import { processMessageMetadata } from './get-message-metadata';

const messageMetadataQueue = new Queue({
	concurrency: 1,
	autostart: true,
	timeout: 3000,
});

messageMetadataQueue.addEventListener('error', (event) => {
	logger.error('Message metadata queue error', event.detail.error);
});

const enqueueProcessMetadata = (content: string, messageId: number) => {
	messageMetadataQueue.push(async (callback) => {
		// Previews are stored but not published because no client reads them.
		await processMessageMetadata(content, messageId);

		callback?.();
	});
};

export { enqueueProcessMetadata, messageMetadataQueue };
