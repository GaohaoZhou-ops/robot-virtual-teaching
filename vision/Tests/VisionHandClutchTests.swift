import Foundation
import simd

@main struct VisionHandClutchTests {
    static func main() {
        let identity = matrix_identity_float4x4
        let tool = VisionHandPose(position: SIMD3(1, 2, 3), rotation: simd_quatf(angle: 0.4, axis: SIMD3(0, 0, 1)))
        func sample(_ time: Double, _ pinch: Float = 0.015, _ x: Float = 0, fist: Bool = false) -> VisionHandSample {
            var matrix = identity; matrix.columns.3.x = x
            return VisionHandSample(worldFromWrist: matrix, pinchDistance: pinch, isFist: fist, timestamp: time)
        }
        func update(_ state: inout VisionHandClutch, _ value: VisionHandSample?, _ now: Double, _ pose: VisionHandPose? = nil) {
            state.update(value, projectFromWorld: identity, tool: pose ?? tool, now: now)
        }
        var left = VisionHandClutch(), right = VisionHandClutch()
        update(&left, sample(0), 0); update(&left, sample(0.2), 0.2)
        precondition(!left.engaged, "Entering with the mode-button pinch must not arm")
        update(&left, sample(0.3, 0.05), 0.3)
        update(&left, sample(0.4), 0.4); update(&left, sample(0.5), 0.5)
        precondition(left.engaged && !right.engaged, "Hands engage independently")
        precondition(simd_distance(left.target!.point, tool.point) < 1e-6, "Clutch onset cannot jump")
        let epoch = left.epoch
        update(&left, sample(0.52, 0.015, 0.02), 0.52)
        let moved = left.target!.point.x - tool.point.x
        precondition(moved > 0 && moved < 0.02, "Position is smoothed")
        precondition(left.accepts(epoch: epoch, now: 0.53))
        update(&left, sample(0.54, 0.05, 0.02), 0.54)
        precondition(!left.engaged && left.target == nil && !left.accepts(epoch: epoch, now: 0.54), "Release rejects the pending reply immediately")
        let held = VisionHandPose(position: SIMD3(1.1, 2, 3), rotation: tool.rotation)
        update(&left, sample(0.6, 0.015, 0.02), 0.6, held); update(&left, sample(0.7, 0.015, 0.02), 0.7, held)
        precondition(simd_distance(left.target!.point, held.point) < 1e-6, "Re-pinch rebases to accepted pose")
        update(&left, nil, 0.71); precondition(!left.engaged && left.phase == .lost)
        update(&left, sample(0.8), 0.8); update(&left, sample(0.95), 0.95)
        precondition(!left.engaged, "Tracking recovery requires release")
        update(&left, sample(1, 0.05), 1)
        update(&left, sample(1.1, fist: true), 1.1); update(&left, sample(1.3, fist: true), 1.3)
        precondition(!left.engaged, "Fists are not pinches")
        update(&left, sample(1.4, 0.05), 1.4); update(&left, sample(1.5), 1.5); update(&left, sample(1.6), 1.6)
        precondition(left.engaged)
        let oldEpoch = left.epoch
        left.interrupt(.ui); update(&left, sample(1.7), 1.7)
        precondition(!left.engaged && !left.accepts(epoch: oldEpoch, now: 1.7), "UI gestures invalidate motion")
        update(&left, sample(1.8, 0.05), 1.8); update(&left, sample(1.9), 1.9); update(&left, sample(2.0), 2)
        update(&left, sample(2.01, 0.015, 0.3), 2.01)
        precondition(!left.engaged && left.phase == .lost, "Tracking jumps must not move the robot")
        update(&right, sample(3, 0.05), 3); update(&right, sample(3.1), 3.1); update(&right, sample(3.2), 3.2)
        precondition(right.engaged)
        update(&right, sample(3.2), 3.4)
        precondition(!right.engaged, "Stale data is a tracking interruption")

        // Relative rotation is expressed in the project frame, independent of
        // the world orientation and scale of a displayed sandbox.
        var converted = VisionHandClutch()
        var projectFromWorld = simd_float4x4(simd_quatf(angle: .pi / 2, axis: SIMD3(0, 0, 1)))
        projectFromWorld.columns.0 *= 2; projectFromWorld.columns.1 *= 2; projectFromWorld.columns.2 *= 2
        func convertedUpdate(_ value: VisionHandSample) {
            converted.update(value, projectFromWorld: projectFromWorld, tool: tool, now: value.timestamp)
        }
        convertedUpdate(sample(4, 0.05)); convertedUpdate(sample(4.1)); convertedUpdate(sample(4.2))
        convertedUpdate(sample(4.3, 0.015, 0.01))
        precondition(abs(converted.target!.point.x - tool.point.x) < 0.0001 && converted.target!.point.y > tool.point.y)
        precondition(abs(simd_length(converted.target!.rotation.vector) - 1) < 1e-6)
        var rotated = sample(4.4, 0.015, 0.01)
        rotated.worldFromWrist = simd_float4x4(simd_quatf(angle: 0.35, axis: SIMD3(1, 0, 0)))
        rotated.worldFromWrist.columns.3.x = 0.01
        convertedUpdate(rotated)
        let smoothedAngle: Float = 0.35 * (1 - exp(-0.1 / 0.065))
        let expected = simd_quatf(angle: smoothedAngle, axis: SIMD3(0, 1, 0)) * tool.rotation
        precondition(abs(simd_dot(converted.target!.rotation.vector, expected.vector)) > 0.99999,
                     "Wrist rotation must be smoothed and mapped into project axes, then applied to the TCP orientation")
        precondition(abs(simd_dot(converted.target!.rotation.vector, tool.rotation.vector)) < 0.999,
                     "Rotation control cannot silently leave the TCP unchanged")
        print("Vision hand clutch: entry/recovery release, independent hands, smoothing, rebase, stale replies, fist/UI rejection and coordinates passed.")
    }
}
