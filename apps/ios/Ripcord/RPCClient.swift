import Foundation

/// The plain (no transformer) tRPC 11 WebSocket wire protocol.
enum RPCWireEvent: Equatable {
  case ping
  case pong
  case reconnect
  case data(Int, JSONValue)
  case started(Int)
  case stopped(Int)
  case failure(Int?, String)

  static func parse(_ text: String) throws -> [RPCWireEvent] {
    if text == "PING" { return [.ping] }
    if text == "PONG" { return [.pong] }
    let value = try JSONValue(json: text)
    let envelopes: [JSONValue]
    if case .array(let batch) = value { envelopes = batch } else { envelopes = [value] }
    return try envelopes.map { envelope in
      if envelope["method"].string == "reconnect" { return .reconnect }
      let id = envelope["id"].int
      if case .object = envelope["error"] {
        return .failure(id, envelope["error"]["message"].string ?? "RPC request failed")
      }
      guard let id else { throw RipcordError.message("RPC response has no request ID") }
      switch envelope["result"]["type"].string {
      case "data": return .data(id, envelope["result"]["data"])
      case "started": return .started(id)
      case "stopped": return .stopped(id)
      default: throw RipcordError.message("Unrecognized RPC response")
      }
    }
  }
}

@MainActor
final class RPCClient {
  var onDisconnect: (@MainActor (Error) -> Void)?

  private enum RequestKind { case connection, call, subscription, stop }
  private struct Pending {
    let kind: RequestKind
    let continuation: CheckedContinuation<JSONValue, Error>
    let timeout: Task<Void, Never>
    let send: Task<Void, Never>
  }

  private var socket: URLSessionWebSocketTask?
  private var reader: Task<Void, Never>?
  private var generation = UUID()
  private var nextID = 1
  private var pending: [Int: Pending] = [:]
  private var subscriptions: [Int: @MainActor (JSONValue) -> Void] = [:]
  private let timeoutNanoseconds: UInt64 = 20_000_000_000

  init() {}

  deinit {
    reader?.cancel()
    socket?.cancel(with: .goingAway, reason: nil)
    for request in pending.values {
      request.timeout.cancel()
      request.send.cancel()
      request.continuation.resume(throwing: CancellationError())
    }
  }

  func connect(serverURL: URL, token: String, clientInstanceId: String) async throws {
    disconnect()
    try Task.checkCancellation()
    guard var components = URLComponents(url: serverURL, resolvingAgainstBaseURL: false),
      let scheme = components.scheme?.lowercased(),
      ["http", "https", "ws", "wss"].contains(scheme), components.host != nil
    else {
      throw RipcordError.message("Invalid server URL")
    }
    components.scheme = (scheme == "https" || scheme == "wss") ? "wss" : "ws"
    components.fragment = nil
    var query = components.queryItems?.filter { $0.name != "connectionParams" } ?? []
    query.append(URLQueryItem(name: "connectionParams", value: "1"))
    components.queryItems = query
    guard let url = components.url else { throw RipcordError.message("Invalid server URL") }
    let socket = URLSession.shared.webSocketTask(with: url)
    self.socket = socket
    let generation = self.generation
    socket.resume()
    reader = Task { @MainActor [weak self] in
      do {
        while !Task.isCancelled {
          let message = try await socket.receive()
          let text: String
          switch message {
          case .string(let value): text = value
          case .data(let value):
            guard let value = String(data: value, encoding: .utf8) else {
              throw RipcordError.message("Invalid RPC text frame")
            }
            text = value
          @unknown default: throw RipcordError.message("Unsupported RPC frame")
          }
          guard self?.generation == generation else { return }
          let events = try RPCWireEvent.parse(text)
          for event in events {
            guard self?.generation == generation else { return }
            if event == .ping {
              try await socket.send(.string("PONG"))
            } else {
              self?.receive(event)
            }
          }
        }
      } catch {
        guard self?.generation == generation else { return }
        self?.terminate(error, notify: true)
      }
    }
    // tRPC sends no connection acknowledgement. A successful connect means
    // the auth frame was sent; the first RPC still verifies server acceptance.
    _ = try await request(
      id: 0, kind: .connection,
      message: .object([
        "method": .string("connectionParams"),
        "data": .object(["token": .string(token), "clientInstanceId": .string(clientInstanceId)]),
      ]))
  }

  func call(_ path: String, _ input: JSONValue? = nil, mutation: Bool = false) async throws
    -> JSONValue
  {
    let id = allocateID()
    return try await request(
      id: id, kind: .call, message: frame(id, mutation ? "mutation" : "query", path, input))
  }

  func subscribe(
    _ path: String, _ input: JSONValue? = nil,
    onEvent: @escaping @MainActor (JSONValue) -> Void
  ) async throws -> Int {
    let id = allocateID()
    subscriptions[id] = onEvent
    do {
      _ = try await request(
        id: id, kind: .subscription, message: frame(id, "subscription", path, input))
      return id
    } catch {
      subscriptions.removeValue(forKey: id)
      throw error
    }
  }

  func unsubscribe(_ id: Int) async {
    subscriptions.removeValue(forKey: id)
    finish(id, .failure(CancellationError()))
    await stopSubscription(id)
  }

  func disconnect() {
    terminate(CancellationError(), notify: false)
  }

  private func allocateID() -> Int {
    defer { nextID += 1 }
    return nextID
  }

  private func frame(_ id: Int, _ method: String, _ path: String, _ input: JSONValue?) -> JSONValue
  {
    var params: [String: JSONValue] = ["path": .string(path)]
    if let input { params["input"] = input }
    return .object([
      "id": .number(Double(id)), "method": .string(method), "params": .object(params),
    ])
  }

  private func request(id: Int, kind: RequestKind, message: JSONValue) async throws -> JSONValue {
    try Task.checkCancellation()
    guard let socket else { throw RipcordError.message("Not connected") }
    let text = try message.jsonString()
    let generation = self.generation
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let timeout = Task { @MainActor [weak self, timeoutNanoseconds] in
          do { try await Task.sleep(nanoseconds: timeoutNanoseconds) } catch { return }
          guard self?.generation == generation else { return }
          self?.cancelRequest(id, error: RipcordError.message("RPC request timed out"))
        }
        let send = Task { @MainActor [weak self] in
          do {
            try await socket.send(.string(text))
            guard self?.generation == generation else { return }
            if kind == .connection || kind == .stop { self?.finish(id, .success(.null)) }
          } catch {
            guard self?.generation == generation, self?.pending[id] != nil else { return }
            self?.terminate(error, notify: true)
          }
        }
        pending[id] = Pending(kind: kind, continuation: continuation, timeout: timeout, send: send)
      }
    } onCancel: {
      Task { @MainActor [weak self] in
        guard self?.generation == generation else { return }
        self?.cancelRequest(id, error: CancellationError())
      }
    }
  }

  private func cancelRequest(_ id: Int, error: Error) {
    guard let request = pending[id] else { return }
    if request.kind == .connection {
      terminate(error, notify: true)
      return
    }
    finish(id, .failure(error))
    if request.kind == .subscription {
      subscriptions.removeValue(forKey: id)
      let generation = self.generation
      Task { @MainActor [weak self] in
        guard self?.generation == generation else { return }
        await self?.stopSubscription(id)
      }
    }
  }

  private func stopSubscription(_ id: Int) async {
    guard socket != nil else { return }
    _ = try? await request(
      id: allocateID(), kind: .stop,
      message: .object([
        "id": .number(Double(id)), "method": .string("subscription.stop"),
      ]))
  }

  private func receive(_ event: RPCWireEvent) {
    switch event {
    case .ping, .pong: break
    case .reconnect:
      terminate(RipcordError.message("Server requested reconnection"), notify: true)
    case .data(let id, let value):
      if pending[id]?.kind == .call {
        finish(id, .success(value))
      } else if pending[id] == nil {
        subscriptions[id]?(value)
      }
    case .started(let id):
      if pending[id]?.kind == .subscription { finish(id, .success(.null)) }
    case .stopped(let id):
      subscriptions.removeValue(forKey: id)
      if pending[id]?.kind == .subscription {
        finish(id, .failure(RipcordError.message("Subscription stopped before starting")))
      }
    case .failure(let id, let message):
      let error = RipcordError.message(message)
      guard let id else {
        terminate(error, notify: true)
        return
      }
      if pending[id] != nil {
        subscriptions.removeValue(forKey: id)
        finish(id, .failure(error))
      } else if subscriptions[id] != nil {
        // There is no per-subscription error callback in the POC contract.
        // Surface the failure rather than silently leaving stale UI state.
        terminate(error, notify: true)
      }
    }
  }

  private func finish(_ id: Int, _ result: Result<JSONValue, Error>) {
    guard let request = pending.removeValue(forKey: id) else { return }
    request.timeout.cancel()
    request.send.cancel()
    request.continuation.resume(with: result)
  }

  private func terminate(_ error: Error, notify: Bool) {
    let wasConnected = socket != nil
    generation = UUID()
    reader?.cancel()
    reader = nil
    socket?.cancel(with: .goingAway, reason: nil)
    socket = nil
    subscriptions.removeAll()
    for id in Array(pending.keys) { finish(id, .failure(error)) }
    if notify && wasConnected { onDisconnect?(error) }
  }
}
