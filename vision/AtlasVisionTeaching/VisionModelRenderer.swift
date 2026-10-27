import RealityKit
import UIKit

@MainActor
enum VisionModelRenderer {
    static func makeEntity(_ data: VisionMeshData) async throws -> ModelEntity {
        try await VisionSurfaceRenderer.makeEntity(data)
    }

    static func line(from: SIMD3<Float>, to: SIMD3<Float>, color: UIColor, width: Float = 0.004) -> Entity {
        let delta = to - from, length = simd_length(delta)
        let entity = ModelEntity(mesh: .generateCylinder(height: max(length, 0.0001), radius: width / 2),
            materials: [UnlitMaterial(color: color)])
        entity.position = (from + to) / 2
        if length > 0.0001 { entity.orientation = simd_quatf(from: SIMD3(0, 1, 0), to: delta / length) }
        return entity
    }

    static func axes() -> Entity {
        let root = Entity()
        root.addChild(line(from: .zero, to: SIMD3(0.25, 0, 0), color: .systemRed))
        root.addChild(line(from: .zero, to: SIMD3(0, 0.25, 0), color: .systemGreen))
        root.addChild(line(from: .zero, to: SIMD3(0, 0, 0.25), color: .systemBlue))
        return root
    }

    static func markers(_ samples: [TeachingSample]) -> Entity {
        let root = Entity()
        let sphere = MeshResource.generateSphere(radius: 0.022)
        let material = UnlitMaterial(color: .systemYellow)
        // Visualize recent markers with a bounded entity count; preserve every saved sample.
        for sample in samples.suffix(500) {
            let marker = ModelEntity(mesh: sphere, materials: [material])
            marker.position = sample.cameraPose.position.simd
            marker.components.set(VisionRecordedTarget(sampleID: sample.id))
            marker.components.set(CollisionComponent(shapes: [.generateSphere(radius: 0.035)], mode: .trigger))
            marker.components.set(InputTargetComponent())
            marker.components.set(HoverEffectComponent())
            root.addChild(marker)
            let q = sample.cameraPose.quaternion
            let forward = simd_quatf(vector: SIMD4(q.x, q.y, q.z, q.w)).act(SIMD3(0, 0, 0.07))
            root.addChild(line(from: marker.position, to: marker.position + forward, color: .systemYellow, width: 0.003))
        }
        return root
    }
}
