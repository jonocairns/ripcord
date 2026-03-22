import { Text, View } from 'react-native';

type TMessageContentProps = {
	content: string;
	contentWidth: number;
};

type TParsedCommandArg = {
	name: string;
	value: unknown;
};

type TParsedCommand = {
	args: TParsedCommandArg[];
	commandName: string;
	logo?: string;
	pluginId: string;
	response?: string;
	status: 'pending' | 'completed' | 'failed';
};

const commandMarkupRegex = /^<command\s+([\s\S]+?)><\/command>$/i;
const commandAttributeRegex = /(data-[\w-]+)=(?:"([^"]*)"|'([^']*)')/g;
const blockTagRegex = /<\/?(?:p|div|section|article|header|footer|aside|blockquote|pre|ul|ol|li|h[1-6])[^>]*>/gi;
const lineBreakTagRegex = /<br\s*\/?>/gi;
const htmlTagRegex = /<[^>]+>/g;

const isValidCommandStatus = (value: unknown): value is TParsedCommand['status'] => {
	return value === 'pending' || value === 'completed' || value === 'failed';
};

const isParsedCommandArg = (value: unknown): value is TParsedCommandArg => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	return 'name' in value && typeof value.name === 'string';
};

const isParsedCommand = (value: unknown): value is TParsedCommand => {
	if (typeof value !== 'object' || value === null) {
		return false;
	}

	if (!('pluginId' in value) || typeof value.pluginId !== 'string' || value.pluginId.length === 0) {
		return false;
	}

	if (!('commandName' in value) || typeof value.commandName !== 'string' || value.commandName.length === 0) {
		return false;
	}

	if (!('status' in value) || !isValidCommandStatus(value.status)) {
		return false;
	}

	if (!('args' in value) || !Array.isArray(value.args) || !value.args.every(isParsedCommandArg)) {
		return false;
	}

	if ('logo' in value && value.logo !== undefined && typeof value.logo !== 'string') {
		return false;
	}

	if ('response' in value && value.response !== undefined && typeof value.response !== 'string') {
		return false;
	}

	return true;
};

const parseCommandMarkup = (content: string) => {
	const trimmed = content.trim();
	const match = commandMarkupRegex.exec(trimmed);

	if (!match) {
		return undefined;
	}

	const attributes: Record<string, string> = {};

	for (const entry of match[1].matchAll(commandAttributeRegex)) {
		const [, key, doubleQuotedValue, singleQuotedValue] = entry;
		const value = doubleQuotedValue ?? singleQuotedValue;

		if (key && value !== undefined) {
			attributes[key] = value;
		}
	}

	try {
		const parsedCommand = {
			args: JSON.parse(attributes['data-args'] ?? '[]'),
			commandName: attributes['data-command'],
			logo: attributes['data-plugin-logo'],
			pluginId: attributes['data-plugin-id'],
			response: attributes['data-response'],
			status: attributes['data-status'] ?? 'pending',
		};

		if (!isParsedCommand(parsedCommand)) {
			return undefined;
		}

		return parsedCommand;
	} catch {
		return undefined;
	}
};

const decodeHtmlEntities = (content: string) => {
	return content
		.replaceAll('&nbsp;', ' ')
		.replaceAll('&amp;', '&')
		.replaceAll('&lt;', '<')
		.replaceAll('&gt;', '>')
		.replaceAll('&quot;', '"')
		.replaceAll('&#39;', "'");
};

const renderPlainMessage = (content: string) => {
	const withLineBreaks = content.replace(lineBreakTagRegex, '\n').replace(blockTagRegex, '\n');
	const withoutTags = withLineBreaks.replace(htmlTagRegex, '');
	const decoded = decodeHtmlEntities(withoutTags);

	return decoded
		.split('\n')
		.map((line) => line.trimEnd())
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
};

function MessageContent({ content }: TMessageContentProps) {
	const command = parseCommandMarkup(content);
	const plainContent = renderPlainMessage(content);

	if (command) {
		return (
			<View
				style={{
					backgroundColor: '#0b1724',
					borderColor: command.status === 'failed' ? '#7c2d2d' : '#204764',
					borderRadius: 12,
					borderWidth: 1,
					gap: 8,
					padding: 12,
				}}
			>
				<Text style={{ color: '#f4fbff', fontWeight: '700' }}>
					/{command.commandName} <Text style={{ color: '#8eb0c6', fontWeight: '500' }}>via {command.pluginId}</Text>
				</Text>
				<Text style={{ color: '#9dc3d8' }}>Status: {command.status}</Text>
				{command.args.length > 0 ? (
					<View style={{ gap: 4 }}>
						{command.args.map((arg: TParsedCommandArg) => (
							<Text key={arg.name} style={{ color: '#d7edf9' }}>
								{arg.name}: {String(arg.value)}
							</Text>
						))}
					</View>
				) : null}
				{command.response ? <Text style={{ color: '#d7edf9' }}>{command.response}</Text> : null}
			</View>
		);
	}

	return <Text style={{ color: '#d7edf9' }}>{plainContent}</Text>;
}

export { MessageContent };
