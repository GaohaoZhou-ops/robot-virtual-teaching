import RealityKit
import Metal

@MainActor
enum VisionRecallControlTests {
    static func run() async throws {
        let renderer = try RealityRenderer(), root = Entity(), head = Entity(), card = Entity()
        root.addChild(head); head.addChild(card)
        card.position = SIMD3(-0.30, -0.25, -0.70); card.scale = SIMD3(repeating: 0.7)
        // An attachment can be laid out after make; the fallback hit area must
        // already accept indirect input and beat the map behind it.
        VisionRecallControl.configure(card)
        precondition(card.components[InputTargetComponent.self]!.allowedInputTypes.contains(.indirect))
        let behind = Entity()
        behind.position = SIMD3(0, 0, -2)
        behind.components.set(CollisionComponent(shapes: [.generateBox(size: SIMD3(10, 10, 0.02))]))
        head.addChild(behind)
        let camera = PerspectiveCamera(); head.addChild(camera)
        renderer.entities.append(root); renderer.activeCamera = camera
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: 64, height: 64, mipmapped: false)
        descriptor.usage = [.renderTarget, .shaderRead]
        let texture = MTLCreateSystemDefaultDevice()!.makeTexture(descriptor: descriptor)!
        let output = try RealityRenderer.CameraOutput(.singleProjection(colorTexture: texture))
        func frame() async throws {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                do { try renderer.updateAndRender(deltaTime: 1.0 / 60, cameraOutput: output,
                    onComplete: { _ in continuation.resume() }) }
                catch { continuation.resume(throwing: error) }
            }
        }
        for yaw: Float in [0, 0.8, -1.4] {
            head.position = SIMD3(1, 1.6, -0.5)
            head.orientation = simd_quatf(angle: yaw, axis: SIMD3(0, 1, 0))
            for _ in 0..<3 { try await frame() }
            let origin = head.position(relativeTo: nil)
            func hit(_ local: SIMD3<Float>) -> Entity? {
                let target = card.convert(position: local, to: nil)
                return root.scene!.raycast(origin: origin, direction: simd_normalize(target-origin), length: 5,
                                           query: .nearest, mask: .all, relativeTo: nil).first?.entity
            }
            precondition(hit(.zero) === card, "The recall card must receive the nearest hit before the map")
            precondition(hit(SIMD3(0.10, 0.04, 0)) === card, "Card padding remains clickable after scaling and head rotation")
            precondition(hit(SIMD3(0.3, 0, 0)) === behind, "Clicks outside the control must still reach scene geometry")
        }
        // Once the attachment has geometry, its whole visible width is usable.
        let surface = ModelEntity(mesh: .generateBox(size: SIMD3(0.4, 0.18, 0.001)))
        card.addChild(surface); VisionRecallControl.configure(card)
        for _ in 0..<3 { try await frame() }
        let origin = head.position(relativeTo: nil), edge = card.convert(position: SIMD3(0.19, 0.08, 0), to: nil)
        let hit = root.scene!.raycast(origin: origin, direction: simd_normalize(edge-origin), length: 5,
                                     query: .nearest, mask: .all, relativeTo: nil).first
        precondition(hit?.entity === card, "Measured attachment bounds replace the layout fallback")
        print("Control recall input: indirect input, nearest hit, padding, scaled/rotated head space and late attachment layout passed.")
    }
}
