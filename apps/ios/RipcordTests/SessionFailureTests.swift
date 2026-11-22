import Darwin
import XCTest

@testable import Ripcord

/// Uses the isolated peer's fault proxy, not a mocked Session or production server.
@MainActor
final class SessionFailureTests: XCTestCase {
  private func control(_ body: [String: JSONValue] = [:]) async throws -> JSONValue {
    let url = try XCTUnwrap(URL(string: "http://localhost:5193/failure/control"))
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = try JSONEncoder().encode(JSONValue.object(body))
    let (data, _) = try await URLSession.shared.data(for: request)
    return try JSONDecoder().decode(JSONValue.self, from: data)
  }

  private func session() -> Session {
    let session = Session()
    session.serverAddress = "http://localhost:5193/failure"
    session.identity = "ios-simulator-poc"
    session.password = "local-poc-only"
    return session
  }

  private func waitFor(_ path: String) async throws {
    for _ in 0..<100 {
      let state = try await control()
      if state["paths"].array.contains(.string(path)), (state["held"].int ?? 0) > 0 { return }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTFail("Fixture did not hold \(path)")
  }

  private func audioEnergyDelta() async throws -> Double {
    let url = try XCTUnwrap(URL(string: "http://localhost:5193/fixture"))
    func energy() async throws -> Double {
      let (data, _) = try await URLSession.shared.data(from: url)
      let state = try JSONDecoder().decode(JSONValue.self, from: data)
      guard case .number(let value) = state["inboundAudioEnergy"] else {
        throw RipcordError.message("Missing decoded peer audio energy")
      }
      return value
    }
    try await Task.sleep(for: .seconds(1))
    let before = try await energy()
    try await Task.sleep(for: .seconds(2))
    return try await energy() - before
  }

  private func voiceState(of user: Int, observedBy observer: Session) async throws -> JSONValue {
    let handshake = try await observer.rpc.call("others.handshake")
    let snapshot = try await observer.rpc.call(
      "others.joinServer", .object(["handshakeHash": handshake["handshakeHash"]]))
    return snapshot["voiceMap"]["3"]["users"][String(user)]
  }

  func testDeafenSilencesTransmissionAndPreservesRestingMicrophoneIntent() async throws {
    _ = try await control(["reset": .bool(true)])
    setenv("RIPCORD_SYNTHETIC_AUDIO", "1", 1)
    let session = session()
    addTeardownBlock { await session.signOut() }
    await session.signIn()
    try await session.voice.join(channelId: 3)
    let baseline = try await audioEnergyDelta()
    XCTAssertGreaterThan(baseline, 0.0001)
    await session.voice.toggleDeafen()
    let deafened = try await audioEnergyDelta()
    XCTAssertTrue(session.voice.micMuted)
    XCTAssertLessThan(deafened, 0.0001, "Deafen must silence audio at the remote peer")
    await session.voice.toggleMicrophone()
    await session.voice.toggleDeafen()
    let restingMuted = try await audioEnergyDelta()
    XCTAssertTrue(session.voice.micMuted, "Undeafen must retain the resting microphone preference")
    XCTAssertLessThan(restingMuted, 0.0001)
    await session.voice.toggleDeafen()
    await session.voice.toggleMicrophone()
    let toggled = try await audioEnergyDelta()
    XCTAssertTrue(session.voice.micMuted, "A mic toggle must not bypass Deafen")
    XCTAssertLessThan(toggled, 0.0001)
    await session.voice.leave()
    try await session.voice.join(channelId: 3)
    let rejoined = try await audioEnergyDelta()
    XCTAssertTrue(session.voice.micMuted)
    XCTAssertLessThan(rejoined, 0.0001, "Rejoining while deafened must remain silent")
    await session.voice.toggleDeafen()
    let restored = try await audioEnergyDelta()
    XCTAssertFalse(session.voice.micMuted)
    XCTAssertGreaterThan(restored, 0.0001)
    print(
      "VOICE_ENERGY baseline=\(baseline) deafened=\(deafened) restingMuted=\(restingMuted) toggled=\(toggled) rejoined=\(rejoined) restored=\(restored)"
    )
    await session.voice.leave()
  }

  func testListenOnlyGrantReceivesAudioAndScreenWithoutProducing() async throws {
    // Script the existing permission contract and reject any accidental production.
    _ = try await control([
      "reset": .bool(true), "listenOnly": .bool(true),
      "fail": .array([.string("voice.produce")]),
    ])
    setenv("RIPCORD_SYNTHETIC_AUDIO", "1", 1)
    let session = session()
    addTeardownBlock {
      await session.voice.leave()
      await session.signOut()
      _ = try await self.control(["reset": .bool(true)])
    }
    await session.signIn()
    try await session.voice.join(channelId: 3)
    XCTAssertEqual(session.voice.channelId, 3)
    XCTAssertTrue(session.voice.micMuted)
    await session.voice.toggleMicrophone()
    XCTAssertTrue(session.voice.micMuted)
    for _ in 0..<100 {
      if session.voice.diagnostics.range(
        of: #"audio: [^\n]*bytesReceived=[1-9]"#, options: .regularExpression) != nil,
        !session.voice.screenSharers.isEmpty
      {
        break
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertNotNil(
      session.voice.diagnostics.range(
        of: #"audio: [^\n]*bytesReceived=[1-9]"#, options: .regularExpression))
    let sharer = try XCTUnwrap(session.voice.screenSharers.first)
    await session.voice.watch(userId: sharer)
    for _ in 0..<100 where session.voice.screenTrack == nil {
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertNotNil(session.voice.screenTrack)
    let state = try await control()
    XCTAssertFalse(state["paths"].array.contains(.string("voice.produce")))
  }

  func testReconnectAndTerminalFailureRemoveAbandonedVoiceMembership() async throws {
    _ = try await control(["reset": .bool(true)])
    setenv("RIPCORD_SYNTHETIC_AUDIO", "1", 1)
    let session = session()
    let observer = self.session()
    addTeardownBlock {
      await session.voice.leave()
      await observer.voice.leave()
      await session.signOut()
      await observer.signOut()
      _ = try await self.control(["reset": .bool(true)])
    }
    await session.signIn()
    await observer.signIn()
    try await session.voice.join(channelId: 3)
    let before = try await voiceState(of: session.ownUserId, observedBy: observer)
    XCTAssertNotEqual(before, .null)
    await session.reconnect()
    XCTAssertTrue(session.connected)
    XCTAssertNil(session.voice.channelId)
    let afterReconnect = try await voiceState(of: session.ownUserId, observedBy: observer)
    XCTAssertEqual(afterReconnect, .null)
    try await session.voice.join(channelId: 3)
    _ = try await control(["event": .string("current")])
    var afterFailure = before
    for _ in 0..<100 {
      afterFailure = try await voiceState(of: session.ownUserId, observedBy: observer)
      if session.voice.channelId == nil, afterFailure == .null { break }
      try await Task.sleep(for: .milliseconds(20))
    }
    XCTAssertNil(session.voice.channelId)
    XCTAssertEqual(afterFailure, .null, "Terminal media failure must release server membership")
    try await session.voice.join(channelId: 3)
    try await observer.voice.join(channelId: 3)
    await session.reconnect()
    XCTAssertEqual(observer.voice.channelId, 3)
    let successor = try await voiceState(of: session.ownUserId, observedBy: observer)
    XCTAssertNotEqual(successor, .null, "Old-session cleanup must not evict a successor's call")
  }

  func testStoppedChannelSwitchCannotRestartVoiceAfterDelayedLeave() async throws {
    _ = try await control(["reset": .bool(true)])
    setenv("RIPCORD_SYNTHETIC_AUDIO", "1", 1)
    let session = session()
    addTeardownBlock {
      _ = try await self.control(["reset": .bool(true)])
      await session.voice.leave()
      await session.signOut()
    }
    await session.signIn()
    try await session.voice.join(channelId: 3)
    _ = try await control(["hold": .array([.string("voice.leave")])])
    let switching = Task { try await session.voice.join(channelId: 3) }
    try await waitFor("voice.leave")
    await session.voice.stopLocally()
    _ = try await control(["hold": .array([]), "release": .bool(true)])
    do {
      try await switching.value
      XCTFail("A stopped channel switch must not restart voice")
    } catch is CancellationError {
      // Session replacement and explicit stop supersede the requested join.
    }
    XCTAssertNil(session.voice.channelId)
    let state = try await control()
    XCTAssertEqual(state["paths"].array.filter { $0 == .string("voice.join") }.count, 1)
  }

  func testOldScreenClosureCannotClearAReplacementWatch() async throws {
    _ = try await control(["reset": .bool(true)])
    setenv("RIPCORD_SYNTHETIC_AUDIO", "1", 1)
    let session = session()
    addTeardownBlock {
      _ = try await self.control(["reset": .bool(true)])
      await session.voice.leave()
      await session.signOut()
    }
    await session.signIn()
    try await session.voice.join(channelId: 3)
    for _ in 0..<100 where session.voice.screenSharers.isEmpty {
      try await Task.sleep(for: .milliseconds(50))
    }
    let sharer = try XCTUnwrap(session.voice.screenSharers.first)
    await session.voice.watch(userId: sharer)
    XCTAssertNotNil(session.voice.screenTrack)
    _ = try await control(["hold": .array([.string("voice.closeConsumer")])])
    let url = try XCTUnwrap(
      URL(string: "http://localhost:5193/fixture?action=codec&value=video/VP8"))
    let (_, response) = try await URLSession.shared.data(from: url)
    XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    try await waitFor("voice.closeConsumer")
    for _ in 0..<100 where !session.voice.screenSharers.contains(sharer) {
      try await Task.sleep(for: .milliseconds(50))
    }
    await session.voice.watch(userId: sharer)
    XCTAssertNotNil(
      session.voice.screenTrack, "A new watch must connect before old cleanup completes")
    _ = try await control(["hold": .array([]), "release": .bool(true)])
    try await Task.sleep(for: .milliseconds(500))
    XCTAssertNotNil(session.voice.screenTrack, "Old consumer cleanup must not erase a new watch")
    XCTAssertEqual(session.voice.watchedUserId, sharer)
  }

  func testSignOutClearsLocalStateBeforeLogoutAndInvalidatesHistory() async throws {
    _ = try await control(["reset": .bool(true)])
    let session = session()
    await session.signIn()
    XCTAssertTrue(session.connected)
    _ = try await control(["hold": .array([.string("messages.get"), .string("logout")])])
    let channel = try XCTUnwrap(session.channels.first { $0.type == "TEXT" })
    let history = Task { await session.openChannel(channel) }
    try await waitFor("messages.get")
    session.serverPassword = "secret"
    session.verificationCode = "123456"
    let logout = Task { await session.signOut() }
    try await waitFor("logout")
    XCTAssertFalse(session.connected, "Slow HTTP logout must not leave an active UI")
    XCTAssertTrue(session.channels.isEmpty)
    XCTAssertNil(session.selectedChannel)
    XCTAssertFalse(session.loadingMessages)
    XCTAssertTrue(session.serverPassword.isEmpty)
    XCTAssertTrue(session.verificationCode.isEmpty)
    _ = try await control(["release": .bool(true)])
    await history.value
    await logout.value
    XCTAssertTrue(session.messages.isEmpty, "Old history cannot repopulate a signed-out session")
    XCTAssertNil(session.errorMessage, "Stale failures cannot overwrite signed-out state")
  }

  func testSignOutInvalidatesDelayedAuthentication() async throws {
    _ = try await control(["reset": .bool(true), "hold": .array([.string("login")])])
    let session = session()
    let login = Task { await session.signIn() }
    try await waitFor("login")
    await session.signOut()
    _ = try await control(["release": .bool(true)])
    await login.value
    XCTAssertFalse(session.connected)
    XCTAssertTrue(session.channels.isEmpty)
    XCTAssertTrue(session.password.isEmpty)
    XCTAssertFalse(session.busy)
    XCTAssertNil(session.errorMessage)
  }

  func testFailedReconnectDisablesSendAndJoin() async throws {
    _ = try await control(["reset": .bool(true)])
    let session = session()
    await session.signIn()
    XCTAssertTrue(session.connected)
    _ = try await control(["fail": .array([.string("others.handshake")])])
    await session.reconnect()
    XCTAssertFalse(session.connected)
    XCTAssertNotNil(session.errorMessage)
    await session.signOut()
  }

  func testSuccessfulTwoFactorCanRetryServerJoinWithoutReusingCode() async throws {
    _ = try await control([
      "reset": .bool(true), "twoFactor": .bool(true),
      "fail": .array([.string("others.joinServer")]),
    ])
    let session = session()
    await session.signIn()
    XCTAssertNotNil(session.challengeToken)
    session.verificationCode = "123456"
    await session.signIn()
    XCTAssertFalse(session.connected)
    XCTAssertNil(
      session.challengeToken, "Successful auth must consume the local challenge immediately")
    XCTAssertTrue(session.password.isEmpty)
    XCTAssertTrue(session.verificationCode.isEmpty)
    _ = try await control(["fail": .array([]), "expired": .bool(true)])
    await session.signIn()
    XCTAssertTrue(session.connected, "Retry join with the authenticated token, not another TOTP")
    let state = try await control()
    XCTAssertEqual(state["paths"].array.filter { $0 == .string("verify-2fa") }.count, 1)
    await session.signOut()
  }

  func testExpiredChallengeCanRestartAndChangedCredentialsDiscardIt() async throws {
    _ = try await control([
      "reset": .bool(true), "twoFactor": .bool(true), "expired": .bool(true),
    ])
    let session = session()
    await session.signIn()
    session.verificationCode = "123456"
    await session.signIn()
    XCTAssertEqual(session.errorMessage, "Challenge expired")
    session.restartSignIn()
    XCTAssertNil(session.challengeToken)
    XCTAssertTrue(session.verificationCode.isEmpty)
    XCTAssertNil(session.errorMessage)
    session.password = "local-poc-only"
    await session.signIn()
    XCTAssertNotNil(session.challengeToken)
    session.identity = "changed-account"
    XCTAssertNil(session.challengeToken)
    XCTAssertTrue(session.password.isEmpty)
    session.identity = "ios-simulator-poc"
    session.password = "local-poc-only"
    await session.signIn()
    XCTAssertNotNil(session.challengeToken)
    session.serverPassword = "old-server-secret"
    session.serverAddress = "http://localhost:4993"
    XCTAssertNil(session.challengeToken)
    XCTAssertTrue(session.serverPassword.isEmpty)
    XCTAssertFalse(session.authenticated)
  }

  func testRestartSignInDuringRefreshRevokesUnadoptedReplacement() async throws {
    _ = try await control(["reset": .bool(true)])
    let session = session()
    addTeardownBlock {
      _ = try await self.control(["reset": .bool(true)])
      await session.signOut()
    }
    await session.signIn()
    XCTAssertTrue(session.connected)
    _ = try await control(["hold": .array([.string("refresh")])])
    let reconnect = Task { await session.reconnect() }
    try await waitFor("refresh")
    session.restartSignIn()
    _ = try await control(["hold": .array([]), "release": .bool(true)])
    await reconnect.value
    let state = try await control()
    XCTAssertEqual(state["revokedReplacement"].bool, true)
    XCTAssertFalse(session.authenticated)
    XCTAssertFalse(session.connected)
    XCTAssertNil(session.errorMessage)
  }

  func testSignOutDuringRefreshRevokesReplacementWithoutReconnecting() async throws {
    _ = try await control(["reset": .bool(true)])
    let session = session()
    await session.signIn()
    XCTAssertTrue(session.connected)
    _ = try await control(["hold": .array([.string("refresh")])])
    let reconnect = Task { await session.reconnect() }
    try await waitFor("refresh")
    let logout = Task { await session.signOut() }
    for _ in 0..<20 where session.authenticated { await Task.yield() }
    XCTAssertFalse(session.connected)
    XCTAssertFalse(session.authenticated)
    _ = try await control(["hold": .array([]), "release": .bool(true)])
    await reconnect.value
    await logout.value
    let state = try await control()
    XCTAssertEqual(state["revokedReplacement"].bool, true)
    XCTAssertEqual(state["paths"].array.filter { $0 == .string("others.handshake") }.count, 1)
    XCTAssertFalse(session.connected)
    XCTAssertTrue(session.channels.isEmpty)
    XCTAssertNil(session.errorMessage)
  }
}
