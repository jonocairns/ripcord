import SwiftUI

struct DiagnosticsView: View {
  @ObservedObject var voice: VoiceClient
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          Text("Live media diagnostics").font(.title2.bold())
          Text(voice.diagnostics).font(.body.monospaced()).textSelection(.enabled)
            .accessibilityIdentifier("mediaDiagnostics")
          Text(
            "Simulator results do not verify physical microphone quality, Bluetooth, screen-lock audio, or cellular handover."
          )
          .foregroundStyle(.secondary)
        }.padding().frame(maxWidth: .infinity, alignment: .leading)
      }.navigationTitle("Diagnostics")
        .toolbar { Button("Close") { dismiss() }.accessibilityIdentifier("closeDiagnostics") }
    }
  }
}
