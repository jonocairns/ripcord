import SwiftUI

@main
struct RipcordApp: App {
  @StateObject private var session = Session()

  var body: some Scene {
    WindowGroup {
      ContentView(session: session, voice: session.voice)
        .tint(RipcordTheme.accent)
    }
  }
}
