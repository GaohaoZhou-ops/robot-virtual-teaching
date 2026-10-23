import Foundation
import Vision
import ImageIO
import CoreGraphics
import simd

@main struct QRCodeTests {
    static func main() async throws {
        let args = CommandLine.arguments
        let file = URL(fileURLWithPath: args[1]), address = args[2], sessionID = args[3], serverID = args[4]
        // Decode the real server PNG with Apple's barcode recognizer, including
        // the actual 248-pixel display size used by the desktop pairing dialog.
        let source = CGImageSourceCreateWithURL(file as CFURL, nil)!
        let original = CGImageSourceCreateImageAtIndex(source, 0, nil)!
        let canvas = CGContext(data: nil, width: 248, height: 248, bitsPerComponent: 8, bytesPerRow: 248 * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        canvas.interpolationQuality = .none
        canvas.draw(original, in: CGRect(x: 0, y: 0, width: 248, height: 248))
        let small = canvas.makeImage()!
        func read(_ request: VNImageRequestHandler) throws -> String {
            let detect = VNDetectBarcodesRequest(); detect.symbologies = [.qr]
            try request.perform([detect])
            guard let value = detect.results?.first?.payloadStringValue else { throw TeachingError("Generated QR image is unreadable") }
            return value
        }
        let text = try read(VNImageRequestHandler(url: file))
        let smallText = try read(VNImageRequestHandler(cgImage: small))
        precondition(smallText == text)
        let qr = try PairingQRCode.parse(text)
        precondition(!qr.isScreen)
        precondition(qr.address == address && qr.sessionId == sessionID && qr.serverId == serverID)
        let fields = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        precondition(fields["ownerToken"] == nil && fields["deviceToken"] == nil, "QR must never expose long-lived credentials")
        func changed(_ key: String, _ value: Any) throws -> String {
            var next = fields; next[key] = value
            return String(decoding: try JSONSerialization.data(withJSONObject: next), as: UTF8.self)
        }
        var invalid = ["https://example.com", "{}", String(repeating: "x", count: 2049),
            try changed("protocol", "other/1"), try changed("expiresAt", 1),
            try changed("code", "ABCDE"), try changed("sessionId", "not-a-session"), try changed("purpose", "unknown")]
        for address in ["https://example.com", "http://8.8.8.8", "http://192.168.1.2@outside.com",
                        "http://192.168.1.2/path", "http://192.168.1.a.2", "http://192..168.1.2", "http://192.168.1.2:99999"] {
            invalid.append(try changed("address", address))
        }
        for value in invalid {
            do { _ = try PairingQRCode.parse(value); preconditionFailure("Invalid QR was accepted") }
            catch is TeachingError {}
        }
        let client = try LANClient(address: address), deviceID = UUID().uuidString
        let screenQR = try PairingQRCode.parse(changed("purpose", "screen"))
        precondition(screenQR.isScreen)
        do { _ = try await client.pair(code: screenQR.code, deviceID: deviceID, name: "QR Test", qr: screenQR); preconditionFailure("Screen QR accepted as a model transfer") }
        catch is TeachingError {}
        do { _ = try await client.pairScreen(code: qr.code, deviceID: deviceID, name: "QR Test", qr: qr); preconditionFailure("Model QR accepted as screen collaboration") }
        catch is TeachingError {}
        for field in ["serverId", "sessionId"] {
            let wrong = try PairingQRCode.parse(changed(field, UUID().uuidString.lowercased()))
            do { _ = try await client.pair(code: wrong.code, deviceID: deviceID, name: "QR Test", qr: wrong); preconditionFailure("Mismatched identity was paired") }
            catch is TeachingError {}
        }
        let paired = try await client.pair(code: qr.code, deviceID: deviceID, name: "QR Test", qr: qr)
        precondition(paired.id == sessionID)
        let downloaded = try await client.download(paired)
        let expected = try Data(contentsOf: URL(fileURLWithPath: args[5]))
        precondition(downloaded == expected)
        // Reuse the very same QR for returning results, including a new desktop
        // transfer for an existing local project. Never download its model again.
        func api(_ route: String, method: String = "GET", token: String? = nil, body: Data? = nil) async throws -> Data {
            var request = URLRequest(url: URL(string: address + "/__atlas/ipad" + route)!)
            request.httpMethod = method; request.httpBody = body
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await URLSession.shared.data(for: request)
            precondition((response as! HTTPURLResponse).statusCode < 300, String(decoding: data, as: UTF8.self))
            return data
        }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let directory = file.deletingLastPathComponent()
        let store = ProjectStore(directory: directory.appendingPathComponent("device"))
        let calibration = Calibration(worldFromModel: TeachingCoordinates.zUpToAR.elements, referencePoint: Point3(.zero), yawDegrees: 0)
        var result = TeachingResult(sessionId: paired.id, modelHash: paired.manifest.modelHash)
        precondition(paired.poseSeed?.samples.count == 3, "QR model pairing receives all three Mac poses")
        try paired.poseSeed?.apply(to: &result)
        precondition(result.samples.count == 3 && result.samples.allSatisfy { $0.resolvedOrigin == .desktop },
                     "imported Mac poses keep their source and enter the local teaching result")
        precondition(TeachingPoseCounts(result.samples)[.leftArm] == 2 && TeachingPoseCounts(result.samples)[.rightArm] == 1,
                     "left/right metadata survives native QR pairing and seed application")
        result.calibrations.append(calibration)
        result.samples.append(TeachingSample(name: "QR Pose", segmentId: calibration.id, kind: "keyframe",
            cameraPose: TeachingCoordinates.opticalPose(camera: matrix_identity_float4x4, worldFromModel: TeachingCoordinates.zUpToAR)))
        result.completedAt = timestamp()
        let originalResult = try encoder.encode(result)
        var project = LocalProject(serverURL: address, session: paired, result: result)
        try await store.saveModel(expected, id: project.id); try await store.save(project)
        let savedProject = try await store.projects()[0]
        precondition(savedProject.result.samples.count == 4
                     && savedProject.result.samples.filter { $0.resolvedOrigin == .desktop }.count == 3,
                     "the three downloaded poses and new iPad pose survive local storage")
        let modelURL = try await store.modelURL(project.id)
        func rejected(_ text: String, _ run: () async throws -> Void) async throws {
            do { try await run(); preconditionFailure("accepted invalid sync: \(text)") }
            catch let error as TeachingError { precondition(error.message.contains(text), error.message) }
        }
        var damaged = expected; damaged[damaged.count - 1] ^= 1
        try await store.saveModel(damaged, id: project.id)
        try await rejected("本地模型内容") { _ = try await client.pairResult(project, modelURL: modelURL, qr: qr, deviceID: deviceID, name: "QR Sync") }
        try await store.saveModel(expected, id: project.id)
        try await rejected("另一台设备") { _ = try await client.pairResult(project, modelURL: modelURL, qr: qr, deviceID: UUID().uuidString, name: "Other device") }
        let expired = PairingQRCode(protocol: qr.protocol, address: address, code: qr.code, sessionId: qr.sessionId, serverId: qr.serverId, expiresAt: 1)
        try await rejected("已过期") { _ = try await client.pairResult(project, modelURL: modelURL, qr: expired, deviceID: deviceID, name: "QR Sync") }
        let originalDestination = try await client.pairResult(project, modelURL: modelURL, qr: qr, deviceID: deviceID, name: "QR Sync")
        project.resultSyncDestination = ResultSyncDestination(serverURL: address, session: originalDestination)
        try await client.upload(project, modelURL: modelURL)

        struct Ticket: Decodable { var id: String; var ownerToken: String; var pairingCode: String; var pairingExpiresAt: Double }
        let creation = try JSONSerialization.data(withJSONObject: ["manifest": JSONSerialization.jsonObject(with: encoder.encode(paired.manifest))])
        let ticket = try JSONDecoder().decode(Ticket.self, from: await api("/sessions", method: "POST", body: creation))
        _ = try await api("/sessions/\(ticket.id)/model", method: "PUT", token: ticket.ownerToken, body: expected)
        let newQR = PairingQRCode(protocol: qr.protocol, address: address, code: ticket.pairingCode, sessionId: ticket.id, serverId: qr.serverId, expiresAt: ticket.pairingExpiresAt)
        var mismatch = project; mismatch.session.manifest.modelHash = String(repeating: "0", count: 64)
        try await rejected("本地模型内容") { _ = try await client.pairResult(mismatch, modelURL: modelURL, qr: newQR, deviceID: deviceID, name: "QR Sync") }
        // A different but internally consistent local model is rejected by the
        // desktop before it claims the transfer or receives any Pose data.
        try await store.saveModel(damaged, id: project.id)
        let changedIdentity = try ModelFileIdentity.read(from: modelURL)
        mismatch.session.manifest.modelHash = changedIdentity.modelHash; mismatch.result.modelHash = changedIdentity.modelHash
        try await rejected("模型内容不一致") { _ = try await client.pairResult(mismatch, modelURL: modelURL, qr: newQR, deviceID: deviceID, name: "QR Sync") }
        let stillReady = try JSONSerialization.jsonObject(with: await api("/sessions/\(ticket.id)", token: ticket.ownerToken)) as! [String: Any]
        precondition(stillReady["status"] as? String == "ready")
        try await store.saveModel(expected, id: project.id)
        let destination = try await client.pairResult(project, modelURL: modelURL, qr: newQR, deviceID: deviceID, name: "QR Sync")
        project.resultSyncDestination = ResultSyncDestination(serverURL: address, session: destination)
        try await store.save(project)
        var restored = try await ProjectStore(directory: directory.appendingPathComponent("device")).projects()[0]
        // The harness corrupts the first receipt for this transfer after storing
        // the result, exercising durable recovery from an ambiguous upload.
        try await rejected("同步回执") { try await client.upload(restored, modelURL: modelURL) }
        try await client.upload(restored, modelURL: modelURL)
        let received = try JSONDecoder().decode(TeachingResult.self, from: await api("/sessions/\(ticket.id)/result", token: ticket.ownerToken))
        precondition(received.id == result.id && received.sessionId == ticket.id)
        var originalSession = received; originalSession.sessionId = result.sessionId
        let receivedBytes = try encoder.encode(originalSession), restoredBytes = try encoder.encode(restored.result)
        precondition(receivedBytes == originalResult, "every Pose, calibration, timestamp and ID survives")
        precondition(restoredBytes == originalResult && restored.id == paired.id, "local project remains unchanged")
        var otherResult = restored; otherResult.result.id = UUID().uuidString
        try await rejected("另一份示教结果") { _ = try await client.pairResult(otherResult, modelURL: modelURL, qr: newQR, deviceID: deviceID, name: "QR Sync") }
        // Same-result rescans are idempotent even after desktop import.
        _ = try await api("/sessions/\(ticket.id)/imported", method: "POST", token: ticket.ownerToken)
        let retryDestination = try await client.pairResult(restored, modelURL: modelURL, qr: newQR, deviceID: deviceID, name: "QR Sync")
        restored.resultSyncDestination?.session = retryDestination
        try await client.upload(restored, modelURL: modelURL)
        let imported = try JSONSerialization.jsonObject(with: await api("/sessions/\(ticket.id)", token: ticket.ownerToken)) as! [String: Any]
        precondition(imported["status"] as? String == "imported")
        try encoder.encode(result).write(to: directory.appendingPathComponent("original-result.json"))
        try encoder.encode(received).write(to: directory.appendingPathComponent("received-result.json"))
        print("Apple Vision QR decode, model receive, existing/new transfer result sync, mismatch/expiry/device rejection, durable retry and immutable Pose preservation passed.")
    }
}
