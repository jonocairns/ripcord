import XCTest

@testable import Ripcord

final class RPCClientTests: XCTestCase {
  func testPlainDataEnvelopePreservesNestedPayload() throws {
    let text =
      #"{"id":7,"result":{"type":"data","data":{"routerRtpCapabilities":{"codecs":[]},"enabled":true}}}"#
    XCTAssertEqual(
      try RPCWireEvent.parse(text),
      [
        .data(
          7,
          .object([
            "routerRtpCapabilities": .object(["codecs": .array([])]), "enabled": .bool(true),
          ]))
      ])
  }

  func testBatchDistinguishesSubscriptionStartDataAndStop() throws {
    let text =
      #"[{"id":2,"result":{"type":"started"}},{"id":2,"result":{"type":"data","data":[1,"event"]}},{"id":2,"result":{"type":"stopped"}}]"#
    XCTAssertEqual(
      try RPCWireEvent.parse(text),
      [
        .started(2), .data(2, .array([.number(1), .string("event")])), .stopped(2),
      ])
  }

  func testNullAndUndefinedResponsesAreSuccessfulData() throws {
    XCTAssertEqual(
      try RPCWireEvent.parse(#"{"id":3,"result":{"type":"data","data":null}}"#), [.data(3, .null)])
    XCTAssertEqual(try RPCWireEvent.parse(#"{"id":4,"result":{"type":"data"}}"#), [.data(4, .null)])
  }

  func testRequestAndConnectionErrorsHaveDifferentScope() throws {
    XCTAssertEqual(
      try RPCWireEvent.parse(
        #"{"id":5,"error":{"message":"Forbidden","code":-32003,"data":{"code":"FORBIDDEN"}}}"#),
      [.failure(5, "Forbidden")])
    XCTAssertEqual(
      try RPCWireEvent.parse(
        #"{"id":null,"error":{"message":"Invalid authentication token","code":-32001}}"#),
      [.failure(nil, "Invalid authentication token")])
  }

  func testApplicationHeartbeatAndReconnect() throws {
    XCTAssertEqual(try RPCWireEvent.parse("PING"), [.ping])
    XCTAssertEqual(try RPCWireEvent.parse("PONG"), [.pong])
    XCTAssertEqual(try RPCWireEvent.parse(#"{"id":null,"method":"reconnect"}"#), [.reconnect])
  }

  func testMalformedResponseDoesNotBecomeNullSuccess() {
    XCTAssertThrowsError(try RPCWireEvent.parse(#"{"id":1,"result":{}}"#))
    XCTAssertThrowsError(try RPCWireEvent.parse(#"{"result":{"type":"data","data":1}}"#))
    XCTAssertThrowsError(try RPCWireEvent.parse("not JSON"))
  }
}
