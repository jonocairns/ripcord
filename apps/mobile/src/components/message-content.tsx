import { zParsedDomCommand } from '@sharkord/shared';
import RenderHTML from 'react-native-render-html';
import { Text, View } from 'react-native';

type TMessageContentProps = {
	content: string;
	contentWidth: number;
};

const commandMarkupRegex = /^<command\s+([\s\S]+?)><\/command>$/i;
const commandAttributeRegex = /(data-[\w-]+)=(?:"([^"]*)"|'([^']*)')/g;

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
		const parsed = zParsedDomCommand.safeParse({
			args: JSON.parse(attributes['data-args'] ?? '[]'),
			commandName: attributes['data-command'],
			logo: attributes['data-plugin-logo'],
			pluginId: attributes['data-plugin-id'],
			response: attributes['data-response'],
			status: attributes['data-status'],
		});

		if (!parsed.success) {
			return undefined;
		}

		return parsed.data;
	} catch {
		return undefined;
	}
};

function MessageContent({ content, contentWidth }: TMessageContentProps) {
	const command = parseCommandMarkup(content);

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
						{command.args.map((arg) => (
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

	return (
		<RenderHTML
			contentWidth={contentWidth}
			source={{ html: content }}
			tagsStyles={{
				a: { color: '#72d7ff', textDecorationLine: 'none' },
				blockquote: {
					borderLeftColor: '#204764',
					borderLeftWidth: 3,
					color: '#9dc3d8',
					marginBottom: 8,
					marginLeft: 0,
					marginTop: 0,
					paddingLeft: 12,
				},
				body: { color: '#d7edf9', margin: 0, padding: 0 },
				code: {
					backgroundColor: '#0b1724',
					borderRadius: 6,
					color: '#bfe8ff',
					paddingHorizontal: 6,
					paddingVertical: 2,
				},
				em: { color: '#d7edf9', fontStyle: 'italic' },
				h1: { color: '#f4fbff', fontSize: 22, fontWeight: '700', marginBottom: 10, marginTop: 0 },
				h2: { color: '#f4fbff', fontSize: 20, fontWeight: '700', marginBottom: 10, marginTop: 0 },
				h3: { color: '#f4fbff', fontSize: 18, fontWeight: '700', marginBottom: 8, marginTop: 0 },
				hr: { borderColor: '#204764', marginVertical: 10 },
				li: { color: '#d7edf9', marginBottom: 4 },
				ol: { color: '#d7edf9', marginBottom: 8, marginTop: 0, paddingLeft: 20 },
				p: { color: '#d7edf9', marginBottom: 8, marginTop: 0 },
				pre: {
					backgroundColor: '#0b1724',
					borderColor: '#204764',
					borderRadius: 10,
					borderWidth: 1,
					color: '#d7edf9',
					marginBottom: 8,
					marginTop: 0,
					padding: 12,
				},
				strong: { color: '#f4fbff', fontWeight: '700' },
				ul: { color: '#d7edf9', marginBottom: 8, marginTop: 0, paddingLeft: 20 },
			}}
		/>
	);
}

export { MessageContent };
