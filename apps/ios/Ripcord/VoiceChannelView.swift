import SwiftUI

struct VoiceChannelView: View {
  @ObservedObject var session: Session
  @ObservedObject var voice: VoiceClient
  let channel: Channel
  @State private var joining = false
  @State private var showScreenPlayer = false
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .body) private var controlIconSize = 17

  var body: some View {
    voiceChannel
      .fullScreenCover(isPresented: $showScreenPlayer) {
        ScreenSharePlayer(
          voice: voice, name: session.userNames[voice.watchedUserId ?? 0] ?? "Screen share")
      }
  }

  private var voiceChannel: some View {
    GeometryReader { geometry in
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            if voice.channelId != channel.id {
              Image(systemName: "speaker.wave.2.fill")
                .font(.system(size: 36)).foregroundStyle(RipcordTheme.accent)
                .frame(width: 80, height: 80)
                .background(RipcordTheme.raised, in: RoundedRectangle(cornerRadius: 24))
                .padding(.top, 24)
              Text("Hang out in \(channel.name)")
                .font(.title2.bold()).fixedSize(horizontal: false, vertical: true).padding(.top)
              Text("Talk, listen, or watch someone’s screen.")
                .foregroundStyle(RipcordTheme.muted)
              Button {
                joining = true
                Task {
                  defer { joining = false }
                  do { try await voice.join(channelId: channel.id) } catch {
                    if !(error is CancellationError) {
                      session.errorMessage = error.localizedDescription
                    }
                  }
                }
              } label: {
                HStack {
                  if joining { ProgressView() }
                  Text("Join voice").bold()
                }.frame(maxWidth: .infinity)
              }
              .buttonStyle(.borderedProminent).controlSize(.large)
              .buttonBorderShape(.roundedRectangle)
              .foregroundStyle(RipcordTheme.onAccent)
              .disabled(joining || !session.connected).accessibilityIdentifier("joinVoice")
              Text("Joining moves your voice session off any other device.")
                .font(.footnote).foregroundStyle(RipcordTheme.muted)
            } else {
              if let track = voice.screenTrack {
                VStack(alignment: .leading, spacing: 12) {
                  HStack {
                    Text(session.userNames[voice.watchedUserId ?? 0] ?? "Screen share")
                      .font(.subheadline.weight(.semibold)).lineLimit(2).layoutPriority(1)
                    Text("Live").font(.caption2.bold()).foregroundStyle(RipcordTheme.liveScreen)
                      .padding(.horizontal, 7).padding(.vertical, 4)
                      .background(RipcordTheme.liveScreen.opacity(0.15), in: Capsule())
                  }
                  ScreenVideoView(track: track)
                    .aspectRatio(16 / 9, contentMode: .fit).background(.black)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .accessibilityIdentifier("screenVideo")
                    .onTapGesture { showScreenPlayer = true }
                    .overlay(alignment: .topTrailing) {
                      HStack(spacing: 0) {
                        Button {
                          Task { await voice.stopWatching() }
                        } label: {
                          Image(systemName: "xmark").frame(minWidth: 44, minHeight: 44)
                        }.foregroundStyle(RipcordTheme.muted)
                          .accessibilityLabel("Stop watching").accessibilityIdentifier(
                            "stopWatching")
                        Button {
                          showScreenPlayer = true
                        } label: {
                          Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .frame(minWidth: 44, minHeight: 44)
                        }.accessibilityLabel("Expand screen share").accessibilityIdentifier(
                          "expandScreen")
                      }.font(.system(size: min(controlIconSize, 22), weight: .semibold))
                        .background(RipcordTheme.sidebar.opacity(0.95), in: Capsule()).padding(6)
                    }
                }
              }
              if voice.watchedUserId != nil && voice.screenTrack == nil {
                VStack(spacing: 12) {
                  ProgressView()
                  Text("Connecting to screen share…").font(.subheadline)
                  Button("Cancel") { Task { await voice.stopWatching() } }
                    .accessibilityIdentifier("cancelWatching")
                }.frame(maxWidth: .infinity).frame(height: 180)
                  .background(RipcordTheme.surface, in: RoundedRectangle(cornerRadius: 12))
              }
              Text("\(voice.participants.count) in this channel")
                .textCase(.uppercase).font(.caption.weight(.semibold)).tracking(0.8)
                .foregroundStyle(RipcordTheme.muted)
                .accessibilityAddTraits(.isHeader)
              if voice.watchedUserId == nil {
                LazyVGrid(
                  columns: [
                    GridItem(
                      .adaptive(minimum: dynamicTypeSize.isAccessibilitySize ? 250 : 150),
                      spacing: 12, alignment: .top)
                  ], spacing: 12
                ) {
                  ForEach(voice.participants, id: \.self) { id in
                    participant(id, tile: true)
                  }
                }
              } else {
                VStack(spacing: 4) {
                  ForEach(voice.participants, id: \.self) { id in
                    participant(id, tile: false)
                  }
                }
              }
              if let error = voice.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(
                  RipcordTheme.danger)
              }
            }
          }.padding().frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: voice.channelId != channel.id ? geometry.size.height : nil)
            .id("voiceRoomTop")
        }
        .onChange(of: voice.watchedUserId) { _, _ in
          proxy.scrollTo("voiceRoomTop", anchor: .top)
        }
      }
    }
  }

  private func participant(_ id: Int, tile: Bool) -> some View {
    let layout =
      tile || dynamicTypeSize.isAccessibilitySize
      ? AnyLayout(VStackLayout(spacing: 12))
      : AnyLayout(HStackLayout(spacing: 12))
    return layout {
      MemberAvatar(name: session.userNames[id] ?? "User \(id)", userId: id, prominent: tile)
      Text(
        "\(session.userNames[id] ?? "User \(id)")\(id == session.ownUserId ? " (you)" : "")"
      )
      .font(.subheadline.weight(.medium))
      .multilineTextAlignment(tile || dynamicTypeSize.isAccessibilitySize ? .center : .leading)
      if !tile && !dynamicTypeSize.isAccessibilitySize { Spacer(minLength: 0) }
      if id == session.ownUserId {
        if voice.micMuted {
          Image(systemName: "mic.slash.fill").foregroundStyle(RipcordTheme.danger)
            .accessibilityLabel("Microphone muted")
        }
        if voice.soundMuted {
          Image(systemName: "headphones.slash").foregroundStyle(RipcordTheme.danger)
            .accessibilityLabel("Deafened")
        }
      }
      if voice.screenSharers.contains(id) {
        Button {
          if voice.watchedUserId != id { Task { await voice.watch(userId: id) } }
        } label: {
          Text(voice.watchedUserId == id ? "Watching" : "Watch live")
            .font(.caption.weight(.semibold)).foregroundStyle(RipcordTheme.liveScreen)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(RipcordTheme.liveScreen.opacity(0.15), in: Capsule())
            .frame(minHeight: 44)
        }.buttonStyle(.plain).accessibilityIdentifier("watch-\(id)")
          .accessibilityLabel(
            "\(voice.watchedUserId == id ? "Watching" : "Watch") \(session.userNames[id] ?? "User \(id)")’s screen"
          )
          .accessibilityAddTraits(voice.watchedUserId == id ? .isSelected : [])
      }
    }
    .padding(tile ? 16 : 6)
    .frame(
      maxWidth: .infinity, minHeight: tile ? 190 : nil, maxHeight: tile ? .infinity : nil,
      alignment: .top
    )
    .background(tile ? RipcordTheme.surface : .clear, in: RoundedRectangle(cornerRadius: 16))
  }
}
