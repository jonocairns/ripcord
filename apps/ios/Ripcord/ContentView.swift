import SwiftUI

struct ContentView: View {
  @ObservedObject var session: Session
  @ObservedObject var voice: VoiceClient
  @State private var path: [Channel] = []
  @State private var showDiagnostics = false
  // These options outlive the sign-in/channel-list branch, just as they did before extraction.
  @State private var signInPresentation = SignInView.Presentation()
  @State private var channelListPresentation = ChannelListView.Presentation()

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if session.channels.isEmpty {
          SignInView(session: session, presentation: $signInPresentation)
        } else {
          ChannelListView(
            session: session, voice: voice, presentation: $channelListPresentation,
            onOpenVoice: openVoice)
        }
      }
      .navigationDestination(for: Channel.self) { channel in
        ChannelView(session: session, voice: voice, channel: channel, onOpenVoice: openVoice)
      }
      .background(RipcordTheme.sidebar)
      .navigationTitle(session.channels.isEmpty ? "" : session.serverName)
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(RipcordTheme.sidebar, for: .navigationBar)
      .toolbarBackground(.visible, for: .navigationBar)
      .toolbar(session.channels.isEmpty ? .hidden : .visible, for: .navigationBar)
      .toolbar {
        if !session.channels.isEmpty {
          ToolbarItem(placement: .topBarLeading) {
            Image("RipcordLogo").resizable().scaledToFit().frame(width: 30, height: 26)
              .accessibilityLabel("Ripcord")
          }
          ToolbarItem(placement: .topBarTrailing) {
            Menu {
              Button("Media diagnostics", systemImage: "waveform.path.ecg") {
                showDiagnostics = true
              }
              .accessibilityIdentifier("mediaDiagnosticsAction")
              Button("Reconnect", systemImage: "arrow.clockwise") {
                Task { await session.reconnect() }
              }
              Button(
                "Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive
              ) {
                Task { await session.signOut() }
              }
            } label: {
              Image(systemName: "ellipsis")
            }
            .accessibilityIdentifier("serverMenu")
          }
        }
      }
      .sheet(isPresented: $showDiagnostics) { DiagnosticsView(voice: session.voice) }
    }
    .onChange(of: session.channels.isEmpty) { _, empty in if empty { path = [] } }
    .overlay(alignment: .top) {
      if let error = session.errorMessage, !session.channels.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          Text(error).font(.callout)
          HStack {
            Button("Dismiss") { session.errorMessage = nil }
            Spacer()
            if !session.connected {
              Button("Reconnect") { Task { await session.reconnect() } }.disabled(session.busy)
            }
          }
        }
        .padding().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14)).padding()
      }
    }
  }

  private func openVoice() {
    if let channel = session.channels.first(where: { $0.id == voice.channelId }) {
      path = [channel]
    }
  }
}
