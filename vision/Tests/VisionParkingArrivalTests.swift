import Foundation
import RealityKit
import Metal
import ImageIO

@MainActor
enum VisionParkingArrivalTests {
    static func run() async throws {
        let parking = VisionSceneMarker(id: "parking", name: "停车点 1", kind: "parking", position: [0, 0, 0], taskId: nil)
        let camera = VisionSceneMarker(id: "camera", name: "相机", kind: "camera", position: [0, 0, 0], taskId: nil)
        func near(_ head: SIMD3<Float>?, enabled: Bool = true) -> String? {
            VisionParkingArrival.nearest(in: [camera, parking], head: head,
                worldFromProject: TeachingCoordinates.zUpToAR, enabled: enabled)?.id
        }
        precondition(near(SIMD3(0.099, 1.6, 0)) == parking.id)
        precondition(near(SIMD3(0.10, 1.1, 0)) == parking.id, "Exactly 10 cm is inside, regardless of eye height")
        precondition(near(SIMD3(0.1001, 1.6, 0)) == nil, "Leaving the 10 cm range clears arrival")
        precondition(near(SIMD3(0.08, 1.6, 0.08)) == nil, "The range is circular, not an axis-aligned square")
        precondition(near(nil) == nil && near(SIMD3(.nan, 1.6, 0)) == nil)
        precondition(near(SIMD3(0, 1.6, 0), enabled: false) == nil, "Overview, placement and travel cannot report arrival")
        precondition(VisionParkingArrival.nearest(in: [camera], head: .zero,
            worldFromProject: TeachingCoordinates.zUpToAR, enabled: true) == nil, "Camera keyframes are never parking targets")
        let second = VisionSceneMarker(id: "second", name: "停车点 2", kind: "parking", position: [0.05, 0, 0], taskId: nil)
        precondition(VisionParkingArrival.nearest(in: [parking, second], head: SIMD3(0.04, 1.6, 0),
            worldFromProject: TeachingCoordinates.zUpToAR, enabled: true)?.id == second.id, "Overlapping arrival zones choose the nearest parking point")
        let offset = VisionSceneMarker(id: "offset", name: "移位点", kind: "parking", position: [1.2, -0.3, 0.2], taskId: nil)
        for angle: Float in [-1.2, 0, 2.4] {
            for scale: Float in [0.25, 1, 2] {
                let transform = Transform(scale: SIMD3(repeating: scale), rotation: simd_quatf(angle: angle, axis: SIMD3(0, 1, 0)),
                    translation: SIMD3(4, 0.3, -7)).matrix * TeachingCoordinates.zUpToAR
                let world = (transform * SIMD4(SIMD3<Float>(offset.position), 1)).xyz
                for distance: Float in [0.099, 0.1, 0.101] {
                    let match = VisionParkingArrival.nearest(in: [offset], head: world + SIMD3(distance, 1.7, 0),
                        worldFromProject: transform, enabled: true)
                    precondition((match != nil) == (distance <= 0.1), "Map translation, rotation and scale must preserve the physical 10 cm threshold")
                }
            }
        }
        try await render(parking)
        print("Parking arrival: 10 cm boundary, horizontal distance, transformed maps, nearest parking only, tracking loss and visible/restored feedback passed.")
    }

    private static func render(_ parking: VisionSceneMarker) async throws {
        let root = Entity(), axes = Entity()
        axes.transform = Transform(matrix: TeachingCoordinates.zUpToAR); root.addChild(axes)
        let marker = ModelEntity(mesh: .generateSphere(radius: 0.03), materials: [VisionSceneMarkers.material(for: parking)])
        axes.addChild(marker)
        let halo = try await VisionParkingArrival.makeIndicator(markerRadius: 0.03)
        halo.position.z = 0.012; axes.addChild(halo)
        precondition(!halo.components.has(InputTargetComponent.self) && !halo.components.has(CollisionComponent.self),
                     "Arrival feedback must not intercept scene input or landing queries")
        axes.addChild(VisionFloorGrid.referenceFloor(low: SIMD3(-1, -1, 0), high: SIMD3(1, 1, 1), ground: 0))
        let camera = PerspectiveCamera(); root.addChild(camera)
        camera.camera.fieldOfViewInDegrees = 45
        camera.look(at: .zero, from: SIMD3(0, 0.65, 0.65), relativeTo: root)
        let renderer = try RealityRenderer(); renderer.entities.append(root); renderer.activeCamera = camera
        renderer.cameraSettings.isToneMappingEnabled = true
        let width = 384, height = 384
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]; descriptor.storageMode = .shared
        let texture = MTLCreateSystemDefaultDevice()!.makeTexture(descriptor: descriptor)!
        let output = try RealityRenderer.CameraOutput(.singleProjection(colorTexture: texture))
        func capture(_ name: String, arrived: Bool) async throws -> (gold: Int, green: Int) {
            marker.model?.materials = [VisionSceneMarkers.material(for: parking, arrived: arrived)]
            halo.isEnabled = arrived
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
            if let path = ProcessInfo.processInfo.environment["VISION_PARKING_ARTIFACTS"] {
                let directory = URL(fileURLWithPath: path)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                    bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.displayP3)!,
                    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                    provider: CGDataProvider(data: Data(rgba) as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
                let destination = CGImageDestinationCreateWithURL(directory.appendingPathComponent("\(name).png") as CFURL, "public.png" as CFString, 1, nil)!
                CGImageDestinationAddImage(destination, image, nil); precondition(CGImageDestinationFinalize(destination))
            }
            var gold = 0, green = 0
            for pixel in stride(from: 0, to: rgba.count, by: 4) {
                let r = Int(rgba[pixel]), g = Int(rgba[pixel + 1]), b = Int(rgba[pixel + 2])
                if r > 190 && g > 150 && r > g + 20 && g > b + 40 { gold += 1 }
                if g > 170 && g > r + 40 && g > b + 40 { green += 1 }
            }
            return (gold, green)
        }
        let before = try await capture("outside", arrived: false)
        let inside = try await capture("arrived", arrived: true)
        let after = try await capture("departed", arrived: false)
        precondition(before.gold > 100 && before.green == 0)
        precondition(inside.green > before.gold + 100 && inside.gold == 0, "The green marker and halo must render above the floor")
        precondition(after.gold == before.gold && after.green == 0, "Leaving restores the Web's gold marker and removes the halo")
    }
}
