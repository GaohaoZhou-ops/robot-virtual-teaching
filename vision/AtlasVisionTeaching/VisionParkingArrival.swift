import RealityKit

enum VisionParkingArrival {
    static let radius: Float = 0.10

    static func nearest(in markers: [VisionSceneMarker], head: SIMD3<Float>?,
                        worldFromProject: simd_float4x4, enabled: Bool) -> VisionSceneMarker? {
        guard enabled, let head, head.x.isFinite, head.y.isFinite, head.z.isFinite else { return nil }
        var nearest: VisionSceneMarker?
        // Ten micrometres of tolerance only compensates for Float transforms
        // at the inclusive 10 cm boundary, including translated project origins.
        var nearestDistance = (radius + 0.00001) * (radius + 0.00001)
        for marker in markers where marker.kind == "parking" {
            let world = worldFromProject * SIMD4(SIMD3<Float>(marker.position), 1)
            // ARKit world is Y-up. Compare floor projections, not eye height
            // or robot pose, and measure after applying the current map transform.
            let offset = SIMD2(world.x - head.x, world.z - head.z)
            let distance = simd_length_squared(offset)
            guard distance.isFinite, distance <= nearestDistance else { continue }
            if distance == nearestDistance, let nearest, marker.id > nearest.id { continue }
            nearest = marker; nearestDistance = distance
        }
        return nearest
    }

    @MainActor
    static func makeIndicator(markerRadius: Float) async throws -> ModelEntity {
        // This halo is visual feedback, not a landing/collision target. Keep it
        // outside even a large marker so it cannot disappear inside the sphere.
        let size = max(radius, markerRadius * 1.25), halfWidth: Float = 0.006
        var vertices: [SIMD3<Float>] = [], indices: [UInt32] = []
        for segment in 0..<64 {
            let angle = Float(segment) * 2 * .pi / 64
            let direction = SIMD3<Float>(cos(angle), sin(angle), 0)
            vertices += [direction * (size - halfWidth), direction * (size + halfWidth)]
            let a = UInt32(segment * 2), b = UInt32((segment + 1) % 64 * 2)
            indices += [a, a + 1, b + 1, a, b + 1, b]
        }
        var descriptor = MeshDescriptor(name: "Parking arrival halo")
        descriptor.positions = MeshBuffers.Positions(vertices)
        descriptor.primitives = .triangles(indices)
        var material = VisionSceneMarkers.arrivalMaterial()
        material.faceCulling = .none
        let entity = ModelEntity(mesh: try await MeshResource(from: [descriptor]), materials: [material])
        entity.name = "停车点到点光环"; entity.isEnabled = false
        entity.components.set(DynamicLightShadowComponent(castsShadow: false))
        return entity
    }
}
