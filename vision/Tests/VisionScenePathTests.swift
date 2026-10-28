import Foundation
import RealityKit
import Metal
import ImageIO

@MainActor
enum VisionScenePathTests {
    static func run(_ scene: VisionSceneManifest) async throws {
        precondition(scene.navigationGroundHeight == 0)
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(scene)) as! [String: Any]
        var markers = object["markers"] as! [[String: Any]]
        for index in markers.indices where markers[index]["kind"] as? String != "parking" {
            markers[index]["position"] = [0, 0, -10]
        }
        func ground() throws -> Float? {
            object["markers"] = markers
            return try JSONDecoder().decode(VisionSceneManifest.self,
                from: JSONSerialization.data(withJSONObject: object)).navigationGroundHeight
        }
        let withoutCamera = try ground()
        precondition(withoutCamera == 0, "Camera keyframes must not lower the navigation floor")
        markers[markers.firstIndex { $0["kind"] as? String == "parking" }!]["position"] = [0, 0, -0.5]
        let lowestLevel = try ground()
        precondition(lowestLevel == -0.5, "The floor must stay below all navigation levels")
        markers.removeAll { $0["kind"] as? String == "parking" }
        let withoutNavigation = try ground()
        precondition(withoutNavigation == nil, "Scenes without navigation retain their existing floor fallback")

        let root = Entity(), axes = Entity()
        axes.transform = Transform(matrix: TeachingCoordinates.zUpToAR); root.addChild(axes)
        let paths = try await VisionScenePaths.make(scene.paths.filter { $0.id == "route-edge" }, width: 0.024)
        axes.addChild(paths)
        let bounds = paths.visualBounds(relativeTo: axes)
        precondition(bounds.extents.x > 3.9, "The imported route must generate non-degenerate native geometry")
        let low = SIMD3<Float>(-3, -2, -0.1), high = SIMD3<Float>(3, 2, 2)
        let raised = VisionFloorGrid.referenceFloor(low: low, high: high, ground: 0.174929)
        axes.addChild(raised)
        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = 50; root.addChild(camera)
        camera.look(at: SIMD3(0, 0, 1), from: SIMD3(0, 3, 3), relativeTo: root)
        let renderer = try RealityRenderer()
        renderer.entities.append(root); renderer.activeCamera = camera
        renderer.cameraSettings.isToneMappingEnabled = false
        renderer.cameraSettings.colorBackground = .color(CGColor(red: 0.02, green: 0.03, blue: 0.04, alpha: 1))
        let width = 512, height = 384
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]; descriptor.storageMode = .shared
        let texture = MTLCreateSystemDefaultDevice()!.makeTexture(descriptor: descriptor)!
        let output = try RealityRenderer.CameraOutput(.singleProjection(colorTexture: texture))
        func capture(_ name: String) async throws -> Int {
            for _ in 0..<4 {
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    do { try renderer.updateAndRender(deltaTime: 1.0 / 60, cameraOutput: output,
                        onComplete: { _ in continuation.resume() }) }
                    catch { continuation.resume(throwing: error) }
                }
            }
            var rgba = [UInt8](repeating: 0, count: width * height * 4)
            texture.getBytes(&rgba, bytesPerRow: width * 4, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0)
            for pixel in stride(from: 0, to: rgba.count, by: 4) { rgba.swapAt(pixel, pixel + 2) }
            if let path = ProcessInfo.processInfo.environment["VISION_ROUTE_ARTIFACTS"] {
                let directory = URL(fileURLWithPath: path)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                    bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                    provider: CGDataProvider(data: Data(rgba) as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
                let destination = CGImageDestinationCreateWithURL(directory.appendingPathComponent("\(name).png") as CFURL, "public.png" as CFString, 1, nil)!
                CGImageDestinationAddImage(destination, image, nil); precondition(CGImageDestinationFinalize(destination))
            }
            return stride(from: 0, to: rgba.count, by: 4).filter { rgba[$0] < 125 && rgba[$0 + 1] > 140 && rgba[$0 + 2] > 180 }.count
        }
        let hidden = try await capture("raised-floor")
        raised.removeFromParent()
        axes.addChild(VisionFloorGrid.referenceFloor(low: low, high: high, ground: scene.navigationGroundHeight!))
        let visible = try await capture("navigation-floor")
        let grid = try await VisionFloorGrid.make(low: low, high: high, ground: scene.navigationGroundHeight!)
        axes.addChild(grid.entity)
        let withGrid = try await capture("navigation-floor-grid")
        precondition(hidden == 0, "A raised opaque floor must reproduce the reported road occlusion")
        precondition(visible > 300 && withGrid > 300, "Ground-level roads must remain visible above the reference floor and grid")
        print("RealityKit routes: native pose coordinates, floor height policy, raised-floor occlusion (\(hidden) pixels) and corrected visibility (\(visible)/\(withGrid) cyan pixels) passed.")
    }
}
