import SwiftUI

struct ChannelListView: View {
  struct Presentation {
    var textChannelsExpanded = true
    var voiceChannelsExpanded = true
  }

  @ObservedObject var session: Session
  @ObservedObject var voice: VoiceClient
  @Binding var presentation: Presentation
  let onOpenVoice: () -> Void
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .body) private var channelIconSize = 17

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        if !session.connected {
          Label("Disconnected", systemImage: "wifi.slash").foregroundStyle(RipcordTheme.danger)
        }
        ForEach(["TEXT", "VOICE"], id: \.self) { type in
          let expanded =
            type == "TEXT" ? presentation.textChannelsExpanded : presentation.voiceChannelsExpanded
          VStack(alignment: .leading, spacing: 0) {
            Button {
              if type == "TEXT" {
                presentation.textChannelsExpanded.toggle()
              } else {
                presentation.voiceChannelsExpanded.toggle()
              }
            } label: {
              HStack(spacing: 6) {
                Image(systemName: "chevron.right").font(.caption2.weight(.bold))
                  .rotationEffect(.degrees(expanded ? 90 : 0))
                Text(type == "TEXT" ? "Text channels" : "Voice channels")
                  .textCase(.uppercase).font(.caption.weight(.semibold)).tracking(0.8)
                Spacer()
              }.foregroundStyle(RipcordTheme.muted).frame(minHeight: 44)
                .contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityAddTraits(.isHeader)
              .accessibilityValue(expanded ? "Expanded" : "Collapsed")
            if expanded {
              ForEach(session.channels.filter { $0.type == type }) { channel in
                let inVoice = voice.channelId == channel.id
                NavigationLink(value: channel) {
                  HStack(spacing: 12) {
                    Image(systemName: type == "TEXT" ? "number" : "speaker.wave.2")
                      .font(.system(size: min(channelIconSize, 24))).foregroundStyle(
                        inVoice ? RipcordTheme.online : RipcordTheme.muted
                      )
                      .frame(width: 24)
                    VStack(alignment: .leading, spacing: 4) {
                      Text(channel.name).font(.body.weight(.medium)).foregroundStyle(
                        inVoice ? RipcordTheme.online : RipcordTheme.text
                      )
                      .multilineTextAlignment(.leading)
                    }
                    Spacer()
                  }
                  .padding(.horizontal, 8).padding(.vertical, 10)
                  .frame(minHeight: 44)
                }.accessibilityIdentifier("channel-\(channel.id)")
                if voice.channelId == channel.id {
                  ForEach(voice.participants, id: \.self) { id in
                    HStack(spacing: 8) {
                      Circle().fill(RipcordTheme.online).frame(width: 6, height: 6)
                      Text(session.userNames[id] ?? "User \(id)").font(.caption)
                        .foregroundStyle(RipcordTheme.muted)
                      if voice.screenSharers.contains(id) {
                        Text("Live").font(.caption2.bold()).foregroundStyle(RipcordTheme.liveScreen)
                          .padding(.horizontal, 7).padding(.vertical, 4)
                          .background(RipcordTheme.liveScreen.opacity(0.15), in: Capsule())
                      }
                    }.padding(.leading, 40).padding(.vertical, 4)
                      .frame(maxWidth: .infinity, alignment: .leading)
                  }
                }
              }
            }
          }
        }
      }
      .padding(.horizontal, 16).padding(.vertical, 16)
    }
    .safeAreaInset(edge: .bottom) {
      VStack(spacing: 0) {
        VoiceBar(voice: voice, channels: session.channels, compact: true, onOpen: onOpenVoice)
        if voice.channelId == nil || !dynamicTypeSize.isAccessibilitySize {
          if voice.channelId != nil {
            Rectangle().fill(RipcordTheme.border).frame(height: 1)
          }
          HStack(spacing: 12) {
            MemberAvatar(
              name: session.userNames[session.ownUserId] ?? "You", userId: session.ownUserId)
            VStack(alignment: .leading, spacing: 3) {
              Text(session.userNames[session.ownUserId] ?? "You").font(
                .subheadline.weight(.semibold))
              HStack(spacing: 6) {
                Circle().fill(RipcordTheme.online).frame(width: 8, height: 8)
                Text("Online").font(.caption).foregroundStyle(RipcordTheme.muted)
              }
            }
            Spacer()
          }.padding(.horizontal, 16).padding(.vertical, 10)
        }
      }.background(RipcordTheme.sidebar)
    }
  }
}
