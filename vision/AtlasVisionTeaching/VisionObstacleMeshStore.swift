import ARKit
import simd

// ARKit supplies room meshes, not camera images. Decode and query them away
// from the main actor; updates and removals remain ordered within this actor.
actor VisionObstacleMeshStore {
    private var field = VisionObstacleField()

    func remove(_ id: UUID) { field.meshes.removeValue(forKey: id) }
    func sample(head: simd_float4x4, floor: Float) -> VisionObstacleSample { field.sample(head: head, floor: floor) }

    func replace(_ anchor: MeshAnchor) {
        let source = anchor.geometry.vertices, faces = anchor.geometry.faces
        guard source.format == .float3, faces.primitive == .triangle, [2, 4].contains(faces.bytesPerIndex),
              source.count > 0, source.stride >= 12, source.offset >= 0,
              source.offset + (source.count - 1) * source.stride + 12 <= source.buffer.length,
              faces.count * 3 * faces.bytesPerIndex <= faces.buffer.length else { remove(anchor.id); return }
        let vertices = (0..<source.count).map { i -> SIMD3<Float> in
            let p = source.buffer.contents().advanced(by: source.offset + i * source.stride)
            let v = SIMD4(p.loadUnaligned(as: Float.self), p.advanced(by: 4).loadUnaligned(as: Float.self),
                          p.advanced(by: 8).loadUnaligned(as: Float.self), 1)
            let world = anchor.originFromAnchorTransform * v
            return SIMD3(world.x, world.y, world.z)
        }
        let indices: [UInt32] = (0..<(faces.count * 3)).map { i in
            let p = faces.buffer.contents().advanced(by: i * faces.bytesPerIndex)
            return faces.bytesPerIndex == 2 ? UInt32(p.loadUnaligned(as: UInt16.self)) : p.loadUnaligned(as: UInt32.self)
        }
        var floorFaces = Set<Int>()
        if let classes = anchor.geometry.classifications, classes.format == .uchar, classes.stride > 0,
           classes.offset >= 0, classes.count >= faces.count,
           faces.count == 0 || classes.offset + (faces.count - 1) * classes.stride + 1 <= classes.buffer.length {
            for i in 0..<faces.count {
                let value = Int(classes.buffer.contents().advanced(by: classes.offset + i * classes.stride).load(as: UInt8.self))
                let isFloor: Bool
                if #available(visionOS 26.0, *) { isFloor = SurfaceClassification(rawValue: value) == .floor }
                else { isFloor = MeshAnchor.MeshClassification(rawValue: value) == .floor }
                if isFloor { floorFaces.insert(i) }
            }
        }
        field.meshes[anchor.id] = VisionObstacleMesh(vertices: vertices, indices: indices, floorFaces: floorFaces)
    }
}
