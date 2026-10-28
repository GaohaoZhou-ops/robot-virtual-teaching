import RealityKit

struct VisionRecallTarget: Component, Equatable {
    var size: SIMD3<Float>
    var center: SIMD3<Float>
}

@MainActor
enum VisionRecallControl {
    static func configure(_ attachment: Entity) {
        VisionRecallTarget.registerComponent()
        let bounds = attachment.visualBounds(relativeTo: attachment)
        // Give the entire card an explicit 3D hit target, including its padding.
        // Attachments can initially have no visual bounds while SwiftUI lays out.
        let valid = bounds.extents.x.isFinite && bounds.extents.x > 0
            && bounds.extents.y.isFinite && bounds.extents.y > 0
            && bounds.center.x.isFinite && bounds.center.y.isFinite && bounds.center.z.isFinite
        let size = valid
            ? SIMD3<Float>(max(bounds.extents.x, 0.22), max(bounds.extents.y, 0.10), 0.02)
            : SIMD3<Float>(0.22, 0.10, 0.02)
        let center = valid ? bounds.center : .zero
        let target = VisionRecallTarget(size: size, center: center)
        guard attachment.components[VisionRecallTarget.self] != target else { return }
        let shape = ShapeResource.generateBox(size: size).offsetBy(translation: center)
        attachment.components.set(target)
        attachment.components.set(InputTargetComponent(allowedInputTypes: .all))
        // Keep the default hit-test filter. Trigger mode gives the card an
        // input surface without physically pushing scene objects.
        attachment.components.set(CollisionComponent(shapes: [shape], mode: .trigger))
        attachment.components.set(HoverEffectComponent())
    }
}
