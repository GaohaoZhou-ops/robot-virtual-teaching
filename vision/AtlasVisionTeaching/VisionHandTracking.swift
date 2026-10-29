import ARKit
import QuartzCore
import simd

@MainActor final class VisionHandTracking {
    private var session: ARKitSession?
    private var tasks: [Task<Void, Never>] = []
    private var generation = UUID()
    private(set) var samples: [VisionHandSide: VisionHandSample] = [:]
    var onInterruption: ((String) -> Void)?

    func start() async throws {
        stop()
        #if targetEnvironment(simulator)
        throw TeachingError("模拟器不提供真实手部跟踪，请在 Vision Pro 真机使用")
        #else
        let token = generation
        guard HandTrackingProvider.isSupported else { throw TeachingError("当前设备不支持手部跟踪；请在 Vision Pro 真机使用") }
        // A dedicated provider/session keeps hand permission and lifecycle
        // independent of the already-running floor/world tracking session.
        let session = ARKitSession(), hands = HandTrackingProvider()
        self.session = session
        let authorization = await session.requestAuthorization(for: [.handTracking])
        guard token == generation, !Task.isCancelled else { throw CancellationError() }
        guard authorization[.handTracking] == .allowed else {
            stop(); throw TeachingError("未允许手部跟踪，请在系统设置中授权后重新开启")
        }
        tasks.append(Task { [weak self] in
            for await event in session.events {
                guard let self, self.generation == token, !Task.isCancelled else { return }
                switch event {
                case .authorizationChanged(let type, let state):
                    if type == .handTracking && state != .allowed {
                        self.samples = [:]; self.onInterruption?("手部跟踪权限已关闭")
                    }
                case .dataProviderStateChanged(_, let state, let error):
                    if state != .running || error != nil {
                        self.samples = [:]; self.onInterruption?("手部跟踪暂不可用，已停止控制")
                    }
                @unknown default: break
                }
            }
        })
        do { try await session.run([hands]) }
        catch {
            // A cancelled older start must not tear down a newer session.
            if token == generation { stop() } else { session.stop() }
            throw error
        }
        guard token == generation, !Task.isCancelled else { session.stop(); throw CancellationError() }
        tasks.append(Task { [weak self] in
            // Cache each side separately: latestAnchors consumes BOTH hands.
            for await update in hands.anchorUpdates {
                guard let self, self.generation == token, !Task.isCancelled else { return }
                let anchor = update.anchor, side: VisionHandSide = anchor.chirality == .left ? .left : .right
                guard update.event != .removed, anchor.isTracked, let skeleton = anchor.handSkeleton else {
                    self.samples[side] = nil; continue
                }
                let thumb = skeleton.joint(.thumbTip), index = skeleton.joint(.indexFingerTip)
                let knuckle = skeleton.joint(.indexFingerKnuckle), wrist = skeleton.joint(.wrist)
                guard thumb.isTracked, index.isTracked, knuckle.isTracked, wrist.isTracked else {
                    self.samples[side] = nil; continue
                }
                func point(_ joint: HandSkeleton.Joint) -> SIMD3<Float> {
                    let p = joint.anchorFromJointTransform.columns.3; return SIMD3(p.x, p.y, p.z)
                }
                let tip = point(index), palm = point(wrist), base = point(knuckle)
                // A compact fist folds the index tip back inside its knuckle.
                // Other fingers need not be extended for a natural precision pinch.
                let fist = simd_distance(tip, palm) < simd_distance(base, palm) * 0.85
                self.samples[side] = VisionHandSample(worldFromWrist: anchor.originFromAnchorTransform * wrist.anchorFromJointTransform,
                    pinchDistance: simd_distance(point(thumb), tip), isFist: fist, timestamp: update.timestamp)
            }
        })
        #endif
    }

    func stop() {
        generation = UUID(); tasks.forEach { $0.cancel() }; tasks = []
        session?.stop(); session = nil; samples = [:]
    }
}
