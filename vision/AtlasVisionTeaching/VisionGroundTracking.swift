import ARKit
import QuartzCore
import RealityKit
import UIKit

struct VisionFloorSelection: Component { let id: UUID }

@MainActor final class VisionGroundTracking {
    let surfacesRoot = Entity()
    var onPlacement: ((simd_float4x4) -> Void)?
    var onAnchorMotion: ((simd_float4x4) -> Void)?
    var onScanning: ((Bool) -> Void)?
    var onMessage: ((String) -> Void)?
    private(set) var placementTransform: simd_float4x4?
    private(set) var floorHeight: Float = 0
    var confirmedPlacement: simd_float4x4? { committing ? nil : placementTransform }
    private(set) var scanning = false
    private var session: ARKitSession?
    private var world: WorldTrackingProvider?
    private var tasks: [Task<Void, Never>] = []
    private var shutdown: Task<Void, Never>?
    private var generation = UUID()
    private var placementTask: Task<Void, Never>?
    private var anchorID: UUID?
    private var surfaces: [UUID: VisionFloorSurface] = [:]
    private var visuals: [UUID: ModelEntity] = [:]
    private var decision = VisionFloorPlacementDecision()
    private var committing = false, floorAvailable = false
    private var pulseTime = 0.0, sampleTime = 0.0
    private var lastMessage = ""
    private var sensedObstacle: VisionObstacleSample = .unavailable
    private var obstacleSampleTime = 0.0
    private var worldSensingAllowed = false
    private(set) var obstacleStatus = "正在识别周围环境，暂时保留透视"
    var obstacleSample: VisionObstacleSample {
        #if targetEnvironment(simulator)
        return .clear // Real room reconstruction is unavailable in Simulator.
        #else
        guard worldSensingAllowed, device() != nil, CACurrentMediaTime() - obstacleSampleTime < 0.5 else { return .unavailable }
        return sensedObstacle
        #endif
    }

    init() { VisionFloorSelection.registerComponent() }

    func start(detectFloor: Bool) async {
        stop(); let token = generation
        await shutdown?.value
        guard token == generation, !Task.isCancelled else { return }
        if detectFloor { beginPlacement() }
        #if targetEnvironment(simulator)
        floorAvailable = true
        if detectFloor {
            let id = UUID(), vertices: [SIMD3<Float>] = [SIMD3(-4, 0, -4), SIMD3(4, 0, -4), SIMD3(4, 0, 4), SIMD3(-4, 0, 4)]
            let floor = VisionFloorSurface(id: id, isFloor: true, transform: matrix_identity_float4x4,
                                         vertices: vertices, indices: [0, 2, 1, 0, 3, 2])
            await install(floor, token: token)
        }
        #else
        guard WorldTrackingProvider.isSupported else {
            obstacleStatus = "空间定位不可用，已保留真实环境"
            message("当前设备不支持空间定位，可先查看沙盘"); return
        }
        let session = ARKitSession(), world = WorldTrackingProvider()
        let obstacleMeshes = VisionObstacleMeshStore()
        self.session = session; self.world = world
        tasks.append(Task { [weak self] in
            for await event in session.events {
                guard let self, self.generation == token, !Task.isCancelled else { return }
                switch event {
                case .authorizationChanged(let type, let status):
                    if type == .worldSensing && status == .denied {
                        self.worldSensingAllowed = false; self.sensedObstacle = .unavailable
                        self.obstacleStatus = "未允许空间感知，已保留真实环境"
                        self.floorAvailable = false; self.clearSurfaces()
                        self.message("请在系统设置中允许空间感知后重新进入；可先查看沙盘")
                    }
                case .dataProviderStateChanged(let providers, let state, let error):
                    if providers.contains(where: { $0 is SceneReconstructionProvider }), state != .running || error != nil {
                        self.sensedObstacle = .unavailable
                        self.obstacleStatus = "环境感知暂不可用，已保留真实环境"
                    }
                    if providers.contains(where: { $0 is PlaneDetectionProvider }) {
                        self.floorAvailable = state == .running && error == nil
                        if !self.floorAvailable { self.clearSurfaces() }
                    }
                    if providers.contains(where: { $0 is WorldTrackingProvider }), state == .paused || state == .stopped {
                        self.message("空间定位暂不可用，等待恢复；工程位置已保留")
                    } else if error != nil { self.message("环境识别暂不可用，可先查看沙盘后重新识别") }
                @unknown default: break
                }
            }
        })
        do {
            var providers: [any DataProvider] = [world]
            var planes: PlaneDetectionProvider?
            var reconstruction: SceneReconstructionProvider?
            if detectFloor {
                let authorization = await session.requestAuthorization(for: [.worldSensing])
                guard token == generation, !Task.isCancelled else { return }
                if authorization[.worldSensing] == .allowed {
                    worldSensingAllowed = true
                    if PlaneDetectionProvider.isSupported {
                        let provider = PlaneDetectionProvider(alignments: [.horizontal])
                        providers.append(provider); planes = provider; floorAvailable = true
                    } else { message("当前环境不支持地面识别，可先查看沙盘") }
                    if SceneReconstructionProvider.isSupported {
                        let provider = SceneReconstructionProvider(modes: [.classification])
                        providers.append(provider); reconstruction = provider
                    } else { obstacleStatus = "当前设备不支持障碍物感知，已保留真实环境" }
                } else {
                    obstacleStatus = "未允许空间感知，已保留真实环境"
                    message("请在系统设置中允许空间感知后重新进入；可先查看沙盘")
                }
            }
            try await session.run(providers)
            guard token == generation, !Task.isCancelled else { session.stop(); return }
            tasks.append(Task { [weak self] in
                for await update in world.anchorUpdates {
                    guard let self, self.generation == token, !Task.isCancelled else { return }
                    guard update.anchor.id == self.anchorID else { continue }
                    if update.event == .removed {
                        self.anchorID = nil; self.placementTransform = nil
                        self.message("地面定位已失效，请在空间选项中重新对齐地面")
                    } else if update.anchor.isTracked {
                        let matrix = update.anchor.originFromAnchorTransform
                        if let old = self.placementTransform, !self.committing { self.onAnchorMotion?(matrix * old.inverse) }
                        self.placementTransform = matrix
                        self.floorHeight = matrix.translation.y
                    }
                }
            })
            if let planes {
                tasks.append(Task { [weak self] in
                    for await update in planes.anchorUpdates {
                        guard let self, self.generation == token, !Task.isCancelled else { return }
                        if update.event == .removed || !self.isFloor(update.anchor) || update.anchor.alignment != .horizontal {
                            self.removeSurface(update.anchor.id)
                        } else { await self.install(update.anchor, token: token) }
                    }
                })
            }
            if let reconstruction {
                tasks.append(Task { [weak self] in
                    for await update in reconstruction.anchorUpdates {
                        guard let self, self.generation == token, !Task.isCancelled else { return }
                        if update.event == .removed { await obstacleMeshes.remove(update.anchor.id) }
                        else { await obstacleMeshes.replace(update.anchor) }
                    }
                })
                tasks.append(Task { [weak self] in
                    while !Task.isCancelled {
                        guard let self, self.generation == token else { return }
                        let sampledAt = CACurrentMediaTime()
                        if self.worldSensingAllowed, reconstruction.state == .running, let head = self.device() {
                            let sample = await obstacleMeshes.sample(head: head, floor: self.floorHeight)
                            guard self.generation == token, !Task.isCancelled else { return }
                            self.sensedObstacle = self.worldSensingAllowed && reconstruction.state == .running && self.device() != nil ? sample : .unavailable
                            self.obstacleSampleTime = sampledAt
                            self.obstacleStatus = sample == .unavailable ? "周围环境尚未识别完整，暂时保留透视" : ""
                        } else {
                            self.sensedObstacle = .unavailable
                            self.obstacleStatus = self.worldSensingAllowed ? "环境定位暂不可用，已保留真实环境" : "未允许空间感知，已保留真实环境"
                        }
                        do { try await Task.sleep(for: .milliseconds(80)) } catch { return }
                    }
                })
            }
        } catch {
            guard token == generation else { return }
            sensedObstacle = .unavailable; obstacleStatus = "环境感知启动失败，已保留真实环境"
            message("空间定位启动失败，请退出后重试；可先查看沙盘")
        }
        #endif
    }

    func stop() {
        generation = UUID(); tasks.forEach { $0.cancel() }; tasks.removeAll()
        placementTask?.cancel(); placementTask = nil
        let oldSession = session, oldWorld = world, oldID = anchorID, pending = shutdown
        session = nil; world = nil; anchorID = nil; placementTransform = nil; floorHeight = 0
        shutdown = Task {
            await pending?.value
            if let oldWorld, let oldID { try? await oldWorld.removeAnchor(forID: oldID) }
            oldSession?.stop()
        }
        scanning = false; committing = false; floorAvailable = false
        sensedObstacle = .unavailable; obstacleSampleTime = 0; worldSensingAllowed = false
        obstacleStatus = "正在识别周围环境，暂时保留透视"
        clearSurfaces(); decision = VisionFloorPlacementDecision(); lastMessage = ""
    }

    func device() -> simd_float4x4? {
        #if targetEnvironment(simulator)
        var head = matrix_identity_float4x4; head.columns.3 = SIMD4(0, 1.6, 0, 1); return head
        #else
        guard world?.state == .running,
              let anchor = world?.queryDeviceAnchor(atTimestamp: CACurrentMediaTime()), anchor.isTracked,
              VisionPoseMath.isRigid(anchor.originFromAnchorTransform) else { return nil }
        return anchor.originFromAnchorTransform
        #endif
    }

    func beginPlacement() {
        placementTask?.cancel()
        decision = VisionFloorPlacementDecision(); pulseTime = 0; sampleTime = 0
        scanning = true; surfacesRoot.isEnabled = true; onScanning?(true)
        message("正在识别脚下地面；请环顾地面，桌面和座面不会作为落点")
    }
    func cancelPlacement() {
        placementTask?.cancel()
        scanning = false; surfacesRoot.isEnabled = false; onScanning?(false)
    }

    func update(delta: Double) {
        guard scanning, !committing, floorAvailable else { return }
        pulseTime += min(delta, 0.1); sampleTime += min(delta, 0.1)
        guard sampleTime >= 0.08 else { return }
        let elapsed = sampleTime; sampleTime = 0
        guard let head = device() else { message("等待头显空间定位…"); return }
        let candidates = surfaces.values.filter { $0.ground(below: head.translation) != nil }
        let ids = Set(candidates.map(\.id)), strength = Float(0.55 + 0.35 * sin(pulseTime * .pi))
        for (id, entity) in visuals {
            entity.isEnabled = ids.contains(id)
            // The system applies this effect to the gazed-at plane without
            // exposing eye-gaze data to the app. Selection requires a pinch.
            entity.components.set(HoverEffectComponent(.highlight(.init(color: .systemGreen, strength: strength))))
        }
        if let id = decision.update(candidates, head: head.translation, delta: elapsed) { select(id); return }
        if candidates.count > 1 || decision.requiresConfirmation {
            message(candidates.isEmpty ? "候选地面暂时丢失，正在重新识别…"
                : "发现多个候选地面 · 注视绿色区域并捏合确认，原点将放在脚下")
        } else if candidates.count == 1 {
            message(candidates[0].containsFoot(of: head.translation) ? "已识别脚下地面，正在稳定定位…"
                : "注视绿色地面并捏合确认；以当前位置作为地图原点")
        } else { message("正在识别地面；请环顾地面，桌面和座面不会作为落点") }
    }

    func select(_ id: UUID) {
        guard scanning, !committing, let floor = surfaces[id], visuals[id]?.isEnabled == true,
              let head = device(), let transform = floor.placement(head: head) else { return }
        committing = true; let token = generation, provider = world
        message("正在固定地面原点…")
        placementTask = Task { [weak self] in
            guard let self else { return }
            defer { if token == self.generation { self.committing = false } }
            let oldID = self.anchorID, oldTransform = self.placementTransform, oldHeight = self.floorHeight
            var newID: UUID?
            do {
                #if !targetEnvironment(simulator)
                guard let world = provider else { return }
                let anchor = WorldAnchor(originFromAnchorTransform: transform); newID = anchor.id
                self.anchorID = anchor.id; self.placementTransform = transform
                try await world.addAnchor(anchor)
                #else
                self.placementTransform = transform
                #endif
                guard self.generation == token, self.scanning, !Task.isCancelled else { throw CancellationError() }
                self.floorHeight = (self.placementTransform ?? transform).translation.y
                self.onPlacement?(self.placementTransform ?? transform)
                self.scanning = false; self.surfacesRoot.isEnabled = false; self.onScanning?(false)
                #if targetEnvironment(simulator)
                self.message("")
                #else
                self.message("已对齐地面 · 地图原点位于脚下，比例 1:1")
                #endif
                if let oldID { try? await provider?.removeAnchor(forID: oldID) }
            } catch {
                if let newID { try? await provider?.removeAnchor(forID: newID) }
                if token == self.generation {
                    self.anchorID = oldID; self.placementTransform = oldTransform; self.floorHeight = oldHeight
                    if !Task.isCancelled { self.message("地面锚定未完成，请注视绿色地面并捏合重试") }
                }
            }
        }
    }

    private func message(_ value: String) {
        guard lastMessage != value else { return }; lastMessage = value; onMessage?(value)
    }
    private func removeSurface(_ id: UUID) {
        surfaces.removeValue(forKey: id); visuals.removeValue(forKey: id)?.removeFromParent()
    }
    private func clearSurfaces() {
        surfaces.removeAll(); visuals.values.forEach { $0.removeFromParent() }; visuals.removeAll()
    }
    private func isFloor(_ anchor: PlaneAnchor) -> Bool {
        if #available(visionOS 26.0, *) { return anchor.surfaceClassification == .floor }
        return anchor.classification == .floor
    }
    private func install(_ anchor: PlaneAnchor, token: UUID) async {
        let source = anchor.geometry.meshVertices, faces = anchor.geometry.meshFaces
        guard source.format == .float3, faces.primitive == .triangle, [2, 4].contains(faces.bytesPerIndex) else { return }
        let vertices = (0..<source.count).map { index -> SIMD3<Float> in
            let p = source.buffer.contents().advanced(by: source.offset + index * source.stride)
            let vertex = SIMD3(p.loadUnaligned(as: Float.self), p.advanced(by: 4).loadUnaligned(as: Float.self), p.advanced(by: 8).loadUnaligned(as: Float.self))
            return (anchor.originFromAnchorTransform * SIMD4(vertex, 1)).xyz
        }
        let indices: [UInt32] = (0..<(faces.count * 3)).map { index in
            let p = faces.buffer.contents().advanced(by: index * faces.bytesPerIndex)
            return faces.bytesPerIndex == 2 ? UInt32(p.loadUnaligned(as: UInt16.self)) : p.loadUnaligned(as: UInt32.self)
        }
        await install(VisionFloorSurface(id: anchor.id, isFloor: isFloor(anchor),
            transform: anchor.originFromAnchorTransform, vertices: vertices, indices: indices), token: token)
    }
    private func install(_ surface: VisionFloorSurface, token: UUID) async {
        guard surface.valid else { removeSurface(surface.id); return }
        // Store new candidate data before mesh generation so ambiguity is never
        // hidden while the second plane's input/collision shape is being built.
        surfaces[surface.id] = surface
        do {
            var descriptor = MeshDescriptor(name: "Detected floor")
            descriptor.positions = MeshBuffers.Positions(surface.vertices)
            descriptor.primitives = .triangles(surface.indices)
            let mesh = try await MeshResource(from: [descriptor])
            let shape = try await ShapeResource.generateStaticMesh(from: mesh)
            guard generation == token, !Task.isCancelled else { return }
            var material = UnlitMaterial(color: .systemGreen)
            material.blending = .transparent(opacity: .init(floatLiteral: 0.10)); material.faceCulling = .none
            // Keep the input target's identity while ARKit refines its mesh;
            // replacing it would interrupt gaze highlighting and active pinches.
            let entity = visuals[surface.id] ?? ModelEntity()
            entity.model = ModelComponent(mesh: mesh, materials: [material])
            entity.components.set(CollisionComponent(shapes: [shape], mode: .trigger))
            if visuals[surface.id] == nil {
                entity.name = "可选地面"
                entity.components.set(VisionFloorSelection(id: surface.id))
                entity.components.set(InputTargetComponent())
                entity.components.set(HoverEffectComponent(.highlight(.init(color: .systemGreen, strength: 0.8))))
                visuals[surface.id] = entity; surfacesRoot.addChild(entity)
            }
        } catch {
            if generation == token, !Task.isCancelled { removeSurface(surface.id); message("地面预览暂不可用，正在重新识别…") }
        }
    }
}
