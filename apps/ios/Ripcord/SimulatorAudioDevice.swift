#if DEBUG && targetEnvironment(simulator)
  import AVFoundation
  import WebRTC

  /// Opt-in deterministic PCM for transport tests when simulator host audio is unavailable.
  /// Not compiled into device or Release builds. Never claims to exercise real audio hardware.
  final class SimulatorAudioDevice: NSObject, RTCAudioDevice {
    let deviceInputSampleRate = 48_000.0
    let deviceOutputSampleRate = 48_000.0
    let inputIOBufferDuration = 0.01
    let outputIOBufferDuration = 0.01
    let inputNumberOfChannels = 1
    let outputNumberOfChannels = 1
    let inputLatency = 0.0
    let outputLatency = 0.0
    private(set) var isInitialized = false
    private(set) var isPlaying = false
    private(set) var isRecording = false
    private(set) var isPlayoutInitialized = false
    private(set) var isRecordingInitialized = false

    // All device protocol methods run on WebRTC's owning thread. The timer
    // dispatches back to that same thread, keeping PCM callbacks ordered.
    private var delegate: RTCAudioDeviceDelegate?
    private var timer: DispatchSourceTimer?
    private var sample: Int64 = 0

    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
      self.delegate = delegate
      isInitialized = true
      let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInteractive))
      timer.schedule(deadline: .now(), repeating: .milliseconds(10))
      timer.setEventHandler { [weak self, weak delegate] in
        delegate?.dispatchAsync { [weak self] in self?.tick() }
      }
      self.timer = timer
      timer.resume()
      return true
    }

    func terminateDevice() -> Bool {
      timer?.cancel()
      timer = nil
      delegate = nil
      isInitialized = false
      isPlaying = false
      isRecording = false
      isPlayoutInitialized = false
      isRecordingInitialized = false
      return true
    }

    func initializePlayout() -> Bool {
      isPlayoutInitialized = true
      return true
    }
    func initializeRecording() -> Bool {
      isRecordingInitialized = true
      return true
    }
    func startPlayout() -> Bool {
      isPlaying = true
      return true
    }
    func stopPlayout() -> Bool {
      isPlaying = false
      return true
    }
    func startRecording() -> Bool {
      isRecording = true
      return true
    }
    func stopRecording() -> Bool {
      isRecording = false
      return true
    }

    private func tick() {
      guard let delegate, isInitialized else { return }
      var flags: AudioUnitRenderActionFlags = []
      var timestamp = AudioTimeStamp()
      timestamp.mSampleTime = Double(sample)
      timestamp.mFlags = .sampleTimeValid
      var pcm = [Int16](repeating: 0, count: 480)
      pcm.withUnsafeMutableBytes { bytes in
        var buffers = AudioBufferList(
          mNumberBuffers: 1,
          mBuffers: AudioBuffer(
            mNumberChannels: 1, mDataByteSize: UInt32(bytes.count), mData: bytes.baseAddress))
        if isPlaying {
          _ = delegate.getPlayoutData(&flags, &timestamp, 0, 480, &buffers)
        }
        if isRecording {
          let samples = bytes.bindMemory(to: Int16.self)
          for index in samples.indices {
            samples[index] = Int16(
              sin(Double(sample + Int64(index)) * 2 * .pi * 440 / 48_000) * 4_000)
          }
          _ = delegate.deliverRecordedData(&flags, &timestamp, 0, 480, &buffers, nil, nil)
        }
      }
      sample += 480
    }
  }
#endif
