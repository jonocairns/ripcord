import { getTRPCClient } from '@/lib/trpc';
import { addMessages, deleteMessage, updateMessage } from './actions';
import { subscribeToMessageEvents } from './subscriptions-core';

// Subscription replacement is a message-session boundary even when the proxy
// client is reused for a silent reconnect.
let messageSession = 0;
export const getMessageSession = () => messageSession;
const subscribeToMessages = () => {
	messageSession += 1;
	const unsubscribe = subscribeToMessageEvents(getTRPCClient(), { addMessages, updateMessage, deleteMessage });
	return () => {
		messageSession += 1;
		unsubscribe();
	};
};

export { subscribeToMessages };
