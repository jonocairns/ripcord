import Foundation

struct Channel: Decodable, Identifiable, Hashable {
  let id: Int
  let name: String
  let type: String
  let topic: String?
  let position: Int
}

struct ChatMessage: Decodable, Identifiable {
  let id: Int
  let channelId: Int
  let userId: Int
  let content: String
  let createdAt: Double

  var date: Date { Date(timeIntervalSince1970: createdAt / 1_000) }
}

enum MessageText {
  static func html(_ text: String) -> String {
    let escaped = text.replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;")
      .replacingOccurrences(of: "'", with: "&#39;")
      .replacingOccurrences(of: "\n", with: "<br>")
    return "<p>\(escaped)</p>"
  }

  static func plain(_ html: String) -> String {
    // The server sanitizes markup. Render it as text without WebKit's HTML
    // importer, which spins the main run loop during SwiftUI layout.
    let text = html.replacingOccurrences(
      of: "<img\\b[^>]*>", with: "[emoji]", options: .regularExpression
    )
    .replacingOccurrences(of: "<br\\s*/?>|</(?:p|pre)>", with: "\n", options: .regularExpression)
    .replacingOccurrences(of: "<[^>]*>", with: "", options: .regularExpression)
    let named = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": "\u{00a0}"]
    guard let pattern = try? NSRegularExpression(pattern: "&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);")
    else { return text }
    var result = text
    // Decode once, after stripping tags, so escaped markup stays literal.
    for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed()
    {
      guard let range = Range(match.range, in: result),
        let keyRange = Range(match.range(at: 1), in: text)
      else { continue }
      let key = String(text[keyRange])
      var replacement = named[key]
      if key.hasPrefix("#") {
        let hex = key.hasPrefix("#x")
        if let number = UInt32(key.dropFirst(hex ? 2 : 1), radix: hex ? 16 : 10),
          let scalar = UnicodeScalar(number)
        {
          replacement = String(scalar)
        }
      }
      if let replacement { result.replaceSubrange(range, with: replacement) }
    }
    return result.trimmingCharacters(in: .newlines)
  }
}
