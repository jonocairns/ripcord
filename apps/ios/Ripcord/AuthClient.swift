import Foundation

struct AuthTokens: Codable {
  let token: String
  let refreshToken: String
}

enum LoginResult {
  case authenticated(AuthTokens)
  case requires2FA(String)
}

@MainActor
final class AuthClient {
  private let serverURL: URL
  private var refreshes: [String: Task<AuthTokens, Error>] = [:]

  init(serverURL: URL) { self.serverURL = serverURL }

  func login(identity: String, password: String, invite: String? = nil) async throws -> LoginResult
  {
    var body: [String: JSONValue] = ["identity": .string(identity), "password": .string(password)]
    if let invite { body["invite"] = .string(invite) }
    let response = try await post("login", body)
    if response["requires2fa"].bool == true {
      guard let challenge = response["challengeToken"].string, !challenge.isEmpty else {
        throw RipcordError.message("Server returned an invalid two-factor challenge")
      }
      return .requires2FA(challenge)
    }
    return .authenticated(try response.decode(AuthTokens.self))
  }

  func verify2FA(challengeToken: String, code: String) async throws -> AuthTokens {
    try await post(
      "verify-2fa", ["challengeToken": .string(challengeToken), "code": .string(code)]
    )
    .decode(AuthTokens.self)
  }

  func refresh(refreshToken: String) async throws -> AuthTokens {
    // Coalesce simultaneous refreshes: the backend rotates single-use tokens.
    if let existing = refreshes[refreshToken] { return try await existing.value }
    let task = Task { @MainActor in
      try await post("refresh", ["refreshToken": .string(refreshToken)]).decode(AuthTokens.self)
    }
    refreshes[refreshToken] = task
    defer { refreshes.removeValue(forKey: refreshToken) }
    return try await task.value
  }

  func logout(refreshToken: String) async {
    // If rotation is in flight, revoke the replacement rather than its spent predecessor.
    let token: String
    if let refresh = refreshes[refreshToken], let tokens = try? await refresh.value {
      token = tokens.refreshToken
    } else {
      token = refreshToken
    }
    _ = try? await post("logout", ["refreshToken": .string(token)])
  }

  private func post(_ path: String, _ body: [String: JSONValue]) async throws -> JSONValue {
    guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false),
      let scheme = components.scheme?.lowercased(),
      ["http", "https"].contains(scheme), components.host != nil
    else {
      throw RipcordError.message("Invalid server URL")
    }
    components.query = nil
    components.fragment = nil
    guard let baseURL = components.url else { throw RipcordError.message("Invalid server URL") }
    var request = URLRequest(url: baseURL.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.timeoutInterval = 20
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = try JSONEncoder().encode(JSONValue.object(body))
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw RipcordError.message("Invalid HTTP response")
    }
    let value = try? JSONDecoder().decode(JSONValue.self, from: data)
    guard (200..<300).contains(http.statusCode) else {
      let fields = value?["errors"].dictionary ?? [:]
      let validation = fields.keys.sorted().compactMap { field -> String? in
        guard let message = fields[field]?.string else { return nil }
        return "\(field): \(message)"
      }.joined(separator: "\n")
      throw RipcordError.message(
        validation.isEmpty ? (value?["error"].string ?? "HTTP \(http.statusCode)") : validation
      )
    }
    guard let value else { throw RipcordError.message("Server returned invalid JSON") }
    return value
  }
}
