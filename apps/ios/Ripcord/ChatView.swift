import SwiftUI

struct ChatView: View {
  struct Presentation {
    var draft = ""
    var sending = false
    var followingLatest = true
    var userScrolling = false
    var bottomVisible = true
  }

  @ObservedObject var session: Session
  @ObservedObject var voice: VoiceClient
  let channel: Channel
  @Binding var presentation: Presentation
  @FocusState.Binding var composing: Bool
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .body) private var avatarSize = 38
  @ScaledMetric(relativeTo: .body) private var composerIconSize = 17

  var body: some View {
    ScrollViewReader { proxy in
      let history = ScrollView {
        VStack(alignment: .leading, spacing: 6) {
          if session.nextCursor != .null {
            Button("Load older messages") { Task { await session.loadHistory(older: true) } }
              .frame(maxWidth: .infinity).disabled(session.loadingMessages)
          }
          if session.loadingMessages { ProgressView().frame(maxWidth: .infinity) }
          if !session.loadingMessages && session.messages.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
              Text("Welcome to #\(channel.name)").font(.title2.weight(.bold))
              Text("This is the start of the conversation. Say hello.")
                .font(.callout).foregroundStyle(RipcordTheme.muted)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 20)
          }
          ForEach(Array(session.messages.enumerated()), id: \.element.id) { index, message in
            let previous = index > 0 ? session.messages[index - 1] : nil
            let grouped =
              previous.map {
                $0.userId == message.userId && message.createdAt - $0.createdAt < 300_000
                  && Calendar.current.isDate($0.date, inSameDayAs: message.date)
              } ?? false
            if previous.map({ !Calendar.current.isDate($0.date, inSameDayAs: message.date) })
              ?? true
            {
              HStack {
                Rectangle().fill(RipcordTheme.border).frame(height: 1)
                Text(message.date, format: .dateTime.month(.abbreviated).day())
                  .font(.caption.weight(.medium)).foregroundStyle(RipcordTheme.muted)
                  .fixedSize()
                Rectangle().fill(RipcordTheme.border).frame(height: 1)
              }.padding(.vertical, 14)
            }
            let messageLayout =
              dynamicTypeSize.isAccessibilitySize
              ? AnyLayout(VStackLayout(alignment: .leading, spacing: 5))
              : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
            messageLayout {
              if dynamicTypeSize.isAccessibilitySize {
                if !grouped {
                  HStack(spacing: 12) {
                    MemberAvatar(
                      name: session.userNames[message.userId] ?? "User \(message.userId)",
                      userId: message.userId)
                    messageAuthor(message)
                  }
                }
              } else if !grouped {
                MemberAvatar(
                  name: session.userNames[message.userId] ?? "User \(message.userId)",
                  userId: message.userId)
              } else {
                Color.clear.frame(width: avatarSize, height: 1).accessibilityHidden(true)
              }
              VStack(alignment: .leading, spacing: 5) {
                if !grouped && !dynamicTypeSize.isAccessibilitySize {
                  messageAuthor(message)
                }
                Text(MessageText.plain(message.content)).font(.callout).lineSpacing(3)
                  .foregroundStyle(RipcordTheme.text).textSelection(.enabled)
              }
              if !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
            }.padding(.top, grouped ? 0 : 12)
              .id(message.id).accessibilityIdentifier("message-\(message.id)")
              .accessibilityElement(children: .combine)
              .accessibilityLabel(
                "\(session.userNames[message.userId] ?? "User \(message.userId)"), \(message.date.formatted(date: .omitted, time: .shortened)): \(MessageText.plain(message.content))"
              )
          }
          if #available(iOS 18, *) {
            Color.clear.frame(height: 1).id("chatBottom").accessibilityHidden(true)
              .onScrollVisibilityChange { visible in
                presentation.bottomVisible = visible
                if presentation.userScrolling { presentation.followingLatest = visible }
              }
          } else {
            Color.clear.frame(height: 1).id("chatBottom").accessibilityHidden(true)
          }
        }.padding()
      }
      .scrollDismissesKeyboard(.interactively)
      .defaultScrollAnchor(.bottom)
      Group {
        if #available(iOS 18, *) {
          history.defaultScrollAnchor(
            presentation.followingLatest ? .bottom : nil, for: .sizeChanges
          )
          .onScrollPhaseChange { _, phase in
            let wasUserScrolling = presentation.userScrolling
            presentation.userScrolling = phase == .interacting || phase == .decelerating
            if presentation.userScrolling || (wasUserScrolling && phase == .idle) {
              presentation.followingLatest = presentation.bottomVisible
            }
          }
          .onScrollGeometryChange(for: CGFloat.self) {
            $0.contentInsets.bottom
          } action: { _, _ in
            if presentation.followingLatest { proxy.scrollTo("chatBottom", anchor: .bottom) }
          }
        } else {
          history
        }
      }
      .onChange(of: session.messages.last?.id) { _, _ in
        if presentation.followingLatest {
          withAnimation { proxy.scrollTo("chatBottom", anchor: .bottom) }
        }
      }
      .onChange(of: composing) { _, _ in
        if presentation.followingLatest { proxy.scrollTo("chatBottom", anchor: .bottom) }
      }
      .onReceive(
        NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)
      ) { _ in
        if presentation.followingLatest { proxy.scrollTo("chatBottom", anchor: .bottom) }
      }
      .clipped()
      .safeAreaInset(edge: .bottom) {
        let canSend =
          !presentation.sending && session.connected
          && !presentation.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(spacing: 0) {
          if !presentation.followingLatest {
            Button {
              presentation.followingLatest = true
              withAnimation { proxy.scrollTo("chatBottom", anchor: .bottom) }
            } label: {
              Label(
                dynamicTypeSize.isAccessibilitySize ? "Latest" : "Jump to latest",
                systemImage: "arrow.down"
              )
              .font(.callout.weight(.semibold)).foregroundStyle(RipcordTheme.accent)
              .padding(.horizontal, 14).frame(minHeight: 44)
              .background(RipcordTheme.raised, in: Capsule())
            }.buttonStyle(.plain)
              .accessibilityLabel("Jump to latest messages")
              .accessibilityIdentifier("jumpToLatest")
              .padding(.horizontal, 12).padding(.vertical, 6)
          }
          if composing, let voiceId = voice.channelId {
            HStack(spacing: 8) {
              Label(
                dynamicTypeSize.isAccessibilitySize
                  ? "In call"
                  : "In \(session.channels.first { $0.id == voiceId }?.name ?? "voice")",
                systemImage: "waveform"
              )
              .font(.caption.weight(.semibold)).foregroundStyle(RipcordTheme.online)
              .lineLimit(1)
              Spacer(minLength: 0)
              Button {
                Task { await voice.toggleMicrophone() }
              } label: {
                HStack(spacing: 6) {
                  Image(systemName: voice.micMuted ? "mic.slash.fill" : "mic.fill")
                    .font(.system(size: min(composerIconSize, 20), weight: .semibold))
                  Text(voice.canSpeak ? (voice.micMuted ? "Unmute" : "Mute") : "Listen only")
                    .font(.caption.weight(.semibold))
                }
                .foregroundStyle(
                  voice.canSpeak && voice.micMuted ? RipcordTheme.danger : RipcordTheme.text
                )
                .padding(.horizontal, 10).frame(minHeight: 44)
                .background(
                  voice.canSpeak && voice.micMuted
                    ? RipcordTheme.dangerSurface : RipcordTheme.raised,
                  in: Capsule())
              }.buttonStyle(.plain)
                .disabled(!voice.canSpeak)
                .accessibilityIdentifier("composerMicrophone")
                .accessibilityLabel(
                  voice.canSpeak
                    ? (voice.micMuted ? "Unmute microphone" : "Mute microphone") : "Listen only"
                )
                .accessibilityValue(
                  "Voice connected to \(session.channels.first { $0.id == voiceId }?.name ?? "voice channel")"
                )
            }.padding(.horizontal, 16).padding(.top, 6).background(RipcordTheme.sidebar)
          }
          HStack(alignment: .bottom, spacing: 4) {
            TextField(
              "Message #\(channel.name)", text: $presentation.draft,
              prompt: Text(
                dynamicTypeSize.isAccessibilitySize ? "Message" : "Message #\(channel.name)"
              )
              .foregroundColor(RipcordTheme.muted),
              axis: .vertical
            ).lineLimit(1...5)
              .font(.body)
              .fixedSize(horizontal: false, vertical: true)
              .padding(.vertical, 8)
              .frame(minHeight: 44)
              .focused($composing)
              .accessibilityIdentifier("messageInput")
            Button {
              let text = presentation.draft
              presentation.sending = true
              Task {
                defer { presentation.sending = false }
                do {
                  try await session.send(text)
                  if presentation.draft == text { presentation.draft = "" }
                } catch { session.errorMessage = error.localizedDescription }
              }
            } label: {
              Image(systemName: "arrow.up")
                .font(.system(size: min(composerIconSize, 18), weight: .semibold))
                .foregroundStyle(canSend ? RipcordTheme.onAccent : RipcordTheme.muted)
                .frame(width: 32, height: 32)
                .background(canSend ? RipcordTheme.accent : RipcordTheme.raised, in: Circle())
                .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel("Send message").accessibilityIdentifier("sendMessage")
          }
          .padding(.leading, 14).padding(.trailing, 2)
          .background(RipcordTheme.surface, in: RoundedRectangle(cornerRadius: 18))
          .padding(.horizontal, 12).padding(.vertical, 8).background(RipcordTheme.background)
        }
        .onGeometryChange(for: CGFloat.self) {
          $0.size.height
        } action: { _ in
          if presentation.followingLatest { proxy.scrollTo("chatBottom", anchor: .bottom) }
        }
      }
    }
  }

  private func messageAuthor(_ message: ChatMessage) -> some View {
    let layout =
      dynamicTypeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(alignment: .leading, spacing: 3))
      : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
    return layout {
      Text(session.userNames[message.userId] ?? "User \(message.userId)")
        .font(.callout.weight(.semibold))
      Text(message.date, style: .time).font(.caption2).foregroundStyle(RipcordTheme.muted)
    }
  }
}
