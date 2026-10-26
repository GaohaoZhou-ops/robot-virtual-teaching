import SwiftUI

struct VisionTeachingControls: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @Environment(\.dismissImmersiveSpace) private var dismissSpace
    @State private var nearby: NearbyPoseConfirmation?
    let compact: Bool
    private var readOnly: Bool { session.current?.result.completedAt != nil }
    private func id(_ name: String) -> String { compact ? "spatial-" + name : name }
    private var selectedName: String {
        session.current?.result.samples.first(where: { $0.id == spatial.selectedSampleID })?.name ?? "新视点"
    }
    private var targetAccessibilityValue: String {
        #if targetEnvironment(simulator)
        return spatial.cameraTarget.map { $0.transform.elements.map { String(format: "%.4f", $0) }.joined(separator: ",") } ?? ""
        #else
        return ""
        #endif
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Label(spatial.placement.isCalibrated ? selectedName : "摆放工件", systemImage: "camera.viewfinder")
                    .font(.title3.weight(.semibold))
                Spacer()
                Image(systemName: spatial.trackingNormal ? "location.fill" : "location.slash")
                    .foregroundStyle(spatial.trackingNormal ? .green : .orange)
                    .accessibilityLabel(spatial.tracking)
            }
            if !spatial.placement.isCalibrated { placementControls }
            else {
                preview
                if readOnly { Label("已完成 · 空间回看", systemImage: "checkmark.seal").foregroundStyle(.mint) }
                else { editingControls }
                if !spatial.recordedSamples.isEmpty {
                    HStack {
                        Button { spatial.stepRecordedTarget(-1) } label: { Image(systemName: "chevron.left") }
                            .accessibilityLabel("上一个视点").accessibilityIdentifier(id("previous-target"))
                        Text("\(session.current?.result.samples.count ?? 0) 个视点").frame(maxWidth: .infinity).accessibilityIdentifier("pose-count")
                        Button { spatial.stepRecordedTarget(1) } label: { Image(systemName: "chevron.right") }
                            .accessibilityLabel("下一个视点").accessibilityIdentifier(id("next-target"))
                    }
                }
                HStack {
                    Toggle(isOn: $spatial.showFrustum) { Image(systemName: "viewfinder") }
                        .toggleStyle(.button).accessibilityLabel("Zivid 视野")
                        .accessibilityValue(spatial.showFrustum ? "已显示" : "已隐藏")
                        .accessibilityIdentifier(id("zivid-fov"))
                    Spacer()
                    Button("重新摆放", systemImage: "cube.transparent") { spatial.beginAdjustment() }
                        .labelStyle(.iconOnly).disabled(spatial.isManipulating).accessibilityIdentifier(id("adjust-model"))
                }
            }
            if !spatial.message.isEmpty { Text(spatial.message).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            if !session.error.isEmpty { Text(session.error).font(.callout).foregroundStyle(.orange) }
            if !spatial.surfacePickError.isEmpty { Text(spatial.surfacePickError).font(.caption).foregroundStyle(.secondary) }
            #if targetEnvironment(simulator)
            if spatial.isDemo && spatial.placement.isCalibrated {
                HStack {
                    Button("移动观察者") { spatial.moveDemo() }.accessibilityIdentifier(id("move-demo"))
                    Button("演练相机拖动") { spatial.moveCameraDemo() }.accessibilityIdentifier(id("move-camera-demo"))
                }.font(.caption).disabled(readOnly)
            }
            #endif
            if compact {
                Button("返回工作台", systemImage: "rectangle.portrait.and.arrow.right") {
                    session.backgroundSave(); spatial.spaceState = .closing; spatial.stop()
                    Task { await dismissSpace() }
                }.frame(maxWidth: .infinity).accessibilityIdentifier("spatial-exit-space")
            }
        }
        .buttonStyle(.bordered).controlSize(.large).tint(.cyan)
        .disabled(session.busy || spatial.spaceState != .open)
        .alert("这个视点与上一点很接近", isPresented: Binding(get: { nearby != nil }, set: { if !$0 { nearby = nil } })) {
            Button("仍然记录") {
                if let pending = nearby, spatial.canRecord,
                   pending.sample.segmentId == spatial.placement.calibration?.id { _ = session.addSample(pending.sample) }
                nearby = nil
            }
            Button("取消", role: .cancel) { nearby = nil }
        } message: { Text("可以保留这个视点，也可以继续调整蓝色相机。") }
    }

    private var placementControls: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("捏住工件移动，转动手腕调整朝向", systemImage: "hand.draw").font(.callout)
            HStack {
                Button("放到前方") { spatial.placeInFront() }.accessibilityIdentifier(id("place-front"))
                Button("确认摆放") {
                    Task {
                        do {
                            guard readOnly || (session.current?.result.calibrations.count ?? 0) < 1000 else { throw TeachingError("请先完成当前任务") }
                            let calibration = try await spatial.confirm()
                            if !readOnly { session.addCalibration(calibration) }
                        } catch is CancellationError {} catch { session.error = error.localizedDescription }
                    }
                }.buttonStyle(.borderedProminent)
                    .disabled(spatial.placement.transform == nil || !spatial.trackingNormal || spatial.preparing || spatial.calibrating || spatial.isManipulating)
                    .accessibilityIdentifier(id("confirm-placement"))
            }
            if spatial.canCancelAdjustment {
                Button("取消摆放") { spatial.cancelAdjustment() }.accessibilityIdentifier(id("cancel-adjustment"))
            }
        }
    }

    private var preview: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack {
                RoundedRectangle(cornerRadius: 18).fill(.black.opacity(0.45))
                if let image = spatial.cameraImage {
                    Image(uiImage: image).resizable().aspectRatio(contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 18))
                        .accessibilityLabel("虚拟相机取景").accessibilityIdentifier(id("camera-preview"))
                } else { Text(spatial.cameraPreviewError.isEmpty ? "正在生成取景…" : spatial.cameraPreviewError).font(.callout) }
                Image(systemName: "plus").font(.caption).foregroundStyle(.white.opacity(0.6)).accessibilityHidden(true)
            }.frame(width: compact ? 360 : 420, height: compact ? 222 : 259)
            HStack {
                Text("M70 · 模型取景").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Text(spatial.keepFocus && spatial.cameraTarget?.focus != nil ? "持续对准" : "自由摆放")
                    .font(.caption).foregroundStyle(.cyan).accessibilityIdentifier(id("camera-target-state"))
                    .accessibilityValue(targetAccessibilityValue)
            }
        }
    }

    private var editingControls: some View {
        VStack(spacing: 12) {
            HStack {
                Button(spatial.selectedSampleID == nil ? "记录视点" : "更新视点", systemImage: "checkmark") { capture() }
                    .buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
                    .disabled(!spatial.canRecord).accessibilityIdentifier(id("record-pose"))
                Button { spatial.undoCamera() } label: { Image(systemName: "arrow.uturn.backward") }
                    .disabled(!spatial.canUndoTarget || !spatial.canEditTarget || spatial.isManipulating)
                    .accessibilityLabel("撤销相机调整").accessibilityIdentifier(id("undo-camera"))
            }
            HStack {
                Button("新视点", systemImage: "plus") { spatial.placeCameraNearWorkpiece() }
                    .accessibilityIdentifier(id("new-camera"))
                Button("取当前视角", systemImage: "eye") { spatial.useCurrentView() }
                    .accessibilityIdentifier(id("camera-from-view"))
            }.disabled(!spatial.canEditTarget || spatial.isManipulating)
            HStack {
                Toggle("持续对准", isOn: Binding(get: { spatial.keepFocus }, set: { spatial.setFocusLock($0) })).toggleStyle(.button)
                    .disabled(spatial.cameraTarget?.focus == nil).accessibilityIdentifier(id("keep-focus"))
                ForEach(Array(zip(["近景", "标准", "远景"], [Float(0.4), 0.7, 1.0])), id: \.0) { label, distance in
                    Button(label) { spatial.setCameraDistance(distance) }.accessibilityIdentifier(id("distance-\(label)"))
                        .disabled(spatial.cameraTarget?.focus == nil)
                }
            }.disabled(!spatial.canEditTarget || spatial.isManipulating)
        }
    }

    private func capture() {
        do {
            let sample = try spatial.capture()
            if let id = spatial.selectedSampleID {
                if session.replaceSpatialSample(id, with: sample) {
                    spatial.refreshMarkers(session.current?.result.samples ?? [])
                    spatial.targetMessage("视点已更新并保存")
                }
            } else if let confirmation = NearbyPoseConfirmation(sample: sample, previousSample: session.current?.result.samples.last) {
                nearby = confirmation
            } else if session.addSample(sample) { spatial.targetMessage("视点已保存；继续移动相机，记录下一个") }
        } catch { session.error = error.localizedDescription }
    }
}

/// A native utility window stays independently movable and accessible while
/// the workpiece and camera receive spatial manipulation in the immersive scene.
struct VisionSpatialToolsWindow: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @Environment(\.dismissImmersiveSpace) private var dismissSpace
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow

    var body: some View {
        VisionTeachingControls(compact: true).padding(24).frame(width: 440)
            .task {
                // Restoring a utility window after process termination doesn't
                // restore its AR session. Always offer the project library.
                if session.current == nil || spatial.spaceState == .closed {
                    openWindow(id: "workspace", value: "workspace")
                    dismissWindow(id: "spatial-controls")
                }
            }
            .onDisappear {
                if spatial.spaceState == .open {
                    session.backgroundSave(); spatial.spaceState = .closing; spatial.stop()
                    Task { await dismissSpace() }
                }
            }
    }
}
