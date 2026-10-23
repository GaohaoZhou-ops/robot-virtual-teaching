import Foundation
import Vision
import ImageIO
import CoreGraphics

@main struct ScreenPairingTests {
    static func main() async throws {
        let file = URL(fileURLWithPath: CommandLine.arguments[1])
        let original = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithURL(file as CFURL, nil)!, 0, nil)!
        let canvas = CGContext(data: nil, width: 248, height: 248, bitsPerComponent: 8, bytesPerRow: 248 * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        canvas.interpolationQuality = .none
        canvas.draw(original, in: CGRect(x: 0, y: 0, width: 248, height: 248))
        let detector = VNDetectBarcodesRequest(); detector.symbologies = [.qr]
        try VNImageRequestHandler(cgImage: canvas.makeImage()!).perform([detector])
        guard let text = detector.results?.first?.payloadStringValue else { throw TeachingError("Collaboration QR is unreadable at display size") }
        let qr = try PairingQRCode.parse(text)
        precondition(qr.isScreen)
        let fields = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
        precondition(fields["token"] == nil && fields["deviceToken"] == nil && fields["ownerToken"] == nil)
        let client = try LANClient(address: qr.address)
        let paired = try await client.pairScreen(code: qr.code, deviceID: UUID().uuidString, name: "Swift QR iPad", qr: qr)
        precondition(paired.id == qr.sessionId && paired.serverId == qr.serverId)
        let socket = try client.screenSocket(paired); socket.resume()
        defer { socket.cancel(with: .normalClosure, reason: nil) }
        var actions = Set<UInt8>()
        while true {
            let message = try await socket.receive()
            guard case let .data(data) = message, data.count >= 5 else { throw TeachingError("Expected collaboration binary envelope") }
            let action = data[0], id = data[1..<5].reduce(0) { ($0 << 8) | Int($1) }
            actions.insert(action)
            if action == 1 {
                let body = try JSONSerialization.jsonObject(with: Data(data.dropFirst(5))) as! [String: String]
                precondition(body["protocol"] == "atlas-ipad-screen/1")
            }
            if action == 2 || action == 3 { precondition(data.count > 16) }
            let reply: [String: Any] = ["requestId": id, "status": 200, "body": ["page": "cameras", "commands": []]]
            try await socket.send(.string(String(decoding: JSONSerialization.data(withJSONObject: reply), as: UTF8.self)))
            if action == 5 { break }
        }
        precondition(actions.isSuperset(of: [1, 2, 3, 5]))
        print("Apple Vision decoded the collaboration QR at 248px; native LANClient paired and relayed camera/workspace data over its authenticated WebSocket.")
    }
}
