import RealityKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
enum VisionScenePaths {
    static func make(_ paths: [VisionScenePath], width: Float) async throws -> Entity {
        let root = Entity(); root.name = "空间路线"
        var positions: [SIMD3<Float>] = [], indices: [UInt32] = []
        func flush() async throws {
            guard !positions.isEmpty else { return }
            try Task.checkCancellation()
            var descriptor = MeshDescriptor(name: "Scene routes")
            descriptor.positions = MeshBuffers.Positions(positions); descriptor.primitives = .triangles(indices)
            let mesh = try await MeshResource(from: [descriptor])
            #if os(macOS)
            let material = UnlitMaterial(color: NSColor.systemCyan)
            #else
            let material = UnlitMaterial(color: UIColor.systemCyan)
            #endif
            root.addChild(ModelEntity(mesh: mesh, materials: [material]))
            positions.removeAll(keepingCapacity: true); indices.removeAll(keepingCapacity: true)
        }
        // Preserve project coordinates, batching long polylines into bounded
        // meshes. Shared by the immersive scene and offscreen render checks.
        for path in paths {
            for pair in zip(path.points, path.points.dropFirst()) {
                let a = SIMD3<Float>(pair.0), b = SIMD3<Float>(pair.1), delta = b - a
                guard simd_length(delta) > 0.00001 else { continue }
                let direction = simd_normalize(delta)
                let u = simd_normalize(simd_cross(direction, abs(direction.z) < 0.9 ? SIMD3(0, 0, 1) : SIMD3(0, 1, 0))) * width / 2
                let v = simd_normalize(simd_cross(direction, u)) * width / 2, first = UInt32(positions.count)
                positions += [a-u-v, a+u-v, a+u+v, a-u+v, b-u-v, b+u-v, b+u+v, b-u+v]
                indices += [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7].map { first + $0 }
                if positions.count >= 32768 { try await flush() }
            }
            try await flush()
        }
        return root
    }
}
