import Combine
import Foundation

@MainActor
final class Session: ObservableObject {
  let rpc = RPCClient()
  lazy var voice = VoiceClient(rpc: rpc)
  @Published var serverAddress =
    UserDefaults.standard.string(forKey: "serverAddress") ?? "http://localhost:4993"
  {
    didSet {
      if oldValue != serverAddress {
        restartSignIn()
        serverPassword = ""
      }
    }
  }
  @Published var identity = "" {
    didSet { if oldValue != identity { restartSignIn() } }
  }
  @Published var password = ""
  @Published var serverPassword = ""
  @Published var verificationCode = ""
  @Published var challengeToken: String?
  @Published private(set) var connected = false
  @Published private(set) var busy = false
  @Published private(set) var serverName = "Ripcord"
  @Published private(set) var ownUserId = 0
  @Published private(set) var channels: [Channel] = []
  @Published private(set) var userNames: [Int: String] = [:]
  @Published private(set) var messages: [ChatMessage] = []
  @Published private(set) var selectedChannel: Channel?
  @Published private(set) var loadingMessages = false
  @Published private(set) var nextCursor: JSONValue = .null
  @Published var errorMessage: String?
  @Published private var tokens: AuthTokens?
  var authenticated: Bool { tokens != nil }
  private var auth: AuthClient?
  private var generation = UUID()
  private var connectionTask: Task<Void, Never>?
  private var subscriptions: [Int] = []
  private var loadGeneration = UUID()
  private var liveMessages: [Int: ChatMessage] = [:]
  private var deletedMessages: Set<Int> = []
  private let clientInstanceId = UUID().uuidString

  init() {
    #if DEBUG
      if let address = ProcessInfo.processInfo.environment["RIPCORD_TEST_SERVER"] {
        serverAddress = address
      }
    #endif
    rpc.onDisconnect = { [weak self] error in
      guard let self else { return }
      self.connected = false
      self.loadGeneration = UUID()
      self.loadingMessages = false
      self.errorMessage = "Connection lost. Reconnect to resume. \(error.localizedDescription)"
      let generation = self.generation
      Task {
        guard self.generation == generation else { return }
        await self.voice.stopLocally()
      }
    }
  }

  func signIn() async {
    await startConnection(refresh: false)
  }

  func reconnect() async {
    guard tokens != nil else { return }
    await startConnection(refresh: true)
  }

  private func startConnection(refresh: Bool) async {
    guard !busy else { return }
    generation = UUID()
    let generation = generation
    busy = true
    connected = false
    loadGeneration = UUID()
    loadingMessages = false
    errorMessage = nil
    rpc.disconnect()
    let task = Task { await authenticateAndConnect(refresh: refresh, generation: generation) }
    connectionTask = task
    await task.value
  }

  private func authenticateAndConnect(refresh: Bool, generation: UUID) async {
    defer {
      if self.generation == generation {
        busy = false
        connectionTask = nil
      }
    }
    do {
      try checkCurrent(generation)
      guard let url = URL(string: serverAddress),
        ["http", "https"].contains(url.scheme), url.host != nil
      else {
        throw RipcordError.message("Enter an http:// or https:// server address.")
      }
      let auth = self.auth ?? AuthClient(serverURL: url)
      self.auth = auth
      if refresh, let tokens {
        await voice.stopLocally()
        try checkCurrent(generation)
        let refreshed = try await auth.refresh(refreshToken: tokens.refreshToken)
        try checkCurrent(generation)
        self.tokens = refreshed
      } else if tokens == nil, let challengeToken {
        let verified = try await auth.verify2FA(
          challengeToken: challengeToken, code: verificationCode)
        try checkCurrent(generation)
        tokens = verified
      } else if tokens == nil {
        switch try await auth.login(identity: identity, password: password) {
        case .requires2FA(let token):
          try checkCurrent(generation)
          challengeToken = token
          return
        case .authenticated(let result):
          try checkCurrent(generation)
          tokens = result
        }
      }
      // Authentication succeeded even if joining this server still needs a retry.
      password = ""
      verificationCode = ""
      challengeToken = nil
      try await connect(url: url, generation: generation)
      try checkCurrent(generation)
      UserDefaults.standard.set(serverAddress, forKey: "serverAddress")
    } catch {
      if self.generation == generation, !(error is CancellationError) {
        errorMessage = error.localizedDescription
      }
    }
  }

  private func checkCurrent(_ generation: UUID) throws {
    try Task.checkCancellation()
    guard self.generation == generation else { throw CancellationError() }
  }

  func restartSignIn() {
    generation = UUID()
    connectionTask?.cancel()
    connectionTask = nil
    rpc.disconnect()
    connected = false
    busy = false
    tokens = nil
    auth = nil
    password = ""
    verificationCode = ""
    challengeToken = nil
    errorMessage = nil
  }

  private func connect(url: URL, generation: UUID) async throws {
    guard let tokens else { throw RipcordError.message("Sign in first.") }
    rpc.disconnect()
    subscriptions = []
    try await rpc.connect(serverURL: url, token: tokens.token, clientInstanceId: clientInstanceId)
    do {
      try checkCurrent(generation)
      let handshake = try await rpc.call("others.handshake")
      try checkCurrent(generation)
      let joined = try await rpc.call(
        "others.joinServer",
        .object([
          "handshakeHash": handshake["handshakeHash"], "password": .string(serverPassword),
        ]))
      try checkCurrent(generation)
      // Reconnect may adopt our old server seat, but native media is not restored.
      // Leave only the seat bound to this socket; the server guards newer sessions.
      _ = try? await rpc.call(
        "voice.leave", .object(["reason": .string("recovery_exhausted")]), mutation: true)
      try checkCurrent(generation)
      if joined["mustChangePassword"].bool == true {
        throw RipcordError.message(
          "Change this account’s password in the web app before using this proof of concept.")
      }
      serverName = joined["serverName"].string ?? "Ripcord"
      ownUserId = joined["ownUserId"].int ?? 0
      channels = try joined["channels"].decode([Channel].self).sorted {
        $0.type == $1.type ? $0.position < $1.position : $0.type < $1.type
      }
      voice.speakingChannelIDs = Set(
        joined["channels"].array.compactMap { channel in
          guard let id = channel["id"].int else { return nil }
          // Public channels do not require explicit per-channel grants.
          let allowed =
            channel["private"].bool == false
            || joined["channelPermissions"][String(id)]["permissions"]["SPEAK"].bool == true
          return allowed ? id : nil
        })
      for user in joined["users"].array {
        if let id = user["id"].int { userNames[id] = user["name"].string }
      }
      for path in ["messages.onNew", "messages.onUpdate"] {
        subscriptions.append(
          try await rpc.subscribe(path) { [weak self] event in
            guard let self, self.generation == generation else { return }
            self.receiveMessage(event)
          })
        try checkCurrent(generation)
      }
      subscriptions.append(
        try await rpc.subscribe("messages.onDelete") { [weak self] event in
          guard let self, self.generation == generation,
            event["channelId"].int == self.selectedChannel?.id,
            let id = event["messageId"].int
          else { return }
          self.deletedMessages.insert(id)
          self.liveMessages[id] = nil
          self.messages.removeAll { $0.id == id }
        })
      try checkCurrent(generation)
      for path in ["users.onCreate", "users.onUpdate", "users.onJoin"] {
        subscriptions.append(
          try await rpc.subscribe(path) { [weak self] user in
            guard let self, self.generation == generation else { return }
            if let id = user["id"].int { self.userNames[id] = user["name"].string }
          })
        try checkCurrent(generation)
      }
      subscriptions.append(
        try await rpc.subscribe("voice.onSessionReplaced") { [weak self] event in
          guard let self, self.generation == generation,
            event["replacedByClientInstanceId"].string != self.clientInstanceId
          else {
            return
          }
          Task {
            guard self.generation == generation else { return }
            await self.voice.stopLocally()
          }
        })
      try checkCurrent(generation)
      connected = true
      errorMessage = nil
      if let channel = selectedChannel, let current = channels.first(where: { $0.id == channel.id })
      {
        await openChannel(current)
      }
    } catch {
      if self.generation == generation { rpc.disconnect() }
      throw error
    }
  }

  func openChannel(_ channel: Channel) async {
    guard !Task.isCancelled, channels.contains(where: { $0.id == channel.id }) else { return }
    selectedChannel = channel
    messages = []
    liveMessages = [:]
    deletedMessages = []
    nextCursor = .null
    loadGeneration = UUID()
    loadingMessages = false
    if channel.type == "TEXT" { await loadHistory(older: false) }
  }

  func loadHistory(older: Bool) async {
    guard let channel = selectedChannel, !loadingMessages else { return }
    let generation = loadGeneration
    loadingMessages = true
    defer { if generation == loadGeneration { loadingMessages = false } }
    do {
      let page = try await rpc.call(
        "messages.get",
        .object([
          "channelId": .number(Double(channel.id)), "cursor": older ? nextCursor : .null,
          "limit": .number(40),
        ]))
      guard generation == loadGeneration else { return }
      let history = try page["messages"].decode([ChatMessage].self)
      var merged = Dictionary(messages.map { ($0.id, $0) }, uniquingKeysWith: { _, newer in newer })
      for message in history where !deletedMessages.contains(message.id) {
        merged[message.id] = message
      }
      for (id, message) in liveMessages { merged[id] = message }
      messages = merged.values.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
      nextCursor = page["nextCursor"]
    } catch { if generation == loadGeneration { errorMessage = error.localizedDescription } }
  }

  private func receiveMessage(_ value: JSONValue) {
    guard let message = try? value.decode(ChatMessage.self),
      message.channelId == selectedChannel?.id
    else { return }
    deletedMessages.remove(message.id)
    liveMessages[message.id] = message
    messages.removeAll { $0.id == message.id }
    messages.append(message)
    messages.sort { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
  }

  func send(_ text: String) async throws {
    guard connected, let channel = selectedChannel, channel.type == "TEXT" else {
      throw RipcordError.message("Open a text channel while connected.")
    }
    _ = try await rpc.call(
      "messages.send",
      .object([
        "channelId": .number(Double(channel.id)), "content": .string(MessageText.html(text)),
        "files": .array([]),
      ]), mutation: true)
  }

  func signOut() async {
    let auth = auth
    let tokens = tokens
    restartSignIn()
    let generation = generation
    busy = true
    connected = false
    rpc.disconnect()
    subscriptions = []
    loadGeneration = UUID()
    loadingMessages = false
    nextCursor = .null
    liveMessages = [:]
    deletedMessages = []
    serverPassword = ""
    channels = []
    selectedChannel = nil
    messages = []
    userNames = [:]
    ownUserId = 0
    serverName = "Ripcord"
    errorMessage = nil
    await voice.stopLocally()
    if self.generation == generation { busy = false }
    // Remote revocation is best effort and cannot keep local controls signed in.
    if let auth, let tokens { await auth.logout(refreshToken: tokens.refreshToken) }
  }
}
