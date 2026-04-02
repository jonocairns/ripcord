import { getTRPCClient } from '@/lib/trpc';
import { addMessages, deleteMessage, updateMessage } from './actions';
import { subscribeToMessageEvents } from './subscriptions-core';

const subscribeToMessages = () =>
	subscribeToMessageEvents(getTRPCClient(), { addMessages, updateMessage, deleteMessage });

export { subscribeToMessages };
