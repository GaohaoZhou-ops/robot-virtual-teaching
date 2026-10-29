import SwiftUI
import RealityKit

enum VisionPanelMetrics {
    static let gap: CGFloat = 28
}

private struct VisionPanelTarget: ViewModifier {
    let minimumWidth: CGFloat
    let expands: Bool
    @ScaledMetric(relativeTo: .body) private var labelHeight = 72.0
    func body(content: Content) -> some View {
        content.frame(minWidth: minimumWidth, maxWidth: expands ? .infinity : nil, minHeight: labelHeight)
            .contentShape(Rectangle())
    }
}

extension View {
    // Size the label inside the system control so its visible surface, gaze
    // highlight and hit target grow together. Keep system hover feedback.
    func visionPanelTarget(minWidth: CGFloat = 0, expands: Bool = true) -> some View {
        modifier(VisionPanelTarget(minimumWidth: minWidth, expands: expands))
    }
}

// The project itself occupies the immersive space. The optional document
// editor lives in a separate window; no web canvas is used as the scene.
struct VisionProjectImmersiveView: View {
    @EnvironmentObject private var review: VisionSceneController
    @EnvironmentObject private var workbench: VisionWorkbench
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.scenePhase) private var phase
    var body: some View {
        RealityView { content, attachments in
            content.add(review.root)
            if let button = attachments.entity(for: "recall-tools") {
                #if targetEnvironment(simulator)
                // Simulator has no tracked hands. Place the same control where
                // a raised left wrist would be, for interaction checks.
                let wrist = AnchorEntity(.head, trackingMode: .continuous)
                button.position = SIMD3(-0.30, -0.25, -0.70)
                #else
                let wrist = AnchorEntity(.hand(.left, location: .wrist), trackingMode: .continuous)
                button.position = SIMD3(0, 0.08, 0)
                button.components.set(BillboardComponent())
                #endif
                button.scale = SIMD3(repeating: 0.7)
                // The simulator head anchor already faces the camera. Keep its
                // hit plane stable instead of applying a second billboard turn.
                VisionRecallControl.configure(button)
                wrist.addChild(button); content.add(wrist)
            }
            await review.begin(in: content)
        } update: { _, attachments in
            if let button = attachments.entity(for: "recall-tools") {
                VisionRecallControl.configure(button)
            }
        } attachments: {
            Attachment(id: "recall-tools") {
                VStack(spacing: 6) {
                    Button(action: recallTools) {
                        Label(workbench.toolsPresentation.pending == nil ? "唤回控制" : "正在唤回…", systemImage: "viewfinder")
                            .font(.system(size: 22, weight: .semibold)).lineLimit(1)
                            .frame(width: 176, height: 58)
                    }
                    .buttonStyle(.borderedProminent).tint(.cyan)
                    .disabled(!workbench.projectImmersed || workbench.openingScene || workbench.replacingScene
                              || workbench.toolsPresentation.pending != nil)
                    .accessibilityLabel("将沉浸游走控制窗口唤回面前")
                    .accessibilityIdentifier("project-recall-tools")
                    #if targetEnvironment(simulator)
                    Text("模拟左手腕").font(.caption).foregroundStyle(.secondary)
                    #endif
                }.padding(8).glassBackgroundEffect(in: RoundedRectangle(cornerRadius: 24))
                    .simultaneousGesture(SpatialEventGesture().onChanged { events in
                        if events.contains(where: { $0.phase == .active && $0.kind != .pointer }) { review.handTeaching.suspendForUI() }
                    })
            }
        }
        // Use one nearest-hit gesture for spatial controls and map selection,
        // while allowing the attachment's SwiftUI Button to handle its own tap.
        .simultaneousGesture(SpatialTapGesture().targetedToEntity(where:
            .has(VisionRecallTarget.self) || .has(VisionSceneSelection.self) || .has(VisionFloorSelection.self)
        ).onEnded { value in
            if value.entity.components.has(VisionRecallTarget.self) {
                recallTools()
            } else if let item = value.entity.components[VisionSceneSelection.self] {
                review.select(item, point: value.convert(value.location3D, from: .local, to: review.content))
            } else if let floor = value.entity.components[VisionFloorSelection.self] {
                review.selectFloor(floor.id)
            }
        })
        .onChange(of: phase) { _, value in
            if value != .active {
                if value == .background || review.handTeaching.enabled {
                    review.handTeaching.stop(message: "应用已离开前台，手部控制已停止")
                } else { review.handTeaching.interrupt(.release) }
                if review.playing { review.togglePlayback() }
            }
        }
        .task(id: workbench.toolsPresentation.pending?.replacement) {
            guard let id = workbench.toolsPresentation.pending?.replacement else { return }
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            guard let request = workbench.toolsPresentation.cancelRecall(id) else { return }
            dismissWindow(id: "project-tools", value: id)
            if workbench.projectImmersed, !workbench.isHome {
                if let previous = request.previous { openWindow(id: "project-tools", value: previous) }
                workbench.error = "控制窗口暂未唤回，请再次点击左手腕旁的按钮"
            }
        }
        .onAppear { workbench.projectSpaceVisible = true }
        .onDisappear {
            review.stop(); workbench.projectSpaceVisible = false
            if !workbench.replacingScene {
                workbench.toolsPresentation.end()
                dismissWindow(id: "project-cameras")
                workbench.projectImmersed = false; workbench.editorVisible = false
                workbench.sceneStatus = "空间已关闭，可重新进入"
                openWindow(id: "workspace", value: "workspace"); dismissWindow(id: "project-tools")
            }
        }
    }

    private func recallTools() {
        review.handTeaching.suspendForUI()
        guard workbench.projectImmersed, !workbench.isHome, !workbench.openingScene, !workbench.replacingScene,
              let id = workbench.toolsPresentation.recall(now: ProcessInfo.processInfo.systemUptime) else { return }
        // A fresh value creates a fresh window at utilityPanel's user-relative
        // placement. Re-opening the old value would retain its distant position.
        openWindow(id: "project-tools", value: id)
    }
}

struct VisionProjectToolsView: View {
    static let defaultSize = CGSize(width: 1120, height: 500)
    let windowID: String
    @EnvironmentObject private var review: VisionSceneController
    @EnvironmentObject private var workbench: VisionWorkbench
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.dismissImmersiveSpace) private var dismissSpace
    @ScaledMetric(relativeTo: .title) private var headingSize = 32.0
    @ScaledMetric(relativeTo: .body) private var actionSize = 30.0
    @ScaledMetric(relativeTo: .callout) private var detailSize = 26.0
    @ScaledMetric(relativeTo: .caption) private var captionSize = 20.0
    private var toolsActive: Bool { workbench.projectImmersed || workbench.replacingScene }
    var body: some View {
        VStack(alignment: .leading, spacing: VisionPanelMetrics.gap) {
            HStack(spacing: VisionPanelMetrics.gap) {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 14) {
                        viewState
                        if review.lifeSize {
                            Text("1:1").font(.system(size: detailSize, weight: .semibold, design: .monospaced))
                                .foregroundStyle(.mint).padding(.horizontal, 14).padding(.vertical, 6)
                                .background(.mint.opacity(0.12), in: Capsule())
                                .accessibilityLabel("真实比例，一比一")
                        }
                    }
                    Menu {
                        ForEach(Array((review.manifest?.clips ?? []).enumerated()), id: \.element.id) { index, clip in
                            Button(clip.taskName) { review.chooseClip(index) }
                        }
                    } label: {
                        Label(review.clip?.taskName ?? review.manifest?.name ?? "沉浸式工程", systemImage: "cube.transparent")
                            .lineLimit(1).truncationMode(.middle)
                            .visionPanelTarget()
                    }
                    .font(.system(size: detailSize)).disabled(!review.hasClips || review.handTeaching.active)
                }.frame(maxWidth: .infinity, alignment: .leading)
                VisionHandTeachingToggle(teaching: review.handTeaching)
                Menu {
                    Section("工程") {
                        Button("更新空间", systemImage: "arrow.clockwise") { workbench.command("scene") }
                            .disabled(!workbench.sceneReady || workbench.buildingScene || workbench.openingScene)
                            .accessibilityIdentifier("project-refresh")
                        Button("保存工程", systemImage: "square.and.arrow.down") { workbench.command("save") }
                            .disabled(!workbench.ready).accessibilityIdentifier("project-save")
                        Button("返回工程入口", systemImage: "rectangle.portrait.and.arrow.right") { workbench.command("home") }
                            .accessibilityIdentifier("project-home")
                    }
                    .disabled(review.handTeaching.active)
                    Section("游走") {
                        Button("重新对齐地面", systemImage: "viewfinder.circle") { review.alignProjectToFloor() }
                            .disabled(review.placingProject || review.travelling).accessibilityIdentifier("project-align-floor")
                        Button("回到机器人旁", systemImage: "viewfinder") { review.returnToRobot() }
                            .disabled(review.placingProject).accessibilityIdentifier("project-robot")
                        Menu("前往示教点", systemImage: "mappin.and.ellipse") {
                            ForEach((review.manifest?.markers ?? []).filter { $0.kind == "parking" }, id: \.id) { marker in
                                Button(marker.name) { review.visit(marker) }.accessibilityIdentifier("project-visit-\(marker.id)")
                            }
                        }
                        .disabled(review.placingProject)
                        Button("向左转身", systemImage: "arrow.turn.up.left") { review.turn(-.pi / 6) }.disabled(!review.lifeSize)
                        Button("向右转身", systemImage: "arrow.turn.up.right") { review.turn(.pi / 6) }.disabled(!review.lifeSize)
                        Toggle("测量两点间距", isOn: Binding(get: { review.measuring }, set: { review.setMeasurement($0) }))
                            .disabled(review.placingProject)
                    }
                    .disabled(review.handTeaching.active)
                    Section("显示") {
                        Toggle("地面网格（\(Int(review.floorGridSpacing)) 米/格）", isOn: $review.floorGridVisible)
                            .accessibilityIdentifier("project-floor-grid")
                    }
                    #if targetEnvironment(simulator)
                    Menu("模拟器演练") {
                        Picker("障碍物渐显", selection: $review.simulatedObstacleDistance) {
                            Text("无附近障碍物").tag(Float(3))
                            Text("距离 2 米").tag(Float(2))
                            Text("距离 1.75 米").tag(Float(1.75))
                            Text("距离 1.5 米").tag(Float(1.5))
                            Text("距离 1.25 米").tag(Float(1.25))
                            Text("距离 1 米").tag(Float(1))
                            Text("感知中断").tag(Float(-1))
                        }
                    }
                    #endif
                } label: {
                    Label("空间选项", systemImage: "ellipsis")
                        .visionPanelTarget(minWidth: 180, expands: false)
                }
                    .accessibilityLabel("空间选项").accessibilityIdentifier("project-options")
            }.disabled(workbench.openingScene || review.busy)
            if !review.handTeaching.active {
                projectActions.disabled(workbench.openingScene || review.busy)
            }
            if review.handTeaching.active || !review.handTeaching.message.isEmpty {
                VisionHandTeachingView(teaching: review.handTeaching)
            }
            if review.clip != nil {
                Slider(value: Binding(get: { review.progress }, set: { review.scrub($0) }), in: 0...1)
                    .disabled(review.placingProject || review.handTeaching.active)
                    .accessibilityLabel("回放进度").accessibilityIdentifier("project-timeline")
            }
            if review.destination != nil {
                HStack(spacing: VisionPanelMetrics.gap) {
                    Label("落点已选好", systemImage: "mappin.circle.fill").foregroundStyle(.mint)
                    Spacer()
                    Button { review.clearDestination() } label: {
                        Text("取消").visionPanelTarget(minWidth: 140, expands: false)
                    }
                    Button { review.travel() } label: {
                        Label("前往此处", systemImage: "figure.walk").visionPanelTarget(minWidth: 180, expands: false)
                    }.tint(.mint).accessibilityIdentifier("project-travel")
                }.disabled(review.travelling)
            } else if review.travelling { ProgressView("正在前往…") }
            else if let marker = review.arrivedParkingPoint, !review.measuring {
                Label("已到达停车点：\(marker.name)", systemImage: "checkmark.circle.fill")
                    .font(.system(size: detailSize, weight: .semibold)).foregroundStyle(.green)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("project-parking-arrival")
            }
            else if review.measuring || !review.navigationMessage.isEmpty {
                Text(review.measuring ? "点选两处几何，查看真实间距" : review.navigationMessage)
                    .font(.system(size: detailSize)).foregroundStyle(review.placingProject ? Color.green : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("project-placement-status")
            }
            if !review.selection.isEmpty {
                HStack(spacing: VisionPanelMetrics.gap) {
                    Text(review.selection).lineLimit(1)
                    if let distance = review.measurement { Text(distance < 1 ? String(format: "约 %.1f cm", distance * 100) : String(format: "约 %.2f m", distance)).foregroundStyle(.yellow) }
                    Spacer()
                    Button { review.clearSelection() } label: {
                        Label("清除标记", systemImage: "xmark.circle").visionPanelTarget(minWidth: 180, expands: false)
                    }.accessibilityLabel("清除检查标记")
                }.font(.system(size: detailSize))
            }
            if !review.proximityMessage.isEmpty {
                Label(review.proximityMessage, systemImage: "eye")
                    .font(.system(size: captionSize)).foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("project-obstacle-status")
            }
            if workbench.buildingScene || workbench.openingScene {
                ProgressView(workbench.openingScene ? review.status : workbench.sceneStatus).font(.system(size: captionSize))
            } else if workbench.sceneIsOutdated {
                HStack(spacing: VisionPanelMetrics.gap) {
                    Text("工程有更新").foregroundStyle(.secondary)
                    Button { workbench.command("scene") } label: {
                        Label("更新空间", systemImage: "arrow.clockwise").visionPanelTarget(minWidth: 180, expands: false)
                    }
                }.font(.system(size: detailSize))
            }
            if let exported = workbench.exportedFile {
                ShareLink(item: exported) {
                    Label("导出文件", systemImage: "square.and.arrow.up").visionPanelTarget(minWidth: 180, expands: false)
                }.accessibilityIdentifier("project-exported")
            }
            if !workbench.error.isEmpty || !review.error.isEmpty {
                Text(workbench.error.isEmpty ? review.error : workbench.error).font(.system(size: captionSize)).foregroundStyle(.orange)
            }
            Label("找不到窗口时，抬起左手点击「唤回控制」", systemImage: "hand.raised")
                .font(.system(size: captionSize)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }.padding(36).frame(width: Self.defaultSize.width)
        .simultaneousGesture(SpatialEventGesture().onChanged { events in
            if events.contains(where: { $0.phase == .active && $0.kind != .pointer }) { review.handTeaching.suspendForUI() }
        })
        .frame(minHeight: Self.defaultSize.height, alignment: .topLeading)
        .font(.system(size: actionSize)).buttonStyle(.bordered).controlSize(.large)
        .opacity(toolsActive && workbench.toolsPresentation.current == windowID ? 1 : 0)
        .allowsHitTesting(toolsActive && workbench.toolsPresentation.current == windowID)
        .accessibilityHidden(!toolsActive || workbench.toolsPresentation.current != windowID)
        .background {
            if workbench.toolsPresentation.current == windowID { VisionWorkbenchEngine() }
        }
        .modifier(VisionProjectSceneCoordinator())
        .onAppear {
            guard workbench.toolsPresentation.current == windowID else {
                dismissWindow(id: "project-tools", value: windowID); return
            }
            if let previous = workbench.toolsPresentation.appeared(windowID) {
                dismissWindow(id: "project-tools", value: previous)
            }
        }
        .task(id: toolsActive) {
            // Handles previously saved windows and pre-26 scene restoration.
            // Keep the panel during an internal scene refresh, but never on
            // the gateway or after an immersive session has ended.
            if !toolsActive {
                openWindow(id: "workspace", value: "workspace")
                dismissWindow(id: "project-cameras")
                dismissWindow(id: "project-tools")
            }
        }
        .onDisappear {
            if workbench.toolsPresentation.closed(windowID), workbench.projectImmersed && !workbench.replacingScene {
                workbench.command("checkpoint"); review.stop()
                Task { await dismissSpace() }
            }
        }
    }

    private var viewState: some View {
        Label(review.placingProject ? "地面对齐" : review.lifeSize ? "沉浸游走" : "沙盘总览",
              systemImage: review.placingProject ? "viewfinder" : review.lifeSize ? "figure.walk" : "square.3.layers.3d")
            .font(.system(size: headingSize, weight: .semibold))
            .fixedSize().accessibilityIdentifier("project-view-state")
            #if targetEnvironment(simulator)
            .accessibilityValue("\(review.manifest?.nodes.count ?? 0) 个节点 · \(review.manifest?.clips.count ?? 0) 个任务 · \(String(describing: review.content.position)) · \(review.manifest?.id ?? "")")
            #endif
    }

    // Separate gaze targets into evenly sized cells; intrinsic-width controls
    // in a crowded row made adjacent buttons too easy to select accidentally.
    private var projectActions: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 290), spacing: VisionPanelMetrics.gap)],
                  spacing: VisionPanelMetrics.gap) {
            playbackButton; scaleButton; camerasButton; editorButton; parkingLabelsToggle
        }
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var playbackButton: some View {
        Button { review.togglePlayback() } label: {
            Label(review.playing ? "暂停回放" : "开始回放", systemImage: review.playing ? "pause.fill" : "play.fill")
                .visionPanelTarget()
        }
            .disabled(!review.hasClips || review.travelling || review.placingProject)
            .accessibilityLabel(review.playing ? "暂停回放" : "开始回放").accessibilityIdentifier("project-play")
    }

    private var scaleButton: some View {
        Button {
            if review.lifeSize || review.placingProject { review.overview() } else { review.enterProject() }
        } label: {
            Label(review.placingProject ? "沙盘预览" : review.lifeSize ? "沙盘总览" : "进入空间",
                  systemImage: review.lifeSize || review.placingProject ? "square.3.layers.3d" : "figure.walk").visionPanelTarget()
        }.disabled(review.travelling).accessibilityIdentifier("project-scale")
    }

    private var editorButton: some View {
        Button {
            workbench.editorVisible = true; openWindow(id: "workspace", value: "workspace")
        } label: {
            Label("编辑工具", systemImage: "slider.horizontal.3").visionPanelTarget()
        }.accessibilityIdentifier("project-editor")
    }

    private var camerasButton: some View {
        Button {
            if review.cameraWindowVisible { dismissWindow(id: "project-cameras") }
            else { openWindow(id: "project-cameras", value: "project-cameras") }
        } label: {
            Label("双相机", systemImage: "camera.on.rectangle").visionPanelTarget()
        }.disabled(!review.hasCameras || review.placingProject)
            .tint(review.cameraWindowVisible ? .cyan : nil).accessibilityIdentifier("project-cameras")
    }

    private var parkingLabelsToggle: some View {
        Toggle(isOn: $review.parkingLabelsVisible) {
            Label("停车点标签", systemImage: "tag").visionPanelTarget()
        }
            .toggleStyle(.button).tint(.cyan)
            .accessibilityLabel("显示停车点标签").accessibilityIdentifier("project-parking-labels")
    }
}

struct VisionSceneLibraryView: View {
    @EnvironmentObject private var review: VisionSceneController
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openImmersiveSpace) private var openSpace
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @StateObject private var discovery = LANServiceDiscovery()
    @State private var local: [VisionSceneManifest] = []
    @State private var offers: [VisionSceneOffer] = []
    @State private var address = ""
    @State private var busy = false
    @State private var operation: Task<Void, Never>?
    @State private var lookup: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text("空间工程").font(.largeTitle)
                    Text("地图 · 完整机器人 · 动作回放").foregroundStyle(.secondary)
                }
                Spacer()
                Button("关闭", systemImage: "xmark") { operation?.cancel(); dismiss() }.labelStyle(.iconOnly)
            }
            if busy { ProgressView(review.status).accessibilityIdentifier("scene-loading") }
            if !review.error.isEmpty { Text(review.error).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true) }
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        Label("电脑正在共享", systemImage: "wifi")
                        Spacer()
                        Button("重新发现") { discovery.start(); if !address.isEmpty { findOffers(address) } }
                            .fixedSize()
                    }
                    if discovery.servers.count > 1 {
                        ForEach(discovery.servers) { server in
                            Button(server.name) { findOffers(server.address) }.multilineTextAlignment(.leading)
                        }
                    }
                    if offers.isEmpty {
                        Text("在电脑选择「设备 → Vision Pro → 完整工程空间查看」，保持共享窗口打开。")
                            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    ForEach(offers) { offer in
                        Button {
                            run {
                                let scene = try await VisionSceneStore.shared.download(offer, address: address) { message in
                                    await MainActor.run { review.status = message }
                                }
                                try await open(scene)
                            }
                        } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                Label(offer.name, systemImage: "cube.transparent").lineLimit(2)
                                Text("\(offer.hasRobot ? "含完整机器人" : "地图场景") · \(offer.clipCount) 个动作任务")
                                    .font(.callout).foregroundStyle(.secondary)
                            }.multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        }.accessibilityIdentifier("scene-offer-\(offer.id)")
                    }
                    Divider()
                    Label("本机空间工程", systemImage: "square.stack.3d.up")
                    ForEach(local) { scene in
                        Button { run { try await open(scene) } } label: {
                            Label(scene.name, systemImage: "cube.fill").lineLimit(2).multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        }.accessibilityIdentifier("scene-local-\(scene.id)")
                    }
                    if local.isEmpty { Text("接收一次后，可离线查看和回放。").foregroundStyle(.secondary) }
                }.disabled(busy)
            }
        }.padding(32).frame(width: 700, height: 650).buttonStyle(.bordered).controlSize(.large)
        .task {
            local = (try? await VisionSceneStore.shared.localScenes()) ?? []
            discovery.start()
            var savedAddress = session.serverAddress
            #if targetEnvironment(simulator)
            if let testAddress = UserDefaults.standard.string(forKey: "visionSceneTestAddress") { savedAddress = testAddress }
            #endif
            if (try? LANClient(address: savedAddress)) != nil { findOffers(savedAddress) }
        }
        .onChange(of: discovery.servers.map(\.address)) { _, values in
            if !busy, offers.isEmpty, let first = values.first { findOffers(first) }
        }
        .onDisappear { discovery.stop(); lookup?.cancel(); operation?.cancel() }
    }
    private func findOffers(_ value: String) {
        lookup?.cancel(); address = value; offers = []
        lookup = Task {
            do {
                let received = try await VisionSceneStore.shared.offers(address: value)
                guard !Task.isCancelled else { return }; offers = received; review.error = ""
            } catch { if !Task.isCancelled { review.error = error.localizedDescription } }
        }
    }
    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        busy = true; review.error = ""; review.status = "正在打开空间工程…"
        operation = Task {
            do { try await action() }
            catch is CancellationError {} catch { review.error = error.localizedDescription }
            busy = false
        }
    }
    private func open(_ scene: VisionSceneManifest) async throws {
        try Task.checkCancellation(); try await review.prepare(scene); try Task.checkCancellation()
        switch await openSpace(id: "scene-review") {
        case .opened:
            operation = nil; review.immersed = true
            openWindow(id: "scene-review-tools", value: "scene-review-tools")
            dismiss(); dismissWindow(id: "workspace")
        case .userCancelled: review.stop()
        default: review.stop(); throw TeachingError("暂时无法打开空间，请关闭其他沉浸式应用后重试")
        }
    }
}

struct VisionSceneImmersiveView: View {
    @EnvironmentObject private var review: VisionSceneController
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.scenePhase) private var phase
    var body: some View {
        RealityView { content in
            content.add(review.root)
            await review.begin(in: content)
        }
            .simultaneousGesture(SpatialTapGesture().targetedToEntity(where: .has(VisionSceneSelection.self)).onEnded { value in
                if let item = value.entity.components[VisionSceneSelection.self] {
                    review.select(item, point: value.convert(value.location3D, from: .local, to: review.content))
                }
            })
            .simultaneousGesture(SpatialTapGesture(count: 2).targetedToEntity(where: .has(VisionSceneSelection.self)).onEnded { value in
                review.detail(at: value.convert(value.location3D, from: .local, to: review.content))
            })
            .onChange(of: phase) { _, value in if value != .active && review.playing { review.togglePlayback() } }
            .onDisappear {
                review.stop(); openWindow(id: "workspace", value: "workspace"); dismissWindow(id: "scene-review-tools")
            }
    }
}

struct VisionSceneToolsView: View {
    @EnvironmentObject private var review: VisionSceneController
    @Environment(\.dismissImmersiveSpace) private var dismissSpace
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                if review.hasClips {
                    Menu {
                        ForEach(Array((review.manifest?.clips ?? []).enumerated()), id: \.element.id) { index, clip in
                            Button(clip.taskName) { review.chooseClip(index) }
                        }
                    } label: { Text(review.clip?.taskName ?? "已保存动作").lineLimit(1) }
                } else { Text(review.manifest?.name ?? "空间工程").lineLimit(1).truncationMode(.middle) }
                Spacer()
            }
            VisionActionRow {
                Button { review.togglePlayback() } label: { Image(systemName: review.playing ? "pause.fill" : "play.fill") }
                    .disabled(!review.hasClips).accessibilityLabel(review.playing ? "暂停回放" : "开始回放").accessibilityIdentifier("scene-play")
                Button(review.lifeSize ? "沙盘" : "原大", systemImage: review.lifeSize ? "square.3.layers.3d" : "viewfinder") {
                    if review.lifeSize { review.overview() } else { review.detail() }
                }.accessibilityIdentifier("scene-scale")
                Button {
                    review.stop()
                    Task {
                        await dismissSpace()
                        openWindow(id: "workspace", value: "workspace")
                        dismissWindow(id: "scene-review-tools")
                    }
                } label: { Image(systemName: "rectangle.portrait.and.arrow.right") }
                    .accessibilityLabel("返回工作台").accessibilityIdentifier("scene-exit")
            }
            Toggle("显示停车点标签", systemImage: "tag", isOn: $review.parkingLabelsVisible)
                .toggleStyle(.button).tint(.cyan).accessibilityIdentifier("scene-parking-labels")
            if review.clip != nil {
                Slider(value: Binding(get: { review.progress }, set: { review.scrub($0) }), in: 0...1)
                    .accessibilityLabel("回放进度").accessibilityIdentifier("scene-timeline")
            }
            if !review.selection.isEmpty {
                HStack {
                    Text(review.selection).lineLimit(1)
                    if let distance = review.measurement { Text(distance < 1 ? String(format: "约 %.1f cm", distance * 100) : String(format: "约 %.2f m", distance)).foregroundStyle(.yellow) }
                    Spacer()
                    Button { review.clearSelection() } label: { Image(systemName: "xmark.circle") }.accessibilityLabel("清除检查标记")
                }.font(.callout)
            } else {
                Text(review.lifeSize ? "点选两处几何可查看间距；回到沙盘继续总览" : "双手捏住缩放和旋转 · 双击局部原大查看")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !review.error.isEmpty { Text(review.error).font(.caption).foregroundStyle(.orange) }
            #if targetEnvironment(simulator)
            Text(review.lifeSize ? "原大查看" : "沙盘总览").font(.caption).accessibilityIdentifier("scene-view-state")
                .accessibilityValue("\(review.manifest?.nodes.count ?? 0) 个节点 · \(review.manifest?.clips.count ?? 0) 个任务")
            #endif
        }.padding(20).frame(width: 560).buttonStyle(.bordered).controlSize(.large)
        .task { if review.manifest == nil || !review.immersed { openWindow(id: "workspace", value: "workspace"); dismissWindow(id: "scene-review-tools") } }
        .onDisappear { if review.immersed { review.stop(); Task { await dismissSpace() } } }
    }
}
