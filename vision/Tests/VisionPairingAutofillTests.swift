import Foundation

@main struct VisionPairingAutofillTests {
    @MainActor static func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !condition() && Date() < deadline { try await Task.sleep(for: .milliseconds(10)) }
        precondition(condition(), "asynchronous pairing state did not settle")
    }

    @MainActor static func main() async throws {
        let address = CommandLine.arguments[1], serverID = CommandLine.arguments[2], expectedCode = CommandLine.arguments[3]
        let client = try LANClient(address: address)
        let remote = try await client.visionPairingOffers(serverID: serverID)
        precondition(remote.count == 1 && remote[0].code == expectedCode)
        do {
            _ = try await client.visionPairingOffers(serverID: UUID().uuidString)
            preconditionFailure("a response from another server must be rejected")
        } catch is TeachingError {}

        let first = DiscoveredTeachingServer(id: UUID().uuidString, name: "First", address: "http://127.0.0.1:22001")
        let second = DiscoveredTeachingServer(id: UUID().uuidString, name: "Second", address: "http://127.0.0.1:22002")
        let offerA = VisionPairingOffer(sessionId: UUID().uuidString, name: "A", code: "A1B2", expiresAt: Date().addingTimeInterval(60).timeIntervalSince1970 * 1000)
        let offerB = VisionPairingOffer(sessionId: UUID().uuidString, name: "B", code: "C3D4", expiresAt: offerA.expiresAt)
        var callbacks: [String: CheckedContinuation<[VisionPairingOffer], Error>] = [:]
        let state = VisionPairingAutofill { server in
            try await withCheckedThrowingContinuation { callbacks[server.id] = $0 }
        }
        state.edit("WXYZ")
        state.load(from: first)
        precondition(state.code.isEmpty && state.isLoading, "switching servers clears a previous code immediately")
        try await waitUntil { callbacks[first.id] != nil }
        state.load(from: second)
        try await waitUntil { callbacks[second.id] != nil }
        callbacks.removeValue(forKey: second.id)!.resume(returning: [offerB])
        try await waitUntil { state.code == offerB.code }
        callbacks.removeValue(forKey: first.id)!.resume(returning: [offerA])
        try await Task.sleep(for: .milliseconds(50))
        precondition(state.code == offerB.code && state.server?.id == second.id, "late responses cannot overwrite the selected computer")

        state.load(from: first)
        try await waitUntil { callbacks[first.id] != nil }
        state.beginEditing(); state.edit("MAN1")
        callbacks.removeValue(forKey: first.id)!.resume(returning: [offerA])
        try await Task.sleep(for: .milliseconds(50))
        precondition(state.code == "MAN1" && !state.isLoading, "manual input wins over an in-flight response")

        state.load(from: first)
        try await waitUntil { callbacks[first.id] != nil }
        callbacks.removeValue(forKey: first.id)!.resume(returning: [offerA, offerB])
        try await waitUntil { !state.isLoading }
        precondition(state.code.isEmpty && state.offers.count == 2, "multiple active tasks require a model selection")
        state.select(offerA)
        precondition(state.code == offerA.code)
        state.select(offerB)
        precondition(state.code == offerB.code)
        state.addressChanged()
        precondition(state.code.isEmpty && state.server == nil, "an automatic code belongs only to the selected address")

        state.load(from: first)
        try await waitUntil { callbacks[first.id] != nil }
        let expired = VisionPairingOffer(sessionId: offerA.id, name: "Expired", code: "Z9Y8", expiresAt: 0)
        callbacks.removeValue(forKey: first.id)!.resume(returning: [expired])
        try await waitUntil { !state.isLoading }
        precondition(state.code.isEmpty && state.offers.isEmpty)

        state.load(from: first)
        try await waitUntil { callbacks[first.id] != nil }
        let shortLived = VisionPairingOffer(sessionId: offerA.id, name: "Short", code: "Z9Y8", expiresAt: Date().addingTimeInterval(0.15).timeIntervalSince1970 * 1000)
        callbacks.removeValue(forKey: first.id)!.resume(returning: [shortLived])
        try await waitUntil { state.code == shortLived.code }
        try await waitUntil { state.code.isEmpty && state.message.contains("过期") }

        state.load(from: first)
        try await waitUntil { callbacks[first.id] != nil }
        callbacks.removeValue(forKey: first.id)!.resume(throwing: TeachingError("测试连接中断"))
        try await waitUntil { !state.isLoading }
        precondition(state.code.isEmpty && state.message.contains("测试连接中断"))
        state.load(from: first)
        try await waitUntil { callbacks[first.id] != nil }
        state.reset()
        callbacks.removeValue(forKey: first.id)!.resume(returning: [offerA])
        try await Task.sleep(for: .milliseconds(50))
        precondition(state.code.isEmpty && state.server == nil && state.offers.isEmpty)
        print("Vision pairing HTTP identity, autofill, server switching, manual input, multiple tasks, expiration and cancellation passed.")
    }
}
