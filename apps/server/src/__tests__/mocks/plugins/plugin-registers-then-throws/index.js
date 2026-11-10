const onLoad = async (ctx) => {
	// Lets a test act as a stray timer that keeps using the context after the load failed.
	if (Reflect.get(globalThis, 'failedPluginKeepContext')) {
		Reflect.set(globalThis, 'failedPluginContext', ctx);
	}
	ctx.commands.register({ name: 'leaked-command', executes: () => 'leaked' });
	ctx.events.on('message:created', () => {
		const count = Reflect.get(globalThis, 'failedPluginEventCount') ?? 0;
		Reflect.set(globalThis, 'failedPluginEventCount', count + 1);
	});
	await ctx.settings.register([{ key: 'greeting', name: 'Greeting', type: 'string', defaultValue: 'Hello' }]);
	if (Reflect.get(globalThis, 'failedPluginCreateStreams')) {
		ctx.actions.voice.createStream({ channelId: 2, title: 'Failed stream', key: 'failed', producers: {} });
		const removed = ctx.actions.voice.createStream({
			channelId: 2,
			title: 'Removed stream',
			key: 'removed',
			producers: {},
		});
		removed.remove();
	}
	throw new Error('Intentional error after registering resources');
};

export { onLoad };
