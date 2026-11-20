import SwiftUI

struct ChannelView: View {
  @ObservedObject var session: Session
  @ObservedObject var voice: VoiceClient
  let channel: Channel
  let onOpenVoice: () -> Void
  // Keep chat state at the destination lifetime, including when its channel changes to voice.
  @State private var chatPresentation = ChatView.Presentation()
  @FocusState private var composing: Bool

  var body: some View {
    Group {
      if channel.type == "TEXT" {
        ChatView(
          session: session, voice: voice, channel: channel,
          presentation: $chatPresentation, composing: $composing)
      } else {
        VoiceChannelView(session: session, voice: voice, channel: channel)
      }
    }
    .background { RipcordTheme.background.ignoresSafeArea() }
    .safeAreaInset(edge: .bottom) {
      if !composing {
        VoiceBar(
          voice: voice, channels: session.channels, compact: voice.channelId != channel.id,
          onOpen: onOpenVoice)
      }
    }
    .navigationTitle(channel.name).navigationBarTitleDisplayMode(.inline)
    .toolbarBackground(RipcordTheme.sidebar, for: .navigationBar)
    .toolbarBackground(.visible, for: .navigationBar)
    .toolbar {
      ToolbarItem(placement: .principal) {
        VStack(spacing: 2) {
          Label(channel.name, systemImage: channel.type == "TEXT" ? "number" : "speaker.wave.2")
            .font(.headline).labelStyle(.titleAndIcon)
          if let topic = channel.topic, !topic.isEmpty {
            Text(topic).font(.caption2).foregroundStyle(RipcordTheme.muted).lineLimit(1)
          }
        }
      }
      if composing {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            composing = false
          } label: {
            Image(systemName: "keyboard.chevron.compact.down")
              .foregroundStyle(RipcordTheme.muted)
              .frame(minWidth: 44, minHeight: 44)
          }.accessibilityLabel("Dismiss keyboard").accessibilityIdentifier("dismissKeyboard")
        }
      }
    }
    .task(id: channel.id) { await session.openChannel(channel) }
  }
}
