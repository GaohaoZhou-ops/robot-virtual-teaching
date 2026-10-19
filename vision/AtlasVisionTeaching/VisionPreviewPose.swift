import Foundation

/// View-only orbit state. It never becomes a spatial placement or a saved Pose.
struct VisionPreviewPose: Equatable {
    var yaw: Float = -30
    var pitch: Float = 20
    var zoom: Float = 1

    /// Gesture values are totals from the start of the gesture, not frame deltas.
    func applying(drag: SIMD2<Float> = .zero, magnification: Float = 1) -> Self {
        var result = self
        if drag.x.isFinite && drag.y.isFinite {
            result.yaw = (yaw + drag.x * 0.35).remainder(dividingBy: 360)
            result.pitch = min(80, max(-80, pitch + drag.y * 0.35))
        }
        if magnification.isFinite && magnification > 0 {
            result.zoom = min(2, max(0.5, zoom * magnification))
        }
        return result
    }

    var accessibilityValue: String {
        "水平 \(Int(yaw))°，俯仰 \(Int(pitch))°，缩放 \(Int((zoom * 100).rounded()))%"
    }
}
