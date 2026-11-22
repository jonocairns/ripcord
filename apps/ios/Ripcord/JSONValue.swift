import Foundation

/// Opaque mediasoup payloads stay JSON so codec-specific fields survive unchanged.
enum JSONValue: Codable, Equatable, Sendable {
  case object([String: JSONValue])
  case array([JSONValue])
  case string(String)
  case number(Double)
  case bool(Bool)
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .object(let value): try container.encode(value)
    case .array(let value): try container.encode(value)
    case .string(let value): try container.encode(value)
    case .number(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }

  init(json: String) throws {
    self = try JSONDecoder().decode(Self.self, from: Data(json.utf8))
  }

  subscript(_ key: String) -> JSONValue { dictionary[key] ?? .null }
  var dictionary: [String: JSONValue] {
    if case .object(let value) = self { return value }
    return [:]
  }
  var array: [JSONValue] {
    if case .array(let value) = self { return value }
    return []
  }
  var string: String? {
    if case .string(let value) = self { return value }
    return nil
  }
  var int: Int? {
    if case .number(let value) = self { return Int(exactly: value) }
    return nil
  }
  var bool: Bool? {
    if case .bool(let value) = self { return value }
    return nil
  }
  func jsonString() throws -> String {
    String(decoding: try JSONEncoder().encode(self), as: UTF8.self)
  }
  func decode<T: Decodable>(_ type: T.Type) throws -> T {
    try JSONDecoder().decode(type, from: JSONEncoder().encode(self))
  }
}

enum RipcordError: LocalizedError {
  case message(String)
  var errorDescription: String? {
    switch self {
    case .message(let text): return text
    }
  }
}
