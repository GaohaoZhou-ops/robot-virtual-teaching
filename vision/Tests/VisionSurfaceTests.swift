import Foundation
import RealityKit
import Metal
import ImageIO

@MainActor
enum VisionSurfaceTests {
    static func run(_ scene: VisionSceneManifest, store: VisionSceneStore) async throws {
        let node = scene.nodes.first { $0.role == "part" && $0.asset != nil }!
        var parts: [(VisionMeshData, VisionMeshData, VisionSceneMaterial)] = []
        for part in scene.nodes where part.role == "part" && part.parent == node.parent && part.asset != nil {
            let asset = scene.assets.first { $0.id == part.asset }!
            let model = try await store.model(asset)
            let plain = try VisionMeshData(model: model, mode: .mesh, quality: .full)
            let surface = try VisionMeshData(model: model, mode: .mesh, quality: .full, includeNormals: true)
            precondition(plain.normals.isEmpty, "Map rendering should not allocate surface normals")
            precondition(surface.normals.count == surface.positions.count)
            precondition(surface.pixels == plain.pixels && surface.positions == plain.positions && surface.triangles == plain.triangles)
            precondition(surface.normals.allSatisfy { abs(simd_length($0) - 1) < 0.0001 })
            parts.append((plain, surface, part.material ?? .robotDefault))
        }
        let directions = Set(parts.flatMap { $0.1.normals }.map { "\(Int($0.x.rounded())),\(Int($0.y.rounded())),\(Int($0.z.rounded()))" })
        precondition(directions.count == 6, "The box must retain six distinct CAD face normals")

        let root = Entity(), axes = Entity(), lighting = Entity()
        axes.transform = Transform(matrix: TeachingCoordinates.zUpToAR)
        root.addChild(axes); axes.addChild(lighting)
        try await VisionSurfaceRenderer.configureLighting(lighting)
        let childCount = lighting.children.count
        try await VisionSurfaceRenderer.configureLighting(lighting)
        precondition(lighting.children.count == childCount, "Refreshing a scene must not duplicate lights")
        let flat = Entity(), lit = Entity()
        for (plain, surface, material) in parts {
            let flatPart = try await VisionSurfaceRenderer.makeEntity(plain)
            let litPart = try await VisionSurfaceRenderer.makeEntity(surface, surface: material)
            precondition(flatPart.model!.materials[0] is UnlitMaterial && litPart.model!.materials[0] is PhysicallyBasedMaterial)
            precondition(flatPart.components[DynamicLightShadowComponent.self]?.castsShadow == false)
            precondition(litPart.components[DynamicLightShadowComponent.self]?.castsShadow == true)
            litPart.components.set(ImageBasedLightReceiverComponent(imageBasedLight: lighting))
            flat.addChild(flatPart); lit.addChild(litPart)
        }
        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = 32
        root.addChild(camera)
        camera.look(at: .zero, from: SIMD3(1.4, 0.9, 1.8), relativeTo: root)
        let renderer = try RealityRenderer()
        renderer.entities.append(root); renderer.activeCamera = camera
        renderer.cameraSettings.isToneMappingEnabled = false
        renderer.cameraSettings.colorBackground = .color(CGColor(red: 0.02, green: 0.03, blue: 0.04, alpha: 1))
        let width = 512, height = 384
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]; descriptor.storageMode = .shared
        let texture = MTLCreateSystemDefaultDevice()!.makeTexture(descriptor: descriptor)!
        let output = try RealityRenderer.CameraOutput(.singleProjection(colorTexture: texture))
        func capture(_ name: String) async throws -> [UInt8] {
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
            if let path = ProcessInfo.processInfo.environment["VISION_SURFACE_ARTIFACTS"] {
                let directory = URL(fileURLWithPath: path)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let provider = CGDataProvider(data: Data(rgba) as CFData)!
                let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                    bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                    bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
                let destination = CGImageDestinationCreateWithURL(directory.appendingPathComponent("\(name).png") as CFURL, "public.png" as CFString, 1, nil)!
                CGImageDestinationAddImage(destination, image, nil); precondition(CGImageDestinationFinalize(destination))
            }
            return rgba
        }
        axes.addChild(flat)
        let before = try await capture("unlit")
        flat.removeFromParent(); axes.addChild(lit)
        let after = try await capture("physical")
        let mask = stride(from: 0, to: before.count, by: 4).filter { before[$0] > 150 && before[$0 + 1] > 150 && before[$0 + 2] > 150 }
        precondition(mask.count > 1000, "The offscreen image must contain the robot surface")
        let brightness = mask.map { (Double(after[$0]) + Double(after[$0 + 1]) + Double(after[$0 + 2])) / 3 }
        let range = brightness.max()! - brightness.min()!
        precondition(range > 25, "White robot faces must have visible directional shading")
        precondition(brightness.filter { $0 > 250 }.count < brightness.count / 2, "The robot must not be washed out to white")
        let key = lighting.findEntity(named: "Robot key light")!
        key.look(at: .zero, from: SIMD3(4, 6, 3), relativeTo: lighting)
        let relit = try await capture("relit")
        let difference = mask.map { abs(Int(after[$0]) - Int(relit[$0])) }.reduce(0, +) / mask.count
        precondition(difference > 5, "Robot shading must respond to light direction")
        lit.removeFromParent(); axes.addChild(flat)
        let map = try await capture("unlit-after-light-change")
        precondition(before == map, "Changing robot lights must not change unlit map colors")
        print("RealityKit surfaces: CAD normals, source PBR materials, directional shading (range \(Int(range))), shadows, stable map colors and repeatable light setup passed.")
    }
}
