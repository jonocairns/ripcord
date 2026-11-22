import SwiftUI

struct ScreenSharePlayer: View {
  @ObservedObject var voice: VoiceClient
  let name: String
  @Environment(\.dismiss) private var dismiss
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOverEnabled
  @State private var zoom: CGFloat = 1
  @State private var offset = CGSize.zero
  @State private var videoSize = CGSize(width: 16, height: 9)
  @State private var showControls = true
  @State private var lastInteraction = Date()
  @GestureState private var magnification: CGFloat = 1
  @GestureState private var drag = CGSize.zero

  var body: some View {
    GeometryReader { geometry in
      let scale = min(4, max(1, zoom * magnification))
      let position = bounded(
        CGSize(width: offset.width + drag.width, height: offset.height + drag.height),
        scale: scale, viewport: geometry.size)
      ZStack {
        Color.black
        if let track = voice.screenTrack {
          ScreenVideoView(track: track, onVideoSize: { videoSize = $0 })
            .frame(width: fitted(in: geometry.size).width, height: fitted(in: geometry.size).height)
            .scaleEffect(scale)
            .offset(x: position.width, y: position.height)
            .accessibilityIdentifier("expandedScreenVideo")
            .accessibilityLabel("Screen shared by \(name)")
            .accessibilityValue("\(Int(zoom * 100)) percent zoom")
            .accessibilityAdjustableAction { direction in
              switch direction {
              case .increment: zoom = min(4, zoom + 0.5)
              case .decrement: zoom = max(1, zoom - 0.5)
              @unknown default: return
              }
              offset = bounded(offset, scale: zoom, viewport: geometry.size)
            }
            .accessibilityScrollAction { edge in
              var next = offset
              switch edge {
              case .top: next.height += geometry.size.height / 4
              case .bottom: next.height -= geometry.size.height / 4
              case .leading: next.width += geometry.size.width / 4
              case .trailing: next.width -= geometry.size.width / 4
              }
              offset = bounded(next, scale: zoom, viewport: geometry.size)
            }
        }
      }
      .frame(width: geometry.size.width, height: geometry.size.height)
      .clipped().contentShape(Rectangle())
      .gesture(
        MagnificationGesture().updating($magnification) { value, state, _ in
          state = value
        }.onEnded { value in
          zoom = min(4, max(1, zoom * value))
          offset = bounded(offset, scale: zoom, viewport: geometry.size)
        }
      )
      .simultaneousGesture(
        DragGesture().updating($drag) { value, state, _ in
          if zoom > 1 { state = value.translation }
        }.onEnded { value in
          offset = bounded(
            CGSize(
              width: offset.width + value.translation.width,
              height: offset.height + value.translation.height), scale: zoom,
            viewport: geometry.size)
        }
      )
      .onTapGesture(count: 2) {
        zoom = zoom == 1 ? 2 : 1
        offset = .zero
        showControls = true
        lastInteraction = Date()
      }
      .onTapGesture { showControls.toggle() }
      .onChange(of: geometry.size) { _, _ in
        zoom = 1
        offset = .zero
        showControls = true
        lastInteraction = Date()
      }
      .onChange(of: videoSize) { _, _ in
        offset = bounded(offset, scale: zoom, viewport: geometry.size)
      }
    }
    .ignoresSafeArea()
    .overlay {
      if showControls {
        VStack {
          HStack {
            Label(name, systemImage: "rectangle.on.rectangle")
              .font(.subheadline.weight(.semibold)).lineLimit(1)
            Spacer()
            Button {
              dismiss()
            } label: {
              Image(systemName: "chevron.down").frame(width: 44, height: 44)
            }.accessibilityLabel("Minimise screen share").accessibilityIdentifier(
              "closeScreenPlayer")
          }.padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
            .foregroundStyle(.white)
            .background {
              LinearGradient(
                colors: [.black.opacity(0.8), .clear], startPoint: .top, endPoint: .bottom
              )
              .ignoresSafeArea(edges: .top)
            }
          Spacer()
          HStack {
            if zoom > 1 {
              Button {
                zoom = 1
                offset = .zero
                lastInteraction = Date()
              } label: {
                Text("Reset zoom").frame(minHeight: 44).padding(.horizontal, 14)
                  .foregroundStyle(.white).background(.black.opacity(0.65), in: Capsule())
              }
            }
            Spacer()
            Button(role: .destructive) {
              Task {
                await voice.stopWatching()
                dismiss()
              }
            } label: {
              Label("Stop watching", systemImage: "xmark")
                .frame(minHeight: 44).padding(.horizontal, 14)
                .foregroundStyle(RipcordTheme.danger)
                .background(RipcordTheme.dangerSurface, in: Capsule())
            }
          }.buttonStyle(.plain).font(.subheadline.weight(.semibold))
            .padding(.horizontal, 16).padding(.bottom, 8).padding(.top, 24)
            .background {
              LinearGradient(
                colors: [.clear, .black.opacity(0.8)], startPoint: .top, endPoint: .bottom
              )
              .ignoresSafeArea(edges: .bottom)
            }
        }
      }
    }
    .background(.black).preferredColorScheme(.dark).statusBarHidden()
    .persistentSystemOverlays(.hidden)
    .onChange(of: showControls) { _, _ in lastInteraction = Date() }
    .task(id: lastInteraction) {
      guard showControls, !voiceOverEnabled else { return }
      do { try await Task.sleep(for: .seconds(3)) } catch { return }
      showControls = false
    }
    .onChange(of: voice.watchedUserId) { _, id in if id == nil { dismiss() } }
    .onChange(of: voice.channelId) { _, id in if id == nil { dismiss() } }
  }

  private func fitted(in viewport: CGSize) -> CGSize {
    let scale = min(viewport.width / videoSize.width, viewport.height / videoSize.height)
    return CGSize(width: videoSize.width * scale, height: videoSize.height * scale)
  }

  private func bounded(_ offset: CGSize, scale: CGFloat, viewport: CGSize) -> CGSize {
    let video = fitted(in: viewport)
    let x = max(0, (video.width * scale - viewport.width) / 2)
    let y = max(0, (video.height * scale - viewport.height) / 2)
    return CGSize(width: min(x, max(-x, offset.width)), height: min(y, max(-y, offset.height)))
  }
}
