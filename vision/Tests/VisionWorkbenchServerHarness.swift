import Foundation

@main struct VisionWorkbenchServerHarness {
    static func main() async throws {
        let args = CommandLine.arguments
        let directory = URL(fileURLWithPath: args[2], isDirectory: true)
        let server = VisionWorkbenchServer(root: URL(fileURLWithPath: args[1], isDirectory: true), sessionID: "vision-workbench-regression",
                                           sceneStore: VisionSceneStore(directory: directory.appendingPathComponent("scene-cache")))
        try await server.start()
        if args.count > 4 { await server.selectRemote(try LANClient(address: args[4]).baseURL) }
        let id = try await server.registerImport(URL(fileURLWithPath: args[3]))
        let output: [String: Any] = ["origin": server.origin.absoluteString, "token": server.token, "importID": id]
        print(String(data: try JSONSerialization.data(withJSONObject: output), encoding: .utf8)!)
        fflush(stdout)
        while !Task.isCancelled { try await Task.sleep(for: .seconds(30)) }
    }
}
