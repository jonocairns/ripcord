import XCTest

/// Deterministic signaling faults; native media still runs against the isolated server/peer.
final class FailureFlowTests: XCTestCase {
  private func control(_ body: [String: Any] = [:]) async throws -> [String: Any] {
    let url = try XCTUnwrap(URL(string: "http://localhost:5193/failure/control"))
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, _) = try await URLSession.shared.data(for: request)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  @MainActor private func signIn() -> XCUIApplication {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchEnvironment["RIPCORD_TEST_SERVER"] = "http://localhost:5193/failure"
    app.launchEnvironment["RIPCORD_SYNTHETIC_AUDIO"] = "1"
    app.launch()
    XCTAssertTrue(app.textFields["identity"].waitForExistence(timeout: 10))
    app.textFields["identity"].tap()
    app.textFields["identity"].typeText("ios-simulator-poc")
    app.secureTextFields["password"].tap()
    app.secureTextFields["password"].typeText("local-poc-only\n")
    return app
  }

  @MainActor private func join(_ app: XCUIApplication) {
    XCTAssertTrue(app.buttons["channel-3"].waitForExistence(timeout: 20))
    app.buttons["channel-3"].tap()
    app.buttons["joinVoice"].tap()
    XCTAssertTrue(app.buttons["leaveVoice"].waitForExistence(timeout: 20))
  }

  private func audioEnergy() async throws -> Double {
    let url = try XCTUnwrap(URL(string: "http://localhost:5193/fixture"))
    let (data, _) = try await URLSession.shared.data(from: url)
    let state = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    return try XCTUnwrap(state["inboundAudioEnergy"] as? Double)
  }

  private func waitForHold() async throws {
    for _ in 0..<100 {
      if ((try await control())["held"] as? Int ?? 0) > 0 { return }
      try await Task.sleep(for: .milliseconds(30))
    }
    XCTFail("Expected a held signaling reply")
  }

  @MainActor
  func testListenOnlyControlsRemainDisabledWhileWatchingAndChatting() async throws {
    _ = try await control(["reset": true, "listenOnly": true, "fail": ["voice.produce"]])
    let app = signIn()
    join(app)
    let microphone = app.buttons["toggleMicrophone"]
    XCTAssertEqual(microphone.label, "Listen only")
    XCTAssertEqual(microphone.value as? String, "Speaking not permitted")
    XCTAssertFalse(microphone.isEnabled)
    capture("Listen-only voice controls", app)
    let watch = app.buttons["watch-2"]
    XCTAssertTrue(watch.waitForExistence(timeout: 10))
    watch.tap()
    XCTAssertTrue(app.otherElements["screenVideo"].waitForExistence(timeout: 15))
    XCTAssertFalse(microphone.isEnabled)
    app.buttons["stopWatching"].tap()
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertFalse(app.buttons["toggleMicrophone"].isEnabled)
    app.buttons["channel-1"].tap()
    let input = app.textFields["messageInput"]
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    input.tap()
    input.typeText("Draft while listening")
    let composerMicrophone = app.buttons["composerMicrophone"]
    XCTAssertTrue(composerMicrophone.waitForExistence(timeout: 5))
    XCTAssertEqual(composerMicrophone.label, "Listen only")
    XCTAssertFalse(composerMicrophone.isEnabled)
    capture("Listen-only chat composer", app)
    app.buttons["dismissKeyboard"].tap()
    app.buttons["leaveVoice"].tap()
    app.terminate()
    _ = try await control(["reset": true])
  }

  @MainActor
  func testMuteAndLeaveDoNotWaitForDTLSReply() async throws {
    _ = try await control(["reset": true, "hold": ["voice.connectConsumerTransport"]])
    let app = signIn()
    join(app)
    try await waitForHold()
    var audible = false
    for _ in 0..<30 {
      if try await audioEnergy() > 0 {
        audible = true
        break
      }
      try await Task.sleep(for: .milliseconds(100))
    }
    XCTAssertTrue(audible, "The delayed receive DTLS reply must leave a genuinely live microphone")
    app.buttons["toggleMicrophone"].tap()
    let unmuted = app.buttons.matching(
      NSPredicate(format: "identifier == 'toggleMicrophone' AND label == 'Unmute'"))
    XCTAssertTrue(
      unmuted.firstMatch.waitForExistence(timeout: 2), "Local mute must bypass signaling")
    try await Task.sleep(for: .milliseconds(500))
    let mutedStart = try await audioEnergy()
    try await Task.sleep(for: .milliseconds(500))
    let mutedEnd = try await audioEnergy()
    XCTAssertLessThan(
      mutedEnd - mutedStart, 0.0001, "Remote decoded audio must actually become silent")
    app.buttons["leaveVoice"].tap()
    XCTAssertTrue(
      app.buttons["joinVoice"].waitForExistence(timeout: 2), "Local leave must cancel signaling")
    let state = try await control()
    XCTAssertGreaterThan(state["held"] as? Int ?? 0, 0)
    _ = try await control(["reset": true])
    app.terminate()
  }

  @MainActor
  func testTransportFailureMatchesIdentityWithoutChannelID() async throws {
    _ = try await control(["reset": true])
    let app = signIn()
    join(app)
    _ = try await control(["event": "stale"])
    try await Task.sleep(for: .milliseconds(500))
    XCTAssertTrue(
      app.buttons["leaveVoice"].exists, "An obsolete transport must not end the current call")
    _ = try await control(["event": "current"])
    XCTAssertTrue(app.buttons["joinVoice"].waitForExistence(timeout: 3))
    capture("Transport failed — manual rejoin", app)
    for event in ["producer", "legacy"] {
      app.buttons["joinVoice"].tap()
      XCTAssertTrue(app.buttons["leaveVoice"].waitForExistence(timeout: 20))
      _ = try await control(["event": event])
      XCTAssertTrue(app.buttons["joinVoice"].waitForExistence(timeout: 3))
    }
    app.terminate()
    _ = try await control(["reset": true])
  }

  @MainActor
  func testScreenConsumptionFailureCanRetryAndPendingWatchCanCancel() async throws {
    _ = try await control(["reset": true])
    let app = signIn()
    join(app)
    let watch = app.buttons["watch-2"]
    XCTAssertTrue(watch.waitForExistence(timeout: 10))
    for path in ["voice.consume", "voice.resumeConsumer"] {
      _ = try await control(["fail": ["\(path):screen"]])
      watch.tap()
      let error = app.staticTexts.matching(
        NSPredicate(format: "label CONTAINS %@", "Fixture rejected \(path)"))
      XCTAssertTrue(error.firstMatch.waitForExistence(timeout: 5))
      XCTAssertEqual(watch.label, "Watch Desktop test peer’s screen")
      XCTAssertFalse(app.staticTexts["Connecting to screen share…"].exists)
      capture("\(path) failed — retry available", app)
    }
    _ = try await control(["fail": [], "hold": ["voice.consume"]])
    watch.tap()
    try await waitForHold()
    XCTAssertTrue(app.buttons["cancelWatching"].waitForExistence(timeout: 3))
    capture("Pending screen — cancel available", app)
    app.buttons["cancelWatching"].tap()
    XCTAssertFalse(
      app.otherElements["screenVideo"].exists, "A late consume cannot revive a cancelled watch")
    XCTAssertFalse(app.staticTexts["Connecting to screen share…"].exists)
    _ = try await control(["hold": []])
    watch.tap()
    XCTAssertTrue(app.otherElements["screenVideo"].waitForExistence(timeout: 15))
    _ = try await control(["release": true])
    try await Task.sleep(for: .milliseconds(500))
    XCTAssertTrue(
      app.otherElements["screenVideo"].exists, "An old request cannot close a newer watch")
    capture("Retried screen share", app)
    app.buttons["leaveVoice"].tap()
    XCTAssertTrue(app.buttons["joinVoice"].waitForExistence(timeout: 5))
    // With no remote microphone, the screen can be the first receive operation.
    // Cancelling it must not wait for (or cancel) the shared transport's DTLS.
    _ = try await control([
      "fail": ["voice.consume:audio"], "hold": ["voice.connectConsumerTransport"],
    ])
    app.buttons["joinVoice"].tap()
    XCTAssertTrue(app.buttons["leaveVoice"].waitForExistence(timeout: 15))
    watch.tap()
    try await waitForHold()
    app.buttons["cancelWatching"].tap()
    let pending = app.staticTexts["Connecting to screen share…"]
    let cancelled = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in !pending.exists }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [cancelled], timeout: 2), .completed)
    _ = try await control(["hold": [], "release": true])
    watch.tap()
    XCTAssertTrue(app.otherElements["screenVideo"].waitForExistence(timeout: 15))
    app.buttons["leaveVoice"].tap()
    app.terminate()
    _ = try await control(["reset": true])
  }

  @MainActor
  func testExpiredTwoFactorCanRestartAndJoinCanRetry() async throws {
    _ = try await control(["reset": true, "twoFactor": true, "expired": true])
    let app = signIn()
    XCTAssertTrue(app.textFields["verificationCode"].waitForExistence(timeout: 10))
    app.swipeUp()
    app.textFields["verificationCode"].tap()
    app.textFields["verificationCode"].typeText("123456")
    app.buttons["connect"].tap()
    XCTAssertTrue(app.staticTexts["Challenge expired"].waitForExistence(timeout: 5))
    capture("Expired two-factor — restart available", app)
    app.buttons["restartSignIn"].tap()
    XCTAssertFalse(app.textFields["verificationCode"].exists)
    app.swipeDown()
    app.secureTextFields["password"].tap()
    app.secureTextFields["password"].typeText("local-poc-only\n")
    XCTAssertTrue(app.textFields["verificationCode"].waitForExistence(timeout: 10))
    _ = try await control(["expired": false, "fail": ["others.joinServer"]])
    app.swipeUp()
    app.buttons["connect"].tap()
    XCTAssertTrue(app.buttons["Retry server join"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.textFields["verificationCode"].exists)
    capture("Authenticated — retry server join", app)
    _ = try await control(["expired": true, "fail": []])
    app.buttons["connect"].tap()
    XCTAssertTrue(app.buttons["channel-3"].waitForExistence(timeout: 10))
    app.terminate()
    _ = try await control(["reset": true])
  }

  @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
