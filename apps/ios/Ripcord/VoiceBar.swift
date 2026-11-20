import SwiftUI

struct VoiceBar: View {
  @ObservedObject var voice: VoiceClient
  @Environment(\.dynamicTypeSize) private var dynamicTypeSize
  @ScaledMetric(relativeTo: .body) private var controlIconSize = 19
  let channels: [Channel]
  let compact: Bool
  let onOpen: () -> Void

  var body: some View {
    if let id = voice.channelId {
      VStack(alignment: .leading, spacing: 10) {
        if compact && dynamicTypeSize.isAccessibilitySize {
          connectionButton(id)
          HStack(spacing: 16) { controls }.frame(maxWidth: .infinity, alignment: .trailing)
        } else if !compact && dynamicTypeSize.isAccessibilitySize {
          LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
            controls
          }
        } else {
          HStack(alignment: .top, spacing: 8) {
            if compact {
              connectionButton(id)
            }
            controls
          }
        }
      }.padding(.horizontal, 16).padding(.vertical, compact ? 10 : 16).background(
        RipcordTheme.sidebar
      )
      .overlay(alignment: .top) { Rectangle().fill(RipcordTheme.border).frame(height: 1) }
      .sensoryFeedback(.selection, trigger: voice.micMuted)
      .sensoryFeedback(.selection, trigger: voice.soundMuted)
    }
  }

  private func connectionButton(_ id: Int) -> some View {
    Button(action: onOpen) {
      HStack(spacing: 8) {
        Image(systemName: "waveform")
          .font(.system(size: min(controlIconSize, 24), weight: .semibold))
          .foregroundStyle(RipcordTheme.online)
        VStack(alignment: .leading, spacing: 3) {
          Text(dynamicTypeSize.isAccessibilitySize ? "In call" : "Voice connected")
            .font(.caption.weight(.semibold)).foregroundStyle(RipcordTheme.online)
            .fixedSize(horizontal: false, vertical: true)
          if !dynamicTypeSize.isAccessibilitySize {
            Text(channels.first { $0.id == id }?.name ?? "Voice").font(.caption)
              .foregroundStyle(RipcordTheme.text).lineLimit(1)
          }
        }
        Spacer(minLength: 0)
      }.frame(minHeight: 44)
    }.buttonStyle(.plain).accessibilityIdentifier("openVoice")
      .accessibilityLabel(
        "Voice connected to \(channels.first { $0.id == id }?.name ?? "voice channel")")
  }

  @ViewBuilder private var controls: some View {
    VoiceControl(
      title: voice.canSpeak ? (voice.micMuted ? "Unmute" : "Mute") : "Listen only",
      symbol: voice.micMuted ? "mic.slash.fill" : "mic.fill",
      compact: compact, muted: voice.canSpeak && voice.micMuted,
      accessibilityIdentifier: "toggleMicrophone",
      accessibilityValue: voice.canSpeak
        ? (voice.micMuted ? "Muted" : "Unmuted") : "Speaking not permitted"
    ) { Task { await voice.toggleMicrophone() } }
    .disabled(!voice.canSpeak)
    VoiceControl(
      title: voice.soundMuted ? "Undeafen" : "Deafen",
      symbol: voice.soundMuted ? "headphones.slash" : "headphones",
      compact: compact, muted: voice.soundMuted,
      accessibilityIdentifier: "toggleDeafen",
      accessibilityValue: voice.soundMuted ? "Deafened" : "Listening"
    ) { Task { await voice.toggleDeafen() } }
    if !compact {
      VoiceControl(
        title: "Speaker", symbol: "speaker.wave.2.fill", compact: compact,
        isSelected: voice.speakerEnabled, accessibilityIdentifier: "toggleSpeaker",
        accessibilityValue: voice.speakerEnabled ? "On" : "Off"
      ) { Task { await voice.toggleSpeaker() } }
    }
    VoiceControl(
      title: "Leave", symbol: "phone.down.fill", compact: compact, destructive: true,
      accessibilityIdentifier: "leaveVoice"
    ) { Task { await voice.leave() } }
  }
}

/// A state-driven control, independent of the live media client and automation identifiers.
private struct VoiceControl: View {
  @ScaledMetric(relativeTo: .body) private var controlSize = 52
  @ScaledMetric(relativeTo: .body) private var controlIconSize = 19
  let title: String
  let symbol: String
  let compact: Bool
  var muted = false
  var destructive = false
  var isSelected = false
  let accessibilityIdentifier: String
  var accessibilityValue = ""
  let action: () -> Void

  private var iconForeground: Color {
    if destructive { return RipcordTheme.onDanger }
    if isSelected { return RipcordTheme.onSelectedControl }
    return muted ? RipcordTheme.danger : RipcordTheme.text
  }

  private var iconBackground: Color {
    if destructive { return RipcordTheme.danger }
    if isSelected { return RipcordTheme.text }
    return muted ? RipcordTheme.dangerSurface : RipcordTheme.raised
  }

  var body: some View {
    Button(action: action) {
      VStack(spacing: 6) {
        Image(systemName: symbol)
          .font(.system(size: min(controlIconSize, compact ? 24 : 28), weight: .semibold))
          .foregroundStyle(iconForeground)
          .frame(
            width: compact ? 44 : min(controlSize, 64), height: compact ? 44 : min(controlSize, 64)
          )
          .background(iconBackground, in: Circle())
        if !compact {
          Text(title).font(.caption2.weight(.medium)).lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
        }
      }.foregroundStyle(muted || destructive ? RipcordTheme.danger : RipcordTheme.text)
        .frame(maxWidth: compact ? nil : .infinity)
        .contentShape(Rectangle())
    }.buttonStyle(.plain).accessibilityLabel(title)
      .accessibilityIdentifier(accessibilityIdentifier)
      .accessibilityAddTraits(isSelected ? .isSelected : [])
      .accessibilityValue(accessibilityValue)
  }
}

private struct VoiceControlsPreview: View {
  var compact = false

  var body: some View {
    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
      VoiceControl(
        title: "Mute", symbol: "mic.fill", compact: compact,
        accessibilityIdentifier: "previewDefault", accessibilityValue: "Unmuted"
      ) {}
      VoiceControl(
        title: "Unmute", symbol: "mic.slash.fill", compact: compact, muted: true,
        accessibilityIdentifier: "previewMuted", accessibilityValue: "Muted"
      ) {}
      VoiceControl(
        title: "Listen only", symbol: "mic.slash.fill", compact: compact,
        accessibilityIdentifier: "previewListenOnly", accessibilityValue: "Speaking not permitted"
      ) {}.disabled(true)
      VoiceControl(
        title: "Deafen", symbol: "headphones", compact: compact,
        accessibilityIdentifier: "previewListening", accessibilityValue: "Listening"
      ) {}
      VoiceControl(
        title: "Undeafen", symbol: "headphones.slash", compact: compact, muted: true,
        accessibilityIdentifier: "previewDeafened", accessibilityValue: "Deafened"
      ) {}
      VoiceControl(
        title: "Speaker", symbol: "speaker.wave.2.fill", compact: compact,
        accessibilityIdentifier: "previewSpeakerOff", accessibilityValue: "Off"
      ) {}
      VoiceControl(
        title: "Speaker", symbol: "speaker.wave.2.fill", compact: compact, isSelected: true,
        accessibilityIdentifier: "previewSpeakerOn", accessibilityValue: "On"
      ) {}
      VoiceControl(
        title: "Leave", symbol: "phone.down.fill", compact: compact, destructive: true,
        accessibilityIdentifier: "previewDestructive"
      ) {}
    }
    .padding(16)
    .background(RipcordTheme.sidebar)
  }
}

#Preview("Voice controls · Light") {
  VoiceControlsPreview().preferredColorScheme(.light)
}

#Preview("Voice controls · Dark") {
  VoiceControlsPreview().preferredColorScheme(.dark)
}

#Preview("Compact controls · Dark") {
  VoiceControlsPreview(compact: true).preferredColorScheme(.dark)
}

#Preview("Voice controls · Accessibility") {
  ScrollView { VoiceControlsPreview() }
    .background(RipcordTheme.sidebar)
    .environment(\.dynamicTypeSize, .accessibility3)
    .preferredColorScheme(.light)
}
