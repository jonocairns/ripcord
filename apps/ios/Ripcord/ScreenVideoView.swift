import SwiftUI
import WebRTC

struct ScreenVideoView: UIViewRepresentable {
  let track: RTCVideoTrack
  var onVideoSize: ((CGSize) -> Void)?

  func makeCoordinator() -> Coordinator { Coordinator(onVideoSize: onVideoSize) }

  func makeUIView(context: Context) -> RTCMTLVideoView {
    let view = RTCMTLVideoView(frame: .zero)
    view.videoContentMode = .scaleAspectFit
    view.delegate = context.coordinator
    context.coordinator.bind(track, to: view)
    return view
  }

  func updateUIView(_ view: RTCMTLVideoView, context: Context) {
    context.coordinator.bind(track, to: view)
  }

  static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
    coordinator.unbind(view)
  }

  final class Coordinator: NSObject, RTCVideoViewDelegate {
    private var track: RTCVideoTrack?
    private let onVideoSize: ((CGSize) -> Void)?

    init(onVideoSize: ((CGSize) -> Void)?) { self.onVideoSize = onVideoSize }

    func videoView(_ videoView: RTCVideoRenderer, didChangeVideoSize size: CGSize) {
      guard size.width > 0, size.height > 0 else { return }
      DispatchQueue.main.async { [weak self] in self?.onVideoSize?(size) }
    }

    func bind(_ next: RTCVideoTrack, to view: RTCMTLVideoView) {
      guard track !== next else { return }
      unbind(view)
      track = next
      next.add(view)
    }

    func unbind(_ view: RTCMTLVideoView) {
      track?.remove(view)
      track = nil
    }
  }
}
