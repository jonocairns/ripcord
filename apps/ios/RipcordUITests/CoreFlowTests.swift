import XCTest

/// Requires the isolated local server and synthetic browser peer documented in README.md.
final class CoreFlowTests: XCTestCase {
  @MainActor
  func testChatVoiceAndScreenViewing() async throws {
    continueAfterFailure = false
    let app = XCUIApplication()
    app.launchEnvironment["RIPCORD_TEST_SERVER"] = "http://localhost:4993"
    app.launchEnvironment["RIPCORD_SYNTHETIC_AUDIO"] = "1"
    app.launch()
    XCTAssertTrue(app.textFields["identity"].waitForExistence(timeout: 10))
    capture("Sign in", app)
    app.textFields["identity"].tap()
    app.textFields["identity"].typeText("ios-simulator-poc")
    app.secureTextFields["password"].tap()
    app.secureTextFields["password"].typeText("local-poc-only\n")
    XCTAssertTrue(app.buttons["channel-1"].waitForExistence(timeout: 25), app.debugDescription)
    capture("Channels", app)

    let history = "Earlier desktop message \(UUID().uuidString.prefix(6))"
    _ = try await fixture(action: "message", value: history)
    app.buttons["channel-1"].tap()
    XCTAssertTrue(message(history, in: app).waitForExistence(timeout: 15))
    let suffix = UUID().uuidString.prefix(6)
    let outgoing = "Hello from Swift <native> & simulator \(suffix)"
    let input = app.textFields["messageInput"]
    XCTAssertTrue(input.waitForExistence(timeout: 10))
    input.tap()
    input.typeText(" ")
    input.typeText(XCUIKeyboardKey.delete.rawValue)
    XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
    assertAboveComposer(history, in: app)
    capture("Empty composer with keyboard", app)
    input.typeText(outgoing)
    assertAboveComposer(history, in: app)
    capture("Wrapped message draft", app)
    app.buttons["sendMessage"].tap()
    XCTAssertTrue(message(outgoing, in: app).waitForExistence(timeout: 15))
    let peer = try await fixture()
    XCTAssertTrue(
      (peer["receivedMessages"] as? [String] ?? []).contains {
        $0 == "<p>Hello from Swift &lt;native&gt; &amp; simulator \(suffix)</p>"
      })
    let incoming = "Desktop reply \(UUID().uuidString.prefix(6))"
    _ = try await fixture(action: "message", value: incoming)
    XCTAssertTrue(message(incoming, in: app).waitForExistence(timeout: 15))
    let multiline = "First line \(suffix)\nSecond line\nThird line"
    input.typeText(multiline)
    XCTAssertEqual(input.value as? String, multiline)
    assertAboveComposer(incoming, in: app)
    capture("Multiline message draft", app)
    app.buttons["sendMessage"].tap()
    XCTAssertTrue(message(multiline, in: app).waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["sendMessage"].isEnabled)
    let multilinePeer = try await fixture()
    XCTAssertTrue(
      (multilinePeer["receivedMessages"] as? [String] ?? []).contains(
        "<p>First line \(suffix)<br />Second line<br />Third line</p>"))
    let longDraft =
      "First line \(suffix)\nSecond line\nThird line\nFourth line\nFifth line\nSixth line"
    input.typeText(longDraft)
    XCTAssertEqual(input.value as? String, longDraft)
    XCTAssertTrue(app.buttons["sendMessage"].isHittable)
    assertAboveComposer(multiline, in: app)
    capture("Six-line message draft", app)
    app.buttons["sendMessage"].tap()
    XCTAssertTrue(message(longDraft, in: app).waitForExistence(timeout: 15))
    app.buttons["dismissKeyboard"].tap()
    XCTAssertFalse(app.keyboards.firstMatch.exists)
    XCTAssertTrue(message(incoming, in: app).isHittable)
    capture("Text chat", app)
    app.scrollViews.firstMatch.swipeDown()
    waitUntil("Browse older messages") { !self.message(longDraft, in: app).isHittable }
    input.tap()
    input.typeText("Draft while reading earlier messages")
    XCTAssertFalse(
      message(longDraft, in: app).isHittable, "Editing must preserve the history position")
    capture("Composing while browsing history", app)
    XCTAssertTrue(app.buttons["jumpToLatest"].isHittable)
    app.buttons["jumpToLatest"].tap()
    assertAboveComposer(longDraft, in: app)
    XCTAssertFalse(app.buttons["jumpToLatest"].exists)
    input.typeText(" and returning to the latest")
    assertAboveComposer(longDraft, in: app)
    app.buttons["dismissKeyboard"].tap()
    app.navigationBars.buttons.element(boundBy: 0).tap()

    app.buttons["channel-3"].tap()
    capture("Before joining voice", app)
    app.buttons["joinVoice"].tap()
    addUIInterruptionMonitor(withDescription: "Microphone") { alert in
      let allow = alert.buttons["Allow"]
      if allow.exists {
        allow.tap()
        return true
      }
      return false
    }
    XCTAssertTrue(app.buttons["leaveVoice"].waitForExistence(timeout: 30), app.debugDescription)
    openDiagnostics(app)
    let diagnostics = app.staticTexts["mediaDiagnostics"]
    waitUntil("Voice RTP received") {
      self.metric("bytesReceived", kind: "audio", text: diagnostics.label) > 0
    }
    let before = try await fixture()
    let outboundBaseline = (before["inboundAudioBytes"] as? Int) ?? 0
    // Native microphone packets must reach the other peer, not just leave a local transport.
    var advanced = false
    for _ in 0..<15 {
      let sample = try await fixture()
      if ((sample["inboundAudioBytes"] as? Int) ?? 0) > outboundBaseline,
        ((sample["inboundAudioEnergy"] as? Double) ?? 0) > 0
      {
        advanced = true
        break
      }
      try await Task.sleep(for: .seconds(1))
    }
    XCTAssertTrue(advanced, "Browser must receive advancing native microphone RTP")
    let audible = try await fixture()
    XCTAssertGreaterThan(
      (audible["inboundAudioEnergy"] as? Double) ?? 0, 0,
      "Browser must decode non-silent native test audio")
    closeDiagnostics(app)
    app.buttons["toggleMicrophone"].tap()
    waitUntil("Muted control confirmed") {
      app.buttons["toggleMicrophone"].label.contains("Unmute")
    }
    XCTAssertEqual(app.buttons["toggleMicrophone"].value as? String, "Muted")
    capture("Muted microphone", app)
    try await Task.sleep(for: .seconds(2))
    let mutedStart = try await fixture()
    try await Task.sleep(for: .seconds(2))
    let mutedEnd = try await fixture()
    let mutedEnergy = try XCTUnwrap(mutedEnd["inboundAudioEnergy"] as? Double)
    XCTAssertLessThan(
      mutedEnergy - (try XCTUnwrap(mutedStart["inboundAudioEnergy"] as? Double)), 0.0001,
      "Muting must silence decoded audio at the remote peer")
    app.buttons["toggleMicrophone"].tap()
    waitUntil("Unmuted control confirmed") { app.buttons["toggleMicrophone"].label == "Mute" }
    XCTAssertEqual(app.buttons["toggleMicrophone"].value as? String, "Unmuted")
    try await Task.sleep(for: .seconds(2))
    let unmuted = try await fixture()
    XCTAssertGreaterThan(
      (try XCTUnwrap(unmuted["inboundAudioEnergy"] as? Double)) - mutedEnergy, 0.0001)
    app.buttons["toggleDeafen"].tap()
    waitUntil("Deafen confirmed") { app.buttons["toggleDeafen"].label == "Undeafen" }
    XCTAssertEqual(app.buttons["toggleDeafen"].value as? String, "Deafened")
    capture("Deafened call", app)
    app.buttons["toggleDeafen"].tap()
    waitUntil("Listening confirmed") {
      app.buttons["toggleDeafen"].value as? String == "Listening"
    }
    let speaker = app.buttons["toggleSpeaker"]
    let speakerWasOn = speaker.value as? String == "On"
    speaker.tap()
    waitUntil("Speaker route confirmed") {
      speaker.value as? String == (speakerWasOn ? "Off" : "On")
        && speaker.isSelected == !speakerWasOn
    }
    capture("Toggled speaker route", app)
    speaker.tap()
    waitUntil("Speaker route restored") {
      speaker.value as? String == (speakerWasOn ? "On" : "Off")
        && speaker.isSelected == speakerWasOn
    }
    capture("Voice call", app)

    let peerState = try await fixture()
    let peerID = try XCTUnwrap(peerState["userId"] as? Int)
    let watch = app.buttons["watch-\(peerID)"]
    XCTAssertTrue(watch.waitForExistence(timeout: 15))
    watch.tap()
    openDiagnostics(app)
    waitUntil("Screen frames decoded") {
      self.metric("framesDecoded", kind: "screen", text: diagnostics.label) > 0
    }
    let firstFrameCount = metric("framesDecoded", kind: "screen", text: diagnostics.label)
    waitUntil("Screen playback advances") {
      self.metric("framesDecoded", kind: "screen", text: diagnostics.label) > firstFrameCount
    }
    waitUntil("Share audio received") {
      self.metric("bytesReceived", kind: "screen_audio", text: diagnostics.label) > 0
    }
    closeDiagnostics(app)
    capture("Screen share", app)
    app.buttons["expandScreen"].tap()
    XCTAssertTrue(app.buttons["closeScreenPlayer"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons["Reset zoom"].exists)
    app.otherElements["expandedScreenVideo"].doubleTap()
    XCTAssertTrue(app.buttons["Reset zoom"].isEnabled)
    app.buttons["Reset zoom"].tap()
    XCTAssertFalse(app.buttons["Reset zoom"].exists)
    capture("Full screen share", app)
    XCUIDevice.shared.orientation = .landscapeLeft
    waitUntil("Landscape viewer laid out") { app.frame.width > app.frame.height }
    if !app.buttons["closeScreenPlayer"].exists { app.otherElements["expandedScreenVideo"].tap() }
    XCTAssertTrue(app.buttons["closeScreenPlayer"].isHittable)
    capture("Landscape screen share", app)
    XCUIDevice.shared.orientation = .portrait
    waitUntil("Portrait viewer laid out") { app.frame.height > app.frame.width }
    if !app.buttons["closeScreenPlayer"].exists { app.otherElements["expandedScreenVideo"].tap() }
    app.buttons["closeScreenPlayer"].tap()
    waitUntil("Player minimises") { !app.otherElements["expandedScreenVideo"].exists }
    XCTAssertTrue(app.buttons["stopWatching"].isHittable)
    app.buttons["stopWatching"].tap()
    waitUntil("Screen consumer closed") {
      !app.otherElements["screenVideo"].exists
    }
    // Exercise real software codecs separately; do not claim hardware H264 High coverage.
    for codec in ["video/VP9", "video/H264"] {
      _ = try await fixture(action: "codec", value: codec)
      let active = try await fixture()
      XCTAssertEqual(active["screenCodec"] as? String, codec)
      let codecEvidence = XCTAttachment(
        data: try JSONSerialization.data(withJSONObject: active),
        uniformTypeIdentifier: "public.json")
      codecEvidence.name = "Negotiated \(codec)"
      codecEvidence.lifetime = .keepAlways
      add(codecEvidence)
      XCTAssertTrue(watch.waitForExistence(timeout: 10))
      watch.tap()
      openDiagnostics(app)
      waitUntil("\(codec) frames decoded") {
        self.metric("framesDecoded", kind: "screen", text: diagnostics.label) > 0
      }
      let decoded = metric("framesDecoded", kind: "screen", text: diagnostics.label)
      waitUntil("\(codec) playback advances") {
        self.metric("framesDecoded", kind: "screen", text: diagnostics.label) > decoded
      }
      closeDiagnostics(app)
      capture("Screen share \(codec)", app)
      app.buttons["stopWatching"].tap()
      waitUntil("\(codec) closed") { !app.otherElements["screenVideo"].exists }
    }
    _ = try await fixture(action: "codec", value: "video/VP8")
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.buttons["openVoice"].waitForExistence(timeout: 5))
    capture("Channels during voice", app)
    app.buttons["channel-1"].tap()
    XCTAssertTrue(app.buttons["openVoice"].waitForExistence(timeout: 5))
    assertAboveComposer(longDraft, in: app)
    capture("Text chat during voice", app)
    app.textFields["messageInput"].tap()
    XCTAssertFalse(app.buttons["openVoice"].exists)
    app.textFields["messageInput"].typeText("Draft while in voice")
    XCTAssertTrue(app.buttons["composerMicrophone"].isHittable)
    app.buttons["composerMicrophone"].tap()
    waitUntil("Mute remains accessible while typing") {
      app.buttons["composerMicrophone"].label == "Unmute microphone"
    }
    app.buttons["composerMicrophone"].tap()
    XCTAssertEqual(app.textFields["messageInput"].value as? String, "Draft while in voice")
    assertAboveComposer(longDraft, in: app)
    capture("Typing during voice", app)
    app.buttons["dismissKeyboard"].tap()
    XCTAssertTrue(app.buttons["openVoice"].waitForExistence(timeout: 5))
    app.buttons["openVoice"].tap()
    XCTAssertTrue(app.buttons["toggleSpeaker"].waitForExistence(timeout: 5))
    app.buttons["leaveVoice"].tap()
    XCTAssertTrue(app.buttons["joinVoice"].waitForExistence(timeout: 15))
    XCTAssertFalse(app.buttons["leaveVoice"].exists)
  }

  @MainActor
  func testLargeTextKeepsChatAndCallControlsUsable() async throws {
    continueAfterFailure = false
    for category in [
      "UICTContentSizeCategoryAccessibilityXL", "UICTContentSizeCategoryAccessibilityXXXL",
    ] {
      let size = category.hasSuffix("XXXL") ? "AX5" : "AX3"
      let app = XCUIApplication()
      app.launchArguments = [
        "-UIPreferredContentSizeCategoryName", category,
      ]
      app.launchEnvironment["RIPCORD_TEST_SERVER"] = "http://localhost:4993"
      app.launchEnvironment["RIPCORD_SYNTHETIC_AUDIO"] = "1"
      app.launch()
      XCTAssertTrue(app.textFields["identity"].waitForExistence(timeout: 10))
      capture("\(size) sign in", app)
      app.textFields["identity"].tap()
      app.textFields["identity"].typeText("ios-simulator-poc")
      app.secureTextFields["password"].tap()
      app.secureTextFields["password"].typeText("local-poc-only\n")
      XCTAssertTrue(app.buttons["channel-3"].waitForExistence(timeout: 25))
      capture("\(size) channels", app)
      app.buttons["channel-3"].tap()
      capture("\(size) prejoin", app)
      if !app.buttons["joinVoice"].isHittable { app.swipeUp() }
      app.buttons["joinVoice"].tap()
      XCTAssertTrue(app.buttons["leaveVoice"].waitForExistence(timeout: 30))
      for id in ["toggleMicrophone", "toggleDeafen", "toggleSpeaker", "leaveVoice"] {
        XCTAssertTrue(app.buttons[id].isHittable, "\(id) must remain reachable at \(size)")
      }
      capture("\(size) voice controls", app)
      let peerState = try await fixture()
      let peerID = try XCTUnwrap(peerState["userId"] as? Int)
      app.buttons["watch-\(peerID)"].tap()
      XCTAssertTrue(app.otherElements["screenVideo"].waitForExistence(timeout: 20))
      capture("\(size) inline screen share", app)
      XCTAssertTrue(app.buttons["expandScreen"].isHittable)
      app.buttons["stopWatching"].tap()
      app.navigationBars.buttons["BackButton"].tap()
      capture("\(size) channels during call", app)
      XCTAssertTrue(app.buttons["openVoice"].isHittable)
      XCTAssertTrue(app.buttons["leaveVoice"].isHittable)
      app.buttons["channel-2"].tap()
      XCTAssertTrue(app.textFields["messageInput"].waitForExistence(timeout: 5))
      capture("\(size) empty channel", app)
      app.textFields["messageInput"].tap()
      app.textFields["messageInput"].typeText("A larger text draft\nWith a second line")
      XCTAssertTrue(app.buttons["sendMessage"].isHittable)
      XCTAssertFalse(app.buttons["openVoice"].exists)
      capture("\(size) multiline composer", app)
      app.buttons["dismissKeyboard"].tap()
      app.navigationBars.buttons["BackButton"].tap()
      app.buttons["channel-1"].tap()
      XCTAssertTrue(app.textFields["messageInput"].waitForExistence(timeout: 5))
      let latest = "\(size) history \(UUID().uuidString.prefix(4))\nSecond line\nLatest line"
      _ = try await fixture(action: "message", value: latest)
      XCTAssertTrue(message(latest, in: app).waitForExistence(timeout: 10))
      assertAboveComposer(latest, in: app)
      capture("\(size) message history", app)
      app.scrollViews.firstMatch.swipeDown()
      waitUntil("Browse history at \(size)") { !self.message(latest, in: app).isHittable }
      capture("\(size) browsing history", app)
      XCTAssertTrue(app.buttons["jumpToLatest"].isHittable)
      app.buttons["jumpToLatest"].tap()
      assertAboveComposer(latest, in: app)
      app.buttons["leaveVoice"].tap()
      waitUntil("Leave completes at \(size)") { !app.buttons["leaveVoice"].exists }
      app.terminate()
    }
  }

  @MainActor private func message(_ text: String, in app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any).matching(
      NSPredicate(format: "identifier BEGINSWITH 'message-' AND label ENDSWITH %@", text)
    ).firstMatch
  }

  @MainActor private func assertAboveComposer(_ text: String, in app: XCUIApplication) {
    waitUntil("Latest message stays fully above the composer", timeout: 5) {
      let row = self.message(text, in: app)
      var top = app.textFields["messageInput"].frame.minY
      if app.buttons["composerMicrophone"].exists {
        top = min(top, app.buttons["composerMicrophone"].frame.minY)
      }
      return row.isHittable && row.frame.maxY <= top
    }
  }

  private func fixture(action: String? = nil, value: String? = nil) async throws -> [String: Any] {
    var url = URLComponents(string: "http://127.0.0.1:5193/fixture")!
    if let action {
      url.queryItems = [
        URLQueryItem(name: "action", value: action), URLQueryItem(name: "value", value: value),
      ]
    }
    let (data, response) = try await URLSession.shared.data(from: XCTUnwrap(url.url))
    XCTAssertEqual(
      (response as? HTTPURLResponse)?.statusCode, 200, String(decoding: data, as: UTF8.self))
    // Message sends return the numeric message ID, other controls return an object.
    return (try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed))
      as? [String: Any] ?? [:]
  }

  @MainActor private func waitUntil(
    _ description: String, timeout: TimeInterval = 30, _ check: @escaping () -> Bool
  ) {
    let expectation = XCTNSPredicateExpectation(
      predicate: NSPredicate { _, _ in check() }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed, description)
  }

  private func metric(_ name: String, kind: String, text: String) -> Int {
    guard let line = text.components(separatedBy: "\n").first(where: { $0.contains(" \(kind):") }),
      let range = line.range(of: "\(name)=[0-9]+", options: .regularExpression)
    else { return 0 }
    return Int(line[range].split(separator: "=").last ?? "0") ?? 0
  }

  @MainActor private func openDiagnostics(_ app: XCUIApplication) {
    app.navigationBars.buttons.element(boundBy: 0).tap()
    app.buttons["serverMenu"].tap()
    let action = app.buttons["mediaDiagnosticsAction"]
    XCTAssertTrue(action.waitForExistence(timeout: 5))
    XCTAssertTrue(action.isHittable)
    action.tap()
    XCTAssertTrue(app.staticTexts["mediaDiagnostics"].waitForExistence(timeout: 5))
  }

  @MainActor private func closeDiagnostics(_ app: XCUIApplication) {
    app.buttons["closeDiagnostics"].tap()
    app.buttons["openVoice"].tap()
    XCTAssertTrue(app.buttons["toggleSpeaker"].waitForExistence(timeout: 5))
  }

  @MainActor private func capture(_ name: String, _ app: XCUIApplication) {
    let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
    attachment.name = name
    attachment.lifetime = .keepAlways
    add(attachment)
  }
}
