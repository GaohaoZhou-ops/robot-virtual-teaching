import SwiftUI
import SceneKit

private let accent = Color(red: 0.35, green: 0.86, blue: 0.91)

private struct PhoneCaptureButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .frame(width: 84, height: 84)
            .foregroundStyle(enabled ? Color(red: 0.02, green: 0.12, blue: 0.14) : .white.opacity(0.45))
            .background(enabled ? accent : .white.opacity(0.12), in: Circle())
            .overlay(Circle().strokeBorder(enabled ? .white.opacity(0.4) : .white.opacity(0.16), lineWidth: 1))
            .contentShape(Circle())
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private extension TeachingPoseCategory {
    var color: Color { Color(red: Double(rgb.x), green: Double(rgb.y), blue: Double(rgb.z)) }
}

private struct PoseOriginLegend: View {
    let samples: [TeachingSample]
    let coveragePercentages: [TeachingPoseCategory: String]
    let coverageTitle: String
    var rowSpacing: CGFloat = 10
    var body: some View {
        let counts = TeachingPoseCounts(samples)
        VStack(alignment: .leading, spacing: rowSpacing) {
            ForEach(TeachingPoseCategory.allCases.filter { $0 != .desktop || counts[$0] > 0 }, id: \.rawValue) { category in
                let percentage = counts[category] == 0 ? "0%" : coveragePercentages[category] ?? "—"
                HStack {
                    Label(category.label, systemImage: category.symbol).foregroundStyle(category.color)
                    Spacer(minLength: 8)
                    Text("\(counts[category]) 个 Pose").monospacedDigit().foregroundStyle(category.color)
                    Text(percentage).monospacedDigit().foregroundStyle(category.color)
                        .frame(width: 54, alignment: .trailing)
                        .accessibilityLabel("\(coverageTitle) \(percentage)")
                }.accessibilityElement(children: .combine)
                    .accessibilityIdentifier("pose-count-\(category.rawValue)")
            }
        }.font(.caption).accessibilityElement(children: .contain)
    }
}

struct ContentView: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var screen: ScreenCollaboration
    @State private var collaboration = !TeachingSession.supportsLocalTeaching
    @State private var collaborationWirelessExpanded = false
    private var pairingBusy: Bool { session.busy || screen.connecting }
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var discovery = LANServiceDiscovery()
    @StateObject private var usbReceiver = USBFileReceiver()
    @State private var scanning = false
    @State private var scannedCode: PairingQRCode?
    @State private var pairingServer: DiscoveredTeachingServer?
    @State private var requestedWiFiPairing: (server: DiscoveredTeachingServer, code: String)?
    @State private var projectToDelete: LocalProject?
    @State private var revealedProjectID: String?
    @State private var deleteActionFrames: [String: CGRect] = [:]
    @State private var refreshingUSB = false
    @State private var usbRefreshTask: Task<Void, Never>?
    @State private var phonePairingMethod = 0
    var body: some View {
        GeometryReader { viewport in
        Group {
            if TeachingSession.supportsLocalTeaching, let project = session.current, let geometry = session.geometry {
                TeachingView(projectID: project.id, geometry: geometry, bottomSafeArea: viewport.safeAreaInsets.bottom)
            } else { library(bottomSafeArea: viewport.safeAreaInsets.bottom) }
        }.frame(width: viewport.size.width, height: viewport.size.height)
        }.tint(accent).task { await session.reload() }
    }
    private func library(bottomSafeArea: CGFloat) -> some View {
        GeometryReader { viewport in
            let wide = viewport.size.width >= 1000 && viewport.size.width > viewport.size.height
            let padding: CGFloat = viewport.size.width >= 700 ? 28 : 20
            // Include the home-indicator safe area in the page's bottom margin.
            let bottomPadding = max(0, padding - bottomSafeArea)
            Group {
            if TeachingDevice.isPhone {
                // One scroll surface keeps every connection method and project
                // reachable with the keyboard open or in a short landscape window.
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        libraryHeader
                        if !ARController.supported {
                            Label(localTeachingNotice, systemImage: "info.circle")
                                .font(.caption).foregroundStyle(.orange)
                                .accessibilityIdentifier("local-teaching-availability")
                        }
                        pairingPanel
                        localProjectsPanel
                    }.padding(16)
                }.scrollBounceBehavior(.basedOnSize)
                    .accessibilityIdentifier("library-phone-scroll")
            } else {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 24) {
                    libraryHeader
                    if !ARController.supported {
                        Label(localTeachingNotice, systemImage: "info.circle")
                            .font(.callout).foregroundStyle(.orange).padding().frame(maxWidth: .infinity, alignment: .leading)
                            .background(.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
                            .accessibilityIdentifier("local-teaching-availability")
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                if wide {
                    HStack(alignment: .top, spacing: 24) {
                        pairingPanel.frame(width: min(420, viewport.size.width * 0.35))
                        localProjectsPanel
                    }
                } else {
                    VStack(spacing: 24) {
                        pairingPanel
                        localProjectsPanel
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            .padding(.horizontal, padding).padding(.top, padding).padding(.bottom, bottomPadding)
            .frame(width: viewport.size.width, height: viewport.size.height, alignment: .topLeading)
            }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(TeachingDevice.isPhone ? "library-phone-scroll" : "library-content")
            .scrollDismissesKeyboard(.interactively)
            .contentShape(Rectangle())
            .coordinateSpace(name: LocalProjectSwipeLayout.coordinateSpace)
            .onPreferenceChange(LocalProjectDeleteFrames.self) { deleteActionFrames = $0 }
            .simultaneousGesture(SpatialTapGesture(coordinateSpace: .named(LocalProjectSwipeLayout.coordinateSpace)).onEnded { tap in
                handleLibraryTap(at: tap.location)
            })
        }
        .background(Color(red: 0.025, green: 0.05, blue: 0.065).ignoresSafeArea())
        .sheet(isPresented: $scanning, onDismiss: finishScanning) {
            PairingScannerView(purpose: collaboration ? .screen : .receiveModel) { qr in scannedCode = qr; scanning = false }
        }
        .sheet(item: $pairingServer, onDismiss: finishWiFiPairing) { server in
            WiFiPairingSheet(server: server, collaboration: collaboration) { code in
                requestedWiFiPairing = (server, code)
                pairingServer = nil
            }
        }
        .alert("从此 \(TeachingDevice.storageName) 删除模型？", isPresented: Binding(
            get: { projectToDelete != nil }, set: { if !$0 { projectToDelete = nil } }
        ), presenting: projectToDelete) { project in
            Button("删除模型与全部 Pose", role: .destructive) {
                Task { await session.deleteLocalProject(project) }
            }.accessibilityIdentifier("confirm-delete-local-project")
            Button("取消", role: .cancel) {}.accessibilityIdentifier("cancel-delete-local-project")
        } message: { project in
            Text("将删除「\(project.session.manifest.name)」在此 \(TeachingDevice.storageName) 上的模型、全部 \(project.result.samples.count) 个 Pose 和应用生成的导出副本。电脑上的工程和已同步结果不受影响。")
        }
        .onAppear { usbReceiver.start(); if !scanning && pairingServer == nil { searchConfiguredServer() } }
        .onDisappear { stopUSBRefresh(); usbReceiver.stop(); discovery.stop() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { stopUSBRefresh() }
            if phase == .active && session.current == nil { usbReceiver.start() } else { usbReceiver.stop() }
            if phase == .active && session.current == nil && !scanning && pairingServer == nil { searchConfiguredServer() }
            else { discovery.stop() }
        }
        .onChange(of: session.serverAddress) { _, _ in discovery.resetProbe() }
        .onChange(of: collaboration) { _, _ in collaborationWirelessExpanded = false }
    }
    private func handleLibraryTap(at location: CGPoint) {
        guard TeachingSession.supportsLocalTeaching, !pairingBusy else { return }
        // A native scroll view can consume the first button touch while settling.
        // Route a tap on its visible delete area to the same confirmation before
        // dismissing the swipe; outside taps still reach the other controls.
        if let id = revealedProjectID, let frame = deleteActionFrames[id], frame.contains(location),
           let project = session.projects.first(where: { $0.id == id }) {
            projectToDelete = project
        }
        revealedProjectID = nil
    }
    private func finishScanning() {
        if let qr = scannedCode {
            scannedCode = nil
            if qr.isScreen {
                collaboration = true; session.serverAddress = qr.address
                Task { await screen.connect(address: qr.address, code: qr.code, deviceID: session.deviceID, qr: qr) }
            } else { Task { await session.pair(qr: qr) } }
        } else { searchConfiguredServer() }
    }
    private func beginScanning() {
        discovery.stop()
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        // Finish the native field's resignation before SwiftUI presents the camera.
        DispatchQueue.main.async { scanning = true }
    }
    private var canPairManually: Bool {
        !pairingBusy && !scanning && pairingServer == nil && session.current == nil
            && session.serverConnection.canConnect && PairingCode.isValid(session.code)
    }
    private func pairManually() {
        guard canPairManually else { return }
        if collaboration {
            Task { await screen.connect(address: session.serverAddress, code: session.code, deviceID: session.deviceID) }
        } else { Task { await session.pair() } }
    }
    private func presentWiFiPairing(_ server: DiscoveredTeachingServer) {
        guard !pairingBusy, !scanning, pairingServer == nil, session.current == nil else { return }
        discovery.stop()
        session.serverAddress = server.address
        session.code = ""; session.error = ""
        requestedWiFiPairing = nil
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        pairingServer = server
    }
    private func presentAddressPairing() {
        guard session.serverConnection.canConnect else { return }
        let address = session.serverAddress
        presentWiFiPairing(discovery.servers.first(where: { $0.address == address })
            ?? DiscoveredTeachingServer(id: address, name: "指定的电脑", address: address))
    }
    private func finishWiFiPairing() {
        if let request = requestedWiFiPairing {
            requestedWiFiPairing = nil
            session.serverAddress = request.server.address
            session.code = request.code
            pairManually()
        } else if !pairingBusy && !scanning && session.current == nil {
            searchConfiguredServer()
        }
    }
    private func searchConfiguredServer() {
        guard !pairingBusy, !scanning, pairingServer == nil, session.current == nil else { return }
        discovery.probe(address: session.serverAddress)
    }
    private var libraryHeader: some View {
        HStack(alignment: .center, spacing: 24) {
            VStack(alignment: .leading, spacing: 10) {
                Text("虚拟示教").font(TeachingDevice.isPhone ? .title.weight(.medium) : .largeTitle.weight(.medium))
                Text(TeachingDevice.isPhone ? "ATLAS / IPHONE" : "ATLAS / IPAD").font(.system(.caption, design: .monospaced)).tracking(3).foregroundStyle(accent)
            }
            Spacer(minLength: 0)
            Image(systemName: TeachingDevice.isPhone ? "iphone" : "ipad.landscape").font(.system(size: TeachingDevice.isPhone ? 44 : 60, weight: .ultraLight)).foregroundStyle(accent)
                .accessibilityHidden(true)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    private var localTeachingNotice: String {
        TeachingSession.supportsLocalTeaching
            ? "当前设备可接收、查看物体和已有 Pose；AR 示教需要配备 LiDAR 的真机。"
            : TeachingSession.localTeachingUnavailableMessage
    }
    private var pairingPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("与电脑配对", systemImage: "desktopcomputer").font(.title2.weight(.medium))
            if !TeachingDevice.isPhone || !TeachingSession.supportsLocalTeaching {
                LibraryPairingPurposePicker(collaboration: $collaboration,
                    localTeachingAvailable: TeachingSession.supportsLocalTeaching, busy: pairingBusy)
                    .frame(height: 32)
            }
            Divider().padding(.vertical, 8)
            if TeachingDevice.isPhone {
                pairingContents
            } else {
                ScrollView { pairingContents }
                    .scrollBounceBehavior(.basedOnSize)
                    .accessibilityIdentifier("library-pairing-scroll")
            }
        }
        .padding(TeachingDevice.isPhone ? 16 : 24)
        .frame(maxWidth: .infinity, maxHeight: TeachingDevice.isPhone ? nil : .infinity, alignment: .topLeading)
        .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 18))
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .accessibilityElement(children: .contain).accessibilityIdentifier("library-pairing-panel")
    }
    @ViewBuilder private var pairingContents: some View {
        if collaboration { collaborationPairingContents }
        else { modelPairingContents }
    }
    private var collaborationPairingContents: some View {
        VStack(alignment: .leading, spacing: 18) {
            Label(screen.connecting ? "正在连接画面协作…" : "等待电脑端发起协作", systemImage: "display")
                .font(.headline).foregroundStyle(accent)
                .accessibilityIdentifier("screen-pairing-status")
            Text("在电脑端打开「设备 → iPad / iPhone → 画面协作」，选择连接方式。")
                .font(.callout).foregroundStyle(.secondary)
            if screen.connecting {
                HStack {
                    ProgressView("连接成功后将自动进入协作页面")
                    Spacer(minLength: 8)
                    Button("取消", action: screen.finish)
                }.font(.callout)
            } else {
                Text("数据线连接：保持此 App 打开，在 Mac 端点击「开始协作」即可。")
                    .font(.callout).foregroundStyle(.secondary)
                Text("扫码或 Wi-Fi：先在电脑端生成二维码或配对码，再展开下方入口完成连接。Windows 请使用这两种方式。")
                    .font(.callout).foregroundStyle(.secondary)
            }
            if !screen.connectionError.isEmpty {
                Text(screen.connectionError).font(.callout).foregroundStyle(.orange).textSelection(.enabled)
            }
            Divider()
            Button {
                collaborationWirelessExpanded.toggle()
                if collaborationWirelessExpanded { searchConfiguredServer() }
            } label: {
                HStack {
                    Text("扫码 / Wi-Fi 连接")
                    Spacer()
                    Image(systemName: collaborationWirelessExpanded ? "chevron.up" : "chevron.down")
                }.font(.body).padding(.vertical, 10).contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(accent).disabled(pairingBusy)
                .accessibilityValue(collaborationWirelessExpanded ? "已展开" : "已收起")
                .accessibilityIdentifier("screen-pairing-wireless")
            if collaborationWirelessExpanded {
                scanPairingButton
                Text("Wi-Fi 连接").font(.headline)
                LANAddressFields(address: $session.serverConnection, onSubmit: presentAddressPairing).disabled(pairingBusy)
                discoveryPanel
            }
        }.frame(maxWidth: .infinity, alignment: .topLeading)
    }
    private var scanPairingButton: some View {
        Button(action: beginScanning) {
            pairingActionLabel("扫码配对", systemImage: "qrcode.viewfinder")
        }.buttonStyle(.bordered).disabled(pairingBusy).accessibilityIdentifier("scan-pairing-code")
    }
    private var modelPairingContents: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let progress = session.transferProgress { modelTransferProgress(progress) }
            if TeachingDevice.isPhone {
                Picker("连接方式", selection: $phonePairingMethod) {
                    Text("扫码").tag(0)
                    Text("Wi-Fi").tag(1)
                    Text("数据线").tag(2)
                }.pickerStyle(.segmented).disabled(pairingBusy)
                    .accessibilityIdentifier("phone-pairing-method")
            }
            if !TeachingDevice.isPhone || phonePairingMethod == 0 {
            pairingMethodHeader("方式一", title: "扫码配对", symbol: "qrcode")
            scanPairingButton
            }
            if !TeachingDevice.isPhone { Divider().padding(.vertical, 4) }
            if !TeachingDevice.isPhone || phonePairingMethod == 1 {
            pairingMethodHeader("方式二", title: "Wifi连接", symbol: "globe")
            LANAddressFields(address: $session.serverConnection, onSubmit: presentAddressPairing).disabled(pairingBusy)
            discoveryPanel
            }
            if !TeachingDevice.isPhone { Divider().padding(.vertical, 4) }
            if !TeachingDevice.isPhone || phonePairingMethod == 2 {
                usbReceivingPanel
            }
            if session.busy && session.transferProgress == nil { ProgressView() }
            if !session.error.isEmpty { Text(session.error).font(.callout).foregroundStyle(.orange).textSelection(.enabled) }
            if session.error.hasPrefix("接收失败：") {
                Button("重试连接") { pairManually() }
                    .buttonStyle(.bordered).disabled(!canPairManually).accessibilityIdentifier("retry-pairing")
            }
            Spacer(minLength: 4)
            if !session.status.isEmpty && session.transferProgress == nil {
                Text(session.status).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
    private var usbReceivingPanel: some View {
        VStack(alignment: .leading, spacing: 10) {
            pairingMethodHeader("方式三", title: "数据线连接", symbol: "cable.connector")
            VStack(alignment: .leading, spacing: 8) {
                Button(action: refreshUSBConnection) {
                    pairingActionLabel("刷新数据线状态", systemImage: "arrow.clockwise", refreshing: refreshingUSB, activity: .refresh)
                }.buttonStyle(.bordered).disabled(pairingBusy || refreshingUSB)
                    .accessibilityValue(refreshingUSB ? "正在刷新" : "")
                    .accessibilityIdentifier("refresh-usb-connection")
                if let connection = usbReceiver.connection {
                    serverConnectionCard(name: connection.serverName, detail: "数据线已连接 · 可接收文件", connected: true)
                        .accessibilityElement(children: .combine).accessibilityIdentifier("usb-connected")
                } else {
                    Label("等待数据线连接", systemImage: "cable.connector")
                        .font(.callout).foregroundStyle(.secondary).accessibilityIdentifier("usb-disconnected")
                }
            }
            if usbReceiver.transfers.isEmpty {
                Text("在 Mac 打开示教服务，用数据线连接并信任此电脑。在电脑「iPad / iPhone 示教」窗口点击「通过数据线发送」，物体会显示在这里。")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                if usbReceiver.connection == nil {
                    Text("以下文件已传到本机，可离线接收。").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(usbReceiver.transfers) { transfer in
                    Button {
                        discovery.stop()
                        Task { await session.receiveUSB(transfer, from: usbReceiver.inbox); await usbReceiver.refresh() }
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            Label("接收 · \(transfer.manifest.name)", systemImage: "arrow.down.doc")
                                .lineLimit(2).multilineTextAlignment(.leading)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(transfer.manifest.byteLength), countStyle: .file))
                                .font(.caption).foregroundStyle(.secondary)
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
                    }.buttonStyle(.borderedProminent).disabled(pairingBusy)
                        .accessibilityIdentifier("receive-usb-model-\(transfer.id)")
                }
            }
            if !usbReceiver.message.isEmpty { Text(usbReceiver.message).font(.caption).foregroundStyle(.orange) }
        }.accessibilityElement(children: .contain).accessibilityIdentifier("usb-receiving-panel")
    }
    private func refreshUSBConnection() {
        guard !refreshingUSB, !pairingBusy else { return }
        refreshingUSB = true
        usbRefreshTask = Task {
            // Keep one full turn visible even when the local status read is fast.
            async let feedback: Void = Task.sleep(for: .milliseconds(800))
            await usbReceiver.refresh()
            _ = try? await feedback
            guard !Task.isCancelled else { return }
            refreshingUSB = false; usbRefreshTask = nil
        }
    }
    private func stopUSBRefresh() {
        usbRefreshTask?.cancel(); usbRefreshTask = nil; refreshingUSB = false
    }
    private func pairingActionLabel(_ title: String, systemImage: String, refreshing: Bool = false,
                                    activity: PairingActivityIcon.Kind? = nil) -> some View {
        Label { Text(title) } icon: {
            if let activity { PairingActivityIcon(kind: activity, active: refreshing) }
            else { Image(systemName: systemImage) }
        }.font(.body)
            .frame(maxWidth: .infinity).padding(.vertical, 10)
    }
    private func serverConnectionCard(name: String, detail: String, connected: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "desktopcomputer").foregroundStyle(accent)
            VStack(alignment: .leading, spacing: 3) {
                Text(name).font(.callout.weight(.medium)).lineLimit(1)
                Text(detail).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: connected ? "checkmark.circle.fill" : "plus.circle").foregroundStyle(accent)
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }
    private func pairingMethodHeader(_ method: String, title: String, symbol: String) -> some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 38, weight: .light)).foregroundStyle(accent)
                .frame(width: 64, height: 64)
                .background(accent.opacity(0.07), in: RoundedRectangle(cornerRadius: 14))
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(accent.opacity(0.18)))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(method).font(.caption.weight(.medium)).foregroundStyle(accent)
                Text(title).font(.headline)
            }
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 4)
    }
    private func modelTransferProgress(_ progress: ModelTransferProgress) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(progress.title).font(.callout.weight(.medium))
                    .accessibilityIdentifier("model-transfer-stage")
                Spacer(minLength: 0)
                Text("\(progress.step) / 4").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            }
            if case .downloading(let download) = progress {
                ProgressView(value: download.fractionCompleted).progressViewStyle(.linear)
                    .accessibilityLabel("物体下载进度").accessibilityIdentifier("model-download-progress")
                HStack {
                    Text("\(Int(download.fractionCompleted * 100))%")
                        .accessibilityIdentifier("model-download-percent")
                    Spacer(minLength: 8)
                    Text("\(ByteCountFormatter.string(fromByteCount: download.receivedBytes, countStyle: .file)) / \(ByteCountFormatter.string(fromByteCount: download.totalBytes, countStyle: .file))")
                        .accessibilityIdentifier("model-download-bytes")
                }.font(.caption.monospacedDigit()).foregroundStyle(.secondary)
            } else {
                HStack(spacing: 5) {
                    ForEach(1...4, id: \.self) { step in
                        Capsule().fill(step <= progress.step ? accent : Color.white.opacity(0.12)).frame(height: 4)
                    }
                }.accessibilityHidden(true)
                Text(progress.step == 1 ? "正在验证配对信息，请稍候…" : "下载已完成，处理完成后将自动打开物体。")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14).frame(maxWidth: .infinity, alignment: .leading)
        .background(accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain).accessibilityIdentifier("model-transfer-progress")
    }
    private var discoveryPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: searchConfiguredServer) {
                pairingActionLabel("搜索服务器", systemImage: "network", refreshing: discovery.isSearching, activity: .globe)
            }.buttonStyle(.bordered)
                .disabled(pairingBusy).allowsHitTesting(!discovery.isSearching)
                .accessibilityValue(discovery.isSearching ? "正在搜索" : "")
                .accessibilityIdentifier("discover-services")
            if !discovery.servers.isEmpty {
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(discovery.servers) { server in
                            Button {
                                presentWiFiPairing(server)
                            } label: {
                                serverConnectionCard(name: server.name, detail: LANAddressInput(address: server.address).displayAddress,
                                                     connected: session.serverAddress == server.address)
                            }.buttonStyle(.plain).disabled(pairingBusy)
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
    private var localProjectsPanel: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                Label("保存在此 \(TeachingDevice.storageName)", systemImage: "square.stack.3d.up")
                    .font(TeachingDevice.isPhone ? .headline : .title2.weight(.medium))
                Spacer()
                Text("\(session.projects.count) 个物体").font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            if !TeachingSession.supportsLocalTeaching {
                Label("本机虚拟示教 · 需要 LiDAR", systemImage: "lock.fill")
                    .font(.callout).foregroundStyle(.secondary)
                    .accessibilityIdentifier("local-teaching-locked")
            }
            if TeachingDevice.isPhone {
                localProjectContents
            } else {
                ScrollView { localProjectContents }
                    .scrollBounceBehavior(.basedOnSize)
                    .accessibilityIdentifier("library-projects-scroll")
            }
        }
        .padding(TeachingDevice.isPhone ? 16 : 24)
        .frame(maxWidth: .infinity, maxHeight: TeachingDevice.isPhone ? nil : .infinity, alignment: .topLeading)
        .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 18))
        .clipShape(RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Color.white.opacity(0.06)))
        .disabled(!TeachingSession.supportsLocalTeaching)
        .opacity(TeachingSession.supportsLocalTeaching ? 1 : 0.5)
        .accessibilityElement(children: .contain).accessibilityIdentifier("library-projects-panel")
    }
    private var localProjectContents: some View {
        VStack(alignment: .leading, spacing: 20) {
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
                                             disabled: pairingBusy, onDelete: { projectToDelete = project }) {
                            Button { Task { await session.open(project) } } label: {
                                HStack(spacing: TeachingDevice.isPhone ? 10 : 18) {
                                    VStack(alignment: .leading, spacing: 10) {
                                        Text(project.session.manifest.name).font(.headline).multilineTextAlignment(.leading).lineLimit(3)
                                        Text("\(project.result.samples.count) 个 Pose · \(project.syncedAt != nil ? "已同步" : project.result.completedAt != nil ? "已完成，待同步" : "本地草稿")")
                                            .font(.caption).foregroundStyle(.secondary)
                                        Text(TeachingPoseCounts(project.result.samples).summary).font(.caption2).foregroundStyle(.secondary)
                                        if session.openingProjectID == project.id {
                                            ProgressView("轻量加载…").font(.caption).controlSize(.small)
                                                .accessibilityIdentifier("opening-model-progress")
                                        } else if session.deletingProjectID == project.id {
                                            ProgressView("正在删除…").font(.caption).controlSize(.small)
                                        }
                                    }
                                    Spacer(minLength: 4)
                                    ProjectThumbnailView(project: project)
                                        .frame(width: TeachingDevice.isPhone ? 88 : 150, height: TeachingDevice.isPhone ? 76 : 100)
                                        .overlay(alignment: .topTrailing) {
                                            Image(systemName: "arrow.up.right").font(.caption.weight(.medium)).foregroundStyle(accent)
                                                .padding(7).background(.black.opacity(0.5), in: Circle()).padding(6)
                                        }
                                        .allowsHitTesting(false)
                                }
                                .padding(TeachingDevice.isPhone ? 12 : 20).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                                .background(Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 14))
                            }.buttonStyle(.plain).disabled(pairingBusy).accessibilityIdentifier("local-project-\(project.id)")
                        }
                    }
                }
                .accessibilityIdentifier("local-project-list")
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

}

private struct LibraryPairingPurposePicker: UIViewRepresentable {
    @Binding var collaboration: Bool
    let localTeachingAvailable: Bool
    let busy: Bool
    func makeCoordinator() -> Coordinator { Coordinator(collaboration: $collaboration) }
    func makeUIView(context: Context) -> UISegmentedControl {
        let control = UISegmentedControl(items: ["接收物体", "画面协作"])
        control.accessibilityIdentifier = "library-pairing-purpose"
        control.accessibilityLabel = "配对用途"
        control.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .valueChanged)
        return control
    }
    func updateUIView(_ control: UISegmentedControl, context: Context) {
        context.coordinator.collaboration = $collaboration
        control.selectedSegmentIndex = collaboration ? 1 : 0
        control.isEnabled = !busy
        control.setEnabled(localTeachingAvailable, forSegmentAt: 0)
    }
    final class Coordinator: NSObject {
        var collaboration: Binding<Bool>
        init(collaboration: Binding<Bool>) { self.collaboration = collaboration }
        @objc func changed(_ control: UISegmentedControl) {
            guard control.isEnabled, control.isEnabledForSegment(at: control.selectedSegmentIndex) else { return }
            collaboration.wrappedValue = control.selectedSegmentIndex == 1
        }
    }
}

private enum LocalProjectSwipeLayout {
    static let coordinateSpace = "library-swipe-actions"
    static let actionWidth: CGFloat = 88
    static let spacing: CGFloat = 12
}

private struct LocalProjectDeleteFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
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
    @State private var scrollOffset: CGFloat = 0

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: LocalProjectSwipeLayout.spacing) {
                    content
                        .containerRelativeFrame(.horizontal)
                        .id("card")
                        .accessibilityAction(named: Text("从此 \(TeachingDevice.storageName) 删除")) {
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
                        .frame(width: LocalProjectSwipeLayout.actionWidth).frame(maxHeight: .infinity)
                        .background(Color.red, in: RoundedRectangle(cornerRadius: 14))
                        .contentShape(RoundedRectangle(cornerRadius: 14))
                    }
                    .buttonStyle(.plain).disabled(disabled)
                    .accessibilityIdentifier("swipe-delete-local-project-\(projectID)")
                    .accessibilityLabel("从此 \(TeachingDevice.storageName) 删除模型和全部 Pose")
                    .accessibilityHidden(!showingAction)
                }
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { geometry in
                    -geometry.frame(in: .scrollView(axis: .horizontal)).minX
                } action: { offset in
                    let revealed = offset > 1
                    if revealed && !showingAction { revealedProjectID = projectID }
                    if !revealed && revealedProjectID == projectID { revealedProjectID = nil }
                    showingAction = revealed; scrollOffset = offset
                }
            }
            .scrollIndicators(.hidden)
            .scrollTargetBehavior(LocalProjectSwipeSnap())
            .scrollDisabled(disabled)
            .fixedSize(horizontal: false, vertical: true)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .background {
                GeometryReader { geometry in
                    let viewport = geometry.frame(in: .named(LocalProjectSwipeLayout.coordinateSpace))
                    let action = CGRect(x: viewport.maxX + LocalProjectSwipeLayout.spacing - scrollOffset,
                        y: viewport.minY, width: LocalProjectSwipeLayout.actionWidth, height: viewport.height)
                    Color.clear.preference(key: LocalProjectDeleteFrames.self,
                        value: showingAction && !disabled ? [projectID: action.intersection(viewport)] : [:])
                }
            }
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

private struct PairingActivityIcon: View {
    enum Kind { case refresh, globe }
    let kind: Kind
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            // Removing the timeline ends rendering immediately. Setting a
            // repeatForever animation to nil can leave its old animation alive.
            if active { AnimatedPairingActivityIcon(kind: kind, reduceMotion: reduceMotion) }
            else { PairingActivityFrame(kind: kind, phase: 0) }
        }
        .frame(width: 20, height: 20)
        .transaction { $0.animation = nil }
        .accessibilityHidden(true)
    }
}

private struct AnimatedPairingActivityIcon: View {
    let kind: PairingActivityIcon.Kind
    let reduceMotion: Bool
    @State private var startedAt = Date()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { timeline in
            let duration = kind == .refresh ? 0.8 : 2.4
            let phase = max(0, timeline.date.timeIntervalSince(startedAt))
                .truncatingRemainder(dividingBy: duration) / duration
            PairingActivityFrame(kind: kind, phase: reduceMotion ? 0 : phase)
                .opacity(reduceMotion ? 0.8 + 0.2 * cos(phase * 2 * .pi) : 1)
        }
    }
}

private struct PairingActivityFrame: View {
    let kind: PairingActivityIcon.Kind
    let phase: Double

    var body: some View {
        Canvas { context, size in
            if kind == .refresh {
                context.stroke(refreshPath(size), with: .foreground,
                    style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
            } else {
                context.stroke(globePath(size), with: .foreground,
                    style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
            }
        }
        .rotationEffect(.degrees(kind == .refresh ? phase * 360 : 0))
    }
    private func refreshPath(_ size: CGSize) -> Path {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let scale = min(size.width, size.height) / 20, radius = scale * 6.7
        var path = Path()
        // The circle and rotation share this exact center, independently of the
        // arrowhead's asymmetric bounds or a font symbol's baseline metrics.
        for step in 0...60 {
            let angle = (15 + Double(step) * 5) * .pi / 180
            let point = CGPoint(x: center.x + radius * CGFloat(cos(angle)), y: center.y + radius * CGFloat(sin(angle)))
            if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        let end = 315.0 * .pi / 180
        let normal = CGVector(dx: cos(end), dy: sin(end))
        let tangent = CGVector(dx: -sin(end), dy: cos(end))
        let tip = CGPoint(x: center.x + radius * normal.dx, y: center.y + radius * normal.dy)
        path.move(to: CGPoint(x: tip.x - scale * 3.3 * tangent.dx + scale * 2.8 * normal.dx,
                              y: tip.y - scale * 3.3 * tangent.dy + scale * 2.8 * normal.dy))
        path.addLine(to: tip)
        path.addLine(to: CGPoint(x: tip.x - scale * 3.3 * tangent.dx - scale * 2.8 * normal.dx,
                                 y: tip.y - scale * 3.3 * tangent.dy - scale * 2.8 * normal.dy))
        return path
    }
    private func globePath(_ size: CGSize) -> Path {
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let radius = min(size.width, size.height) / 2 - 1
        var path = Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
        let tilt = 0.16
        func appendCurve(_ coordinates: [(latitude: Double, longitude: Double)]) {
            var drawing = false
            for coordinate in coordinates {
                let x = cos(coordinate.latitude) * sin(coordinate.longitude)
                let y = sin(coordinate.latitude)
                let z = cos(coordinate.latitude) * cos(coordinate.longitude)
                let visible = y * sin(tilt) + z * cos(tilt) >= 0
                guard visible else { drawing = false; continue }
                let point = CGPoint(x: center.x + radius * CGFloat(x),
                                    y: center.y - radius * CGFloat(y * cos(tilt) - z * sin(tilt)))
                if drawing { path.addLine(to: point) } else { path.move(to: point); drawing = true }
            }
        }
        // A fixed sphere silhouette with meridians turning around its vertical
        // axis. It never rolls around the screen or flips a flat globe image.
        for meridian in 0..<6 {
            let longitude = phase * 2 * Double.pi + Double(meridian) * Double.pi / 3
            let points: [(latitude: Double, longitude: Double)] = (0...48).map { step in
                let latitude = -Double.pi / 2 + Double(step) * (Double.pi / 48)
                return (latitude, longitude)
            }
            appendCurve(points)
        }
        for latitude in [-Double.pi / 4, 0, Double.pi / 4] {
            let points: [(latitude: Double, longitude: Double)] = (0...64).map { step in
                (latitude, Double(step) * (2 * Double.pi / 64))
            }
            appendCurve(points)
        }
        return path
    }
}

private struct WiFiPairingSheet: View {
    let server: DiscoveredTeachingServer
    var collaboration = false
    let onPair: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var code = ""
    @State private var codeFocused = false
    @State private var pendingSubmission: Task<Void, Never>?
    @State private var submitted = false

    private var valid: Bool { PairingCode.isValid(code) }
    private var invalid: Bool {
        code.count > 4 || code.utf8.contains { !(65...90).contains($0) && !(48...57).contains($0) }
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        Image(systemName: "desktopcomputer").font(.title2).foregroundStyle(accent)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(server.name).font(.headline)
                            Text(LANAddressInput(address: server.address).displayAddress)
                                .font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
                        }
                    }
                    Text(collaboration ? "输入电脑「画面协作」窗口中的 4 位配对码，完成后自动连接。"
                         : "输入此电脑窗口中的 4 位配对码，字母或数字均可。输入完成后自动连接。")
                        .font(.callout).foregroundStyle(.secondary)
                    PairingCodeField(code: Binding(get: { code }, set: { value in
                        code = value; submit(after: .milliseconds(600))
                    }), isFocused: $codeFocused, onSubmit: { submit() })
                        .frame(maxWidth: .infinity).frame(height: 58).disabled(submitted)
                    if invalid { Text("请输入 4 位字母或数字").font(.caption).foregroundStyle(.orange) }
                }.padding(24)
            }
            .background(Color(red: 0.025, green: 0.05, blue: 0.065))
            .navigationTitle("输入配对码").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        pendingSubmission?.cancel(); pendingSubmission = nil
                        codeFocused = false; dismiss()
                    }.accessibilityIdentifier("cancel-wifi-pairing")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("连接") { submit() }.disabled(!valid || submitted)
                        .accessibilityIdentifier("confirm-wifi-pairing")
                }
            }
        }
        .presentationDetents([.height(320)]).presentationDragIndicator(.visible)
        .task {
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            codeFocused = true
        }
        .onDisappear { pendingSubmission?.cancel(); pendingSubmission = nil }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { pendingSubmission?.cancel(); pendingSubmission = nil }
        }
    }
    private func submit(after delay: Duration = .zero) {
        pendingSubmission?.cancel(); pendingSubmission = nil
        guard valid, !submitted else { return }
        let value = code
        pendingSubmission = Task {
            // Wait for the entire edit/paste, never submit a valid four-character
            // prefix of a longer or invalid code. Dismissal cancels this work.
            do { try await Task.sleep(for: delay) } catch { return }
            guard !Task.isCancelled, !submitted, valid, code == value else { return }
            submitted = true; codeFocused = false
            onPair(value)
        }
    }
}

private struct LANAddressFields: View {
    @Binding var address: LANAddressInput
    var onSubmit: () -> Void = {}
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
                    onSubmit()
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

private enum ResultSyncMethod: String, CaseIterable {
    case scan = "扫码", wifi = "Wi-Fi", airDrop = "AirDrop 导出"
}

// Give the native segmented control a taller visible track, not just a taller
// SwiftUI container around its standard-height appearance.
private struct ResultSyncMethodPicker: UIViewRepresentable {
    @Binding var selection: ResultSyncMethod

    func makeCoordinator() -> Coordinator { Coordinator(selection: $selection) }
    func makeUIView(context: Context) -> UISegmentedControl {
        let control = UISegmentedControl(items: ResultSyncMethod.allCases.map(\.rawValue))
        control.accessibilityLabel = "同步方式"
        control.accessibilityIdentifier = "result-sync-method"
        control.addTarget(context.coordinator, action: #selector(Coordinator.selectMethod(_:)), for: .valueChanged)
        return control
    }
    func updateUIView(_ control: UISegmentedControl, context: Context) {
        context.coordinator.selection = $selection
        control.selectedSegmentIndex = ResultSyncMethod.allCases.firstIndex(of: selection) ?? 0
        control.isEnabled = context.environment.isEnabled
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UISegmentedControl, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? uiView.intrinsicContentSize.width,
               height: proposal.height ?? uiView.intrinsicContentSize.height)
    }
    final class Coordinator: NSObject {
        var selection: Binding<ResultSyncMethod>
        init(selection: Binding<ResultSyncMethod>) { self.selection = selection }
        @objc func selectMethod(_ control: UISegmentedControl) {
            guard ResultSyncMethod.allCases.indices.contains(control.selectedSegmentIndex) else { return }
            selection.wrappedValue = ResultSyncMethod.allCases[control.selectedSegmentIndex]
        }
    }
}

private struct TeachingResultSyncView: View {
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.dismiss) private var dismiss
    @State private var method: ResultSyncMethod = .scan
    @State private var scanning = false
    @State private var scannedCode: PairingQRCode?
    @State private var resultShare: TeachingResultShareItem?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(session.current?.session.manifest.name ?? "示教结果").font(.title3)
                        Text("已完成 · \(session.current?.result.samples.count ?? 0) 个 Pose")
                            .font(.callout).foregroundStyle(.secondary)
                        Text(TeachingPoseCounts(session.current?.result.samples ?? []).summary)
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ResultSyncMethodPicker(selection: $method)
                        .frame(height: 44).disabled(session.busy)
                    Group {
                        switch method {
                        case .scan: scanContent
                        case .wifi: wifiContent
                        case .airDrop: airDropContent
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    if session.busy { ProgressView("正在处理…") }
                    if !session.status.isEmpty {
                        Text(session.status).font(.callout).foregroundStyle(.secondary)
                            .accessibilityIdentifier("result-sync-status")
                    }
                    if !session.error.isEmpty {
                        Text(session.error).font(.callout).foregroundStyle(.orange)
                            .accessibilityIdentifier("result-sync-error")
                    }
                }.padding(24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(red: 0.025, green: 0.05, blue: 0.065))
            .navigationTitle("同步数据").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) {
                Button("关闭") { dismiss() }.disabled(session.busy)
                    .accessibilityIdentifier("close-result-sync")
            } }
        }
        .interactiveDismissDisabled(session.busy)
        .onChange(of: method) { _, _ in
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        }
        .sheet(isPresented: $scanning, onDismiss: syncScannedResult) {
            PairingScannerView(purpose: .syncResult) { qr in
                scannedCode = qr; scanning = false
            }
        }
    }

    private var scanContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("扫码同步", systemImage: "qrcode.viewfinder").font(.title3)
            Text("电脑与设备 连接同一局域网后，打开电脑「iPad / iPhone 示教」窗口，扫描其中的二维码。核对模型后将自动上传示教结果。")
                .font(.callout).foregroundStyle(.secondary)
            Button { scanning = true } label: {
                Label("开始扫码", systemImage: "qrcode.viewfinder").frame(maxWidth: .infinity).padding(10)
            }.buttonStyle(.borderedProminent).disabled(session.busy)
                .accessibilityIdentifier("scan-sync-result")
        }
    }
    private var wifiContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Wi-Fi 同步", systemImage: "wifi").font(.title3)
            Text("电脑与设备 需连接同一局域网。确认电脑的 IPv4 地址与端口后，上传到已配对的传输任务。")
                .font(.callout).foregroundStyle(.secondary)
            LANAddressFields(address: $session.serverConnection).disabled(session.busy)
            if session.current?.requiresResultPairing == true {
                Text("补录结果需要先配对新的传输任务。请在电脑点击「新建传输」，再切换到扫码同步。")
                    .font(.callout).foregroundStyle(.orange)
                Button("切换到扫码") { method = .scan }.disabled(session.busy)
            }
            Button { Task { await session.finish(sync: true) } } label: {
                Label("通过 Wi-Fi 同步", systemImage: "wifi").frame(maxWidth: .infinity).padding(10)
            }.buttonStyle(.borderedProminent)
                .disabled(session.busy || !session.serverConnection.canConnect || session.current?.requiresResultPairing == true)
                .accessibilityIdentifier("wifi-sync-result")
        }
    }
    private var airDropContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("AirDrop 导出", systemImage: "square.and.arrow.up").font(.title3)
            Text("导出结果文件后，在系统分享面板选择 AirDrop 发送到 Mac，或存储到「文件」。收到后，在电脑「iPad / iPhone 示教」窗口导入结果文件。")
                .font(.callout).foregroundStyle(.secondary)
            Button {
                Task {
                    if let url = await session.exportResult() { resultShare = TeachingResultShareItem(url: url) }
                }
            } label: {
                Label("导出并分享", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity).padding(10)
            }.buttonStyle(.borderedProminent).disabled(session.busy)
                .accessibilityIdentifier("share-teaching-result")
                .popover(item: $resultShare) { item in
                    TeachingResultShareSheet(url: item.url) { activity, completed, error in
                        session.resultShareFinished(activity: activity, completed: completed, error: error)
                        resultShare = nil
                    }.presentationCompactAdaptation(.sheet)
                }
        }
    }
    private func syncScannedResult() {
        guard let qr = scannedCode else { return }
        scannedCode = nil
        Task { await session.syncResult(qr: qr) }
    }
}

struct TeachingView: View {
    @Environment(\.screenCollaborationActive) private var screenCollaborationActive
    @EnvironmentObject private var session: TeachingSession
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var ar = ARController()
    @StateObject private var renderer = ModelRenderer()
    @StateObject private var coverage = TeachingCoverageRenderer()
    @State private var review = false
    @State private var finishing = false
    @State private var resultSyncOpen = false
    @State private var displaySettingsOpen = false
    @State private var levelVisible = true
    @State private var zividFieldOfViewEnabled = true
    @State private var tiltControlsOpen = false
    @State private var sidebarCollapsed = TeachingDevice.isPhone
    @State private var nearbyPoseConfirmation: NearbyPoseConfirmation?
    @State private var loadedProjectID: String?
    @State private var sidebarContentHeight: CGFloat = 0
    @ScaledMetric(relativeTo: .body) private var teachingActionLabelHeight: CGFloat = 34
    let projectID: String
    let geometry: ModelGeometry
    let bottomSafeArea: CGFloat
    private let sidebarPadding: CGFloat = 22
    private var completed: Bool { session.current?.result.completedAt != nil }
    private var count: Int { session.current?.result.samples.count ?? 0 }
    private var liveCamera: Bool { ARController.supported && !completed }
    private var fieldOfView: ZividFieldOfView? { liveCamera ? ar.cameraFieldOfView : nil }
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
        if TeachingDevice.isPhone {
            phoneWorkspace(size: viewport.size)
        } else {
        let sidebarWidth: CGFloat = sidebarCollapsed ? 0 : 340
        let controlsWidth = max(0, viewport.size.width - sidebarWidth)
        let renderSize = CGSize(width: liveCamera ? viewport.size.width : controlsWidth, height: viewport.size.height)
        ZStack(alignment: .leading) {
            // Keep the live AR camera and placement raycasts stable while folding
            // the panel. Free model previews use only the visible left viewport.
            ZStack {
                Color.black
                modelViewport(in: renderSize)
                if liveCamera {
                    Image(systemName: ar.placed && !ar.repositioning ? "plus" : "viewfinder")
                        .font(ar.placed && !ar.repositioning ? .title2.weight(.ultraLight) : .system(size: 48, weight: .ultraLight))
                        .foregroundStyle(ar.groundAssistance && ar.groundTargetAvailable ? accent : .white)
                        .shadow(color: .black, radius: 2).allowsHitTesting(false)
                        .accessibilityLabel("模型放置准星").accessibilityIdentifier("teaching-placement-target")
                }
            }.frame(width: renderSize.width, height: renderSize.height).clipped()
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
                            VStack(alignment: .trailing, spacing: 3) {
                                Text("\(coverage.coverageTitle) \(coverage.coveragePercentage)").monospacedDigit()
                                    .accessibilityIdentifier("floating-coverage-percentage")
                                if coverage.preparing { Text("更新中…").foregroundStyle(.secondary) }
                            }
                            Button { setSidebarCollapsed(false) } label: {
                                Label("展开面板", systemImage: "sidebar.right").frame(minWidth: 88, minHeight: 32)
                            }.buttonStyle(.bordered).accessibilityIdentifier("expand-teaching-panel")
                        }
                    }.font(.caption).padding(16).background(.black.opacity(0.75))
                    parkingReferenceLegend
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
            // Keep sidebar controls and the underlying scene/session alive while folding.
            VStack(spacing: 0) {
                HStack {
                    Button { ar.stop(); Task { await session.close() } } label: { Label("本地项目", systemImage: "chevron.left") }.disabled(session.busy)
                    Spacer()
                    Button { setSidebarCollapsed(true) } label: {
                        Label("收起", systemImage: "chevron.right").font(.caption).frame(minHeight: 32)
                    }.buttonStyle(.bordered).accessibilityLabel("收起右侧面板")
                        .accessibilityIdentifier("collapse-teaching-panel")
                }.padding(.horizontal, sidebarPadding).padding(.vertical, 12)
                if liveCamera && !sidebarCollapsed && (ar.calibrated || ar.adjustingPlacement) {
                    placementAdjustmentControls.padding(.horizontal, sidebarPadding).padding(.bottom, 12)
                }
            GeometryReader { contentViewport in
                let extraHeight = completed && sidebarContentHeight > 0
                    ? max(0, contentViewport.size.height - sidebarContentHeight) : 0
                let counts = TeachingPoseCounts(session.current?.result.samples ?? [])
                let groupCount = TeachingPoseCategory.allCases.filter { $0 != .desktop || counts[$0] > 0 }.count
            ScrollView {
                VStack(alignment: .leading, spacing: 19) {
                    Text(session.current?.session.manifest.name ?? "独立示教物体").font(.title3).lineLimit(2)
                    Text("\(count)").font(.system(size: 54, weight: .light, design: .monospaced)) + Text("  POSES").font(.caption).foregroundColor(.secondary)
                    Text(TeachingPoseCounts(session.current?.result.samples ?? []).summary)
                        .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("teaching-pose-counts")
                    if session.current?.session.manifest.sampled == true { Text("大物体以抽样点云显示，尺寸与坐标不变").font(.caption).foregroundStyle(.secondary) }
                    if !completed { Divider() }
                    if completed {
                        Button { Task { await session.continueTeaching() } } label: {
                            teachingActionLabel("继续示教", systemImage: "camera.fill")
                        }.buttonStyle(.bordered).disabled(session.busy || !ARController.supported)
                            .accessibilityIdentifier("continue-teaching")
                        Divider()
                    }
                    if liveCamera && !ar.calibrated { groundAssistanceControl }
                    if liveCamera { fieldOfViewControl }
                    coverageControl(additionalRowSpacing: extraHeight / CGFloat(groupCount))
                    if !completed {
                        Divider()
                        calibrationPanel
                        if !sidebarCollapsed && !ar.adjustingPlacement { recordPoseButton }
                        reviewPosesButton()
                        finishTeachingButton()
                    }
                    if session.busy { ProgressView() }
                    if !session.status.isEmpty { Text(session.status).font(.caption).foregroundStyle(.secondary) }
                    if !renderer.error.isEmpty { Text(renderer.error).font(.caption).foregroundStyle(.orange) }
                    if !session.error.isEmpty {
                        Text(session.error).font(.caption).foregroundStyle(.orange)
                        Button("重试保存") { Task { do { try await session.saveNow(); session.error = "" } catch { session.error = error.localizedDescription } } }
                    }
                }.padding(.horizontal, sidebarPadding).padding(.top, sidebarPadding)
                    .padding(.bottom, completed ? 12 : sidebarPadding)
                    // Measure the natural content height so distributing spare space
                    // across the coverage rows does not feed back into the measurement.
                    .onGeometryChange(for: CGFloat.self) { max(0, $0.size.height - extraHeight) } action: { height in
                        if abs(height - sidebarContentHeight) > 0.5 { sidebarContentHeight = height }
                    }
            }
            }
                if completed { completedActions }
            }.frame(width: 340, height: viewport.size.height).background(Color(red: 0.025, green: 0.05, blue: 0.065))
                .frame(width: sidebarWidth, alignment: .leading).clipped()
                .opacity(sidebarCollapsed ? 0 : 1).allowsHitTesting(!sidebarCollapsed)
                .accessibilityHidden(sidebarCollapsed)
            }
        }
        }
        }.task(id: projectID) {
            // Returning from full-screen review must retain the live AR session
            // and its calibration instead of loading and resetting it again.
            guard loadedProjectID != projectID, let project = session.current else { return }
            loadedProjectID = projectID
            ar.load(manifest: project.session.manifest, samples: project.result.samples,
                    navigationReference: project.session.navigationReference)
            renderer.bind(geometry, settings: session.$current.compactMap { project in
                guard let project, project.id == projectID else { return nil }
                return project.displaySettings ?? ModelDisplaySettings().forOpening()
            }.eraseToAnyPublisher())
            coverage.update(model: geometry, samples: project.result.samples)
            ar.onCalibration = { session.addCalibration($0) }
            ar.onSample = { sample in
                guard session.addSample(sample) else { return false }
                // Start surface feedback in the recording action itself; the
                // publisher also handles deletion, review and project restore.
                if let project = session.current { coverage.update(model: geometry, samples: project.result.samples) }
                return true
            }
            if !completed { await ar.start() }
        }.onDisappear {
            // A USB camera overlay returns to the same calibrated AR workspace.
            guard !screenCollaborationActive else { return }
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
        .sheet(isPresented: $resultSyncOpen) { TeachingResultSyncView().environmentObject(session) }
        .fullScreenCover(isPresented: $review, onDismiss: { ar.refreshMarkers(session.current?.result.samples ?? []) }) {
            PoseReviewView(geometry: geometry, renderer: renderer, coverage: coverage).environmentObject(session)
        }
        .alert("当前 Pose 与上一个位置和姿态接近", isPresented: Binding(
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
    private func phoneWorkspace(size: CGSize) -> some View {
        let portrait = size.width < size.height
        let panelWidth = portrait ? size.width : min(300, size.width * 0.42)
        let panelHeight = portrait ? min(540, size.height * 0.66) : size.height
        let controlsWidth = !portrait && !sidebarCollapsed ? size.width - panelWidth : size.width
        return ZStack(alignment: .topLeading) {
            // This surface never moves between stacks when rotating or folding
            // the controls: AR tracking, calibration and raycasts stay alive.
            ZStack {
                Color.black
                modelViewport(in: size)
                if liveCamera {
                    Image(systemName: ar.placed && !ar.repositioning ? "plus" : "viewfinder")
                        .font(.system(size: ar.placed && !ar.repositioning ? 24 : 44, weight: .ultraLight))
                        .foregroundStyle(ar.groundAssistance && ar.groundTargetAvailable ? accent : .white)
                        .shadow(color: .black, radius: 2).allowsHitTesting(false)
                        .accessibilityLabel("模型放置准星").accessibilityIdentifier("teaching-placement-target")
                }
            }.frame(width: size.width, height: size.height).clipped()
                .accessibilityElement(children: .contain).accessibilityIdentifier("teaching-viewport")

            VStack(spacing: 8) {
                phoneToolbar
                parkingReferenceLegend
                if liveCamera && levelVisible && (sidebarCollapsed || !portrait) && (portrait || !ar.adjustingPlacement) {
                    HStack {
                        SpatialLevelView(reading: ar.levelReading, compact: true)
                            .frame(width: 180).allowsHitTesting(false)
                        Spacer(minLength: 0)
                    }.padding(.horizontal, 12)
                }
                Spacer(minLength: 0)
                if sidebarCollapsed && portrait {
                    VStack(spacing: 10) {
                        Text(viewportMessage).font(.caption).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading).lineLimit(3)
                        HStack {
                            Text("\(count) 个 Pose").accessibilityIdentifier("floating-pose-count")
                            Spacer()
                            Text("\(coverage.coverageTitle) \(coverage.coveragePercentage)")
                                .foregroundStyle(accent).accessibilityIdentifier("floating-coverage-percentage")
                        }.font(.caption.monospacedDigit())
                        if ar.adjustingPlacement { placementAdjustmentControls }
                        else { phoneActionBar }
                    }.padding(12).background(.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.white.opacity(0.12)))
                        .padding(12)
                        .accessibilityElement(children: .contain).accessibilityIdentifier("floating-pose-controls")
                }
            }.frame(width: controlsWidth, height: size.height)

            if sidebarCollapsed && !portrait {
                phoneLandscapeControls
                    .padding(.trailing, 12).padding(.top, 80).padding(.bottom, 12)
                    .frame(width: size.width, height: size.height, alignment: .trailing)
                if !canRecordPose || !session.error.isEmpty {
                    Text(viewportMessage).font(.caption).foregroundStyle(.secondary)
                        .lineLimit(2).padding(.horizontal, 12).padding(.vertical, 8)
                        .frame(maxWidth: min(320, size.width - 164), alignment: .leading)
                        .background(.black.opacity(0.75), in: RoundedRectangle(cornerRadius: 12))
                        .allowsHitTesting(false).accessibilityIdentifier("phone-landscape-hint")
                        .padding(12)
                        .frame(width: size.width, height: size.height, alignment: .bottomLeading)
                }
            }

            if !sidebarCollapsed {
            phoneInspector
                .frame(width: panelWidth, height: panelHeight)
                .background(Color(red: 0.025, green: 0.05, blue: 0.065))
                .clipShape(RoundedRectangle(cornerRadius: portrait ? 18 : 0))
                .overlay(alignment: .top) { Rectangle().fill(accent.opacity(0.25)).frame(height: 1) }
                .frame(width: size.width, height: size.height, alignment: portrait ? .bottom : .trailing)
            }
        }.frame(width: size.width, height: size.height)
            .background(Color(red: 0.025, green: 0.05, blue: 0.065).ignoresSafeArea())
    }

    private var phoneLandscapeControls: some View {
        VStack(spacing: 12) {
            VStack(spacing: 3) {
                Text("\(count) 个 Pose").font(.subheadline.weight(.medium).monospacedDigit())
                    .accessibilityIdentifier("floating-pose-count")
                Text("覆盖 \(coverage.coveragePercentage)").font(.caption.monospacedDigit()).foregroundStyle(accent)
                    .accessibilityLabel("\(coverage.coverageTitle) \(coverage.coveragePercentage)")
                    .accessibilityIdentifier("floating-coverage-percentage")
            }.lineLimit(1).minimumScaleFactor(0.8)
            if ar.adjustingPlacement {
                placementAdjustmentControls
            } else {
                Button {
                    if completed {
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                        resultSyncOpen = true
                    } else { recordPose() }
                } label: {
                    VStack(spacing: 5) {
                        Image(systemName: completed ? "arrow.triangle.2.circlepath" : "plus.viewfinder")
                            .font(.system(size: 25, weight: .medium))
                        Text(completed ? "同步数据" : "记录 Pose").font(.caption.weight(.semibold)).lineLimit(1)
                    }
                }.buttonStyle(PhoneCaptureButtonStyle())
                    .disabled(completed ? session.busy : !canRecordPose || nearbyPoseConfirmation != nil)
                    .accessibilityLabel(completed ? "同步数据" : "记录 Pose")
                    .accessibilityIdentifier(completed ? "sync-teaching-result" : "capture-pose")
                HStack(spacing: 8) {
                    reviewPosesButton(compact: true).frame(width: 52)
                    if !completed { finishTeachingButton(compact: true).frame(width: 52) }
                }
            }
        }.frame(width: 112).padding(8)
            .background(.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.12)))
            .accessibilityElement(children: .contain).accessibilityIdentifier("phone-landscape-controls")
    }

    private var phoneToolbar: some View {
        VStack(spacing: 6) {
            HStack(spacing: 6) {
                Button { ar.stop(); Task { await session.close() } } label: {
                    Image(systemName: "chevron.left").frame(width: 44, height: 44)
                }.accessibilityLabel("本地项目").accessibilityIdentifier("back-to-library").disabled(session.busy)
                Text(session.current?.session.manifest.name ?? "虚拟示教")
                    .font(.subheadline.weight(.medium)).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                if liveCamera {
                    Button { levelVisible.toggle() } label: {
                        Image(systemName: "move.3d").frame(width: 44, height: 44)
                    }.tint(levelVisible ? accent : .secondary)
                        .accessibilityLabel(levelVisible ? "隐藏姿态坐标轴" : "显示姿态坐标轴")
                        .accessibilityIdentifier("toggle-spatial-level")
                }
                Button { displaySettingsOpen = true } label: {
                    Image(systemName: "slider.horizontal.3").frame(width: 44, height: 44)
                }.accessibilityLabel("显示设置").accessibilityIdentifier("display-settings")
                Button { setSidebarCollapsed(!sidebarCollapsed) } label: {
                    Image(systemName: "sidebar.right").frame(width: 44, height: 44)
                }.accessibilityLabel(sidebarCollapsed ? "展开面板" : "收起面板")
                    .accessibilityIdentifier(sidebarCollapsed ? "expand-teaching-panel" : "phone-toggle-panel")
            }
            HStack(spacing: 8) {
                Label(completed ? "已完成 · 结果预览" : ar.tracking,
                      systemImage: completed ? "checkmark.circle" : ar.trackingNormal ? "location.fill" : "location.slash")
                    .foregroundStyle(completed || ar.trackingNormal ? accent : .orange)
                    .accessibilityIdentifier("teaching-tracking-status")
                Spacer(minLength: 0)
                Text(liveCamera ? (ar.depthAvailable ? "LiDAR 已就绪" : "等待 LiDAR") : "三维预览")
                    .foregroundStyle(.secondary).accessibilityIdentifier("teaching-depth-status")
            }.font(.caption).lineLimit(1).minimumScaleFactor(0.8).padding(.horizontal, 12)
        }.padding(.horizontal, 4).padding(.bottom, 10).background(.black.opacity(0.8))
    }

    private var phoneInspector: some View {
        VStack(spacing: 0) {
            HStack {
                Text("示教面板").font(.headline)
                Spacer()
                Button { setSidebarCollapsed(true) } label: {
                    Label("收起", systemImage: "chevron.down").font(.subheadline).frame(minHeight: 44)
                }.accessibilityIdentifier("collapse-teaching-panel")
            }.padding(.horizontal, 16)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(session.current?.session.manifest.name ?? "独立示教物体").font(.headline).lineLimit(2)
                    HStack(alignment: .firstTextBaseline) {
                        Text("\(count)").font(.system(size: 36, weight: .light, design: .monospaced))
                        Text("POSES").font(.caption).foregroundStyle(.secondary)
                    }
                    Text(TeachingPoseCounts(session.current?.result.samples ?? []).summary)
                        .font(.caption).foregroundStyle(.secondary).accessibilityIdentifier("teaching-pose-counts")
                    if completed {
                        Button { Task { await session.continueTeaching() } } label: {
                            teachingActionLabel("继续示教", systemImage: "camera.fill")
                        }.buttonStyle(.bordered).disabled(session.busy || !ARController.supported)
                            .accessibilityIdentifier("continue-teaching")
                    }
                    if liveCamera && !ar.calibrated { groundAssistanceControl }
                    if liveCamera { fieldOfViewControl }
                    coverageControl(additionalRowSpacing: 0)
                    if !completed {
                        Divider()
                        calibrationPanel
                        if liveCamera && (ar.calibrated || ar.adjustingPlacement) { placementAdjustmentControls }
                    }
                    Text(viewportMessage).font(.caption).foregroundStyle(.secondary)
                    if session.busy { ProgressView() }
                    if !session.status.isEmpty { Text(session.status).font(.caption).foregroundStyle(.secondary) }
                    if !renderer.error.isEmpty { Text(renderer.error).font(.caption).foregroundStyle(.orange) }
                    if !session.error.isEmpty {
                        Text(session.error).font(.caption).foregroundStyle(.orange)
                        Button("重试保存") { Task { do { try await session.saveNow(); session.error = "" } catch { session.error = error.localizedDescription } } }
                    }
                }.padding(16)
            }.scrollDismissesKeyboard(.interactively).accessibilityIdentifier("phone-teaching-panel-scroll")
            Divider()
            phoneActionBar.padding(12)
        }.accessibilityElement(children: .contain).accessibilityIdentifier("phone-teaching-panel")
    }

    private var phoneActionBar: some View {
        HStack(spacing: 8) {
            if completed {
                reviewPosesButton()
                syncResultButton
            } else {
                recordPoseButton
                reviewPosesButton(compact: true).frame(width: 52)
                finishTeachingButton(compact: true).frame(width: 52)
            }
        }
    }

    private var syncResultButton: some View {
        Button {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            resultSyncOpen = true
        } label: {
            teachingActionLabel("同步数据", systemImage: "arrow.triangle.2.circlepath")
        }.buttonStyle(.borderedProminent).disabled(session.busy)
            .accessibilityIdentifier("sync-teaching-result")
    }

    private func teachingActionLabel(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage).font(.body)
            .frame(maxWidth: .infinity).frame(height: teachingActionLabelHeight)
            .padding(.horizontal, 7)
    }
    private func reviewPosesButton(compact: Bool = false) -> some View {
        Button { review = true } label: {
            if compact {
                Image(systemName: "list.bullet.rectangle").frame(width: 22, height: 34)
            } else { teachingActionLabel("查看 / 编辑 Pose", systemImage: "list.bullet.rectangle") }
        }.buttonStyle(.bordered).disabled(count == 0)
            .accessibilityLabel("查看 / 编辑 Pose").accessibilityIdentifier("review-poses")
    }
    private var completedActions: some View {
        VStack(spacing: 19) {
            Divider()
            reviewPosesButton()
            Button {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                resultSyncOpen = true
            } label: {
                teachingActionLabel("同步数据", systemImage: "arrow.triangle.2.circlepath")
            }.buttonStyle(.borderedProminent).disabled(session.busy)
                .accessibilityIdentifier("sync-teaching-result")
        }
        .padding(.horizontal, sidebarPadding)
        // Count the home-indicator safe area as part of the outer bottom margin.
        .padding(.bottom, max(0, sidebarPadding - bottomSafeArea))
        .fixedSize(horizontal: false, vertical: true)
    }
    private func finishTeachingButton(compact: Bool = false) -> some View {
        Button {
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            finishing = true
        } label: {
            if compact {
                Image(systemName: "checkmark.circle").frame(width: 22, height: 34)
            } else { teachingActionLabel("完成示教", systemImage: "checkmark.circle") }
        }
        .buttonStyle(.bordered).disabled(count == 0 || session.busy || ar.adjustingPlacement)
        .accessibilityLabel("完成示教").accessibilityIdentifier("finish-teaching")
        // On iPad the confirmation is a popover. Anchor it to the tapped button,
        // rather than the whole AR viewport and its other presentation modifiers.
        .confirmationDialog("完成示教？", isPresented: $finishing, titleVisibility: .visible) {
            Button("完成并同步数据") {
                ar.stop()
                Task {
                    await session.finish(sync: false)
                    if session.error.isEmpty && completed { resultSyncOpen = true }
                }
            }
            Button("仅完成并保存在 \(TeachingDevice.storageName)") { ar.stop(); Task { await session.finish(sync: false) } }
            Button("继续示教", role: .cancel) {}
        } message: {
            Text("已记录 \(count) 个 Pose。完成后将锁定本次示教；可以现在同步，或仅保存在 \(TeachingDevice.storageName) 后再同步。")
        }
    }
    private func setSidebarCollapsed(_ collapsed: Bool) {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        sidebarCollapsed = collapsed
    }
    private func recordPose() {
        guard canRecordPose, nearbyPoseConfirmation == nil, let sample = ar.captureKeyframe() else { return }
        if let confirmation = NearbyPoseConfirmation(sample: sample, previousSample: session.current?.result.samples.last) {
            nearbyPoseConfirmation = confirmation
        } else {
            ar.recordKeyframe(sample)
        }
    }
    private var recordPoseButton: some View {
        Button(action: recordPose) {
            Label("记录 Pose", systemImage: "plus.viewfinder").font(TeachingDevice.isPhone ? .body : .title3)
                .lineLimit(1).minimumScaleFactor(0.85)
                .frame(maxWidth: .infinity).padding(.vertical, TeachingDevice.isPhone ? 12 : 16)
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
            else {
                ObjectPreviewView(geometry: geometry, rendered: renderer.geometry,
                                  initialViewport: completed ? size : nil,
                                  navigationReference: session.current?.session.navigationReference)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("三维物体预览，拖动旋转，双指缩放和平移")
                    .accessibilityIdentifier("teaching-model-preview")
            }
            if zividFieldOfViewEnabled, let fieldOfView {
                ZividFieldOfViewOverlay(fieldOfView: fieldOfView, labelAtTop: sidebarCollapsed)
            }
        }.frame(width: size.width, height: size.height).clipped().contentShape(Rectangle())
            .accessibilityElement(children: .contain).accessibilityIdentifier("teaching-render-surface")
    }
    @ViewBuilder private var parkingReferenceLegend: some View {
        if let count = session.current?.session.navigationReference?.parkingPoints.count, count > 0 {
            HStack {
                Label("停车点参考 · \(count) 个 · 只读", systemImage: "parkingsign.circle")
                    .font(.caption).foregroundStyle(.white).padding(8)
                    .background(.black.opacity(0.65), in: RoundedRectangle(cornerRadius: 8))
                    .accessibilityIdentifier("parking-reference-legend")
                Spacer(minLength: 0)
            }.padding(.horizontal, 12).allowsHitTesting(false)
        }
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
                    Text(fieldOfView == nil ? "正在获取相机视野…" : "设备相机视野不足，仅显示可见部分")
                        .font(.caption).foregroundStyle(fieldOfView?.fullyVisible == false ? .orange : .secondary)
                        .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("zivid-fov-status")
                }
            }
        }
    }
    private func coverageControl(additionalRowSpacing: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Button { coverage.enabled.toggle() } label: {
                    Label("已示教区域", systemImage: "square.3.layers.3d")
                        .font(.subheadline).frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityHidden(true)
                Spacer(minLength: 4)
                Toggle("已示教区域", isOn: $coverage.enabled).labelsHidden().fixedSize()
                    .tint(accent).accessibilityIdentifier("teaching-coverage-toggle")
            }
            PoseOriginLegend(samples: session.current?.result.samples ?? [],
                             coveragePercentages: coverage.categoryPercentages, coverageTitle: coverage.coverageTitle,
                             rowSpacing: 10 + additionalRowSpacing)
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text("\(coverage.coverageTitle)（估算）").font(.caption)
                    Spacer()
                    if coverage.preparing {
                        ProgressView().controlSize(.mini).accessibilityLabel("正在更新覆盖率")
                            .accessibilityIdentifier("teaching-coverage-progress")
                    }
                    Text(coverage.coveragePercentage).font(.subheadline.monospacedDigit().weight(.semibold))
                        .foregroundStyle(accent).accessibilityIdentifier("teaching-coverage-percentage")
                }
                ProgressView(value: coverage.coveredFraction ?? 0, total: 1).tint(.mint)
                    .accessibilityLabel(coverage.coverageTitle).accessibilityIdentifier("teaching-coverage-bar")
                if !coverage.preparing && coverage.coveredFraction == nil {
                    Text("模型没有可估算的有效表面")
                        .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }.padding(.top, additionalRowSpacing).padding(.bottom, 4)
            if coverage.enabled {
                HStack {
                    Text("着色强度").font(.caption)
                    Slider(value: $coverage.opacity, in: 0.05...1, step: 0.05)
                        .tint(.mint).accessibilityLabel("已示教区域着色强度")
                        .accessibilityIdentifier("teaching-coverage-opacity")
                    Text("\(Int((coverage.opacity * 100).rounded()))%")
                        .font(.caption.monospacedDigit()).frame(width: 42, alignment: .trailing)
                        .accessibilityIdentifier("teaching-coverage-opacity-value")
                }
            }
            if !coverage.error.isEmpty || (coverage.enabled &&
                (coverage.poseCount == 0 || coverage.hasCoverageWarning)) {
                HStack(spacing: 6) {
                    Text(coverage.status).font(.caption)
                        .foregroundStyle(coverage.error.isEmpty && !coverage.hasCoverageWarning ? Color.secondary : .orange)
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
    var initialViewport: CGSize? = nil
    var navigationReference: NavigationReference? = nil
    func makeUIView(context: Context) -> SCNView {
        let view = SCNView(); view.scene = SCNScene(); view.backgroundColor = UIColor(red: 0.025, green: 0.05, blue: 0.065, alpha: 1)
        let object = SCNNode(geometry: rendered); object.name = "preview-object"; view.scene?.rootNode.addChildNode(object)
        view.scene?.rootNode.addChildNode(ParkingReferenceRenderer.makeNode(navigationReference))
        let (minimum, maximum) = ParkingReferenceRenderer.bounds(navigationReference, minimum: geometry.minimum, maximum: geometry.maximum)
        let center = SCNVector3((minimum.x + maximum.x) / 2, (minimum.y + maximum.y) / 2, (minimum.z + maximum.z) / 2)
        let size = max(maximum.x - minimum.x, maximum.y - minimum.y, maximum.z - minimum.z, 0.1)
        let camera = SCNNode(); camera.camera = SCNCamera(); camera.camera?.zNear = 0.001; camera.camera?.zFar = Double(max(size * 100, 1000))
        camera.camera?.projectionDirection = .vertical
        camera.camera?.fieldOfView = ZividFieldOfView.previewVerticalDegrees
        let direction = simd_normalize(SIMD3<Float>(1.2, -1.8, 1))
        var distance = size * simd_length(SIMD3<Float>(1.2, -1.8, 1))
        if let viewport = initialViewport, viewport.width > 0, viewport.height > 0 {
            // Fit the completed model to 86% of the visible left canvas. Using
            // both viewport axes avoids a tiny landscape preview or clipped
            // sides when the same model is first opened in portrait.
            let right = simd_normalize(simd_cross(SIMD3<Float>(0, 0, 1), direction))
            let up = simd_cross(direction, right)
            let tangentY = tan(Float(ZividFieldOfView.previewVerticalDegrees) * .pi / 360) * 0.86
            let tangentX = tangentY * Float(viewport.width / viewport.height)
            distance = size * 0.05
            for x in [minimum.x, maximum.x] {
                for y in [minimum.y, maximum.y] {
                    for z in [minimum.z, maximum.z] {
                        let offset = SIMD3<Float>(x - center.x, y - center.y, z - center.z)
                        let depth = simd_dot(offset, direction)
                        distance = max(distance, depth + max(abs(simd_dot(offset, right)) / tangentX,
                                                             abs(simd_dot(offset, up)) / tangentY))
                    }
                }
            }
        }
        camera.position = SCNVector3(center.x + direction.x * distance,
                                    center.y + direction.y * distance, center.z + direction.z * distance)
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
    @State private var showsModelOrigin = false
    @State private var overviewExpanded = false
    @State private var poseEditorHeight: CGFloat = 0
    @State private var previewToolbarHeight: CGFloat = 0
    @State private var phoneDetailsOpen = false
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
                if TeachingDevice.isPhone {
                    let landscape = viewport.size.width > viewport.size.height
                    let layout = landscape ? AnyLayout(HStackLayout(spacing: 0)) : AnyLayout(VStackLayout(spacing: 0))
                    layout {
                        posePreview
                            .frame(height: landscape ? nil : max(180, viewport.size.height * 0.53))
                        VStack(spacing: 0) {
                            poseList()
                            Button { phoneDetailsOpen = true } label: {
                                HStack {
                                    Image(systemName: selectingForDeletion ? "trash" : "info.circle")
                                    Text(selectingForDeletion ? "管理所选（\(deletionIDs.count)）" : "Pose 详情 / 编辑")
                                    Spacer(minLength: 0)
                                    Image(systemName: "chevron.up")
                                }.font(.subheadline).frame(minHeight: 44).padding(.horizontal, 14)
                            }.disabled(selected == nil).accessibilityIdentifier("phone-pose-details")
                                .background(accent.opacity(0.08))
                        }.frame(width: landscape ? 240 : nil)
                    }
                } else if viewport.size.width >= 1000 && viewport.size.width > viewport.size.height {
                    HStack(spacing: 0) {
                        VStack(spacing: 0) {
                            poseList(headerHeight: previewToolbarHeight)
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
                                poseList().frame(width: viewport.size.width * 0.38)
                                Divider()
                                poseEditorPanel(maximumHeight: max(0, viewport.size.height - max(180, viewport.size.height * 0.62) - 1))
                            }
                        } else {
                            VStack(spacing: 0) {
                                poseList()
                                poseEditorPanel(maximumHeight: min(190, viewport.size.height * 0.3))
                            }
                        }
                    }
                }
            }
            .background(Color(red: 0.025, green: 0.05, blue: 0.065))
            .accessibilityElement(children: .contain).accessibilityIdentifier("pose-review-page")
            .toolbar(.hidden, for: .navigationBar)
        }.sheet(isPresented: $phoneDetailsOpen) {
            NavigationStack {
                ScrollView { poseEditor.padding(20) }
                    .scrollDismissesKeyboard(.interactively)
                    .background(Color(red: 0.025, green: 0.05, blue: 0.065))
                    .navigationTitle("Pose 详情").navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) {
                        Button("完成") { poseNameFocused = false; phoneDetailsOpen = false }
                            .accessibilityIdentifier("close-phone-pose-details")
                    } }
            }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible)
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

    private func poseList(headerHeight: CGFloat = 0) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text("\(samples.count) 个 Pose").font(.subheadline.weight(.medium))
                    .accessibilityIdentifier("pose-review-count")
                Spacer(minLength: 8)
                Button {
                    poseNameFocused = false
                    if selectingForDeletion { endDeletionSelection() }
                    else { deletionIDs = []; selectingForDeletion = true }
                } label: {
                    Text(selectingForDeletion ? "取消" : "多选")
                        .font(.subheadline.weight(.medium)).padding(.vertical, 5)
                }.buttonStyle(.bordered).tint(accent)
                    .disabled(samples.isEmpty || session.busy)
                    .accessibilityIdentifier(selectingForDeletion ? "cancel-pose-selection" : "select-poses")
            }.padding(.horizontal, 16).padding(.vertical, 12)
                .frame(minHeight: headerHeight)
            if !TeachingDevice.isPhone {
                PoseOriginLegend(samples: samples, coveragePercentages: coverage.categoryPercentages,
                                 coverageTitle: coverage.coverageTitle).padding(.horizontal, 16).padding(.bottom, 12)
            }
            Divider()
            if selectingForDeletion {
                HStack {
                    Button {
                        deletionIDs = allPosesSelected ? [] : Set(samples.map(\.id))
                    } label: {
                        Label("全选", systemImage: allPosesSelected ? "checkmark.square.fill" : deletionIDs.isEmpty ? "square" : "minus.square.fill")
                    }.disabled(session.busy).accessibilityIdentifier("select-all-poses")
                        .accessibilityValue(allPosesSelected ? "已全选" : deletionIDs.isEmpty ? "未选择" : "部分选择")
                    Spacer()
                    Text("已选 \(deletionIDs.count)/\(samples.count)").font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("selected-poses-count")
                }
                .padding(.horizontal, 20).frame(minHeight: 48)
                Divider()
            }
            List {
                ForEach(samples) { sample in
                    poseRow(sample)
                }
            }.listStyle(.plain).scrollDismissesKeyboard(.interactively)
                .accessibilityIdentifier("pose-review-list")
        }
    }

    private var allPosesSelected: Bool { !samples.isEmpty && deletionIDs.count == samples.count }

    private func poseRow(_ sample: TeachingSample) -> some View {
        let highlighted = selectingForDeletion ? deletionIDs.contains(sample.id) : sample.id == selected?.id
        let origin = sample.category
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
                        .foregroundStyle(origin.color)
                    Label(origin.label, systemImage: origin.symbol)
                        .font(.caption).foregroundStyle(origin.color)
                    Text(sample.capturedAt).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }.padding(.vertical, 5).contentShape(Rectangle())
        }.listRowBackground(highlighted ? origin.color.opacity(0.12) : Color.clear)
            .disabled(session.busy)
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

    private var previewToolbar: some View {
        VStack(spacing: 0) {
            if TeachingDevice.isPhone {
                VStack(spacing: 6) {
                    HStack(spacing: 6) {
                        previewModeButtons
                        Spacer(minLength: 0)
                        resetPreviewButton.labelStyle(.iconOnly)
                        Button { poseNameFocused = false; dismiss() } label: {
                            Image(systemName: "arrow.uturn.backward").frame(width: 44, height: 44)
                        }.accessibilityLabel("返回示教").accessibilityIdentifier("close-pose-review")
                    }
                    previewQualityControl
                }.padding(.horizontal, 10).padding(.vertical, 6)
            } else {
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
            }
            if !renderer.error.isEmpty {
                Text(renderer.error).font(.caption).foregroundStyle(.orange)
                    .padding(.horizontal, 12).padding(.bottom, 8)
            }
        }
        // Match the sidebar header to this toolbar even when its controls wrap.
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { previewToolbarHeight = $0 }
    }

    private var posePreview: some View {
        VStack(spacing: 0) {
            previewToolbar
            Divider()
            if let selected {
                let ready = previewPreparation.sampleID == selected.id
                GeometryReader { area in
                    let recordedAspect = ZividFieldOfView.nativeAspect
                    // Let the 3D surface anchor its overview to the whole preview area.
                    // The surface fits the recorded camera's aspect ratio internally.
                    let interactive = previewMode == .interactive
                    let width = interactive ? area.size.width : min(area.size.width, area.size.height * recordedAspect)
                    let height = interactive ? area.size.height : width / recordedAspect
                    PosePreviewView(rendered: renderer.geometry, overview: previewPreparation.overview,
                                    footprint: ready ? previewPreparation.footprint : nil,
                                    status: ready ? previewPreparation.status : "正在提取当前 Pose 点云…",
                                    sample: selected, mode: previewMode, resetRevision: previewReset,
                                    navigationReference: session.current?.session.navigationReference,
                                    showsCameraPose: $showsPoseCamera, showsModelOrigin: $showsModelOrigin,
                                    overviewExpanded: $overviewExpanded)
                        .frame(width: width, height: height)
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("\(selected.name) 的物体视角")
                        .accessibilityValue(previewMode == .interactive ? "3D 交互视图" : "2D 记录视角图像")
                        .accessibilityIdentifier("pose-review-preview")
                        .frame(width: area.size.width, height: area.size.height)
                }
                .ignoresSafeArea(.container, edges: previewMode == .interactive ? .bottom : [])
            } else { ContentUnavailableView("还没有 Pose", systemImage: "viewfinder") }
        }.frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.black.opacity(0.25))
            .accessibilityElement(children: .contain).accessibilityIdentifier("pose-review-viewport")
    }

    private var previewModeButtons: some View {
        HStack(spacing: 6) {
            ForEach(PosePreviewMode.allCases) { mode in
                Button { poseNameFocused = false; previewMode = mode } label: {
                    Label(mode == .interactive ? "3D模型" : "2D 图像",
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
            poseEditor.padding(.horizontal, 16).padding(.vertical, 14)
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
                if completed {
                    Text("删除后生成可编辑副本，原完成结果保留。")
                        .font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("completed-pose-edit-note")
                }
                Button("删除所选（\(deletionIDs.count)）", role: .destructive) {
                    let ids = deletionIDs
                    Task {
                        if await session.deleteSelectedSamples(ids) {
                            if let id = selectedID, ids.contains(id) {
                                selectedID = samples.first?.id; poseName = samples.first?.name ?? ""
                            }
                            endDeletionSelection()
                        }
                    }
                }.buttonStyle(.borderedProminent).tint(.red)
                    .disabled(deletionIDs.isEmpty || session.busy)
                    .accessibilityIdentifier("delete-selected-poses")
                if session.busy { ProgressView("正在保存…").font(.caption) }
                if !session.error.isEmpty { Text(session.error).font(.caption).foregroundStyle(.orange) }
            }.frame(maxWidth: .infinity, alignment: .leading)
        } else if let selected {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text("Pose 详情").font(.caption.weight(.medium)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 0)
                    Text(selected.name.isEmpty ? "Pose" : selected.name).font(.headline)
                        .multilineTextAlignment(.trailing)
                }
                Label(selected.category.label, systemImage: selected.category.symbol)
                    .font(.caption.weight(.medium)).foregroundStyle(selected.category.color)
                    .accessibilityIdentifier("pose-selected-origin")
                HStack {
                    Text("\(coverage.coverageTitle)（估算）").font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    let fraction = previewPreparation.sampleID == selected.id ? previewPreparation.footprint?.coveredFraction : nil
                    Text(TeachingCoverageRenderer.percentage(fraction))
                        .font(.subheadline.monospacedDigit().weight(.semibold)).foregroundStyle(selected.category.color)
                        .accessibilityIdentifier("pose-selected-coverage-percentage")
                }
                let p = selected.cameraPose.position
                if previewMode == .image {
                    Text("拍摄参数 · Zivid 2 M70 · 1944 × 1200\n视野 56.6° × 35.6° · 工作距离 0.30–1.30 m")
                        .font(.caption).foregroundStyle(accent)
                        .accessibilityIdentifier("pose-camera-profile")
                }
                Text("X \(p.x, specifier: "%.4f") m\nY \(p.y, specifier: "%.4f") m\nZ \(p.z, specifier: "%.4f") m")
                    .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                if !completed {
                    TextField("Pose 名称", text: $poseName).textFieldStyle(.roundedBorder)
                        .focused($poseNameFocused)
                        .accessibilityIdentifier("review-pose-name")
                    Button("保存名称") { session.renameSample(selected.id, name: poseName); poseNameFocused = false }
                        .buttonStyle(.bordered).accessibilityIdentifier("save-pose-name")
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
