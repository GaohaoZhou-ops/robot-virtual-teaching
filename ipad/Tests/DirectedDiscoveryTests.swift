import Foundation

@main struct DirectedDiscoveryTests {
    @MainActor static func main() async throws {
        let addresses = Array(CommandLine.arguments.dropFirst())
        let expectedID = addresses[0], target = addresses[1], wrong = addresses[2]
        let hanging = addresses[3], trickling = addresses[4], redirect = addresses[5], slow = addresses[6]
        let discovery = LANServiceDiscovery()
        func waitForCompletion() async throws {
            let deadline = Date().addingTimeInterval(4)
            while discovery.isSearching && Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
            precondition(!discovery.isSearching, "a directed probe must always finish within its deadline")
        }
        func checkMinimumFeedback(address: String) async throws {
            let started = ContinuousClock.now
            discovery.probe(address: address)
            let searchingMessage = discovery.message
            precondition(discovery.isSearching && discovery.servers.isEmpty)
            try await Task.sleep(for: .seconds(1))
            precondition(discovery.isSearching && discovery.servers.isEmpty && discovery.message == searchingMessage,
                         "fast responses must not flash results while the globe is still animating")
            try await waitForCompletion()
            let elapsed = started.duration(to: .now)
            precondition(elapsed >= .milliseconds(1500) && elapsed < .milliseconds(2500),
                         "fast success and failure both keep feedback visible for at least 1.5 seconds")
        }
        for address in ["http://192.168.0.2:65536", ""] {
            try await checkMinimumFeedback(address: address)
            precondition(discovery.servers.isEmpty && discovery.message == "请先填写有效的电脑地址和端口。")
        }

        try await checkMinimumFeedback(address: target)
        precondition(discovery.servers.count == 1 && discovery.servers[0].id == expectedID)
        precondition(discovery.servers[0].address == target, "the selected address and port are preserved exactly")

        for address in [wrong, redirect] {
            try await checkMinimumFeedback(address: address)
            precondition(discovery.servers.isEmpty, "incompatible responses and redirects cannot select another server")
        }
        let slowStarted = ContinuousClock.now
        discovery.probe(address: slow)
        try await waitForCompletion()
        precondition(slowStarted.duration(to: .now) < .milliseconds(2800) && discovery.servers.first?.id == expectedID,
                     "a response taking 2 seconds must not wait another 1.5 seconds")
        for address in [hanging, trickling] {
            let started = Date()
            discovery.probe(address: address)
            try await waitForCompletion()
            precondition(Date().timeIntervalSince(started) < 3.6, "total deadline includes an unfinished body")
            precondition(discovery.servers.isEmpty)
        }
        discovery.probe(address: hanging)
        try await Task.sleep(for: .milliseconds(100))
        discovery.probe(address: target)
        try await waitForCompletion()
        precondition(discovery.servers.first?.id == expectedID, "a new target replaces pending work")
        try await Task.sleep(for: .milliseconds(3200))
        precondition(discovery.servers.first?.id == expectedID && !discovery.isSearching,
                     "the cancelled request cannot overwrite the new result")

        discovery.probe(address: target)
        try await Task.sleep(for: .milliseconds(100))
        discovery.resetProbe()
        precondition(!discovery.isSearching, "editing cancels minimum feedback immediately")
        try await Task.sleep(for: .milliseconds(1600))
        precondition(discovery.servers.isEmpty && !discovery.isSearching, "editing clears cards and prevents late results")
        discovery.probe(address: hanging)
        discovery.stop()
        precondition(!discovery.isSearching)
        print("Directed server detection: exact endpoint, 1.5-second minimum feedback for success and failure, no added delay for slow responses, cancellation and 3-second overall deadline passed.")
    }
}
