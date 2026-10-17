import SwiftUI
import SceneKit

private let accent = Color(red: 0.35, green: 0.86, blue: 0.91)

struct ContentView: View {
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var discovery = LANServiceDiscovery()
    @State private var scanning = false
    @State private var scannedCode: PairingQRCode?
    @State private var codeFocused = false
    @State private var projectToDelete: LocalProject?
    @State private var revealedProjectID: String?
    var body: some View {
        GeometryReader { viewport in
        Group {
            if let project = session.current, let geometry = session.geometry {
                TeachingView(projectID: project.id, geometry: geometry)
            } else { library }
        }.frame(width: viewport.size.width, height: viewport.size.height)
        }.tint(accent).task { await session.reload() }
    }
    private var library: some View {
        GeometryReader { viewport in
            let wide = viewport.size.width >= 1000 && viewport.size.width > viewport.size.height
            let padding: CGFloat = viewport.size.width >= 700 ? 28 : 20
            let panelHeight: CGFloat = wide ? max(360, viewport.size.height - 208) : 0
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    libraryHeader
                    if !ARController.supported {
                        Label("空间定位需要配备 LiDAR 的 iPad Pro 真机。当前设备可接收、查看物体和已有 Pose。", systemImage: "info.circle")
                            .font(.callout).foregroundStyle(.orange).padding().frame(maxWidth: .infinity, alignment: .leading)
                            .background(.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
                    }
                    if wide {
                        HStack(alignment: .top, spacing: 24) {
                            pairingPanel(minHeight: panelHeight).frame(width: min(420, viewport.size.width * 0.35))
                            localProjectsPanel(minHeight: panelHeight).frame(maxWidth: .infinity)
                        }
                    } else {
                        pairingPanel(minHeight: 0).fixedSize(horizontal: false, vertical: true)
                        localProjectsPanel(minHeight: 0).fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .padding(padding)
                .frame(minHeight: viewport.size.height, alignment: .topLeading)
                .accessibilityElement(children: .contain).accessibilityIdentifier("library-content")
            }
            .frame(width: viewport.size.width, height: viewport.size.height)
            .scrollDismissesKeyboard(.interactively)
            .contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded {
                revealedProjectID = nil
            })
        }
        .background(Color(red: 0.025, green: 0.05, blue: 0.065).ignoresSafeArea())
        .sheet(isPresented: $scanning, onDismiss: finishScanning) {
            PairingScannerView { qr in scannedCode = qr; scanning = false }
        }
        .alert("从此 iPad 删除模型？", isPresented: Binding(
            get: { projectToDelete != nil }, set: { if !$0 { projectToDelete = nil } }
        ), presenting: projectToDelete) { project in
            Button("删除模型与全部 Pose", role: .destructive) {
                Task { await session.deleteLocalProject(project) }
            }.accessibilityIdentifier("confirm-delete-local-project")
            Button("取消", role: .cancel) {}.accessibilityIdentifier("cancel-delete-local-project")
        } message: { project in
            Text("将删除「\(project.session.manifest.name)」在此 iPad 上的模型、全部 \(project.result.samples.count) 个 Pose 和应用生成的导出副本。电脑上的工程和已同步结果不受影响。")
        }
        .onAppear { if !scanning { discovery.start() } }
        .onDisappear { discovery.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && session.current == nil && !scanning { discovery.start() }
            else { discovery.stop() }
        }
    }
    private func finishScanning() {
        if let qr = scannedCode {
            scannedCode = nil
            Task { await session.pair(qr: qr) }
        } else { discovery.start() }
    }
    private func beginScanning() {
        codeFocused = false; discovery.stop()
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        // Finish the native field's resignation before SwiftUI presents the camera.
        DispatchQueue.main.async { scanning = true }
    }
    private var libraryHeader: some View {
        HStack(alignment: .center, spacing: 24) {
            VStack(alignment: .leading, spacing: 10) {
                Text("ATLAS / IPAD PRO").font(.system(.caption, design: .monospaced)).tracking(3).foregroundStyle(accent)
                Text("虚拟示教").font(.largeTitle.weight(.medium))
            }
            Spacer(minLength: 0)
            Image(systemName: "ipad.landscape").font(.system(size: 60, weight: .ultraLight)).foregroundStyle(accent)
                .accessibilityHidden(true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private func pairingPanel(minHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("从电脑接收物体", systemImage: "wifi").font(.title2.weight(.medium))
            discoveryPanel
            LANAddressFields(address: $session.serverConnection).disabled(session.busy)
            VStack(alignment: .leading, spacing: 8) {
                Text("4 位配对码 · 大写字母或数字").font(.caption).foregroundStyle(.secondary)
                pairingCodeInput
            }
            Button { Task { await session.pair() } } label: {
                Label("接收物体", systemImage: "arrow.down.circle").frame(maxWidth: .infinity).padding(.vertical, 10)
            }
            .buttonStyle(.borderedProminent).disabled(session.busy || !session.serverConnection.canConnect || !PairingCode.isValid(session.code))
            .accessibilityIdentifier("receive-model")
            if session.busy { ProgressView() }
            if !session.error.isEmpty { Text(session.error).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
            Spacer(minLength: 4)
            if !session.status.isEmpty {
                Text(session.status).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .contain).accessibilityIdentifier("library-pairing-panel")
    }
    private var pairingCodeInput: some View {
        let characters = Array(session.code)
        let invalid = characters.count > 4 || characters.contains { !$0.isASCII || !("A"..."Z").contains(String($0)) && !("0"..."9").contains(String($0)) }
        return VStack(alignment: .leading, spacing: 8) {
            PairingCodeField(code: $session.code, isFocused: $codeFocused)
                .frame(maxWidth: .infinity).frame(height: 58).disabled(session.busy)
            if invalid { Text("请输入 4 位字母或数字").font(.caption).foregroundStyle(.orange) }
        }
    }
    private var discoveryPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button(action: beginScanning) {
                    Label("扫码配对", systemImage: "qrcode.viewfinder")
                }.buttonStyle(.borderedProminent).font(.callout)
                    .disabled(session.busy).accessibilityIdentifier("scan-pairing-code")
                Button { discovery.start() } label: {
                    Label("搜索局域网服务", systemImage: "network")
                }.buttonStyle(.bordered).font(.callout)
                    .disabled(discovery.isSearching || session.busy).accessibilityIdentifier("discover-services")
                Spacer(minLength: 4)
                if discovery.isSearching { ProgressView().controlSize(.small) }
            }
            if !discovery.servers.isEmpty {
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(discovery.servers) { server in
                            Button {
                                session.serverAddress = server.address
                                session.error = ""
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "desktopcomputer").foregroundStyle(accent)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(server.name).font(.callout.weight(.medium)).lineLimit(1)
                                        Text(LANAddressInput(address: server.address).displayAddress).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
                                    }
                                    Spacer(minLength: 0)
                                    Image(systemName: session.serverAddress == server.address ? "checkmark.circle.fill" : "plus.circle").foregroundStyle(accent)
                                }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                                    .background(accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                            }.buttonStyle(.plain).disabled(session.busy)
                                .accessibilityIdentifier("discovered-service-\(server.id)")
                        }
                    }
                }.frame(height: min(CGFloat(discovery.servers.count) * 62, 124))
            }
            if !discovery.message.isEmpty {
                Text(discovery.message).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("discovery-status")
            }
        }
    }
    private func localProjectsPanel(minHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Label("保存在此 iPad", systemImage: "square.stack.3d.up").font(.title2.weight(.medium))
                Spacer()
                Text("\(session.projects.count) 个物体").font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            if session.projects.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "cube.transparent").font(.system(size: 64, weight: .ultraLight)).foregroundStyle(accent.opacity(0.7))
                    Text("从电脑接收第一个物体").font(.headline)
                    Text("接收后，物体和示教草稿都会出现在这里。")
                        .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }.frame(maxWidth: .infinity, minHeight: 230)
            } else {
                VStack(spacing: 12) {
                    ForEach(session.projects) { project in
                        LocalProjectSwipeRow(projectID: project.id, revealedProjectID: $revealedProjectID,
                                             disabled: session.busy, onDelete: { projectToDelete = project }) {
                            Button { Task { await session.open(project) } } label: {
                                HStack(spacing: 18) {
                                    VStack(alignment: .leading, spacing: 10) {
                                        Text(project.session.manifest.name).font(.headline).multilineTextAlignment(.leading).lineLimit(3)
                                        Text("\(project.result.samples.count) 个 Pose · \(project.syncedAt != nil ? "已同步" : project.result.completedAt != nil ? "已完成，待同步" : "本地草稿")")
                                            .font(.caption).foregroundStyle(.secondary)
                                        if session.openingProjectID == project.id {
                                            ProgressView("轻量加载…").font(.caption).controlSize(.small)
                                                .accessibilityIdentifier("opening-model-progress")
                                        } else if session.deletingProjectID == project.id {
                                            ProgressView("正在删除…").font(.caption).controlSize(.small)
                                        }
                                    }
                                    Spacer(minLength: 4)
                                    ProjectThumbnailView(project: project)
                                        .frame(width: 150, height: 100)
                                        .overlay(alignment: .topTrailing) {
                                            Image(systemName: "arrow.up.right").font(.caption.weight(.medium)).foregroundStyle(accent)
                                                .padding(7).background(.black.opacity(0.5), in: Circle()).padding(6)
                                        }
                                        .allowsHitTesting(false)
                                }
                                .padding(20).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                                .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 14))
                            }.buttonStyle(.plain).disabled(session.busy).accessibilityIdentifier("local-project-\(project.id)")
                        }
                    }
                }
                .accessibilityIdentifier("local-project-list")
            }
            Spacer(minLength: 12)
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
        .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.white.opacity(0.06)))
        .accessibilityElement(children: .contain).accessibilityIdentifier("library-projects-panel")
    }

}

/// A horizontal scroll keeps vertical page scrolling native, while allowing the
/// action and card to share their actual height (including larger text sizes).
private struct LocalProjectSwipeRow<Content: View>: View {
    let projectID: String
    @Binding var revealedProjectID: String?
    let disabled: Bool
    let onDelete: () -> Void
    @ViewBuilder let content: Content
    @State private var showingAction = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 12) {
                    content
                        .containerRelativeFrame(.horizontal)
                        .id("card")
                        .accessibilityAction(named: Text("从此 iPad 删除")) {
                            guard !disabled else { return }
                            close(using: proxy)
                            onDelete()
                        }
                    Button {
                        close(using: proxy)
                        onDelete()
                    } label: {
                        VStack(spacing: 8) {
                            Image(systemName: "trash").font(.title3.weight(.medium))
                            Text("删除").font(.callout.weight(.semibold))
                        }
                        .foregroundStyle(.white)
                        .frame(width: 88).frame(maxHeight: .infinity)
                        .background(Color.red, in: RoundedRectangle(cornerRadius: 14))
                        .contentShape(RoundedRectangle(cornerRadius: 14))
                    }
                    .buttonStyle(.plain).disabled(disabled)
                    .accessibilityIdentifier("swipe-delete-local-project-\(projectID)")
                    .accessibilityLabel("从此 iPad 删除模型和全部 Pose")
                    .accessibilityHidden(!showingAction)
                }
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: Bool.self) { geometry in
                    geometry.frame(in: .scrollView(axis: .horizontal)).minX < -1
                } action: { revealed in
                    if revealed && !showingAction { revealedProjectID = projectID }
                    if !revealed && revealedProjectID == projectID { revealedProjectID = nil }
                    showingAction = revealed
                }
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(LocalProjectSwipeSnap())
            .scrollDisabled(disabled)
            .fixedSize(horizontal: false, vertical: true)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .onChange(of: revealedProjectID) { _, id in
                if id != projectID && showingAction { close(using: proxy) }
            }
            .onChange(of: disabled) { _, busy in
                if busy { close(using: proxy) }
            }
        }
    }

    private func close(using proxy: ScrollViewProxy) {
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("card", anchor: .leading) }
        if revealedProjectID == projectID { revealedProjectID = nil }
    }
}

private struct LocalProjectSwipeSnap: ScrollTargetBehavior {
    func updateTarget(_ target: inout ScrollTarget, context: TargetContext) {
        let revealWidth = max(0, context.contentSize.width - context.containerSize.width)
        let reveal = abs(context.velocity.dx) > 100 ? context.velocity.dx > 0 : target.rect.minX > revealWidth / 2
        target.rect.origin.x = reveal ? revealWidth : 0
    }
}

private struct LANAddressFields: View {
    @Binding var address: LANAddressInput
    @State private var hostError = ""
    @FocusState private var portFocused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: 12) { hostFields.frame(minWidth: 224); portField }
                VStack(alignment: .leading, spacing: 12) { hostFields; portField }
            }
            if !hostError.isEmpty { Text(hostError).font(.caption).foregroundStyle(.orange).accessibilityIdentifier("server-address-error") }
            // Older saved .local endpoints remain visible until replaced with an IPv4 address.
            if !address.host.isEmpty && IPv4Input.octets(address.host, allowingEmpty: true) == nil {
                Text("当前地址：\(address.host)").font(.caption).foregroundStyle(.secondary)
            }
        }
        .onChange(of: address.host) { _, _ in hostError = "" }
    }
    private var hostFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("IPv4 地址").font(.caption).foregroundStyle(.secondary)
            IPv4AddressField(host: $address.host, error: $hostError) { portFocused = true }
                .frame(maxWidth: .infinity).frame(height: 44)
        }.frame(maxWidth: .infinity)
    }
    private var portField: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("端口").font(.caption).foregroundStyle(.secondary)
            TextField(LANAddressInput.defaultPort, text: $address.port)
                .focused($portFocused).submitLabel(.done).onSubmit {
                    if address.port.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { address.port = LANAddressInput.defaultPort }
                    portFocused = false
                }
                .font(.system(.body, design: .monospaced)).multilineTextAlignment(.center)
                .textFieldStyle(.plain).frame(height: 44)
                .background(.black.opacity(0.24), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.white.opacity(0.18)))
                .keyboardType(.numbersAndPunctuation).textInputAutocapitalization(.never).autocorrectionDisabled()
                .accessibilityLabel("服务端口").accessibilityIdentifier("server-port")
        }.frame(width: 94)
    }
}

struct TeachingView: View {
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var ar = ARController()
    @StateObject private var renderer = ModelRenderer()
    @StateObject private var coverage = TeachingCoverageRenderer()
    @State private var review = false
    @State private var finishing = false
    @State private var resultShare: TeachingResultShareItem?
    @State private var scanningResult = false
    @State private var scannedResultCode: PairingQRCode?
    @State private var displaySettingsOpen = false
    @State private var levelVisible = true
    @State private var zividFieldOfViewEnabled = false
    @State private var tiltControlsOpen = false
    @State private var sidebarCollapsed = false
    @State private var nearbyPoseConfirmation: NearbyPoseConfirmation?
    @State private var loadedProjectID: String?
    @ScaledMetric(relativeTo: .body) private var teachingActionLabelHeight: CGFloat = 34
    let projectID: String
    let geometry: ModelGeometry
    private var completed: Bool { session.current?.result.completedAt != nil }
    private var count: Int { session.current?.result.samples.count ?? 0 }
    private var liveCamera: Bool { ARController.supported && !completed }
    private var fieldOfView: ZividFieldOfView? { liveCamera ? ar.cameraFieldOfView : .modelPreview }
    private var canRecordPose: Bool {
        scenePhase == .active && !review && !finishing && session.current?.id == projectID
            && !completed && ar.calibrated && ar.trackingNormal && renderer.geometry != nil
            && !session.busy && count < maximumSamples && session.error.isEmpty
    }
    private var canFinishPlacementAdjustment: Bool {
        ar.adjustingPlacement && ar.placed && !ar.repositioning && ar.trackingNormal && renderer.geometry != nil
            && !session.busy && session.error.isEmpty
    }
    private var viewportMessage: String {
        if sidebarCollapsed && !session.error.isEmpty { return session.error }
        if completed && ARController.supported { return "示教已完成 · 继续采集请点击「继续示教」" }
        if !liveCamera { return "三维物体预览 · 拖动旋转 / 双指缩放视图" }
        if ar.repositioning || ar.adjustingPlacement { return ar.message }
        if sidebarCollapsed && !ar.calibrated { return "点击或拖动有效表面放置物体，放置后即可记录 Pose" }
        return ar.message
    }

    var body: some View {
        GeometryReader { viewport in
        let sidebarWidth: CGFloat = sidebarCollapsed ? 0 : 340
        let controlsWidth = max(0, viewport.size.width - sidebarWidth)
        ZStack {
            // Always render with the collapsed panel's full viewport. The panel
            // covers its right edge; it must not resize/recenter the camera,
            // the M70 mask, or the center used by placement raycasts.
            ZStack {
                Color.black
                modelViewport(in: viewport.size)
                if liveCamera {
                    Image(systemName: ar.placed && !ar.repositioning ? "plus" : "viewfinder")
                        .font(ar.placed && !ar.repositioning ? .title2.weight(.ultraLight) : .system(size: 48, weight: .ultraLight))
                        .foregroundStyle(ar.groundAssistance && ar.groundTargetAvailable ? accent : .white)
                        .shadow(color: .black, radius: 2).allowsHitTesting(false)
                        .accessibilityLabel("模型放置准星").accessibilityIdentifier("teaching-placement-target")
                }
            }.frame(width: viewport.size.width, height: viewport.size.height).clipped()
                .accessibilityElement(children: .contain).accessibilityIdentifier("teaching-viewport")
            HStack(spacing: 0) {
                VStack {
                    HStack {
                        Label(completed ? "已完成 · 结果预览" : ar.tracking,
                              systemImage: completed ? "checkmark.circle" : ar.trackingNormal ? "location.fill" : "location.slash")
                            .foregroundStyle(completed || ar.trackingNormal ? accent : .orange)
                            .accessibilityIdentifier("teaching-tracking-status")
                        Spacer()
                        Text(liveCamera ? (ar.depthAvailable ? "LiDAR 已就绪" : "等待 LiDAR") : "相机 / LiDAR 未启用")
                            .foregroundStyle(.secondary).accessibilityIdentifier("teaching-depth-status")
                        if ARController.supported && !completed {
                            Button { levelVisible.toggle() } label: {
                                Image(systemName: "move.3d").frame(minWidth: 20, minHeight: 32)
                            }
                                .buttonStyle(.bordered).tint(levelVisible ? accent : .secondary)
                                .accessibilityLabel(levelVisible ? "隐藏姿态坐标轴" : "显示姿态坐标轴")
                                .accessibilityIdentifier("toggle-spatial-level")
                        }
                        Button { displaySettingsOpen = true } label: {
                            Label("显示设置", systemImage: "slider.horizontal.3").frame(minWidth: 88, minHeight: 32)
                        }
                            .buttonStyle(.bordered).accessibilityIdentifier("display-settings")
                        if sidebarCollapsed {
                            Button { setSidebarCollapsed(false) } label: {
                                Label("展开面板", systemImage: "sidebar.right").frame(minWidth: 88, minHeight: 32)
                            }.buttonStyle(.bordered).accessibilityIdentifier("expand-teaching-panel")
                        }
                    }.font(.caption).padding(16).background(.black.opacity(0.75))
                    if liveCamera && levelVisible {
                        HStack {
                            SpatialLevelView(reading: ar.levelReading)
                                .frame(width: 232).allowsHitTesting(false)
                            Spacer(minLength: 0)
                        }.padding(.horizontal, 16).padding(.top, 10)
                    }
                    Spacer()
                    HStack(alignment: .bottom, spacing: 16) {
                        Text(viewportMessage).font(.callout).padding(14)
                            .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 10))
                            .frame(maxWidth: .infinity)
                        if sidebarCollapsed && !completed {
                            VStack(spacing: 8) {
                                Text("\(count) 个 Pose").font(.caption.monospacedDigit()).foregroundStyle(.white)
                                    .accessibilityIdentifier("floating-pose-count")
                                if ar.adjustingPlacement { placementAdjustmentControls }
                                else {
                                    recordPoseButton
                                    if ar.calibrated { placementAdjustmentControls }
                                }
                            }.frame(width: 198).padding(12)
                                .background(.black.opacity(0.8), in: RoundedRectangle(cornerRadius: 16))
                                .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.15)))
                                .accessibilityElement(children: .contain).accessibilityIdentifier("floating-pose-controls")
                        }
                    }.padding(20)
                }.frame(width: controlsWidth, height: viewport.size.height).clipped()
            // Keep sidebar controls alive while folding; only the overlay's
            // usable area changes, never the underlying scene/session.
            VStack(spacing: 0) {
                HStack {
                    Button { ar.stop(); Task { await session.close() } } label: { Label("本地项目", systemImage: "chevron.left") }.disabled(session.busy)
                    Spacer()
                    Button { setSidebarCollapsed(true) } label: {
                        Label("收起", systemImage: "chevron.right").font(.caption).frame(minHeight: 32)
                    }.buttonStyle(.bordered).accessibilityLabel("收起右侧面板")
                        .accessibilityIdentifier("collapse-teaching-panel")
                }.padding(.horizontal, 22).padding(.vertical, 12)
                if liveCamera && !sidebarCollapsed && (ar.calibrated || ar.adjustingPlacement) {
                    placementAdjustmentControls.padding(.horizontal, 22).padding(.bottom, 12)
                }
            ScrollView {
                VStack(alignment: .leading, spacing: 19) {
                    Text(session.current?.session.manifest.name ?? "独立示教物体").font(.title3).lineLimit(2)
                    Text("\(count)").font(.system(size: 54, weight: .light, design: .monospaced)) + Text("  POSES").font(.caption).foregroundColor(.secondary)
                    Text(renderer.appliedSettings.map { geometry.summary($0) } ?? "正在轻量加载模型…")
                        .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("teaching-render-summary")
                    if session.current?.session.manifest.sampled == true { Text("大物体以抽样点云显示，尺寸与坐标不变").font(.caption).foregroundStyle(.secondary) }
                    Divider()
                    if completed {
                        Button { Task { await session.continueTeaching() } } label: {
                            Label("继续示教", systemImage: "camera.fill").frame(maxWidth: .infinity).padding(10)
                        }.buttonStyle(.bordered).disabled(session.busy || !ARController.supported)
                            .accessibilityIdentifier("continue-teaching")
                        Divider()
                    }
                    if liveCamera && !ar.calibrated { groundAssistanceControl }
                    fieldOfViewControl
                    coverageControl
                    Divider()
                    if !completed {
                        calibrationPanel
                        if !sidebarCollapsed && !ar.adjustingPlacement { recordPoseButton }
                    }
                    Button { review = true } label: {
                        teachingActionLabel("查看 / 编辑 Pose", systemImage: "list.bullet.rectangle")
                    }
                        .buttonStyle(.bordered).disabled(count == 0)
                        .accessibilityIdentifier("review-poses")
                    if !completed {
                        finishTeachingButton
                    } else {
                        Button {
                            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                            scanningResult = true
                        } label: {
                            Label("扫码同步到电脑", systemImage: "qrcode.viewfinder")
                                .frame(maxWidth: .infinity).padding(10)
                        }.buttonStyle(.borderedProminent).disabled(session.busy)
                            .accessibilityIdentifier("scan-sync-result")
                            .sheet(isPresented: $scanningResult, onDismiss: syncScannedResult) {
                                PairingScannerView(purpose: .syncResult) { qr in
                                    scannedResultCode = qr; scanningResult = false
                                }
                            }
                        Button { Task { await shareResult() } } label: {
                            Label("AirDrop / 导出结果", systemImage: "square.and.arrow.up")
                                .frame(maxWidth: .infinity).padding(10)
                        }
                            .buttonStyle(.bordered).disabled(session.busy)
                            .accessibilityIdentifier("share-teaching-result")
                            .popover(item: $resultShare) { item in
                                TeachingResultShareSheet(url: item.url) { activity, completed, error in
                                    session.resultShareFinished(activity: activity, completed: completed, error: error)
                                    resultShare = nil
                                }.presentationCompactAdaptation(.sheet)
                            }
                        Divider()
                        LANAddressFields(address: $session.serverConnection).disabled(session.busy)
                        Button { Task { await session.finish(sync: true) } } label: { Label("局域网同步到电脑", systemImage: "wifi").frame(maxWidth: .infinity).padding(10) }
                            .buttonStyle(.bordered).disabled(session.busy || !session.serverConnection.canConnect || session.current?.requiresResultPairing == true)
                    }
                    if session.busy { ProgressView() }
                    if !session.status.isEmpty { Text(session.status).font(.caption).foregroundStyle(.secondary) }
                    if !renderer.error.isEmpty { Text(renderer.error).font(.caption).foregroundStyle(.orange) }
                    if !session.error.isEmpty {
                        Text(session.error).font(.caption).foregroundStyle(.orange)
                        Button("重试保存") { Task { do { try await session.saveNow(); session.error = "" } catch { session.error = error.localizedDescription } } }
                    }
                }.padding(22)
            }
            }.frame(width: 340, height: viewport.size.height).background(Color(red: 0.025, green: 0.05, blue: 0.065))
                .frame(width: sidebarWidth, alignment: .leading).clipped()
                .opacity(sidebarCollapsed ? 0 : 1).allowsHitTesting(!sidebarCollapsed)
                .accessibilityHidden(sidebarCollapsed)
            }
        }
        }.task(id: projectID) {
            // Returning from full-screen review must retain the live AR session
            // and its calibration instead of loading and resetting it again.
            guard loadedProjectID != projectID, let project = session.current else { return }
            loadedProjectID = projectID
            ar.load(manifest: project.session.manifest, samples: project.result.samples)
            renderer.bind(geometry, settings: session.$current.compactMap { project in
                guard let project, project.id == projectID else { return nil }
                return project.displaySettings ?? ModelDisplaySettings().forOpening()
            }.eraseToAnyPublisher())
            coverage.update(model: geometry, samples: project.result.samples)
            ar.onCalibration = { session.addCalibration($0) }
            ar.onSample = { session.addSample($0) }
            if !completed { await ar.start() }
        }.onDisappear {
            guard !review || session.current?.id != projectID else { return }
            loadedProjectID = nil
            nearbyPoseConfirmation = nil; ar.stop(); renderer.cancel(); coverage.cancel()
        }
        .onReceive(renderer.$geometry) { ar.display($0); coverage.attach(to: $0) }
        .onReceive(session.$current) { project in
            if let project, project.id == projectID { coverage.update(model: geometry, samples: project.result.samples) }
        }
        .onChange(of: canRecordPose) { _, available in
            if !available { nearbyPoseConfirmation = nil }
        }
        .onChange(of: session.current?.result.samples.last?.id) { _, _ in nearbyPoseConfirmation = nil }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { nearbyPoseConfirmation = nil; ar.suspend(); coverage.cancel(); session.backgroundSave() }
            else { coverage.resume(); if !completed { Task { await ar.start() } } }
        }
        .sheet(isPresented: $displaySettingsOpen) { ModelDisplaySettingsView(geometry: geometry, renderer: renderer).environmentObject(session) }
        .fullScreenCover(isPresented: $review, onDismiss: { ar.refreshMarkers(session.current?.result.samples ?? []) }) {
            PoseReviewView(geometry: geometry, renderer: renderer, coverage: coverage).environmentObject(session)
        }
        .alert("当前 Pose 与上一个距离很近", isPresented: Binding(
            get: { nearbyPoseConfirmation != nil },
            set: { if !$0 { nearbyPoseConfirmation = nil } }
        ), presenting: nearbyPoseConfirmation) { confirmation in
            Button("仍然记录") {
                guard canRecordPose,
                      session.current?.result.samples.last?.id == confirmation.previousSampleID else { return }
                ar.recordKeyframe(confirmation.sample)
            }.accessibilityIdentifier("confirm-nearby-pose")
            Button("取消", role: .cancel) { nearbyPoseConfirmation = nil }
                .accessibilityIdentifier("cancel-nearby-pose")
        } message: { confirmation in
            Text(confirmation.message)
        }
    }
    private func teachingActionLabel(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage).font(.body)
            .frame(maxWidth: .infinity).frame(height: teachingActionLabelHeight)
            .padding(.horizontal, 7)
    }
    private var finishTeachingButton: some View {
        Button {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            finishing = true
        } label: {
            teachingActionLabel("完成示教", systemImage: "checkmark.circle")
        }
        .buttonStyle(.bordered).disabled(count == 0 || session.busy || ar.adjustingPlacement)
        .accessibilityIdentifier("finish-teaching")
        // On iPad the confirmation is a popover. Anchor it to the tapped button,
        // rather than the whole AR viewport and its other presentation modifiers.
        .confirmationDialog("完成示教？", isPresented: $finishing, titleVisibility: .visible) {
            Button("完成并扫码同步") {
                ar.stop()
                Task {
                    await session.finish(sync: false)
                    if session.error.isEmpty && completed { scanningResult = true }
                }
            }
            Button("完成并通过 AirDrop 分享") {
                ar.stop()
                Task {
                    await session.finish(sync: false)
                    if session.error.isEmpty && completed { await shareResult() }
                }
            }
            Button("完成并同步到电脑") { ar.stop(); Task { await session.finish(sync: true) } }
                .disabled(session.current?.requiresResultPairing == true)
            Button("仅完成并保存在 iPad") { ar.stop(); Task { await session.finish(sync: false) } }
            Button("继续示教", role: .cancel) {}
        } message: {
            Text("已记录 \(count) 个 Pose。完成后将锁定本次示教；可以现在同步，或仅保存在 iPad 后再同步。")
        }
    }
    private func shareResult() async {
        if let url = await session.exportResult() { resultShare = TeachingResultShareItem(url: url) }
    }
    private func syncScannedResult() {
        guard let qr = scannedResultCode else { return }
        scannedResultCode = nil
        Task { await session.syncResult(qr: qr) }
    }
    private func setSidebarCollapsed(_ collapsed: Bool) {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        sidebarCollapsed = collapsed
    }
    private var recordPoseButton: some View {
        Button {
            guard canRecordPose, nearbyPoseConfirmation == nil, let sample = ar.captureKeyframe() else { return }
            if let confirmation = NearbyPoseConfirmation(sample: sample, previousSample: session.current?.result.samples.last) {
                nearbyPoseConfirmation = confirmation
            } else {
                ar.recordKeyframe(sample)
            }
        } label: {
            Label("记录 Pose", systemImage: "plus.viewfinder").font(.title3)
                .frame(maxWidth: .infinity).padding(.vertical, 16)
        }.buttonStyle(.borderedProminent).disabled(!canRecordPose || nearbyPoseConfirmation != nil)
            .accessibilityIdentifier("capture-pose")
    }
    private var placementAdjustmentControls: some View {
        VStack(spacing: 8) {
            if ar.adjustingPlacement {
                Button {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    ar.confirmCalibration()
                } label: {
                    Text("完成调整").frame(maxWidth: .infinity, minHeight: 32)
                }.buttonStyle(.borderedProminent).disabled(!canFinishPlacementAdjustment)
                    .accessibilityIdentifier("finish-placement-adjustment")
                Button { ar.cancelPlacementAdjustment() } label: {
                    Text("取消调整").frame(maxWidth: .infinity, minHeight: 32)
                }.buttonStyle(.bordered).accessibilityIdentifier("cancel-placement-adjustment")
            } else {
                Button {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    ar.beginPlacementAdjustment()
                } label: {
                    Label("调整物体位置", systemImage: "arrow.up.and.down.and.arrow.left.and.right")
                        .frame(maxWidth: .infinity, minHeight: 32)
                }.buttonStyle(.bordered).disabled(session.busy || renderer.geometry == nil)
                    .accessibilityIdentifier("adjust-model-placement")
            }
        }.font(.subheadline)
    }
    private func modelViewport(in available: CGSize) -> some View {
        let size = zividFieldOfViewEnabled ? fieldOfView?.fittedSize(in: available) ?? available : available
        return ZStack {
            if liveCamera { ARSceneView(controller: ar) }
            else { ObjectPreviewView(geometry: geometry, rendered: renderer.geometry) }
            if zividFieldOfViewEnabled, let fieldOfView {
                ZividFieldOfViewOverlay(fieldOfView: fieldOfView, labelAtTop: sidebarCollapsed)
            }
        }.frame(width: size.width, height: size.height).clipped()
            .accessibilityElement(children: .contain).accessibilityIdentifier("teaching-render-surface")
    }
    private var fieldOfViewControl: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { zividFieldOfViewEnabled.toggle() } label: {
                    Label("Zivid 2 M70 视野", systemImage: "viewfinder")
                        .font(.subheadline).frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityHidden(true)
                Spacer(minLength: 4)
                Toggle("Zivid 2 M70 视野", isOn: $zividFieldOfViewEnabled).labelsHidden().fixedSize()
                    .tint(accent).accessibilityIdentifier("zivid-fov-toggle")
            }
            if zividFieldOfViewEnabled {
                Text("水平 56.6° · 垂直 35.6°").font(.caption).monospacedDigit().foregroundStyle(accent)
                if fieldOfView?.fullyVisible != true {
                    Text(fieldOfView == nil ? "正在获取相机视野…" : "iPad 相机视野不足，仅显示可见部分")
                        .font(.caption).foregroundStyle(fieldOfView?.fullyVisible == false ? .orange : .secondary)
                        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("zivid-fov-status")
                }
            }
        }
    }
    private var coverageControl: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { coverage.enabled.toggle() } label: {
                    Label("已示教区域", systemImage: "square.3.layers.3d")
                        .font(.subheadline).frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityHidden(true)
                Spacer(minLength: 4)
                Toggle("已示教区域", isOn: $coverage.enabled).labelsHidden().fixedSize()
                    .tint(accent).accessibilityIdentifier("teaching-coverage-toggle")
            }
            if coverage.enabled {
                HStack {
                    Text("着色强度").font(.caption)
                    Slider(value: $coverage.opacity, in: 0.05...0.6, step: 0.05)
                        .tint(.mint).accessibilityLabel("已示教区域着色强度")
                        .accessibilityIdentifier("teaching-coverage-opacity")
                    Text("\(Int((coverage.opacity * 100).rounded()))%")
                        .font(.caption.monospacedDigit()).frame(width: 32, alignment: .trailing)
                }
            }
            if coverage.preparing || !coverage.error.isEmpty {
                HStack(spacing: 6) {
                    if coverage.preparing {
                        ProgressView().controlSize(.mini)
                            .accessibilityIdentifier("teaching-coverage-progress")
                    }
                    Text(coverage.status).font(.caption)
                        .foregroundStyle(coverage.error.isEmpty ? Color.secondary : .orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("teaching-coverage-status")
                }
            }
        }
    }
    private var groundAssistanceControl: some View {
        HStack {
            Button { ar.groundAssistance.toggle() } label: {
                Label("地面辅助", systemImage: "square.3.layers.3d")
                    .font(.subheadline).frame(minHeight: 44).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityHidden(true)
            Spacer(minLength: 4)
            Toggle("地面辅助", isOn: $ar.groundAssistance).labelsHidden().fixedSize()
                .tint(accent).accessibilityIdentifier("ground-assistance")
        }
    }
    private var calibrationPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label(ar.calibrated ? "物体已放置" : ar.adjustingPlacement ? "正在调整物体" : "先放置物体", systemImage: ar.calibrated ? "checkmark.seal" : "scope").foregroundStyle(accent)
            if !ar.calibrated {
                HStack {
                    coordinate("X", $ar.referenceX); coordinate("Y", $ar.referenceY); coordinate("Z", $ar.referenceZ)
                }.disabled(ar.repositioning)
                    .onChange(of: ar.referenceX) { _, _ in ar.updatePlacement() }
                    .onChange(of: ar.referenceY) { _, _ in ar.updatePlacement() }.onChange(of: ar.referenceZ) { _, _ in ar.updatePlacement() }
                HStack { Text("方向"); Spacer(); Text("\(ar.yaw, specifier: "%.1f")°").monospacedDigit() }.font(.caption)
                Slider(value: $ar.yaw, in: -180...180).disabled(ar.repositioning).onChange(of: ar.yaw) { _, _ in ar.updatePlacement() }
                Button { withAnimation { tiltControlsOpen.toggle() } } label: {
                    HStack {
                        Text("调整物体倾斜"); Spacer()
                        Image(systemName: tiltControlsOpen ? "chevron.down" : "chevron.right")
                    }.frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).font(.caption).foregroundStyle(accent)
                    .accessibilityIdentifier("model-tilt-controls")
                    .accessibilityValue(tiltControlsOpen ? "已展开" : "已折叠")
                if tiltControlsOpen {
                    VStack(spacing: 10) {
                        tiltControl("左右倾斜", angle: $ar.pitch, id: "model-pitch")
                        tiltControl("前后倾斜", angle: $ar.roll, id: "model-roll")
                    }.font(.caption).disabled(ar.repositioning)
                }
                Button {
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    if ar.placed && !ar.repositioning { ar.beginRepositioning() }
                    else { ar.placeObject() }
                } label: {
                    teachingActionLabel(ar.repositioning ? "放到准星位置" : ar.placed ? "重新放置物体" : "放置物体",
                                        systemImage: "scope")
                }.buttonStyle(.bordered)
                    .disabled(!ar.placementActionEnabled)
                    .accessibilityIdentifier("place-model")
                if ar.repositioning {
                    Button("取消重新放置") { ar.cancelRepositioning() }.buttonStyle(.bordered)
                        .accessibilityIdentifier("cancel-model-repositioning")
                    Text("物体暂时隐藏，点击画面选择新位置；取消可恢复原位置。").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
    private func tiltControl(_ label: String, angle: Binding<Float>, id: String) -> some View {
        VStack(spacing: 4) {
            HStack { Text(label); Spacer(); Text("\(angle.wrappedValue, specifier: "%.1f")°").monospacedDigit().accessibilityIdentifier("\(id)-value") }
            Slider(value: angle, in: -180...180).accessibilityLabel(label).accessibilityIdentifier(id)
                .onChange(of: angle.wrappedValue) { _, _ in ar.updatePlacement() }
        }
    }
    private func coordinate(_ name: String, _ value: Binding<Float>) -> some View {
        VStack(alignment: .leading) {
            Text(name).font(.caption).foregroundStyle(.secondary)
            TextField(name, value: value, format: .number.precision(.fractionLength(0...4))).textFieldStyle(.roundedBorder)
                .keyboardType(.numbersAndPunctuation).font(.system(.caption, design: .monospaced))
        }
    }
}

struct ModelDisplaySettingsView: View {
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.dismiss) private var dismiss
    let geometry: ModelGeometry
    @ObservedObject var renderer: ModelRenderer
    private var settings: Binding<ModelDisplaySettings> {
        Binding(get: { session.displaySettings }, set: { session.setDisplaySettings($0) })
    }
    private var mode: Binding<ModelDisplayMode> {
        Binding(get: { geometry.usesMesh(session.displaySettings) ? .mesh : .points }, set: { value in
            var next = session.displaySettings; next.mode = value; session.setDisplaySettings(next)
        })
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    ObjectPreviewView(geometry: geometry, rendered: renderer.geometry)
                        .frame(height: 260).clipShape(RoundedRectangle(cornerRadius: 14))
                        .accessibilityLabel("物体显示预览，拖动旋转，双指缩放")
                    HStack(spacing: 12) {
                        ForEach(ModelDisplayMode.allCases) { option in
                            Button { mode.wrappedValue = option } label: {
                                Label(option.label, systemImage: option == .mesh ? "cube.transparent" : "circle.dotted")
                                    .frame(maxWidth: .infinity).padding(.vertical, 8)
                            }.buttonStyle(.bordered)
                                .tint(mode.wrappedValue == option ? accent : .secondary)
                                .accessibilityAddTraits(mode.wrappedValue == option ? .isSelected : [])
                                .accessibilityIdentifier("display-mode-\(option.rawValue)")
                                .disabled(option == .mesh && geometry.indices == 0)
                        }
                    }
                    HStack {
                        Label("点云密度", systemImage: "circle.dotted")
                        Spacer()
                        Picker("点云密度", selection: settings.pointDensity) {
                            ForEach(PointDensity.allCases) { Text($0.label).tag($0) }
                        }.pickerStyle(.menu).accessibilityIdentifier("point-density")
                            .disabled(mode.wrappedValue != .points)
                    }
                    HStack {
                        Label("Mesh 质量", systemImage: "cube.transparent")
                        Spacer()
                        Picker("Mesh 质量", selection: settings.meshQuality) {
                            ForEach(MeshQuality.allCases) { Text($0.label).tag($0) }
                        }.pickerStyle(.menu).accessibilityIdentifier("mesh-quality")
                            .disabled(!geometry.usesMesh(session.displaySettings))
                    }
                    Divider()
                    if renderer.preparing { ProgressView("正在本机更新显示…").accessibilityIdentifier("model-render-progress") }
                    Text(geometry.summary(renderer.appliedSettings ?? session.displaySettings))
                        .font(.system(.callout, design: .monospaced)).foregroundStyle(accent)
                        .accessibilityIdentifier("model-render-summary")
                    if !renderer.error.isEmpty { Text(renderer.error).foregroundStyle(.orange) }
                    if geometry.indices == 0 {
                        Text("此项目只有点云。若电脑源模型包含 Mesh，请新建传输以接收网格。")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }.padding(24)
            }
            .background(Color(red: 0.025, green: 0.05, blue: 0.065))
            .navigationTitle("显示设置").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() }.accessibilityIdentifier("close-display-settings") } }
        }.presentationDetents([.large])
    }
}

struct ObjectPreviewView: UIViewRepresentable {
    let geometry: ModelGeometry
    let rendered: SCNGeometry?
    func makeUIView(context: Context) -> SCNView {
        let view = SCNView(); view.scene = SCNScene(); view.backgroundColor = UIColor(red: 0.025, green: 0.05, blue: 0.065, alpha: 1)
        let object = SCNNode(geometry: rendered); object.name = "preview-object"; view.scene?.rootNode.addChildNode(object)
        let minimum = geometry.minimum, maximum = geometry.maximum
        let center = SCNVector3((minimum.x + maximum.x) / 2, (minimum.y + maximum.y) / 2, (minimum.z + maximum.z) / 2)
        let size = max(maximum.x - minimum.x, maximum.y - minimum.y, maximum.z - minimum.z, 0.1)
        let camera = SCNNode(); camera.camera = SCNCamera(); camera.camera?.zNear = 0.001; camera.camera?.zFar = Double(max(size * 100, 1000))
        camera.camera?.projectionDirection = .vertical
        camera.camera?.fieldOfView = ZividFieldOfView.previewVerticalDegrees
        camera.position = SCNVector3(center.x + size * 1.2, center.y - size * 1.8, center.z + size)
        camera.look(at: center, up: SCNVector3(0, 0, 1), localFront: SCNVector3(0, 0, -1))
        view.scene?.rootNode.addChildNode(camera); view.pointOfView = camera
        view.allowsCameraControl = true; view.defaultCameraController.worldUp = SCNVector3(0, 0, 1)
        view.defaultCameraController.target = center
        return view
    }
    func updateUIView(_ view: SCNView, context: Context) {
        let object = view.scene?.rootNode.childNode(withName: "preview-object", recursively: false)
        if object?.geometry !== rendered { object?.geometry = rendered }
    }
}

struct PoseReviewView: View {
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.dismiss) private var dismiss
    @State private var selectedID: String?
    @State private var poseName = ""
    @State private var selectingForDeletion = false
    @State private var deletionIDs: Set<String> = []
    @State private var previewMode: PosePreviewMode = .interactive
    @State private var previewReset = 0
    @State private var showsPoseCamera = false
    @State private var overviewExpanded = false
    @State private var poseEditorHeight: CGFloat = 0
    @StateObject private var previewPreparation = PosePreviewPreparation()
    @FocusState private var poseNameFocused: Bool
    let geometry: ModelGeometry
    @ObservedObject var renderer: ModelRenderer
    let coverage: TeachingCoverageRenderer
    private var samples: [TeachingSample] { session.current?.result.samples ?? [] }
    private var selected: TeachingSample? { samples.first { $0.id == selectedID } ?? samples.first }
    private var completed: Bool { session.current?.result.completedAt != nil }
    var body: some View {
        NavigationStack {
            GeometryReader { viewport in
                if viewport.size.width >= 1000 && viewport.size.width > viewport.size.height {
                    HStack(spacing: 0) {
                        VStack(spacing: 0) {
                            poseList
                            poseEditorPanel(maximumHeight: min(290, viewport.size.height * 0.45))
                        }.frame(width: 280)
                        Divider()
                        posePreview
                    }
                } else {
                    VStack(spacing: 0) {
                        posePreview.frame(height: max(180, viewport.size.height * 0.62))
                        Divider()
                        if viewport.size.width >= 600 {
                            HStack(alignment: .top, spacing: 0) {
                                poseList.frame(width: viewport.size.width * 0.38)
                                Divider()
                                poseEditorPanel(maximumHeight: max(0, viewport.size.height - max(180, viewport.size.height * 0.62) - 1))
                            }
                        } else {
                            VStack(spacing: 0) {
                                poseList
                                poseEditorPanel(maximumHeight: min(190, viewport.size.height * 0.3))
                            }
                        }
                    }
                }
            }
            .background(Color(red: 0.025, green: 0.05, blue: 0.065))
            .accessibilityElement(children: .contain).accessibilityIdentifier("pose-review-page")
            .toolbar(.hidden, for: .navigationBar)
        }.onAppear { poseName = selected?.name ?? "" }
            .onChange(of: samples.map(\.id)) { _, ids in
                deletionIDs.formIntersection(ids)
                if ids.isEmpty {
                    endDeletionSelection(); selectedID = nil; poseName = ""; overviewExpanded = false
                }
            }
            .onChange(of: completed) { _, locked in
                if locked { endDeletionSelection() }
            }
            .onChange(of: previewMode) { _, mode in
                if mode == .image { overviewExpanded = false }
            }
            .task(id: selected?.id) {
                if let selected, let model = session.geometry {
                    await previewPreparation.prepare(sample: selected, model: model, coverage: coverage)
                }
            }
    }

    private var poseList: some View {
        VStack(spacing: 0) {
            if selectingForDeletion {
                HStack {
                    Button {
                        deletionIDs = allPosesSelected ? [] : Set(samples.map(\.id))
                    } label: {
                        Label("全选", systemImage: allPosesSelected ? "checkmark.square.fill" : deletionIDs.isEmpty ? "square" : "minus.square.fill")
                    }.accessibilityIdentifier("select-all-poses")
                        .accessibilityValue(allPosesSelected ? "已全选" : deletionIDs.isEmpty ? "未选择" : "部分选择")
                    Spacer()
                    Text("已选 \(deletionIDs.count)/\(samples.count)").font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("selected-poses-count")
                }
                .padding(.horizontal, 20).frame(minHeight: 48)
                Divider()
            }
            List {
                Section {
                    ForEach(samples) { sample in
                        poseRow(sample)
                    }
                } header: {
                    Text("\(samples.count) 个 Pose").accessibilityIdentifier("pose-review-count")
                }
            }.listStyle(.plain).scrollDismissesKeyboard(.interactively)
                .accessibilityIdentifier("pose-review-list")
        }
    }

    private var allPosesSelected: Bool { !samples.isEmpty && deletionIDs.count == samples.count }

    private func poseRow(_ sample: TeachingSample) -> some View {
        let highlighted = selectingForDeletion ? deletionIDs.contains(sample.id) : sample.id == selected?.id
        return Button {
            poseNameFocused = false; selectedID = sample.id; poseName = sample.name
            if selectingForDeletion {
                if deletionIDs.contains(sample.id) { deletionIDs.remove(sample.id) }
                else { deletionIDs.insert(sample.id) }
            }
        } label: {
            HStack(spacing: 12) {
                if selectingForDeletion {
                    Image(systemName: deletionIDs.contains(sample.id) ? "checkmark.square.fill" : "square")
                        .font(.title3).foregroundStyle(accent)
                }
                VStack(alignment: .leading, spacing: 7) {
                    Text(sample.name.isEmpty ? "Pose" : sample.name)
                        .foregroundStyle(highlighted ? accent : .primary)
                    Text(sample.capturedAt).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }.padding(.vertical, 5).contentShape(Rectangle())
        }.listRowBackground(highlighted ? accent.opacity(0.12) : Color.clear)
            .accessibilityIdentifier("review-pose-\(sample.id)")
            .accessibilityValue(selectingForDeletion ? (deletionIDs.contains(sample.id) ? "已勾选" : "未勾选") : "")
            .accessibilityAddTraits(highlighted ? .isSelected : [])
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if !completed && !selectingForDeletion {
                    Button("删除", role: .destructive) { deletePoses([sample.id]) }
                        .tint(.red)
                        .accessibilityIdentifier("swipe-delete-pose-\(sample.id)")
                }
            }
    }

    private var posePreview: some View {
        VStack(spacing: 0) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    previewModeButtons; Spacer(minLength: 0); previewQualityControl; previewActions
                }
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 12) { previewModeButtons; Spacer(minLength: 0); previewActions }
                    previewQualityControl
                }
                VStack(alignment: .trailing, spacing: 8) {
                    HStack { previewModeButtons; Spacer(minLength: 0) }
                    HStack { previewQualityControl; Spacer(minLength: 0) }
                    previewActions
                }
            }.padding(12)
            if !renderer.error.isEmpty {
                Text(renderer.error).font(.caption).foregroundStyle(.orange)
                    .padding(.horizontal, 12).padding(.bottom, 8)
            }
            Divider()
            if let selected {
                let aspect = selected.previewAspect ?? (4.0 / 3.0)
                let ready = previewPreparation.sampleID == selected.id
                GeometryReader { area in
                    let recordedAspect = CGFloat(aspect.isFinite && aspect > 0 ? aspect : 4.0 / 3.0)
                    let expanded = overviewExpanded && previewMode == .interactive
                    let width = expanded ? area.size.width : min(area.size.width, area.size.height * recordedAspect)
                    let height = expanded ? area.size.height : width / recordedAspect
                    PosePreviewView(rendered: renderer.geometry, overview: previewPreparation.overview,
                                    footprint: ready ? previewPreparation.footprint : nil,
                                    status: ready ? previewPreparation.status : "正在提取当前 Pose 点云…",
                                    sample: selected, mode: previewMode, resetRevision: previewReset,
                                    showsCameraPose: $showsPoseCamera, overviewExpanded: $overviewExpanded)
                        .frame(width: width, height: height)
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("\(selected.name) 的物体视角")
                        .accessibilityValue(previewMode == .interactive ? "3D 交互视图" : "2D 记录视角图像")
                        .accessibilityIdentifier("pose-review-preview")
                        .frame(width: area.size.width, height: area.size.height)
                }
            } else { ContentUnavailableView("还没有 Pose", systemImage: "viewfinder") }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.black.opacity(0.25))
            .accessibilityElement(children: .contain).accessibilityIdentifier("pose-review-viewport")
    }

    private var previewModeButtons: some View {
        HStack(spacing: 6) {
            ForEach(PosePreviewMode.allCases) { mode in
                Button { poseNameFocused = false; previewMode = mode } label: {
                    Label(mode == .interactive ? "3D 点云 / 模型" : "2D 图像",
                          systemImage: mode == .interactive ? "cube.transparent" : "photo")
                        .font(.subheadline.weight(.medium)).padding(.vertical, 5)
                }.buttonStyle(.bordered).tint(previewMode == mode ? accent : .secondary)
                    .accessibilityAddTraits(previewMode == mode ? .isSelected : [])
                    .accessibilityIdentifier("pose-preview-mode-\(mode.rawValue)")
            }
        }.fixedSize(horizontal: true, vertical: false).disabled(selected == nil)
    }

    private var qualityOptions: [ModelDisplaySettings] {
        let current = session.displaySettings
        let candidates: [ModelDisplaySettings]
        if geometry.usesMesh(current) {
            candidates = MeshQuality.allCases.map { quality in
                var settings = current; settings.meshQuality = quality; return settings
            }
        } else {
            candidates = PointDensity.allCases.map { density in
                var settings = current; settings.pointDensity = density; return settings
            }
        }
        // Automatic and lightweight budgets can fall between percentage presets.
        // Order by actual draw count, merging equivalent stops for small models.
        var byCount: [Int: ModelDisplaySettings] = [:]
        for settings in [current] + candidates where byCount[geometry.renderedCount(settings)] == nil {
            byCount[geometry.renderedCount(settings)] = settings
        }
        return byCount.sorted { $0.key < $1.key }.map(\.value)
    }

    private var previewQualityControl: some View {
        let options = qualityOptions
        let count = geometry.renderedCount(session.displaySettings)
        let total = geometry.usesMesh(session.displaySettings) ? geometry.indices / 3 : geometry.vertices
        let percentage = (Double(count) / Double(max(total, 1))).formatted(.percent.precision(.fractionLength(0...1)))
        let selection = Binding<Double>(
            get: { Double(options.firstIndex { geometry.renderedCount($0) == count } ?? 0) },
            set: { value in
                let index = min(max(Int(value.rounded()), 0), options.count - 1)
                let settings = options[index]
                guard settings != session.displaySettings else { return }
                session.setDisplaySettings(settings)
            })
        return HStack(spacing: 6) {
            Text("质量").font(.caption).foregroundStyle(.secondary)
            Slider(value: selection, in: 0...Double(max(options.count - 1, 1)), step: 1)
                .frame(width: 100).tint(accent)
                .disabled(selected == nil || options.count < 2)
                .accessibilityLabel("点云 / 模型显示质量")
                .accessibilityValue(percentage)
                .accessibilityHint("向右提高细节，向左提升流畅度")
                .accessibilityIdentifier("pose-preview-quality")
            Text(percentage).font(.caption.monospacedDigit()).foregroundStyle(accent)
                .frame(width: 46, alignment: .trailing)
            ZStack {
                if renderer.preparing {
                    ProgressView().controlSize(.mini)
                        .accessibilityLabel("正在更新显示质量")
                        .accessibilityIdentifier("pose-preview-quality-progress")
                }
            }.frame(width: 14, height: 14)
        }.fixedSize(horizontal: true, vertical: false)
    }

    private var previewActions: some View {
        HStack(spacing: 8) {
            resetPreviewButton
            Button { poseNameFocused = false; dismiss() } label: {
                Label("返回示教", systemImage: "arrow.uturn.backward")
                    .font(.subheadline).padding(.vertical, 5)
            }.buttonStyle(.bordered).tint(accent)
                .accessibilityIdentifier("close-pose-review")
        }.fixedSize(horizontal: true, vertical: false)
    }

    private var resetPreviewButton: some View {
        Button { previewReset += 1 } label: {
            Label(previewMode == .image ? "恢复完整画幅" : "恢复记录视角", systemImage: "arrow.counterclockwise").font(.subheadline)
                .padding(.vertical, 5)
        }.buttonStyle(.bordered).disabled(selected == nil)
            .accessibilityIdentifier("reset-pose-preview")
    }

    private func poseEditorPanel(maximumHeight: CGFloat) -> some View {
        ScrollView {
            poseEditor.padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { poseEditorHeight = $0 }
        }
        // Fit short details to their content; retain scrolling for editing and larger text.
        .frame(height: min(poseEditorHeight, maximumHeight))
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(Color(red: 0.055, green: 0.10, blue: 0.12))
        .overlay(alignment: .top) { Rectangle().fill(accent.opacity(0.4)).frame(height: 1) }
        .accessibilityElement(children: .contain).accessibilityIdentifier("pose-review-details")
    }

    @ViewBuilder private var poseEditor: some View {
        if selectingForDeletion {
            VStack(alignment: .leading, spacing: 14) {
                Text("选择要删除的 Pose").font(.headline)
                Text("勾选列表中的 Pose，或使用全选。点击 Pose 可同时查看对应视角。")
                    .font(.caption).foregroundStyle(.secondary)
                Button("删除所选（\(deletionIDs.count)）", role: .destructive) {
                    deletePoses(deletionIDs)
                    endDeletionSelection()
                }.buttonStyle(.borderedProminent).tint(.red)
                    .disabled(deletionIDs.isEmpty || session.busy)
                    .accessibilityIdentifier("delete-selected-poses")
                Button("取消多选") { endDeletionSelection() }.buttonStyle(.bordered)
                    .accessibilityIdentifier("cancel-pose-selection")
            }.frame(maxWidth: .infinity, alignment: .leading)
        } else if let selected {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("Pose 详情").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 0)
                    Text(selected.name.isEmpty ? "Pose" : selected.name).font(.headline)
                        .multilineTextAlignment(.trailing)
                }
                let p = selected.cameraPose.position
                Text("X \(p.x, specifier: "%.4f") m\nY \(p.y, specifier: "%.4f") m\nZ \(p.z, specifier: "%.4f") m")
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                if !completed {
                    TextField("Pose 名称", text: $poseName).textFieldStyle(.roundedBorder)
                        .focused($poseNameFocused)
                        .accessibilityIdentifier("review-pose-name")
                    HStack {
                        Button("保存名称") { session.renameSample(selected.id, name: poseName); poseNameFocused = false }
                            .accessibilityIdentifier("save-pose-name")
                        Spacer()
                        Button("删除", role: .destructive) {
                            poseNameFocused = false
                            deletionIDs = []; selectingForDeletion = true
                        }.accessibilityIdentifier("delete-review-pose")
                    }.buttonStyle(.bordered)
                }
                if completed {
                    Text("本次示教已完成，Pose 已锁定。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if !session.error.isEmpty { Text(session.error).font(.caption).foregroundStyle(.orange) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func deletePoses(_ ids: Set<String>) {
        guard !completed, !session.busy, !ids.isEmpty else { return }
        poseNameFocused = false
        let viewedID = selected?.id
        session.deleteSamples(ids)
        deletionIDs.subtract(ids)
        if let viewedID, ids.contains(viewedID) {
            selectedID = nil; poseName = samples.first?.name ?? ""
        }
    }

    private func endDeletionSelection() {
        selectingForDeletion = false; deletionIDs = []
    }
}
