import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, Text, TextInput, useWindowDimensions, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useServerStore } from '@sharkord/app-core';
import { MessageContent } from '@/components/message-content';
import { useChannelMessages } from '@/hooks/use-channel-messages';

export default function ChannelScreen() {
	const params = useLocalSearchParams<{ id: string }>();
	const navigation = useNavigation();
	const { width } = useWindowDimensions();
	const channelId = Number(params.id);
	const {
		cancelEditing,
		channel,
		composerValue,
		deleteMessage,
		displayedMessages,
		editingMessageId,
		error,
		hasMore,
		loadingInitial,
		loadingMore,
		loadMore,
		onComposerChange,
		ownUserId,
		pendingUploads,
		pickUploads,
		removePendingUpload,
		startEditing,
		submitComposer,
		toggleReaction,
		typingUsers,
	} = useChannelMessages(channelId);

	useEffect(() => {
		navigation.setOptions({ title: channel?.name ?? 'Channel' });
	}, [channel?.name, navigation]);

	return (
		<View style={{ backgroundColor: '#08121c', flex: 1 }}>
			<FlashList
				contentContainerStyle={{ padding: 16 }}
				data={displayedMessages}
				keyExtractor={(item) => String(item.id)}
				onEndReached={() => {
					if (!hasMore || loadingMore) {
						return;
					}

					void loadMore();
				}}
				ListEmptyComponent={
					loadingInitial ? <Text style={{ color: '#9dc3d8', textAlign: 'center' }}>Loading messages…</Text> : null
				}
				renderItem={({ item }) => (
					<View
						style={{
							backgroundColor: '#102233',
							borderColor: '#1b3d56',
							borderRadius: 14,
							borderWidth: 1,
							gap: 10,
							marginBottom: 12,
							opacity: item.deliveryState ? 0.78 : 1,
							padding: 14,
						}}
					>
						<View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
							<View style={{ gap: 4 }}>
								<Text style={{ color: '#f4fbff', fontWeight: '700' }}>
									{useServerStore.getState().users.find((user) => user.id === item.userId)?.name ??
										(item.userId === ownUserId ? 'You' : 'Unknown')}
								</Text>
								{item.deliveryState ? (
									<Text style={{ color: '#7e9ab0', fontSize: 12 }}>
										{item.deliveryState === 'sending' ? 'Sending…' : 'Saving edit…'}
									</Text>
								) : null}
							</View>
							<Text style={{ color: '#7e9ab0', fontSize: 12 }}>
								{new Date(item.createdAt).toLocaleTimeString()}
								{item.updatedAt ? ' · edited' : ''}
							</Text>
						</View>
						{item.content ? <MessageContent content={item.content} contentWidth={width - 60} /> : null}
						{item.files.length > 0 ? (
							<Text style={{ color: '#72d7ff' }}>
								Attachments: {item.files.map((file) => file.originalName).join(', ')}
							</Text>
						) : null}
						{item.pendingFiles.length > 0 ? (
							<Text style={{ color: '#72d7ff' }}>
								Uploading attachments: {item.pendingFiles.map((file) => file.originalName).join(', ')}
							</Text>
						) : null}
						{item.reactions.length > 0 ? (
							<Text style={{ color: '#9dc3d8' }}>
								Reactions:{' '}
								{Object.entries(
									item.reactions.reduce<Record<string, number>>((acc, reaction) => {
										acc[reaction.emoji] = (acc[reaction.emoji] ?? 0) + 1;
										return acc;
									}, {}),
								)
									.map(([emoji, count]) => `${emoji} ${count}`)
									.join(' · ')}
							</Text>
						) : null}
						<View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
							<Pressable
								onPress={() => {
									void toggleReaction(item.id, '👍');
								}}
								style={{ backgroundColor: '#0d1a27', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}
							>
								<Text style={{ color: '#d7edf9' }}>👍</Text>
							</Pressable>
							<Pressable
								onPress={() => {
									void toggleReaction(item.id, '❤️');
								}}
								style={{ backgroundColor: '#0d1a27', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}
							>
								<Text style={{ color: '#d7edf9' }}>❤️</Text>
							</Pressable>
							{item.userId === ownUserId && !item.isOptimistic ? (
								<>
									<Pressable
										onPress={() => {
											startEditing(item);
										}}
										style={{ backgroundColor: '#0d1a27', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}
									>
										<Text style={{ color: '#d7edf9' }}>Edit</Text>
									</Pressable>
									<Pressable
										onPress={() => {
											void deleteMessage(item.id);
										}}
										style={{ backgroundColor: '#5a1d1d', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}
									>
										<Text style={{ color: '#fff4f4' }}>Delete</Text>
									</Pressable>
								</>
							) : null}
						</View>
					</View>
				)}
			/>

			<View style={{ borderTopColor: '#1b3d56', borderTopWidth: 1, gap: 10, padding: 16 }}>
				{typingUsers.length > 0 ? (
					<Text style={{ color: '#9dc3d8' }}>
						{typingUsers.join(', ')} {typingUsers.length === 1 ? 'is' : 'are'} typing…
					</Text>
				) : null}
				{pendingUploads.length > 0 ? (
					<View style={{ gap: 8 }}>
						<Text style={{ color: '#72d7ff' }}>Pending uploads</Text>
						{pendingUploads.map((file) => (
							<View
								key={file.id}
								style={{
									alignItems: 'center',
									backgroundColor: '#0b1724',
									borderColor: '#204764',
									borderRadius: 10,
									borderWidth: 1,
									flexDirection: 'row',
									justifyContent: 'space-between',
									paddingHorizontal: 12,
									paddingVertical: 10,
								}}
							>
								<Text style={{ color: '#d7edf9', flex: 1 }}>{file.originalName}</Text>
								<Pressable onPress={() => void removePendingUpload(file.id)}>
									<Text style={{ color: '#ff8f8f', fontWeight: '700' }}>Remove</Text>
								</Pressable>
							</View>
						))}
					</View>
				) : null}
				{error ? <Text style={{ color: '#ff8f8f' }}>{error}</Text> : null}
				{editingMessageId ? (
					<Pressable onPress={cancelEditing}>
						<Text style={{ color: '#72d7ff', fontWeight: '700' }}>Cancel edit</Text>
					</Pressable>
				) : null}
				<TextInput
					multiline
					onChangeText={onComposerChange}
					placeholder={editingMessageId ? 'Edit your message…' : 'Send a message…'}
					placeholderTextColor="#668298"
					style={{
						backgroundColor: '#0b1724',
						borderColor: '#204764',
						borderRadius: 12,
						borderWidth: 1,
						color: '#f4fbff',
						maxHeight: 140,
						minHeight: 52,
						paddingHorizontal: 14,
						paddingVertical: 12,
					}}
					value={composerValue}
				/>
				<View style={{ flexDirection: 'row', gap: 12 }}>
					<Pressable
						onPress={() => {
							void pickUploads();
						}}
						style={{
							alignItems: 'center',
							backgroundColor: '#0e2b3e',
							borderRadius: 12,
							flex: 1,
							opacity: editingMessageId ? 0.45 : 1,
							paddingVertical: 14,
						}}
					>
						<Text style={{ color: '#d7edf9', fontWeight: '700' }}>Upload</Text>
					</Pressable>
					<Pressable
						onPress={() => {
							void submitComposer();
						}}
						style={{
							alignItems: 'center',
							backgroundColor: '#72d7ff',
							borderRadius: 12,
							flex: 1,
							paddingVertical: 14,
						}}
					>
						<Text style={{ color: '#04131d', fontWeight: '700' }}>{editingMessageId ? 'Save' : 'Send'}</Text>
					</Pressable>
				</View>
			</View>
		</View>
	);
}
