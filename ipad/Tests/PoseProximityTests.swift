import Foundation
import simd

@main struct PoseProximityTests {
    static func main() throws {
        func sample(_ position: SIMD3<Float>, segment: String = "segment", rotation: simd_quatf = simd_quatf()) -> TeachingSample {
            TeachingSample(segmentId: segment, kind: "keyframe",
                cameraPose: CameraPose(position: Point3(position), quaternion: Rotation4(rotation)))
        }
        let previous = sample(.zero)
        precondition(NearbyPoseConfirmation(sample: previous, previousSample: nil) == nil, "first Pose records directly")
        precondition(NearbyPoseConfirmation(sample: sample(.zero), previousSample: previous)?.distanceMeters == 0,
            "an identical position and orientation still need explicit confirmation")
        for axis in [SIMD3<Float>(1, 0, 0), SIMD3(0, 1, 0), SIMD3(0, 0, 1)] {
            precondition(NearbyPoseConfirmation(sample: sample(axis * 0.099), previousSample: previous) != nil)
            precondition(NearbyPoseConfirmation(sample: sample(axis * 0.100), previousSample: previous) == nil,
                "exactly 10 cm records directly")
            precondition(NearbyPoseConfirmation(sample: sample(axis * 0.101), previousSample: previous) == nil)
        }
        precondition(NearbyPoseConfirmation(sample: sample(SIMD3(0.06, 0.06, 0.06)), previousSample: previous) == nil,
            "compare the full 3D distance, not each component or the ground plane")
        let diagonal = NearbyPoseConfirmation(sample: sample(SIMD3(0.03, -0.04, 0)), previousSample: previous)!
        precondition(abs(diagonal.distanceMeters - 0.05) < 0.000001)
        precondition(diagonal.message.contains("5.0 cm") && diagonal.message.contains("10 cm"), "convert meters to cm for the alert")
        precondition(diagonal.angleDegrees == 0 && diagonal.message.contains("0.0°") && diagonal.message.contains("1°"))

        let axes: [SIMD3<Float>] = [SIMD3(1, 0, 0), SIMD3(0, 1, 0), SIMD3(0, 0, 1), simd_normalize(SIMD3(1, 2, 3))]
        for axis in axes {
            for degrees: Float in [0, 0.1, 0.99, 1, 1.01, 2, 4.99, 5, 10, 90, 180] {
                let rotation = simd_quatf(angle: degrees * .pi / 180, axis: axis)
                for distance: Float in [0, 0.05, 0.099, 0.1] {
                    let next = sample(SIMD3(distance, 0, 0), rotation: rotation)
                    let nearby = NearbyPoseConfirmation(sample: next, previousSample: previous)
                    precondition((nearby != nil) == (distance < 0.1 && degrees < 1),
                        "remind only if BOTH translation and full yaw/pitch/roll rotation are close")
                    if let nearby { precondition(abs(nearby.angleDegrees - Double(degrees)) < 0.0001) }
                }
            }
        }
        let tilted = simd_quatf(angle: 1.2, axis: simd_normalize(SIMD3<Float>(1, -2, 3)))
        let tiltedPrevious = sample(.zero, rotation: tilted)
        for degrees: Float in [0.99, 1, 1.01, 2, 5, 25] {
            let turned = sample(.zero, rotation: tilted * simd_quatf(angle: degrees * .pi / 180, axis: axes[3]))
            precondition((NearbyPoseConfirmation(sample: turned, previousSample: tiltedPrevious) != nil) == (degrees < 1),
                "the angular threshold also works from a non-identity camera orientation")
        }
        var equivalent = tiltedPrevious
        let q = equivalent.cameraPose.quaternion
        equivalent.cameraPose.quaternion.x = -q.x * 2; equivalent.cameraPose.quaternion.y = -q.y * 2
        equivalent.cameraPose.quaternion.z = -q.z * 2; equivalent.cameraPose.quaternion.w = -q.w * 2
        precondition(NearbyPoseConfirmation(sample: equivalent, previousSample: tiltedPrevious)!.angleDegrees < 0.0001,
            "quaternion sign and normalization cannot turn an identical view into a different Pose")
        let nearWrap = sample(.zero, rotation: simd_quatf(angle: 179.75 * .pi / 180, axis: axes[2]))
        let wrapped = sample(.zero, rotation: simd_quatf(angle: -179.75 * .pi / 180, axis: axes[2]))
        precondition(abs(NearbyPoseConfirmation(sample: wrapped, previousSample: nearWrap)!.angleDegrees - 0.5) < 0.0001,
            "crossing the angle wrap is a 0.5-degree turn, not 359.5 degrees")
        let widerWrap = sample(.zero, rotation: simd_quatf(angle: -170 * .pi / 180, axis: axes[2]))
        precondition(NearbyPoseConfirmation(sample: widerWrap, previousSample: nearWrap) == nil)

        var captured = sample(SIMD3(0.01, 0, 0), segment: "recalibrated-segment")
        captured.cameraPose.quaternion = Rotation4(simd_quatf(angle: 0.5 * .pi / 180, axis: SIMD3(0, 0, 1)))
        captured.surfacePoint = Point3(SIMD3(1, 2, 3))
        captured.previewCameraTransform = matrix_identity_float4x4.elements
        captured.previewProjection = matrix_identity_float4x4.elements
        captured.previewAspect = 4.0 / 3.0
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let original = try encoder.encode(captured)
        let confirmation = NearbyPoseConfirmation(sample: captured, previousSample: previous)!
        precondition(confirmation.previousSampleID == previous.id && confirmation.id == captured.id,
            "near-identical poses remain comparable across model-space calibration segments")
        captured.cameraPose.position = Point3(SIMD3(2, 3, 4))
        captured.capturedAt = "later"; captured.surfacePoint = nil
        let frozen = try encoder.encode(confirmation.sample)
        precondition(frozen == original, "confirmation preserves the capture time, transform, depth and preview together")

        var samples = [previous, sample(SIMD3(1, 0, 0))]
        let next = sample(SIMD3(0.02, 0, 0))
        precondition(NearbyPoseConfirmation(sample: next, previousSample: samples.last) == nil,
            "only compare the most recent Pose, not every historical Pose")
        samples.removeLast()
        precondition(NearbyPoseConfirmation(sample: next, previousSample: samples.last) != nil,
            "deleting the last Pose changes the next comparison")
        let restored = try JSONDecoder().decode([TeachingSample].self, from: encoder.encode(samples))
        precondition(NearbyPoseConfirmation(sample: next, previousSample: restored.last) != nil,
            "reopened drafts use their persisted last Pose")
        for value: Float in [.nan, .infinity, -.infinity] {
            precondition(NearbyPoseConfirmation(sample: sample(SIMD3(value, 0, 0)), previousSample: previous) == nil)
            var invalid = previous; invalid.cameraPose.quaternion.w = value
            precondition(NearbyPoseConfirmation(sample: invalid, previousSample: previous) == nil)
        }
        var zeroRotation = previous; zeroRotation.cameraPose.quaternion.w = 0
        precondition(NearbyPoseConfirmation(sample: zeroRotation, previousSample: previous) == nil)
        print("Pose proximity: combined 10 cm / 1 degree thresholds, same-position yaw/pitch/roll, quaternion sign/normalization/wrap, recalibration, frozen capture, deletion and reopened drafts passed.")
    }
}
