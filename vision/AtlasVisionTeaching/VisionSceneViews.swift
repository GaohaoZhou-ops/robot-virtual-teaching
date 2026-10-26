import SwiftUI
import RealityKit

// The project itself occupies the immersive space. The optional document
// editor lives in a separate window; no web canvas is used as the scene.
struct VisionProjectImmersiveView: View {
    @EnvironmentObject private var review: VisionSceneController
    @EnvironmentObject private var workbench: VisionWorkbench
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.scenePhase) private var phase
    var body: some View {
        RealityView { content in
            content.add(review.root)
            await review.begin(in: content)
        }
        .gesture(SpatialTapGesture().targetedToEntity(where: .has(VisionSceneSelection.self)).onEnded { value in
            if let item = value.entity.components[VisionSceneSelection.self] {
                review.select(item, point: value.convert(value.location3D, from: .local, to: review.content))
            }
        })
        .onChange(of: phase) { _, value in if value != .active && review.playing { review.togglePlayback() } }
        .onAppear { workbench.projectSpaceVisible = true }
        .onDisappear {
            review.stop(); workbench.projectSpaceVisible = false
            if !workbench.replacingScene {
                workbench.projectImmersed = false; workbench.editorVisible = false
                workbench.sceneStatus = "空间已关闭，可重新进入"
                openWindow(id: "workspace", value: "workspace"); dismissWindow(id: "project-tools")
            }
        }
    }
}

struct VisionProjectToolsView: View {
    @EnvironmentObject private var review: VisionSceneController
    @EnvironmentObject private var workbench: VisionWorkbench
    @Environment(\.openWindow) private var openWindow
    @Environment(\.dismissImmersiveSpace) private var dismissSpace
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Menu {
                    ForEach(Array((review.manifest?.clips ?? []).enumerated()), id: \.element.id) { index, clip in
                        Button(clip.taskName) { review.chooseClip(index) }
                    }
                } label: { Label(review.clip?.taskName ?? review.manifest?.name ?? "沉浸式工程", systemImage: "cube.transparent").lineLimit(1) }
                    .disabled(!review.hasClips)
                Spacer(minLength: 0)
                Button { review.togglePlayback() } label: { Image(systemName: review.playing ? "pause.fill" : "play.fill") }
                    .disabled(!review.hasClips || review.travelling)
                    .accessibilityLabel(review.playing ? "暂停回放" : "开始回放").accessibilityIdentifier("project-play")
                Button(review.lifeSize ? "沙盘" : "进入", systemImage: review.lifeSize ? "square.3.layers.3d" : "figure.walk") {
                    if review.lifeSize { review.overview() } else { review.enterProject() }
                }.disabled(review.travelling).accessibilityIdentifier("project-scale")
                Button("编辑工具", systemImage: "slider.horizontal.3") {
                    workbench.editorVisible = true; openWindow(id: "workspace", value: "workspace")
                }.accessibilityIdentifier("project-editor")
                Menu {
                    Section("游走") {
                        Button("回到机器人旁", systemImage: "viewfinder") { review.returnToRobot() }
                            .accessibilityIdentifier("project-robot")
                        Menu("前往示教点", systemImage: "mappin.and.ellipse") {
                            ForEach((review.manifest?.markers ?? []).filter { $0.kind == "parking" }, id: \.id) { marker in
                                Button(marker.name) { review.visit(marker) }.accessibilityIdentifier("project-visit-\(marker.id)")
                            }
                        }
                        Button("向左转身", systemImage: "arrow.turn.up.left") { review.turn(-.pi / 6) }.disabled(!review.lifeSize)
                        Button("向右转身", systemImage: "arrow.turn.up.right") { review.turn(.pi / 6) }.disabled(!review.lifeSize)
                        Toggle("测量两点间距", isOn: Binding(get: { review.measuring }, set: { review.setMeasurement($0) }))
                    }
                    Section("工程") {
                        Button("更新空间", systemImage: "arrow.clockwise") { workbench.command("scene") }
                            .disabled(!workbench.sceneReady || workbench.buildingScene || workbench.openingScene)
                            .accessibilityIdentifier("project-refresh")
                        Button("保存工程", systemImage: "square.and.arrow.down") { workbench.command("save") }
                            .disabled(!workbench.ready).accessibilityIdentifier("project-save")
                        Button("返回工程入口", systemImage: "rectangle.portrait.and.arrow.right") { workbench.command("home") }
                            .accessibilityIdentifier("project-home")
                    }
                } label: { Image(systemName: "ellipsis") }
                    .accessibilityLabel("空间选项").accessibilityIdentifier("project-options")
            }.disabled(workbench.openingScene || review.busy)
            if review.clip != nil {
                Slider(value: Binding(get: { review.progress }, set: { review.scrub($0) }), in: 0...1)
                    .accessibilityLabel("回放进度").accessibilityIdentifier("project-timeline")
            }
            if review.destination != nil {
                HStack {
                    Label("落点已选好", systemImage: "mappin.circle.fill").foregroundStyle(.mint)
                    Spacer()
                    Button("取消") { review.clearDestination() }
                    Button("前往此处", systemImage: "figure.walk") { review.travel() }
                        .tint(.mint).accessibilityIdentifier("project-travel")
                }.disabled(review.travelling)
            } else if review.travelling { ProgressView("正在前往…") }
            else {
                Text(review.measuring ? "点选两处几何，查看真实间距" : review.navigationMessage)
                    .font(.callout).foregroundStyle(.secondary)
            }
            if !review.selection.isEmpty {
                HStack {
                    Text(review.selection).lineLimit(1)
                    if let distance = review.measurement { Text(distance < 1 ? String(format: "约 %.1f cm", distance * 100) : String(format: "约 %.2f m", distance)).foregroundStyle(.yellow) }
                    Spacer()
                    Button { review.clearSelection() } label: { Image(systemName: "xmark.circle") }.accessibilityLabel("清除检查标记")
                }.font(.callout)
            }
            if workbench.buildingScene || workbench.openingScene {
                ProgressView(workbench.openingScene ? review.status : workbench.sceneStatus).font(.caption)
            } else if workbench.sceneIsOutdated {
                HStack {
                    Text("工程有更新").foregroundStyle(.secondary)
                    Button("更新空间", systemImage: "arrow.clockwise") { workbench.command("scene") }
                }.font(.callout)
            }
            if let exported = workbench.exportedFile { ShareLink("导出文件", item: exported).accessibilityIdentifier("project-exported") }
            if !workbench.error.isEmpty || !review.error.isEmpty {
                Text(workbench.error.isEmpty ? review.error : workbench.error).font(.caption).foregroundStyle(.orange)
            }
            #if targetEnvironment(simulator)
            Text(review.lifeSize ? "沉浸游走" : "沙盘总览").font(.caption).accessibilityIdentifier("project-view-state")
                .accessibilityValue("\(review.manifest?.nodes.count ?? 0) 个节点 · \(review.manifest?.clips.count ?? 0) 个任务 · \(String(describing: review.content.position)) · \(review.manifest?.id ?? "")")
            #endif
        }.padding(20).frame(width: 660).buttonStyle(.bordered).controlSize(.large)
        .background(VisionWorkbenchEngine())
        .modifier(VisionProjectSceneCoordinator())
        .onDisappear {
            if workbench.projectImmersed && !workbench.replacingScene {
                workbench.command("checkpoint"); review.stop()
                Task { await dismissSpace() }
            }
        }
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
                    }
                    if discovery.servers.count > 1 {
                        ForEach(discovery.servers) { server in Button(server.name) { findOffers(server.address) } }
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
                                Label(offer.name, systemImage: "cube.transparent")
                                Text("\(offer.hasRobot ? "含完整机器人" : "地图场景") · \(offer.clipCount) 个动作任务")
                                    .font(.callout).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        }.accessibilityIdentifier("scene-offer-\(offer.id)")
                    }
                    Divider()
                    Label("本机空间工程", systemImage: "square.stack.3d.up")
                    ForEach(local) { scene in
                        Button { run { try await open(scene) } } label: {
                            Label(scene.name, systemImage: "cube.fill").frame(maxWidth: .infinity, alignment: .leading).padding(12)
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
                } else { Text(review.manifest?.name ?? "空间工程").lineLimit(1) }
                Spacer()
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
