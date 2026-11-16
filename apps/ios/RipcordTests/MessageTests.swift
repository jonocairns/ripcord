import XCTest

@testable import Ripcord

final class MessageTests: XCTestCase {
  @MainActor
  func testPlainTextRoundTripDoesNotBecomeMarkup() {
    let text = "<strong>Not bold</strong> & \"quoted\"\nSecond line > first"
    let html = MessageText.html(text)
    XCTAssertTrue(html.contains("&lt;strong&gt;"))
    XCTAssertEqual(MessageText.plain(html), text)
    XCTAssertEqual(
      MessageText.plain("<p>Hello <strong>Ripcord</strong><br>again &amp; again</p>"),
      "Hello Ripcord\nagain & again")
    XCTAssertEqual(
      MessageText.plain("<p>&#x1F680; &#39; &amp;lt;</p><p>Next</p>"), "🚀 ' &lt;\nNext")
  }

  func testMediaJSONRoundTripPreservesCodecFields() throws {
    let payload = try JSONValue(
      json: """
        {"codecs":[{"mimeType":"video/H264","parameters":{"profile-level-id":"640034","level-asymmetry-allowed":1}}],"paused":false,"optional":null}
        """)
    XCTAssertEqual(try JSONValue(json: payload.jsonString()), payload)
    XCTAssertEqual(
      payload["codecs"].array.first?["parameters"]["profile-level-id"].string, "640034")
  }
}
