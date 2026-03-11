import Queue from 'queue';
import { publishMessage } from '../../db/publishers';
import { logger } from '../../logger';
import { processMessageMetadata } from './get-message-metadata';

const messageMetadataQueue = new Queue({
  concurrency: 1,
  autostart: true,
  timeout: 3000
});

messageMetadataQueue.addEventListener('error', (event) => {
  logger.error('Message metadata queue error', event.detail.error);
});

const enqueueProcessMetadata = (content: string, messageId: number) => {
  messageMetadataQueue.push(async (callback) => {
    const updatedMessage = await processMessageMetadata(content, messageId);

    if (updatedMessage) {
      publishMessage(messageId, undefined, 'update');
    }

    callback?.();
  });
};

export { enqueueProcessMetadata, messageMetadataQueue };
