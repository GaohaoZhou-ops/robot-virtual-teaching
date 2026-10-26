import RealityKit
import UIKit

struct VisionSurfaceTarget: Component {}
struct VisionRecordedTarget: Component { var sampleID: String }

extension VisionTrackingController {
    func buildCameraRig() {
        VisionSurfaceTarget.registerComponent(); VisionRecordedTarget.registerComponent()
        cameraRig.name = "atlas-virtual-camera"
        let body = ModelEntity(mesh: .generateBox(size: SIMD3(0.12, 0.075, 0.055), cornerRadius: 0.012),
            materials: [SimpleMaterial(color: .systemCyan, roughness: 0.35, isMetallic: true)])
        body.position.z = -0.04; cameraRig.addChild(body)
        let lens = ModelEntity(mesh: .generateCylinder(height: 0.035, radius: 0.025),
            materials: [SimpleMaterial(color: .darkGray, roughness: 0.2, isMetallic: true)])
        lens.orientation = simd_quatf(angle: .pi / 2, axis: SIMD3(1, 0, 0))
        lens.position.z = -0.005; cameraRig.addChild(lens)
        cameraRig.addChild(cameraFrustum)
        let x = Float(tan(ZividFieldOfView.horizontalDegrees * .pi / 360))
        let y = Float(tan(ZividFieldOfView.verticalDegrees * .pi / 360))
        let corners: [SIMD3<Float>] = [SIMD3(-x, -y, 1), SIMD3(x, -y, 1), SIMD3(x, y, 1), SIMD3(-x, y, 1)]
        for index in 0..<4 {
            cameraFrustum.addChild(VisionModelRenderer.line(from: corners[index] * 0.3,
                to: corners[index] * 1.3, color: .systemCyan, width: 0.0013))
            for distance: Float in [0.3, 1.3] {
                cameraFrustum.addChild(VisionModelRenderer.line(from: corners[index] * distance,
                    to: corners[(index + 1) % 4] * distance, color: .systemCyan, width: 0.0013))
            }
        }
        objectRoot.addChild(cameraRig); objectRoot.addChild(focusMarker)
        cameraRig.isEnabled = false; focusMarker.isEnabled = false
        cameraRig.components.set(CollisionComponent(shapes: [.generateBox(size: SIMD3(0.17, 0.13, 0.13))], mode: .trigger))
        cameraRig.components.set(InputTargetComponent())
        cameraRig.components.set(HoverEffectComponent())
        var accessibility = AccessibilityComponent()
        accessibility.isAccessibilityElement = true; accessibility.label = "虚拟相机"
        cameraRig.components.set(accessibility)
        refreshManipulation()
    }

    func configurePlacementManipulation(_ model: ModelGeometry) {
        let lower = SIMD3<Float>(model.minimum.x, model.minimum.y, model.minimum.z)
        let upper = SIMD3<Float>(model.maximum.x, model.maximum.y, model.maximum.z)
        objectRoot.components.set(CollisionComponent(shapes: [.generateBox(size: simd_max(upper - lower, SIMD3(repeating: 0.02)))
            .offsetBy(translation: (lower + upper) / 2)], mode: .trigger))
        refreshManipulation()
    }

    func refreshManipulation() {
        let placing = trackingNormal && !placement.isCalibrated && !calibrating && !preparing
        objectRoot.components[InputTargetComponent.self] = placing ? InputTargetComponent() : nil
        if #available(visionOS 26.0, *) {
            func component(rotate: Bool) -> ManipulationComponent {
                var value = ManipulationComponent()
                value.releaseBehavior = .stay
                value.dynamics.scalingBehavior = .none
                value.dynamics.inertia = .zero
                value.dynamics.primaryRotationBehavior = rotate ? .unconstrained : .none
                value.dynamics.secondaryRotationBehavior = rotate ? .unconstrained : .none
                return value
            }
            objectRoot.components[ManipulationComponent.self] = placing ? component(rotate: true) : nil
            modelEntity?.components[ManipulationComponent.HitTarget.self] = placing ? .init(redirectedEntity: objectRoot) : nil
            cameraRig.components[ManipulationComponent.self] = canEditTarget
                ? component(rotate: !keepFocus || cameraTarget?.focus == nil) : nil
        }
    }

    func bindSpatialGestures() {
        sceneSubscriptions.forEach { $0.cancel() }; sceneSubscriptions.removeAll()
        guard let scene = root.scene else { return }
        if #available(visionOS 26.0, *) {
            for entity in [cameraRig, objectRoot] {
                sceneSubscriptions.append(scene.subscribe(to: ManipulationEvents.WillBegin.self, on: entity) { [weak self] event in
                    Task { @MainActor in self?.beginTargetGesture(entity: event.entity) }
                })
                sceneSubscriptions.append(scene.subscribe(to: ManipulationEvents.DidUpdateTransform.self, on: entity) { [weak self] event in
                    Task { @MainActor in self?.updateTargetGesture(entity: event.entity) }
                })
                sceneSubscriptions.append(scene.subscribe(to: ManipulationEvents.WillRelease.self, on: entity) { [weak self] event in
                    if event.wasCancelled { Task { @MainActor in self?.cancelTargetGesture() } }
                })
                sceneSubscriptions.append(scene.subscribe(to: ManipulationEvents.WillEnd.self, on: entity) { [weak self] event in
                    Task { @MainActor in self?.endTargetGesture(entity: event.entity, cancelled: false) }
                })
            }
        }
    }

    func placementConfirmed() {
        refreshManipulation()
        if cameraTarget == nil {
            if readOnly, let first = recordedSamples.first { selectRecordedTarget(first.id) }
            else { placeCameraNearWorkpiece() }
        }
        refreshTarget()
        targetMessage(readOnly ? "选择已记录的相机，查看它的取景" : "捏住蓝色相机移动；点选工件，让相机对准这里")
    }

    func placeCameraNearWorkpiece() {
        guard placement.isCalibrated, !readOnly, !isManipulating, let device = modelDeviceTransform() else { return }
        var optical = device * TeachingCoordinates.opticalToARCamera
        optical.columns.3 += SIMD4(device.columns.0.xyz * 0.55, 0)
        var target = try? VisionCameraTarget(transform: optical)
        if let bounds = modelEntity?.visualBounds(relativeTo: objectRoot) {
            let origin = objectRoot.convert(position: optical.translation, to: nil)
            let center = objectRoot.convert(position: bounds.center, to: nil)
            let hit = root.scene?.raycast(from: origin, to: center).first(where: { $0.entity === modelEntity })
            if let hit {
                let point = objectRoot.convert(position: hit.position, from: nil)
                target = try? target?.aiming(at: point).atDistance(0.7)
            } else {
                target = try? target?.aiming(at: bounds.center).atDistance(0.7)
                // A model centre is a useful initial direction, but isn't a
                // measured surface point. Ask the user to choose a surface.
                target?.focus = nil; target?.focusLocked = false
            }
        }
        targetHistory.push(cameraTarget)
        setCameraTarget(target)
        refreshManipulation()
    }

    func useCurrentView() {
        guard canEditTarget, !isManipulating, let device = modelDeviceTransform(),
              let target = try? VisionCameraTarget(transform: device * TeachingCoordinates.opticalToARCamera) else { return }
        targetHistory.push(cameraTarget)
        setCameraTarget(target)
        refreshManipulation()
        targetMessage("已取当前视角；相机已停留，可以自由转头查看")
    }

    func focusCamera(at point: SIMD3<Float>) {
        guard canEditTarget, !isManipulating, let target = cameraTarget else { return }
        do {
            var next = try target.aiming(at: point)
            if let distance = next.distance, !(0.3...1.3).contains(distance) { next = try next.atDistance(0.7) }
            targetHistory.push(target)
            setCameraTarget(next, selectedID: selectedSampleID); refreshManipulation()
            targetMessage("已锁定拍摄位置；移动相机时会保持对准")
        } catch { targetMessage(error.localizedDescription) }
    }

    func setCameraDistance(_ distance: Float) {
        guard canEditTarget, !isManipulating, let target = cameraTarget, let next = try? target.atDistance(distance) else { return }
        targetHistory.push(target); setCameraTarget(next, selectedID: selectedSampleID)
    }

    func setFocusLock(_ enabled: Bool) {
        guard canEditTarget, !isManipulating, let target = cameraTarget, let point = target.focus else { return }
        var next = enabled ? (try? target.aiming(at: point)) ?? target : target
        next.focusLocked = enabled
        targetHistory.push(target); setCameraTarget(next, selectedID: selectedSampleID)
        refreshManipulation()
    }

    func undoCamera() {
        guard canEditTarget, !isManipulating, let target = targetHistory.pop() else { return }
        setCameraTarget(target, selectedID: selectedSampleID)
        refreshManipulation()
    }

    func selectRecordedTarget(_ id: String) {
        guard placement.isCalibrated, !isManipulating, let sample = recordedSamples.first(where: { $0.id == id }),
              let target = try? VisionCameraTarget(draft: SpatialCameraDraft(cameraPose: sample.cameraPose, surfacePoint: sample.surfacePoint)) else { return }
        targetHistory.clear()
        setCameraTarget(target, selectedID: id); refreshManipulation()
        targetMessage(readOnly ? "正在回看 \(sample.name)" : "正在调整 \(sample.name)，保存后更新这个视点")
    }

    func stepRecordedTarget(_ direction: Int) {
        guard !recordedSamples.isEmpty else { return }
        let current = recordedSamples.firstIndex(where: { $0.id == selectedSampleID }) ?? (direction > 0 ? -1 : recordedSamples.count)
        selectRecordedTarget(recordedSamples[min(max(current + direction, 0), recordedSamples.count - 1)].id)
    }

    func beginTargetGesture(entity: Entity) {
        guard !isManipulating else { return }
        if entity === objectRoot {
            guard !placement.isCalibrated, !calibrating else { return }
            gesturePlacement = placement.transform
        } else {
            guard canEditTarget else { return }
            gestureTarget = cameraTarget
        }
        setGestureActive(true)
    }

    func updateTargetGesture(entity: Entity) {
        guard isManipulating else { return }
        entity.scale = .one
        if entity === objectRoot {
            guard !placement.isCalibrated, !calibrating else { return }
            applyPlacementGesture(entity.transform.matrix)
        } else if let previous = gestureTarget {
            do {
                var target = try VisionCameraTarget(transform: cameraRig.transform.matrix, focus: previous.focus, focusLocked: previous.focusLocked)
                if keepFocus, let focus = target.focus { target = try target.aiming(at: focus) }
                setCameraTarget(target, selectedID: selectedSampleID, commit: false)
            } catch { cameraRig.transform = Transform(matrix: previous.transform) }
        }
    }

    func endTargetGesture(entity: Entity, cancelled: Bool) {
        guard isManipulating else { return }
        if cancelled { cancelTargetGesture(); return }
        updateTargetGesture(entity: entity)
        if entity === cameraRig, let target = cameraTarget {
            targetHistory.push(gestureTarget)
            setCameraTarget(target, selectedID: selectedSampleID)
        }
        gestureTarget = nil; gesturePlacement = nil; setGestureActive(false)
    }

    func cancelTargetGesture() {
        if let target = gestureTarget { setCameraTarget(target, selectedID: selectedSampleID, commit: false) }
        if let matrix = gesturePlacement { applyPlacementGesture(matrix) }
        gestureTarget = nil; gesturePlacement = nil; setGestureActive(false)
    }

    func refreshTarget() {
        guard let target = cameraTarget, placement.isCalibrated else {
            cameraRig.isEnabled = false; focusMarker.isEnabled = false; return
        }
        cameraRig.isEnabled = true; cameraRig.transform = Transform(matrix: target.transform)
        cameraFrustum.isEnabled = showFrustum
        focusMarker.isEnabled = target.focus != nil
        if let focus = target.focus { focusMarker.position = focus }
        previewTask?.cancel(); previewGeneration = UUID()
        let token = previewGeneration, engine = previewEngine, preparation = previewPrepareTask
        previewTask = Task {
            do { try await Task.sleep(for: .milliseconds(120)) } catch { return }
            await preparation?.value
            guard !Task.isCancelled else { return }
            let image = await engine.image(target.transform)
            guard !Task.isCancelled, token == previewGeneration else { return }
            setCameraPreview(image)
        }
    }

    #if targetEnvironment(simulator)
    func moveCameraDemo() {
        guard isDemo, canEditTarget, let target = cameraTarget,
              let next = try? target.moving(to: target.position + SIMD3(0.2, 0, 0), keepFocus: keepFocus) else { return }
        targetHistory.push(target); setCameraTarget(next, selectedID: selectedSampleID)
    }
    #endif
}
