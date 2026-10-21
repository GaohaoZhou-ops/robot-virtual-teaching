import Foundation

/// Fits the centered model's bounding sphere into a positive-depth preview.
/// The depth budget includes the complete sphere at every rotation, not just
/// the model's thin initial orientation, including at the maximum zoom.
struct VisionPreviewFraming {
    let scale: Float
    let centerZ: Float

    init?(diameter: Float, availableSize: SIMD3<Float>, zoom: Float) {
        guard diameter.isFinite, diameter > 0, VisionPreviewPose.zoomRange.contains(zoom),
              (0..<3).allSatisfy({ availableSize[$0].isFinite && availableSize[$0] > 0 }) else { return nil }
        let fittedDiameter = min(min(availableSize.x, availableSize.y) * 0.82,
                                 availableSize.z * 0.9 / VisionPreviewPose.zoomRange.upperBound)
        let displayDiameter = fittedDiameter * zoom
        scale = displayDiameter / diameter
        // RealityView's origin is the center of its depth frame, not its back.
        centerZ = -availableSize.z / 2 + availableSize.z * 0.05 + displayDiameter / 2
    }
}

/// View-only orbit state. It never becomes a spatial placement or a saved Pose.
struct VisionPreviewPose: Equatable {
    static let zoomRange: ClosedRange<Float> = 0.5...2
    var yaw: Float = -30
    var pitch: Float = 20
    var zoom: Float = 1

    /// Gesture values are totals from the start of the gesture, not frame deltas.
    func applying(drag: SIMD2<Float> = .zero, magnification: Float = 1) -> Self {
        var result = self
        if drag.x.isFinite && drag.y.isFinite {
            // Wrap both axes instead of clamping the vertical orbit. This lets
            // successive drags turn through the top, underside and multiple laps.
            result.yaw = (yaw + drag.x * 0.35).remainder(dividingBy: 360)
            result.pitch = (pitch + drag.y * 0.35).remainder(dividingBy: 360)
        }
        if magnification.isFinite && magnification > 0 {
            result.zoom = min(Self.zoomRange.upperBound, max(Self.zoomRange.lowerBound, zoom * magnification))
        }
        return result
    }

    var accessibilityValue: String {
        "水平 \(Int(yaw))°，俯仰 \(Int(pitch))°，缩放 \(Int((zoom * 100).rounded()))%"
    }
}
