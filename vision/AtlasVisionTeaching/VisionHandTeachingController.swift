import SwiftUI
import RealityKit
import QuartzCore

struct VisionHandTask: Decodable, Identifiable {
    struct Parking: Decodable, Identifiable { let id: String; let name: String }
    let id: String; let name: String; let parkingPoints: [Parking]
}
struct VisionHandStart: Encodable {
    let token: String; let joints: [String: Float]; let baseMatrix: [Float]; let basePose: VisionScenePose
}
struct VisionHandSetup: Decodable { let jointNames: [String: [String]]; let tasks: [VisionHandTask] }
struct VisionHandTarget: Encodable { let position: [Float]; let quaternion: [Float]; let epoch: Int }
struct VisionHandSolve: Encodable {
    let token: String; let joints: [String: Float]; let targets: [String: VisionHandTarget]; let deltaTime: Double
}
struct VisionHandSolution: Decodable { let epoch: Int; let status: String; let joints: [String: Float] }
struct VisionHandRecord: Encodable {
    let token: String; let joints: [String: Float]; let taskId: String?; let parkingId: String?; let name: String
}
struct VisionHandSaved: Decodable { let taskId: String; let parkingId: String; let name: String }

@MainActor final class VisionHandTeachingController: ObservableObject {
    @Published private(set) var enabled = false
    @Published private(set) var starting = false
    @Published private(set) var recording = false
    @Published private(set) var phases: [VisionHandSide: VisionHandPhase] = [:]
    @Published private(set) var message = ""
    @Published private(set) var tasks: [VisionHandTask] = []
    @Published var taskID = ""
    @Published var parkingID = ""
    @Published var poseName = ""
    var active: Bool { enabled || starting || recording }
    private let tracking = VisionHandTracking()
    private var clutches = Dictionary(uniqueKeysWithValues: VisionHandSide.allCases.map { ($0, VisionHandClutch()) })
    private var allowed: [String: Set<String>] = [:]
    private var token = UUID().uuidString
    private var sceneID: String?
    private weak var workbench: VisionWorkbench?
    private weak var scene: VisionSceneController?
    private var operation: Task<Void, Never>?
    private var inFlight = false
    private var lastSent = 0.0
    private var uiBlockedUntil = 0.0
    private var ghosts: [VisionHandSide: ModelEntity] = [:]
    private var lastTargets: [VisionHandSide: VisionHandPose] = [:]
    private var lastEpochs: [VisionHandSide: Int] = [:]

    func start(scene: VisionSceneController, workbench: VisionWorkbench) {
        guard !active else { return }
        guard scene.immersed, scene.lifeSize, !scene.placingProject, !scene.travelling,
              workbench.ready, !workbench.editorVisible, !workbench.sceneIsOutdated,
              let snapshot = scene.handTeachingSnapshot(token: token) else {
            message = "请先更新空间，进入 1:1 模式并关闭工程编辑窗口"; return
        }
        self.scene = scene; self.workbench = workbench; self.sceneID = scene.manifest?.id
        starting = true; message = "正在准备双臂示教…"; scene.lockForHandTeaching(true)
        let currentToken = token
        workbench.invalidateHandTeaching = { [weak self] in self?.stop(message: "工程或窗口已变化，手部控制已停止") }
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                let setup: VisionHandSetup = try await workbench.handTeachingCall("start", payload: snapshot)
                guard self.token == currentToken, !Task.isCancelled else { return }
                for side in VisionHandSide.allCases {
                    guard let names = setup.jointNames[side.rawValue], !names.isEmpty else { throw TeachingError("双臂关节配置不完整") }
                    self.allowed[side.rawValue] = Set(names)
                }
                guard self.allowed["left"]!.isDisjoint(with: self.allowed["right"]!) else { throw TeachingError("双臂共享关节无法冻结") }
                self.tasks = setup.tasks
                if !setup.tasks.contains(where: { $0.id == self.taskID }) { self.taskID = ""; self.parkingID = "" }
                if let task = setup.tasks.first(where: { $0.id == self.taskID }), !task.parkingPoints.contains(where: { $0.id == self.parkingID }) {
                    self.parkingID = ""
                }
                self.tracking.onInterruption = { [weak self] text in self?.interrupt(.lost); self?.message = text }
                try await self.tracking.start()
                guard self.token == currentToken, !Task.isCancelled else { return }
                self.starting = false; self.enabled = true; self.installGhosts(in: scene)
                self.message = "拇指与食指捏合控制同侧末端；松开停止。先松开双手一次。"
                self.interrupt(.release)
            } catch {
                if self.token == currentToken { self.stop(message: error.localizedDescription) }
            }
        }
    }

    func stop(message: String? = nil) {
        token = UUID().uuidString; operation?.cancel(); operation = nil
        tracking.stop(); interrupt(.release); inFlight = false
        enabled = false; starting = false; recording = false
        ghosts.values.forEach { $0.removeFromParent() }; ghosts = [:]; lastTargets = [:]; lastEpochs = [:]; lastSent = 0
        scene?.lockForHandTeaching(false)
        workbench?.invalidateHandTeaching = nil; workbench?.stopHandTeachingBridge()
        if let message { self.message = message }
    }

    func interrupt(_ phase: VisionHandPhase = .release) {
        for side in VisionHandSide.allCases { clutches[side]?.interrupt(phase); ghosts[side]?.isEnabled = false }
        lastTargets = [:]; lastEpochs = [:]; publishPhases()
    }

    func suspendForUI() {
        guard active else { return }
        uiBlockedUntil = CACurrentMediaTime() + 0.25
        interrupt(.ui)
    }

    func update(scene: VisionSceneController, spatialTracking: Bool) {
        guard enabled, !recording else { return }
        guard self.sceneID == scene.manifest?.id, workbench?.ready == true,
              workbench?.editorVisible == false, workbench?.sceneIsOutdated == false, !scene.travelling, !scene.placingProject else {
            stop(message: "空间状态已变化，手部控制已停止"); return
        }
        let now = CACurrentMediaTime(), fromWorld = scene.content.transformMatrix(relativeTo: nil).inverse
        var targets: [String: VisionHandTarget] = [:]
        for side in VisionHandSide.allCases {
            guard let tool = scene.handToolPose(side) else { stop(message: "末端坐标系不可用"); return }
            clutches[side]?.update(spatialTracking ? tracking.samples[side] : nil, projectFromWorld: fromWorld,
                                   tool: tool, now: now, uiBlocked: now < uiBlockedUntil)
            if let clutch = clutches[side], clutch.engaged, let target = clutch.target {
                if lastTargets[side]?.position != target.position || lastTargets[side]?.quaternion != target.quaternion || lastEpochs[side] != clutch.epoch {
                    targets[side.rawValue] = VisionHandTarget(position: target.position, quaternion: target.quaternion, epoch: clutch.epoch)
                }
                updateGhost(side, target: target, phase: clutch.phase)
            } else { ghosts[side]?.isEnabled = false; lastTargets[side] = nil; lastEpochs[side] = nil }
        }
        publishPhases()
        guard !targets.isEmpty, !inFlight, now - lastSent >= 1 / 30, let workbench,
              let snapshot = scene.handTeachingSnapshot(token: token) else { return }
        // One small local RPC in flight, no FIFO of old poses and no LAN hand stream.
        let request = VisionHandSolve(token: token, joints: snapshot.joints, targets: targets, deltaTime: min(0.1, now - lastSent))
        for side in VisionHandSide.allCases where targets[side.rawValue] != nil {
            lastTargets[side] = clutches[side]?.target; lastEpochs[side] = clutches[side]?.epoch
        }
        let currentToken = token; lastSent = now; inFlight = true
        operation = Task { [weak self, weak scene] in
            guard let self, let scene else { return }
            defer { if self.token == currentToken { self.inFlight = false } }
            do {
                let response: [String: VisionHandSolution] = try await workbench.handTeachingCall("solve", payload: request, timeout: 0.5)
                guard self.token == currentToken, !Task.isCancelled, self.enabled, !self.recording else { return }
                guard CACurrentMediaTime() - now <= 0.15 else {
                    self.interrupt(.lost); self.message = "求解延迟过大，已保持原位；请松开后重新捏合"; return
                }
                for side in VisionHandSide.allCases {
                    guard let result = response[side.rawValue], let sent = targets[side.rawValue], result.epoch == sent.epoch,
                          self.clutches[side]?.accepts(epoch: result.epoch, now: CACurrentMediaTime()) == true else { continue }
                    guard let sample = self.tracking.samples[side], sample.pinchDistance < 0.035, !sample.isFist,
                          CACurrentMediaTime() - sample.timestamp <= VisionHandClutch.staleAfter else {
                        self.clutches[side]?.interrupt(.release); continue
                    }
                    if result.status == "tracking" {
                        guard let names = self.allowed[side.rawValue], Set(result.joints.keys) == names,
                              result.joints.values.allSatisfy(\.isFinite) else { throw TeachingError("求解结果关节无效") }
                        scene.applyHandJoints(result.joints)
                    }
                    self.clutches[side]?.solved(result.status)
                }
                self.publishPhases()
            } catch {
                if self.token == currentToken { self.stop(message: "求解已停止：\(error.localizedDescription)") }
            }
        }
    }

    func record() {
        guard enabled, !recording, let scene, let workbench,
              let snapshot = scene.handTeachingSnapshot(token: token) else { return }
        // Freeze BEFORE awaiting the document engine. In-flight motion replies
        // are invalidated, and the exact visible snapshot is the only record.
        suspendForUI(); recording = true
        let request = VisionHandRecord(token: token, joints: snapshot.joints,
            taskId: taskID.isEmpty ? nil : taskID, parkingId: parkingID.isEmpty ? nil : parkingID, name: poseName)
        let currentToken = token
        operation = Task { [weak self] in
            guard let self else { return }
            do {
                let result: VisionHandSaved = try await workbench.handTeachingCall("record", payload: request, timeout: 45)
                guard self.token == currentToken else { return }
                self.taskID = result.taskId; self.parkingID = result.parkingId; self.poseName = ""
                self.stop(message: "已记录 \(result.name)，正在更新空间；继续示教时请重新开启")
                workbench.command("scene")
            } catch {
                if self.token == currentToken { self.stop(message: "记录未完成：\(error.localizedDescription)") }
            }
        }
    }

    private func publishPhases() {
        let next = clutches.mapValues(\.phase)
        if next != phases { phases = next }
    }
    private func installGhosts(in scene: VisionSceneController) {
        for side in VisionHandSide.allCases {
            let marker = ModelEntity(mesh: .generateSphere(radius: 0.012), materials: [UnlitMaterial(color: .systemCyan)])
            // Only a visual target; it cannot receive system pinch gestures.
            for (direction, color) in [(SIMD3<Float>(0.065, 0, 0), UIColor.systemRed),
                                       (SIMD3<Float>(0, 0.065, 0), .systemGreen), (SIMD3<Float>(0, 0, 0.065), .systemBlue)] {
                marker.addChild(VisionModelRenderer.line(from: .zero, to: direction, color: color, width: 0.003))
            }
            marker.isEnabled = false; scene.content.addChild(marker); ghosts[side] = marker
        }
    }
    private func updateGhost(_ side: VisionHandSide, target: VisionHandPose, phase: VisionHandPhase) {
        guard let marker = ghosts[side] else { return }
        marker.isEnabled = true; marker.position = target.point; marker.orientation = target.rotation
        marker.model?.materials = [UnlitMaterial(color: phase == .unreachable || phase == .speedLimited ? .systemRed : .systemCyan)]
    }
}
