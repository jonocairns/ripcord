import AVFoundation
import Combine
import Foundation
import Mediasoup
import WebRTC

@MainActor
final class VoiceClient: ObservableObject {
  @Published private(set) var channelId: Int?
  @Published private(set) var micMuted = false
  @Published private(set) var soundMuted = false
  @Published private(set) var canSpeak = false
  @Published private(set) var speakerEnabled = true
  @Published private(set) var status = "Not connected"
  @Published private(set) var errorMessage: String?
  @Published private(set) var screenSharers: [Int] = []
  @Published private(set) var watchedUserId: Int?
  @Published private(set) var screenTrack: RTCVideoTrack?
  @Published private(set) var participants: [Int] = []
  @Published private(set) var diagnostics = "No media"

  var speakingChannelIDs: Set<Int> = []
  private let rpc: RPCClient
  private var engine: NativeVoiceEngine?
  private var generation = UUID()
  private var subscriptions: [Int] = []
  private var producers: [MediaKey: String] = [:]
  private var producerEventVersion = 0
  private var producerVersions: [MediaKey: Int] = [:]
  private var closedProducerIds: Set<String> = []
  private var consuming: [MediaKey: UUID] = [:]
  private var consumingProducers: [MediaKey: String] = [:]
  private var consumers: [MediaKey: NativeConsumer] = [:]
  private var statsTask: Task<Void, Never>?
  private var shutdownTask: Task<Void, Never>?
  private var mediaReady = false
  private var stateSequence = 0
  private var micIntent = false
  private var soundIntent = false
  private var speakerIntent = true
  private var joining = false
  private var localProducerId: String?
  private var transportIDs: Set<String> = []
  private var watchIntent: Int?
  private var watchRequest = UUID()

  private var effectiveMicrophoneMuted: Bool { !canSpeak || micIntent || soundIntent }

  init(rpc: RPCClient) { self.rpc = rpc }

  func join(channelId target: Int) async throws {
    guard !joining else { throw RipcordError.message("A voice join is already in progress") }
    joining = true
    defer { joining = false }
    await leave()
    let token = generation
    canSpeak = speakingChannelIDs.contains(target)
    if canSpeak {
      status = "Requesting microphone"
      let allowed = await withCheckedContinuation { continuation in
        AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
      }
      guard token == generation else { throw CancellationError() }
      guard allowed else {
        status = "Microphone permission denied"
        throw RipcordError.message("Enable microphone access in iOS Settings before joining voice")
      }
    }
    var joined = false
    do {
      status = "Joining voice"
      let bootstrap = try await rpc.call(
        "voice.join",
        .object([
          "channelId": .number(Double(target)),
          "state": .object([
            "micMuted": .bool(effectiveMicrophoneMuted), "soundMuted": .bool(soundIntent),
          ]),
        ]), mutation: true)
      guard token == generation else { throw CancellationError() }
      joined = true
      channelId = target
      transportIDs = Set(
        [
          bootstrap["producerTransportParams"]["id"].string,
          bootstrap["consumerTransportParams"]["id"].string,
        ].compactMap { $0 })
      participants = bootstrap["channelUsers"].array.compactMap { $0["userId"].int }.sorted()
      // These subscriptions are channel-scoped at subscription time: bind AFTER join.
      try await bindSubscriptions(token: token)
      guard token == generation else { throw CancellationError() }
      let native = NativeVoiceEngine(rpc: rpc, muted: effectiveMicrophoneMuted) {
        [weak self] message, terminal in
        guard let self, self.generation == token else { return }
        if terminal {
          self.errorMessage = message
          Task {
            guard self.generation == token else { return }
            await self.leave(status: message, reason: "recovery_exhausted")
          }
        } else {
          self.diagnostics = message
        }
      }
      engine = native
      let initialSoundMuted = soundIntent
      let initialSpeaker = speakerIntent
      let microphoneEnabled = canSpeak
      let media = try await native.perform {
        try native.start(
          bootstrap: bootstrap, canSpeak: microphoneEnabled,
          deafened: initialSoundMuted, speaker: initialSpeaker)
      }
      guard token == generation else { throw CancellationError() }
      native.capabilitiesJSON = media.capabilities
      localProducerId = media.producerId
      producers = producers.filter { $0.value != media.producerId }
      mediaReady = true
      micMuted = effectiveMicrophoneMuted
      soundMuted = soundIntent
      speakerEnabled = speakerIntent
      // Sweep after binding, not before: closes the join/subscription race.
      let snapshotVersion = producerEventVersion
      let snapshot = try await rpc.call("voice.getProducers")
      guard token == generation else { throw CancellationError() }
      applySnapshot(snapshot, startedAt: snapshotVersion)
      status = "In voice"
      errorMessage = nil
      startStats(native, token: token)
      for key in producers.keys where key.kind == "audio" {
        Task { await self.consume(key, token: token) }
      }
    } catch {
      if token == generation {
        await stopLocally()
        if joined { _ = try? await rpc.call("voice.leave", mutation: true) }
        status = "Voice join failed"
        errorMessage = error.localizedDescription
      }
      throw error
    }
  }

  func leave(status finalStatus: String = "Not connected", reason: String = "user_action") async {
    let hadSession = channelId != nil
    let token = await stopLocally(status: finalStatus)
    guard generation == token else { return }
    if hadSession {
      do {
        _ = try await rpc.call(
          "voice.leave", .object(["reason": .string(reason)]), mutation: true)
      } catch {
        if generation == token { errorMessage = error.localizedDescription }
      }
    }
  }

  /// Used for socket loss and session replacement. NEVER sends voice.leave.
  @discardableResult
  func stopLocally(status finalStatus: String = "Not connected") async -> UUID {
    generation = UUID()
    let token = generation
    mediaReady = false
    watchIntent = nil
    watchRequest = UUID()
    statsTask?.cancel()
    statsTask = nil
    let native = engine
    engine = nil
    // Wake a synchronous delegate before enqueuing teardown behind it.
    native?.cancelSignaling()
    let oldSubscriptions = subscriptions
    subscriptions = []
    let pending = shutdownTask
    let shutdown = Task {
      await pending?.value
      if let native { await native.perform { native.stop() } }
    }
    shutdownTask = shutdown
    await shutdown.value
    guard generation == token else {
      for id in oldSubscriptions { await rpc.unsubscribe(id) }
      return token
    }
    shutdownTask = nil
    // Resource shutdown completes before the UI claims the call is inactive.
    channelId = nil
    watchedUserId = nil
    screenTrack = nil
    screenSharers = []
    participants = []
    producers = [:]
    producerEventVersion = 0
    producerVersions = [:]
    closedProducerIds = []
    consuming = [:]
    consumingProducers = [:]
    consumers = [:]
    localProducerId = nil
    transportIDs = []
    status = finalStatus
    diagnostics = "Media stopped"
    for id in oldSubscriptions { await rpc.unsubscribe(id) }
    return token
  }

  func toggleMicrophone() async {
    guard canSpeak, let native = engine else { return }
    micIntent.toggle()
    let desired = effectiveMicrophoneMuted
    native.setMicrophone(muted: desired)
    micMuted = desired
    await publishState()
  }

  func toggleDeafen() async {
    guard let native = engine else { return }
    soundIntent.toggle()
    let desired = soundIntent
    let token = generation
    // Stop transmission immediately, even if receive signaling is blocked.
    native.setMicrophone(muted: effectiveMicrophoneMuted)
    micMuted = effectiveMicrophoneMuted
    await native.perform { native.setDeafened(desired) }
    guard generation == token, soundIntent == desired else { return }
    soundMuted = desired
    await publishState()
  }

  func toggleSpeaker() async {
    guard let native = engine else { return }
    speakerIntent.toggle()
    let desired = speakerIntent
    let token = generation
    do {
      try await native.perform { try native.routeSpeaker(desired) }
      guard generation == token, speakerIntent == desired else { return }
      speakerEnabled = desired
    } catch {
      guard generation == token, speakerIntent == desired else { return }
      speakerIntent = speakerEnabled
      errorMessage = error.localizedDescription
    }
  }

  func watch(userId: Int) async {
    let request = UUID()
    watchRequest = request
    let token = generation
    await stopWatchingMedia(request: request)
    guard generation == token, watchRequest == request, mediaReady,
      producers[MediaKey(userId: userId, kind: "screen")] != nil
    else { return }
    watchIntent = userId
    watchedUserId = userId
    errorMessage = nil
    await consume(MediaKey(userId: userId, kind: "screen"), token: token)
    guard generation == token, watchRequest == request, watchIntent == userId, screenTrack != nil
    else { return }
    await consume(MediaKey(userId: userId, kind: "screen_audio"), token: token)
  }

  func stopWatching() async {
    let request = UUID()
    watchRequest = request
    await stopWatchingMedia(request: request)
  }

  private func stopWatchingMedia(request: UUID) async {
    watchIntent = nil
    guard let userId = watchedUserId, let native = engine else { return }
    // A pending watch has no published playback to stop. Dismiss its intent
    // immediately; the shared receive transport may still be connecting.
    if screenTrack == nil { watchedUserId = nil }
    let token = generation
    let keys = ["screen", "screen_audio"].map { MediaKey(userId: userId, kind: $0) }
    var closing: [(MediaKey, NativeConsumer)] = []
    for key in keys {
      consuming.removeValue(forKey: key)
      consumingProducers.removeValue(forKey: key)
      if let old = consumers.removeValue(forKey: key) { closing.append((key, old)) }
    }
    let expected = keys.compactMap { key -> (MediaKey, String)? in
      guard let id = producers[key] else { return nil }
      return (key, id)
    }
    await native.perform {
      for (key, producerId) in expected { native.close(key, producerId: producerId) }
      for (key, old) in closing { native.closeConsumer(key, id: old.id) }
    }
    guard generation == token else { return }
    if watchRequest == request {
      screenTrack = nil
      watchedUserId = nil
    }
    for (key, old) in closing {
      guard generation == token else { return }
      await closeServerConsumer(key, id: old.id)
    }
  }

  private func publishState() async {
    let token = generation
    stateSequence += 1
    do {
      _ = try await rpc.call(
        "voice.updateState",
        .object([
          "micMuted": .bool(micMuted), "soundMuted": .bool(soundMuted),
          "seq": .number(Double(stateSequence)),
        ]), mutation: true)
    } catch {
      if generation == token { errorMessage = "Voice state: \(error.localizedDescription)" }
    }
  }

  private func bindSubscriptions(token: UUID) async throws {
    for path in [
      "voice.onNewProducer", "voice.onProducerClosed", "voice.onJoin", "voice.onLeave",
      "voice.onSessionReplaced", "voice.onTransportFailed",
    ] {
      let id = try await rpc.subscribe(path) { [weak self] event in
        guard let self, self.generation == token else { return }
        self.handle(path, event: event, token: token)
      }
      guard generation == token else {
        await rpc.unsubscribe(id)
        throw CancellationError()
      }
      subscriptions.append(id)
    }
  }

  private func handle(_ path: String, event: JSONValue, token: UUID) {
    // This user-scoped event deliberately has no channelId. Newer servers also
    // identify the failed transport so delayed failures cannot end a newer call.
    if path == "voice.onTransportFailed" {
      guard channelId != nil else { return }
      if let id = event["transportId"].string, !transportIDs.contains(id) { return }
      Task {
        guard self.generation == token else { return }
        await self.leave(
          status: "Voice transport failed; rejoin to retry", reason: "recovery_exhausted")
      }
      return
    }
    guard event["channelId"].int == channelId else { return }
    switch path {
    case "voice.onSessionReplaced":
      Task {
        guard self.generation == token else { return }
        await self.stopLocally(status: "Voice moved to another device")
      }
    case "voice.onJoin":
      if let id = event["userId"].int { participants = Array(Set(participants + [id])).sorted() }
    case "voice.onLeave":
      if let id = event["userId"].int { participants.removeAll { $0 == id } }
    default:
      guard let userId = event["remoteId"].int, let kind = event["kind"].string,
        ["audio", "screen", "screen_audio"].contains(kind),
        let producerId = event["producerId"].string
      else { return }
      guard producerId != localProducerId else { return }
      let key = MediaKey(userId: userId, kind: kind)
      producerEventVersion += 1
      if path == "voice.onNewProducer" {
        producerVersions[key] = producerEventVersion
        producers[key] = producerId
        updateSharers()
        if kind == "audio" || watchIntent == userId {
          Task { await self.consume(key, token: token) }
        }
      } else {
        // An old close must never remove a replacement producer or consumer.
        closedProducerIds.insert(producerId)
        guard producers[key] == producerId else { return }
        producerVersions[key] = producerEventVersion
        producers.removeValue(forKey: key)
        consuming.removeValue(forKey: key)
        consumingProducers.removeValue(forKey: key)
        if consumers[key]?.producerId == producerId { consumers.removeValue(forKey: key) }
        updateSharers()
        if let native = engine {
          Task {
            await native.perform { native.close(key, producerId: producerId) }
            guard self.generation == token, self.producers[key] == nil else { return }
            if kind == "screen", self.watchedUserId == userId {
              await self.stopWatching()
              self.screenTrack = nil
            }
          }
        }
      }
    }
  }

  private func applySnapshot(_ value: JSONValue, startedAt version: Int) {
    var snapshotKeys: Set<MediaKey> = []
    for (kind, field) in [
      ("audio", "remoteAudioProducers"), ("screen", "remoteScreenProducers"),
      ("screen_audio", "remoteScreenAudioProducers"),
    ] {
      for ref in value[field].array {
        if let userId = ref["remoteId"].int, let id = ref["producerId"].string {
          let key = MediaKey(userId: userId, kind: kind)
          snapshotKeys.insert(key)
          // A live replacement after the sweep started wins. A stale close
          // for some OTHER producer must not hide this snapshot producer.
          if !closedProducerIds.contains(id),
            (producerVersions[key] ?? 0) <= version || producers[key] == nil
          {
            producers[key] = id
          }
        }
      }
    }
    for key in Array(producers.keys)
    where !snapshotKeys.contains(key) && (producerVersions[key] ?? 0) <= version {
      producers.removeValue(forKey: key)
    }
    updateSharers()
  }

  private func updateSharers() {
    screenSharers = producers.keys.filter { $0.kind == "screen" }.map(\.userId).sorted()
  }

  private func consume(_ key: MediaKey, token: UUID) async {
    guard generation == token, mediaReady, let native = engine, let producerId = producers[key],
      key.kind == "audio" || watchIntent == key.userId
    else { return }
    if consumers[key]?.producerId == producerId { return }
    if consumingProducers[key] == producerId { return }
    // A newer producer may supersede an in-flight request. Its token owns publication.
    let request = UUID()
    consuming[key] = request
    consumingProducers[key] = producerId
    var createdID: String?
    do {
      let transportId = try await native.perform { try native.receiveID() }
      guard generation == token, consuming[key] == request else { return }
      let response = try await rpc.call(
        "voice.consume",
        .object([
          "remoteId": .number(Double(key.userId)), "kind": .string(key.kind),
          "rtpCapabilities": native.capabilitiesJSON, "paused": .bool(true),
          "transportId": .string(transportId),
        ]), mutation: true)
      guard let id = response["consumerId"].string else {
        throw RipcordError.message("Missing consumer ID")
      }
      createdID = id
      guard generation == token, consuming[key] == request, producers[key] == producerId,
        response["producerId"].string == producerId,
        key.kind == "audio" || watchIntent == key.userId
      else { throw CancellationError() }
      let consumer = try await native.perform { try native.consume(key, response: response) }
      guard generation == token, consuming[key] == request, producers[key] == producerId,
        key.kind == "audio" || watchIntent == key.userId
      else { throw CancellationError() }
      _ = try await rpc.call(
        "voice.resumeConsumer",
        .object([
          "remoteId": .number(Double(key.userId)), "kind": .string(key.kind),
          "consumerId": .string(id),
        ]), mutation: true)
      guard generation == token, consuming[key] == request, producers[key] == producerId,
        key.kind == "audio" || watchIntent == key.userId
      else { throw CancellationError() }
      await native.perform { native.resume(key, id: id) }
      guard generation == token, consuming[key] == request else { throw CancellationError() }
      consumers[key] = consumer
      if key.kind == "screen" { screenTrack = consumer.track as? RTCVideoTrack }
    } catch {
      if generation == token, consuming[key] == request, !(error is CancellationError) {
        errorMessage =
          "Cannot receive \(key.kind) from user \(key.userId): \(error.localizedDescription)"
        if key.kind == "screen", watchIntent == key.userId {
          watchIntent = nil
          watchedUserId = nil
          screenTrack = nil
        }
        consuming.removeValue(forKey: key)
        consumingProducers.removeValue(forKey: key)
      }
      if let id = createdID {
        await native.perform { native.closeConsumer(key, id: id) }
        if generation == token { await closeServerConsumer(key, id: id) }
      }
    }
    if consuming[key] == request {
      consuming.removeValue(forKey: key)
      consumingProducers.removeValue(forKey: key)
    }
  }

  private func closeServerConsumer(_ key: MediaKey, id: String) async {
    _ = try? await rpc.call(
      "voice.closeConsumer",
      .object([
        "remoteId": .number(Double(key.userId)), "kind": .string(key.kind),
        "consumerId": .string(id), "intent": .string("stop-watching"),
      ]), mutation: true)
  }

  private func startStats(_ native: NativeVoiceEngine, token: UUID) {
    statsTask = Task { [weak self] in
      while !Task.isCancelled {
        let report = await native.perform { native.statistics() }
        guard let self, self.generation == token else { return }
        self.diagnostics = report
        do { try await Task.sleep(for: .seconds(2)) } catch { return }
      }
    }
  }
}

private struct MediaKey: Hashable {
  let userId: Int
  let kind: String
}

private struct NativeConsumer {
  let id: String
  let producerId: String
  let track: RTCMediaStreamTrack
}

private struct NativeBootstrap {
  let capabilities: JSONValue
  let producerId: String?
}

/// Mediasoup objects stay on one queue. The WebRTC microphone track is the sole
/// exception: its thread-safe enabled setter must not queue behind network waits.
private final class NativeVoiceEngine: NSObject, SendTransportDelegate, ReceiveTransportDelegate {
  private let queue = DispatchQueue(label: "ripcord.ios.media", qos: .userInitiated)
  private let rpc: RPCClient
  private let report: @MainActor (String, Bool) -> Void
  private var device: Device?
  private var factory: RTCPeerConnectionFactory?
  private var send: SendTransport?
  private var receive: ReceiveTransport?
  private let controlLock = NSLock()
  // Protected by controlLock, including installation/removal of the track.
  private var microphone: RTCAudioTrack?
  private var microphoneMuted: Bool
  private var cancelled = false
  private var signalingTask: Task<Void, Never>?
  private var signalingResult: SignalingResult?
  private var producer: Producer?
  private var consumers: [MediaKey: Consumer] = [:]
  private var deafened = false
  private var stopped = false
  private var audioMode = "System microphone and output"
  // Opaque negotiated capabilities are published once, after start completes.
  var capabilitiesJSON: JSONValue = .null

  init(rpc: RPCClient, muted: Bool, report: @escaping @MainActor (String, Bool) -> Void) {
    self.rpc = rpc
    microphoneMuted = muted
    self.report = report
  }

  func perform<T>(_ operation: @escaping () -> T) async -> T {
    await withCheckedContinuation { continuation in
      queue.async { continuation.resume(returning: operation()) }
    }
  }

  func perform<T>(_ operation: @escaping () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { continuation in
      queue.async { continuation.resume(with: Result { try operation() }) }
    }
  }

  private func configureAudio(speaker: Bool) throws {
    let audio = RTCAudioSession.sharedInstance()
    audio.lockForConfiguration()
    defer { audio.unlockForConfiguration() }
    let configuration = RTCAudioSessionConfiguration.webRTC()
    configuration.category = AVAudioSession.Category.playAndRecord.rawValue
    configuration.mode = AVAudioSession.Mode.voiceChat.rawValue
    configuration.categoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP]
    try audio.setConfiguration(configuration, active: true)
    try audio.overrideOutputAudioPort(speaker ? .speaker : .none)
  }

  func start(bootstrap: JSONValue, canSpeak: Bool, deafened: Bool, speaker: Bool) throws
    -> NativeBootstrap
  {
    RTCInitializeSSL()
    var audioDevice: RTCAudioDevice?
    #if DEBUG && targetEnvironment(simulator)
      if ProcessInfo.processInfo.environment["RIPCORD_SYNTHETIC_AUDIO"] == "1" {
        audioDevice = SimulatorAudioDevice()
        audioMode = "TEST: synthetic audio, no hardware"
      }
    #endif
    if audioDevice == nil { try configureAudio(speaker: speaker) }
    let factory = RTCPeerConnectionFactory(
      encoderFactory: RTCDefaultVideoEncoderFactory(),
      decoderFactory: RTCDefaultVideoDecoderFactory(),
      audioDevice: audioDevice)
    self.factory = factory
    let device = Device(pcFactory: factory)
    self.device = device
    try device.load(with: bootstrap["routerRtpCapabilities"].jsonString())
    let sending = bootstrap["producerTransportParams"]
    let receiving = bootstrap["consumerTransportParams"]
    send = try device.createSendTransport(
      id: try requiredString(sending, "id"), iceParameters: sending["iceParameters"].jsonString(),
      iceCandidates: sending["iceCandidates"].jsonString(),
      dtlsParameters: sending["dtlsParameters"].jsonString(),
      sctpParameters: nil, appData: nil)
    receive = try device.createReceiveTransport(
      id: try requiredString(receiving, "id"),
      iceParameters: receiving["iceParameters"].jsonString(),
      iceCandidates: receiving["iceCandidates"].jsonString(),
      dtlsParameters: receiving["dtlsParameters"].jsonString())
    send?.delegate = self
    receive?.delegate = self
    self.deafened = deafened
    if canSpeak {
      let source = factory.audioSource(
        with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
      let track = factory.audioTrack(with: source, trackId: "ripcord-microphone")
      controlLock.lock()
      microphone = track
      track.isEnabled = !microphoneMuted && !cancelled
      let cancelled = cancelled
      controlLock.unlock()
      guard !cancelled else { throw CancellationError() }
      producer = try send?.createProducer(
        for: track, encodings: nil, codecOptions: nil, codec: nil, appData: nil)
    }
    return try NativeBootstrap(
      capabilities: JSONValue(json: device.rtpCapabilities()), producerId: producer?.id)
  }

  func receiveID() throws -> String {
    guard !stopped, let receive else { throw RipcordError.message("Receive transport is closed") }
    return receive.id
  }

  func consume(_ key: MediaKey, response: JSONValue) throws -> NativeConsumer {
    guard !stopped, let receive else { throw RipcordError.message("Receive transport is closed") }
    let consumer = try receive.consume(
      consumerId: requiredString(response, "consumerId"),
      producerId: requiredString(response, "producerId"),
      kind: key.kind == "screen" ? .video : .audio,
      rtpParameters: response["consumerRtpParameters"].jsonString(), appData: nil)
    consumers.removeValue(forKey: key)?.close()
    consumer.track.isEnabled = key.kind == "screen" || !deafened
    consumers[key] = consumer
    return NativeConsumer(id: consumer.id, producerId: consumer.producerId, track: consumer.track)
  }

  func resume(_ key: MediaKey, id: String) {
    guard let consumer = consumers[key], consumer.id == id else { return }
    consumer.resume()
    consumer.track.isEnabled = key.kind == "screen" || !deafened
  }

  func close(_ key: MediaKey, producerId: String?) {
    guard let consumer = consumers[key], producerId == nil || consumer.producerId == producerId
    else { return }
    consumer.track.isEnabled = false
    consumer.close()
    consumers.removeValue(forKey: key)
  }

  func closeConsumer(_ key: MediaKey, id: String) {
    guard consumers[key]?.id == id else { return }
    close(key, producerId: nil)
  }

  func setMicrophone(muted: Bool) {
    controlLock.lock()
    defer { controlLock.unlock() }
    microphoneMuted = muted
    microphone?.isEnabled = !muted && !cancelled
  }

  func cancelSignaling() {
    controlLock.lock()
    defer { controlLock.unlock() }
    cancelled = true
    microphone?.isEnabled = false
    signalingTask?.cancel()
    signalingResult?.store(.failure(CancellationError()))
  }

  func setDeafened(_ value: Bool) {
    deafened = value
    for (key, consumer) in consumers where key.kind != "screen" {
      consumer.track.isEnabled = !value
    }
  }

  func routeSpeaker(_ enabled: Bool) throws {
    let audio = RTCAudioSession.sharedInstance()
    audio.lockForConfiguration()
    defer { audio.unlockForConfiguration() }
    try audio.overrideOutputAudioPort(enabled ? .speaker : .none)
  }

  func stop() {
    guard !stopped else { return }
    stopped = true
    controlLock.lock()
    microphone?.isEnabled = false
    microphone = nil
    controlLock.unlock()
    producer?.close()
    producer = nil
    for consumer in consumers.values {
      consumer.track.isEnabled = false
      consumer.close()
    }
    consumers.removeAll()
    send?.delegate = nil
    receive?.delegate = nil
    send?.close()
    receive?.close()
    send = nil
    receive = nil
    device = nil
    factory = nil
    let audio = RTCAudioSession.sharedInstance()
    audio.lockForConfiguration()
    try? audio.setActive(false)
    audio.unlockForConfiguration()
  }

  func statistics() -> String {
    guard !stopped else { return "Media stopped" }
    var lines = [
      audioMode,
      "send=\(String(describing: send?.connectionState)) recv=\(String(describing: receive?.connectionState))",
    ]
    if let producer { lines.append("microphone \(summarize(producer.stats))") }
    for (key, consumer) in consumers.sorted(by: {
      "\($0.key.userId)\($0.key.kind)" < "\($1.key.userId)\($1.key.kind)"
    }) {
      lines.append("\(key.userId) \(key.kind): \(summarize(consumer.stats))")
    }
    return lines.joined(separator: "\n")
  }

  private func summarize(_ stats: String) -> String {
    guard let value = try? JSONValue(json: stats) else { return "Stats unavailable" }
    let entries = value.array.isEmpty ? Array(value.dictionary.values) : value.array
    let fields = [
      "bytesSent", "bytesReceived", "packetsSent", "packetsReceived", "framesDecoded",
      "framesReceived", "totalAudioEnergy", "audioLevel",
    ]
    let reports = entries.filter {
      ["inbound-rtp", "outbound-rtp"].contains($0["type"].string ?? "")
    }
    let details = reports.map { entry in
      fields.compactMap { field -> String? in
        guard entry[field] != .null, let number = try? entry[field].jsonString() else { return nil }
        return "\(field)=\(number)"
      }.joined(separator: " ")
    }.filter { !$0.isEmpty }
    return details.isEmpty ? "Waiting for RTP counters" : details.joined(separator: "; ")
  }

  func onConnect(transport: Transport, dtlsParameters: String) {
    let path =
      transport is SendTransport
      ? "voice.connectProducerTransport" : "voice.connectConsumerTransport"
    do {
      _ = try signaling(
        path,
        input: .object([
          "transportId": .string(transport.id),
          "dtlsParameters": try JSONValue(json: dtlsParameters),
        ]))
    } catch {
      Task { @MainActor in report("DTLS signaling failed: \(error.localizedDescription)", true) }
    }
  }

  func onProduce(
    transport: Transport, kind: MediaKind, rtpParameters: String, appData: String,
    callback: @escaping (String?) -> Void
  ) {
    do {
      let response = try signaling(
        "voice.produce",
        input: .object([
          "transportId": .string(transport.id), "kind": .string("audio"),
          "rtpParameters": try JSONValue(json: rtpParameters),
        ]))
      callback(response.string)
    } catch {
      callback(nil)
      Task { @MainActor in
        report("Microphone signaling failed: \(error.localizedDescription)", true)
      }
    }
  }

  func onProduceData(
    transport: Transport, sctpParameters: String, label: String,
    protocol dataProtocol: String, appData: String, callback: @escaping (String?) -> Void
  ) {
    callback(nil)
  }

  func onConnectionStateChange(transport: Transport, connectionState: TransportConnectionState) {
    let terminal = connectionState == .failed || connectionState == .disconnected
    let message = "\(transport is SendTransport ? "Send" : "Receive") transport: \(connectionState)"
    Task { @MainActor in report(message, terminal) }
  }

  private func signaling(_ path: String, input: JSONValue) throws -> JSONValue {
    let result = SignalingResult()
    controlLock.lock()
    guard !cancelled else {
      controlLock.unlock()
      throw CancellationError()
    }
    let task = Task { @MainActor in
      do { result.store(.success(try await rpc.call(path, input, mutation: true))) } catch {
        result.store(.failure(error))
      }
    }
    signalingTask = task
    signalingResult = result
    controlLock.unlock()
    defer {
      controlLock.lock()
      signalingTask = nil
      signalingResult = nil
      controlLock.unlock()
    }
    guard result.ready.wait(timeout: .now() + 20) == .success else {
      task.cancel()
      throw RipcordError.message("\(path) timed out")
    }
    return try result.get()
  }

  private func requiredString(_ value: JSONValue, _ key: String) throws -> String {
    guard let string = value[key].string else {
      throw RipcordError.message("Missing media field: \(key)")
    }
    return string
  }
}

private final class SignalingResult {
  let ready = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var result: Result<JSONValue, Error>?
  func store(_ value: Result<JSONValue, Error>) {
    lock.lock()
    defer { lock.unlock() }
    guard result == nil else { return }
    result = value
    ready.signal()
  }
  func get() throws -> JSONValue {
    lock.lock()
    defer { lock.unlock() }
    guard let result else { throw RipcordError.message("No signaling response") }
    return try result.get()
  }
}
