import Foundation
import simd

enum VisionHandSide: String, CaseIterable, Codable, Identifiable {
    case left, right
    var id: String { rawValue }
    var title: String { self == .left ? "左臂" : "右臂" }
}

struct VisionHandPose: Codable {
    var position: [Float]
    var quaternion: [Float]
    init(_ matrix: simd_float4x4) {
        position = [matrix.columns.3.x, matrix.columns.3.y, matrix.columns.3.z]
        // Project sandbox scale must not contaminate wrist orientation.
        let rotation = simd_float3x3(simd_normalize(SIMD3(matrix.columns.0.x, matrix.columns.0.y, matrix.columns.0.z)),
            simd_normalize(SIMD3(matrix.columns.1.x, matrix.columns.1.y, matrix.columns.1.z)),
            simd_normalize(SIMD3(matrix.columns.2.x, matrix.columns.2.y, matrix.columns.2.z)))
        let q = simd_normalize(simd_quatf(rotation)).vector
        quaternion = [q.x, q.y, q.z, q.w]
    }
    init(position: SIMD3<Float>, rotation: simd_quatf) {
        self.position = [position.x, position.y, position.z]
        let q = simd_normalize(rotation).vector; quaternion = [q.x, q.y, q.z, q.w]
    }
    var point: SIMD3<Float> { SIMD3(position) }
    var rotation: simd_quatf { simd_quatf(vector: SIMD4(quaternion)) }
    var valid: Bool {
        position.count == 3 && quaternion.count == 4 && position.allSatisfy(\.isFinite)
            && quaternion.allSatisfy(\.isFinite) && abs(simd_length(SIMD4(quaternion)) - 1) < 0.01
    }
}

struct VisionHandSample {
    var worldFromWrist: simd_float4x4
    var pinchDistance: Float // metres in physical space, unaffected by sandbox scale
    var isFist: Bool
    var timestamp: Double
}

enum VisionHandPhase: String {
    case release, ready, controlling, lost, unreachable, speedLimited, ui
    var title: String {
        switch self {
        case .release: "先松开拇指和食指"
        case .ready: "已停止 · 捏合接管"
        case .controlling: "捏合控制中"
        case .lost: "跟踪中断 · 松开后重新捏合"
        case .unreachable: "目标不可达 · 保持原位"
        case .speedLimited: "移动过快 · 保持原位"
        case .ui: "操作面板中 · 已暂停"
        }
    }
}

/// Pure state/maths: hardware sampling, solving and UI have separate lifetimes.
struct VisionHandClutch {
    static let staleAfter = 0.12
    private(set) var phase: VisionHandPhase = .release
    private(set) var epoch = 0
    private(set) var engaged = false
    private(set) var target: VisionHandPose?
    private var needsRelease = true
    private var pinchSince: Double?
    private var lastSample: VisionHandSample?
    private var filtered: VisionHandPose?
    private var handOrigin: VisionHandPose?
    private var toolOrigin: VisionHandPose?

    mutating func interrupt(_ phase: VisionHandPhase = .release) {
        epoch += 1; engaged = false; needsRelease = true; pinchSince = nil
        filtered = nil; handOrigin = nil; toolOrigin = nil; target = nil; lastSample = nil
        self.phase = phase
    }

    mutating func update(_ sample: VisionHandSample?, projectFromWorld: simd_float4x4,
                         tool: VisionHandPose, now: Double, uiBlocked: Bool = false) {
        if uiBlocked { if phase != .ui { interrupt(.ui) }; return }
        guard let sample, sample.timestamp <= now + 0.01, now - sample.timestamp <= Self.staleAfter,
              sample.pinchDistance.isFinite, sample.pinchDistance >= 0, tool.valid else {
            if phase != .lost { interrupt(.lost) }; return
        }
        let hand = VisionHandPose(projectFromWorld * sample.worldFromWrist)
        guard hand.valid else { interrupt(.lost); return }
        // Release and invalid gestures bypass smoothing. No tail of a filter or
        // delayed solver reply may move an arm after the fingers separate.
        if sample.pinchDistance >= 0.035 {
            if engaged || needsRelease { epoch += 1 }
            engaged = false; needsRelease = false; pinchSince = nil; target = nil
            handOrigin = nil; toolOrigin = nil; filtered = hand; lastSample = sample; phase = .ready
            return
        }
        if sample.isFist { interrupt(.release); return }
        if needsRelease { return }
        if let previous = lastSample, sample.timestamp < previous.timestamp { interrupt(.lost); return }
        if let previous = lastSample, sample.timestamp > previous.timestamp {
            let a = previous.worldFromWrist.columns.3, b = sample.worldFromWrist.columns.3
            let distance = simd_distance(SIMD3(a.x, a.y, a.z), SIMD3(b.x, b.y, b.z))
            let angle = simd_quatf(previous.worldFromWrist).angle(to: simd_quatf(sample.worldFromWrist))
            if distance > 0.18 || angle > .pi / 3 { interrupt(.lost); return }
        }
        if lastSample?.timestamp != sample.timestamp {
            let dt = Float(min(0.1, max(0.001, sample.timestamp - (lastSample?.timestamp ?? sample.timestamp - 0.016))))
            if let old = filtered {
                filtered = VisionHandPose(position: simd_mix(old.point, hand.point, SIMD3(repeating: 1 - exp(-dt / 0.045))),
                    rotation: simd_slerp(old.rotation, hand.rotation, 1 - exp(-dt / 0.065)))
            } else { filtered = hand }
            lastSample = sample
        }
        guard let filtered else { return }
        if !engaged {
            guard sample.pinchDistance <= 0.022 else { pinchSince = nil; return }
            if pinchSince == nil { pinchSince = sample.timestamp }
            // Gives UI spatial events time to claim their pinch before arming.
            guard sample.timestamp - (pinchSince ?? sample.timestamp) >= 0.09 else { return }
            epoch += 1; engaged = true; handOrigin = filtered; toolOrigin = tool; phase = .controlling
        }
        guard let handOrigin, let toolOrigin else { return }
        let next = VisionHandPose(position: toolOrigin.point + filtered.point - handOrigin.point,
            rotation: (filtered.rotation * handOrigin.rotation.inverse) * toolOrigin.rotation)
        if let target, simd_distance(next.point, target.point) < 0.0007,
           next.rotation.angle(to: target.rotation) < 0.006 { return }
        target = next
    }

    func accepts(epoch: Int, now: Double) -> Bool {
        engaged && self.epoch == epoch && lastSample.map { now - $0.timestamp <= Self.staleAfter } == true
    }
    mutating func solved(_ status: String) {
        guard engaged else { return }
        phase = status == "tracking" ? .controlling : status == "speedLimited" ? .speedLimited : .unreachable
    }
}

private extension simd_quatf {
    func angle(to other: simd_quatf) -> Float { 2 * acos(min(1, abs(simd_dot(vector, other.vector)))) }
}
