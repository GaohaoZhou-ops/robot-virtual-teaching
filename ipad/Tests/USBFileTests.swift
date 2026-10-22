import Foundation

@main struct USBFileTests {
    static func main() async throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1])
        let id = CommandLine.arguments[2]
        let inbox = USBModelInbox(directory: directory)
        let snapshot = try await inbox.snapshot()
        precondition(snapshot.connection != nil && snapshot.transfers.count == 1)
        let transfer = snapshot.transfers[0]
        precondition(transfer.id == id)
        let data = try await inbox.model(transfer)
        _ = try ModelGeometry(data: data, manifest: transfer.manifest)
        precondition(!data.isEmpty)

        let stale = try await inbox.snapshot(now: Date().addingTimeInterval(60))
        precondition(stale.connection == nil, "an old heartbeat must not claim a live USB connection")
        precondition(stale.transfers.count == 1, "a fully copied file remains available offline")
        let connectionURL = directory.appendingPathComponent("connection.json")
        let heartbeat = try Data(contentsOf: connectionURL)
        var record = try JSONSerialization.jsonObject(with: heartbeat) as! [String: Any]
        record["transport"] = "wifi"
        try JSONSerialization.data(withJSONObject: record).write(to: connectionURL)
        let wireless = try await inbox.snapshot()
        precondition(wireless.connection == nil, "wireless or charging signals are not USB confirmation")
        try heartbeat.write(to: connectionURL)

        let folder = directory.appendingPathComponent("Inbox").appendingPathComponent(id)
        let modelURL = folder.appendingPathComponent("model.atls")
        var corrupt = data; corrupt[corrupt.count - 1] ^= 1
        try corrupt.write(to: modelURL)
        do { _ = try await inbox.model(transfer); preconditionFailure("corrupt data was accepted") }
        catch let error as TeachingError { precondition(error.message.contains("校验失败")) }
        try Data(data.prefix(40)).write(to: modelURL)
        let partial = try await inbox.snapshot()
        precondition(partial.transfers.isEmpty && !partial.message.isEmpty)
        try data.write(to: modelURL)

        let incomplete = directory.appendingPathComponent("Inbox").appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: incomplete, withIntermediateDirectories: true)
        try data.write(to: incomplete.appendingPathComponent("model.atls"))
        let withoutCommit = try await inbox.snapshot()
        precondition(withoutCommit.transfers.count == 1, "a copied model is invisible until ready.json commits it")

        let link = directory.appendingPathComponent("Inbox").appendingPathComponent(UUID().uuidString)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: folder)
        let linked = try await inbox.snapshot()
        precondition(linked.transfers.count == 1, "symlinks cannot create duplicate or outside inbox transfers")
        try await inbox.removeReceived(transfer)
        precondition(!FileManager.default.fileExists(atPath: folder.path))
        precondition(FileManager.default.fileExists(atPath: incomplete.path), "cleanup removes only the received transfer")
        print("USB native files: freshness, offline files, SHA-256, partial copies, commit marker and scoped cleanup passed.")
    }
}
