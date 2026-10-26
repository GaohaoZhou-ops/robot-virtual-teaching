import SwiftUI

struct VisionWorkspaceView: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @Environment(\.openImmersiveSpace) private var openSpace
    @Environment(\.dismissImmersiveSpace) private var dismissSpace
    @Environment(\.dismissWindow) private var dismissWindow
    @Environment(\.openWindow) private var openWindow
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var discovery = LANServiceDiscovery()
    @StateObject private var pairingAutofill = VisionPairingAutofill()
    @State private var finishConfirmation = false
    @State private var syncOnFinish = false
    @State private var autofillDiscovery = false
    @State private var hasSearched = false
    @State private var addressReplacementID = UUID()
    @State private var addressError = ""
    @State private var modelSyncPresented = false
    @State private var showingModelPreview = true
    @State private var sceneLibraryPresented = false
    @FocusState private var portFocused: Bool

    private var completed: Bool { session.current?.result.completedAt != nil }
    private var spaceClosed: Bool { spatial.spaceState == .closed }
    private var previewing: Bool { spaceClosed && showingModelPreview }
    private var canUseAddress: Bool {
        addressError.isEmpty && IPv4Input.octets(session.serverConnection.host) != nil && session.serverConnection.canConnect
    }
    private var discoveryMessage: String {
        if let selected = discovery.servers.first(where: { $0.address == session.serverAddress }) {
            return "已填入 \(selected.name) 的地址和端口。" + (discovery.servers.count > 1 ? "可选择下方其他电脑切换。" : "配对码将从电脑配对窗口自动获取。")
        }
        if hasSearched && !discovery.isSearching && discovery.servers.isEmpty && discovery.message.isEmpty {
            return "未找到局域网服务器。请确认电脑已启动示教服务，两台设备连接同一 Wi-Fi，再点重新检测；也可手动填写下方地址。"
        }
        return discovery.message
    }

    private var windowContent: some View {
        Group {
            if session.current == nil { welcome }
            else { workspace }
        }
        .frame(minWidth: 1100, minHeight: 800)
        .font(.title3)
        .controlSize(.extraLarge)
    }

    private var sampleIDs: [String] { session.current?.result.samples.map(\.id) ?? [] }

    private var observedContent: some View {
        windowContent
        .task {
            await session.reload()
            if let current = session.current { showingModelPreview = current.result.samples.isEmpty }
        }
        .onChange(of: session.pendingModel?.id) { _, id in
            modelSyncPresented = id != nil
            if id != nil { pairingAutofill.stop() }
        }
        .sheet(isPresented: $modelSyncPresented) { VisionModelSyncView().environmentObject(session) }
        .onChange(of: session.current?.id) { _, _ in
            discovery.stop(); autofillDiscovery = false
            pairingAutofill.reset()
            showingModelPreview = true
            addressReplacementID = UUID(); addressError = ""; portFocused = false
            if let model = session.geometry, let current = session.current {
                spatial.configure(model, samples: current.result.samples, demo: current.result.device.platform == "visionOS-simulator", draft: current.spatialCameraDraft, readOnly: current.result.completedAt != nil)
            }
        }
        .onChange(of: discovery.servers.map { $0.id + $0.address }) { _, _ in
            if autofillDiscovery, session.current == nil, let server = discovery.servers.first { selectServer(server) }
        }
        .onChange(of: discovery.isSearching) { _, searching in if !searching { autofillDiscovery = false } }
        .onChange(of: portFocused) { _, focused in
            if focused { autofillDiscovery = false; pairingAutofill.addressChanged() }
        }
        .onChange(of: session.serverAddress) { _, address in
            if let server = pairingAutofill.server, server.address != address { pairingAutofill.addressChanged() }
        }
        .onChange(of: spatial.targetCommit) { _, _ in session.saveSpatialDraft(spatial.cameraTarget?.draft) }
        .onChange(of: session.current?.result.completedAt) { _, value in spatial.readOnly = value != nil; spatial.refreshManipulation() }
        .onChange(of: sampleIDs) { _, _ in spatial.refreshMarkers(session.current?.result.samples ?? []) }
        .onChange(of: spatial.quality) { _, _ in if let model = session.geometry { spatial.render(model) } }
        .onChange(of: spatial.displayMode) { _, _ in if let model = session.geometry { spatial.render(model) } }
    }

    var body: some View {
        observedContent
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { pairingAutofill.validateExpiration() }
            if phase == .background && spaceClosed {
                session.backgroundSave(); spatial.stop()
            }
        }
        .onDisappear {
            discovery.stop(); pairingAutofill.stop(); session.backgroundSave()
        }
        .sheet(isPresented: $sceneLibraryPresented) { VisionSceneLibraryView() }
        .confirmationDialog("完成后将锁定当前 Pose，可以稍后重试同步。", isPresented: $finishConfirmation, titleVisibility: .visible) {
            Button(syncOnFinish ? "完成并同步" : "完成并保存在本机") {
                Task {
                    if !spaceClosed { spatial.stop(); spatial.spaceState = .closing; await dismissSpace() }
                    await session.finish(sync: syncOnFinish && !spatial.isDemo)
                }
            }
            Button("取消", role: .cancel) {}
        }
    }

    private var welcome: some View {
        GeometryReader { viewport in
            let panelHeight = max(600, viewport.size.height - 250)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack(spacing: 24) {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("ATLAS / VISION PRO")
                                .font(.system(.callout, design: .monospaced)).tracking(3).foregroundStyle(.cyan)
                            Text("虚拟示教").font(.largeTitle.weight(.medium))
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "visionpro").font(.system(size: 60, weight: .ultraLight))
                            .foregroundStyle(.cyan).accessibilityHidden(true)
                    }
                    VisionInteractionHint()
                    Button { sceneLibraryPresented = true } label: {
                        HStack(spacing: 20) {
                            Image(systemName: "square.3.layers.3d").font(.largeTitle)
                            VStack(alignment: .leading, spacing: 6) {
                                Text("打开空间工程").font(.title2)
                                Text("地图、机器人与动作，在沙盘和原大空间中查看").font(.body).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Image(systemName: "arrow.up.right")
                        }.padding(16).frame(maxWidth: .infinity)
                    }.buttonStyle(.borderedProminent).tint(.cyan).accessibilityIdentifier("open-scene-library")
                    HStack(alignment: .top, spacing: 24) {
                        pairingPanel(minHeight: panelHeight)
                            .frame(width: min(560, (viewport.size.width - 88) * 0.5))
                        localProjectsPanel(minHeight: panelHeight)
                    }
                }
                .padding(32)
                .frame(maxWidth: .infinity, minHeight: viewport.size.height, alignment: .topLeading)
                .accessibilityElement(children: .contain).accessibilityIdentifier("library-content")
            }
        }
    }

    private func pairingPanel(minHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Label("从电脑接收物体", systemImage: "wifi").font(.title2.weight(.medium))
            if let pending = session.pendingModel {
                Divider()
                Label("新模型待同步", systemImage: "arrow.down.circle").foregroundStyle(.cyan)
                VisionModelFileInfo(manifest: pending.session.manifest)
                Button("查看文件并同步") { modelSyncPresented = true }
                    .buttonStyle(.borderedProminent).tint(.cyan)
                    .accessibilityIdentifier("review-model-sync")
                Button("连接新任务") { Task { await session.close() } }
                    .accessibilityIdentifier("new-project")
            } else { connection }
            status
            Spacer(minLength: 0)
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
        .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.1)))
        .accessibilityElement(children: .contain).accessibilityIdentifier("library-pairing-panel")
    }

    private func localProjectsPanel(minHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 16) {
                Label("保存在此 Vision Pro", systemImage: "square.stack.3d.up").font(.title2.weight(.medium))
                Spacer(minLength: 0)
                Text("\(session.projects.count) 个物体").font(.body).foregroundStyle(.secondary)
                    .fixedSize().accessibilityIdentifier("local-project-count")
            }
            Divider()
            if session.projects.isEmpty {
                VStack(spacing: 20) {
                    Image(systemName: "cube.transparent")
                        .font(.system(size: 76, weight: .ultraLight)).foregroundStyle(.cyan.opacity(0.8))
                        .accessibilityHidden(true)
                    Text("从电脑接收第一个物体").font(.title3.weight(.medium))
                    Text("接收后，物体和示教草稿都会出现在这里。")
                        .font(.body).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, minHeight: 300)
                .accessibilityElement(children: .combine).accessibilityIdentifier("local-projects-empty")
            } else {
                LazyVStack(spacing: 16) {
                    ForEach(session.projects) { item in
                        Button { Task { await session.open(item) } } label: {
                            HStack(spacing: 20) {
                                VStack(alignment: .leading, spacing: 12) {
                                    Text(item.session.manifest.name).font(.title3.weight(.medium)).lineLimit(3)
                                    Text("\(item.result.samples.count) 个 Pose · \(item.syncedAt != nil ? "已同步" : item.result.completedAt != nil ? "已完成，待同步" : "本地草稿")")
                                        .font(.body).foregroundStyle(.secondary)
                                    if session.openingProjectID == item.id {
                                        ProgressView("正在加载…").font(.body).controlSize(.small)
                                    }
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "cube.transparent").font(.system(size: 40, weight: .light))
                                    .foregroundStyle(.cyan).frame(width: 76, height: 76)
                                    .background(.cyan.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
                                    .accessibilityHidden(true)
                            }
                            .multilineTextAlignment(.leading).padding(20)
                            .frame(maxWidth: .infinity, minHeight: 116, alignment: .leading)
                            .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 18))
                            .contentShape(RoundedRectangle(cornerRadius: 18))
                        }
                        .buttonStyle(.plain).hoverEffect(.highlight).disabled(session.busy)
                        .accessibilityIdentifier("project-\(item.id)")
                    }
                }.accessibilityIdentifier("local-project-list")
            }
            Spacer(minLength: 0)
            Label("下载后可离线示教，完成后再同步到电脑。", systemImage: "checkmark.icloud")
                .font(.body).foregroundStyle(.secondary)
            #if targetEnvironment(simulator)
            Divider()
            Button { Task { await VisionDemo.load(into: session) } } label: {
                Label("打开本地演练", systemImage: "testtube.2").frame(maxWidth: .infinity)
            }.disabled(session.busy).accessibilityIdentifier("open-demo")
            Text("演练使用合成模型和位姿，仅保存在本机。")
                .font(.body).foregroundStyle(.secondary)
            #endif
        }
        .padding(24)
        .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .topLeading)
        .background(.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 24))
        .overlay(RoundedRectangle(cornerRadius: 24).strokeBorder(.white.opacity(0.1)))
        .accessibilityElement(children: .contain).accessibilityIdentifier("library-projects-panel")
    }

    private var workspace: some View {
        HStack(spacing: 0) {
            library.frame(width: 280)
            Divider()
            VStack(alignment: .leading, spacing: 24) {
                header
                GeometryReader { viewport in
                    ScrollView {
                        project
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 8).padding(.trailing, 8)
                            .frame(minHeight: previewing ? viewport.size.height : nil, alignment: .top)
                    }
                }
                status
                if previewing { previewActions }
                else if !completed { completionActions }
            }.padding(32)
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Text("ATLAS / SPATIAL TEACHING").font(.callout.weight(.semibold)).tracking(2).foregroundStyle(.secondary)
                Text(session.current?.session.manifest.name ?? "把示教带入空间").font(.largeTitle.bold()).lineLimit(2)
            }
            Spacer()
            Image(systemName: "visionpro").font(.system(size: 38)).foregroundStyle(.cyan).accessibilityHidden(true)
        }
    }

    private var library: some View {
        VStack(alignment: .leading, spacing: 24) {
            Label("本地任务", systemImage: "square.stack.3d.up").font(.title2.bold()).padding(.horizontal, 20)
            Button { Task { await session.close() } } label: {
                Label("连接新任务", systemImage: "plus")
            }.padding(.horizontal, 20).disabled(session.busy || !spaceClosed).accessibilityIdentifier("new-project")
            if session.projects.isEmpty {
                Text("下载后的模型与 Pose 会保存在这里，可离线继续示教。")
                    .foregroundStyle(.secondary).padding(.horizontal, 20)
            }
            ScrollView {
                LazyVStack(spacing: 20) {
                    ForEach(session.projects) { item in
                        let displayed = session.current?.id == item.id ? (session.current ?? item) : item
                        Button { Task { await session.open(item) } } label: {
                            VStack(alignment: .leading, spacing: 7) {
                                Text(item.session.manifest.name).font(.title3.weight(.medium)).lineLimit(2)
                                Text("\(displayed.result.samples.count) 个 Pose · \(displayed.syncedAt != nil ? "已同步" : displayed.result.completedAt != nil ? "待同步" : "草稿")")
                                    .font(.body).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                        }
                        .tint(item.id == session.current?.id ? Color.cyan : nil)
                        .accessibilityIdentifier("project-\(item.id)")
                        .disabled(session.busy || !spaceClosed || item.id == session.current?.id)
                    }
                }.padding(.horizontal, 20).padding(.vertical, 8)
            }
            Text("下载后可断网使用\n完成后再回到局域网同步").font(.body).foregroundStyle(.secondary).padding(20)
        }.padding(.top, 30)
    }

    private var connection: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 16) {
                Image(systemName: "globe").font(.system(size: 36, weight: .light)).foregroundStyle(.cyan)
                    .frame(width: 64, height: 64)
                    .background(.cyan.opacity(0.07), in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(.cyan.opacity(0.18)))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text("局域网配对").font(.title3.weight(.medium)).foregroundStyle(.cyan)
                    Text("自动查找电脑，免输地址和端口").font(.body).foregroundStyle(.secondary)
                }
            }
            discoveryPanel
            Text("在电脑端打开「设备 → Vision Pro」配对窗口，两台设备连接同一局域网。")
                .font(.body).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            pairingCodeStatus
            DisclosureGroup {
                addressFields
                VStack(alignment: .leading, spacing: 12) {
                Text("4 位配对码 · 选择电脑后自动填入").font(.body).foregroundStyle(.secondary)
                VisionPairingCodeField(code: Binding(get: { pairingAutofill.code }, set: { pairingAutofill.edit($0) }),
                                       replacementID: pairingAutofill.replacementID, onEdit: { pairingAutofill.beginEditing() })
                    .frame(maxWidth: .infinity).frame(height: 68)
                }
            } label: {
                Text("手动连接").accessibilityIdentifier("manual-connection")
            }
            Button {
                discovery.stop(); pairingAutofill.validateExpiration()
                guard PairingCode.isValid(pairingAutofill.code) else { return }
                session.code = pairingAutofill.code; pairingAutofill.stop()
                Task { await session.pair(confirmNewModel: true) }
            } label: {
                Label("配对并检查模型", systemImage: "checkmark.shield")
                    .frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent).tint(.cyan)
            .disabled(session.busy || pairingAutofill.isLoading || !canUseAddress || !PairingCode.isValid(pairingAutofill.code))
            .accessibilityIdentifier("pair-model")
        }.disabled(session.busy)
    }

    private var pairingCodeStatus: some View {
        VStack(alignment: .leading, spacing: 12) {
            if pairingAutofill.isLoading { ProgressView().controlSize(.small) }
            if !pairingAutofill.message.isEmpty {
                Text(pairingAutofill.message).font(.body).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("pairing-autofill-status")
            }
            if pairingAutofill.offers.count > 1 {
                ForEach(pairingAutofill.offers) { offer in
                    Button { pairingAutofill.select(offer) } label: {
                        HStack {
                            Label(offer.name, systemImage: "cube.transparent").lineLimit(2)
                            Spacer(minLength: 0)
                            if pairingAutofill.selected?.id == offer.id { Image(systemName: "checkmark.circle.fill").foregroundStyle(.cyan) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityIdentifier("pairing-offer-\(offer.id)")
                }
            }
            if let server = pairingAutofill.server, server.address == session.serverAddress, !pairingAutofill.isLoading {
                Button("重新获取配对码") { pairingAutofill.load(from: server) }
                    .accessibilityIdentifier("retry-pairing-code")
            }
        }
    }

    private var discoveryPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                portFocused = false; addressReplacementID = UUID(); addressError = ""
                pairingAutofill.reset()
                hasSearched = true; autofillDiscovery = true; discovery.start()
            } label: {
                HStack(spacing: 12) {
                    if discovery.isSearching {
                        ProgressView().controlSize(.small)
                        Text("正在检测局域网服务器…")
                    } else {
                        Label(hasSearched ? "重新检测局域网服务器" : "自动检测局域网服务器", systemImage: "network")
                    }
                }.frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.bordered).tint(.cyan)
            .disabled(discovery.isSearching || session.busy)
            .accessibilityIdentifier("discover-teaching-server")
            .accessibilityHint("自动查找同一局域网内的示教服务器，并填入电脑地址和端口")
            if hasSearched {
                Text(discoveryMessage).font(.body).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("discovery-status")
            }
            ForEach(discovery.servers) { server in
                let selected = server.address == session.serverAddress
                Button { selectServer(server) } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "desktopcomputer").foregroundStyle(.cyan)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(server.name).lineLimit(2)
                            Text(LANAddressInput(address: server.address).displayAddress)
                                .font(.system(.body, design: .monospaced)).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 0)
                        if selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(.cyan) }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                .disabled(session.busy)
                .accessibilityIdentifier("discovered-service-\(server.id)")
                .accessibilityValue(selected ? "已填入" : "未选择")
            }
        }
    }

    private func selectServer(_ server: DiscoveredTeachingServer) {
        autofillDiscovery = false; portFocused = false
        session.serverAddress = server.address
        addressReplacementID = UUID(); addressError = ""
        pairingAutofill.load(from: server)
    }

    private var addressFields: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 20) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("电脑 IPv4 地址").font(.body).foregroundStyle(.secondary)
                    VisionIPv4AddressField(host: $session.serverConnection.host, error: $addressError,
                                           replacementID: addressReplacementID,
                                           onEdit: { autofillDiscovery = false; pairingAutofill.addressChanged() }, onSubmit: { portFocused = true })
                        .frame(maxWidth: .infinity).frame(height: 68)
                }.frame(minWidth: 300, maxWidth: 440)
                VStack(alignment: .leading, spacing: 12) {
                    Text("端口").font(.body).foregroundStyle(.secondary)
                    TextField(LANAddressInput.defaultPort, text: $session.serverConnection.port)
                        .focused($portFocused).keyboardType(.numberPad).submitLabel(.done)
                        .onSubmit { portFocused = false }
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(.system(size: 26, weight: .medium, design: .monospaced)).multilineTextAlignment(.center)
                        .textFieldStyle(.plain).padding(.horizontal, 8).frame(height: 68)
                        .background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 18))
                        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(portFocused ? .cyan : .white.opacity(0.3), lineWidth: portFocused ? 2 : 1))
                        .contentShape([.interaction, .hoverEffect], RoundedRectangle(cornerRadius: 18))
                        .hoverEffect(.highlight)
                        .onTapGesture { portFocused = true }
                        .accessibilityLabel("服务端口").accessibilityIdentifier("server-port")
                }.frame(width: 108)
            }
            if !addressError.isEmpty {
                Text(addressError).foregroundStyle(.orange).accessibilityIdentifier("server-address-error")
            } else if IPv4Input.octets(session.serverConnection.host, allowingEmpty: true) == nil {
                Text("已保存的地址不是 IPv4，请重新搜索电脑或手动填写。").foregroundStyle(.orange)
            } else {
                Text("每段 0–255，也可粘贴完整 IPv4 地址。").foregroundStyle(.secondary)
            }
        }.font(.body).disabled(session.busy)
    }

    private var project: some View {
        VStack(alignment: .leading, spacing: 24) {
            if spaceClosed, let current = session.current { VisionModelFileInfo(manifest: current.session.manifest) }
            HStack(spacing: 16) {
                Label(completed ? "已完成" : "本地草稿", systemImage: completed ? "checkmark.seal" : "square.and.pencil")
                Text("\(session.current?.result.samples.count ?? 0) 个 Pose").monospacedDigit().accessibilityIdentifier("pose-count")
                if !previewing {
                    if spatial.preparing {
                        ProgressView(spatial.renderStatus).font(.body).controlSize(.small)
                            .accessibilityIdentifier("render-progress")
                    } else {
                        Text(spatial.renderSummary).font(.body).foregroundStyle(.secondary)
                            .accessibilityIdentifier("render-summary")
                    }
                } else if spatial.preparing { ProgressView().controlSize(.small) }
            }
            if spatial.isDemo { Label("模拟演练 · 不可同步", systemImage: "testtube.2").foregroundStyle(.orange) }
            if previewing {
                if let model = session.geometry { VisionModelPreview(model: model).id(session.current?.id) }
            } else {
                teachingProject
            }
        }
    }

    private var teachingProject: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 24) {
                Picker("显示", selection: $spatial.displayMode) {
                    ForEach(ModelDisplayMode.allCases) { Text($0.label).tag($0) }
                }.pickerStyle(.segmented).frame(width: 220)
                Picker("精度", selection: $spatial.quality) {
                    ForEach(VisionQuality.allCases) { Text($0.label).tag($0) }
                }.pickerStyle(.menu).frame(width: 190).accessibilityIdentifier("render-quality")
                Spacer(minLength: 0)
                Button(spaceClosed ? "进入空间示教" : "退出空间") { Task { await toggleSpace() } }
                    .buttonStyle(.borderedProminent).tint(.cyan)
                    .disabled(session.busy || spatial.preparing || spatial.spaceState == .opening || spatial.spaceState == .closing)
                    .accessibilityIdentifier("toggle-space")
            }
            if !spaceClosed {
                VisionTeachingControls(compact: false)
                Text("可将任务窗口移到侧面，使用空间控制板记录 Pose。")
                    .font(.body).foregroundStyle(.secondary)
            }
            VisionPoseList().frame(height: 240)
            if completed {
                Divider()
                DisclosureGroup("更换接收电脑") { addressFields }
                Button(session.current?.syncedAt == nil ? "同步到电脑" : "再次同步") { Task { await session.finish(sync: true) } }
                    .disabled(session.busy || spatial.isDemo || !canUseAddress).accessibilityIdentifier("sync-result")
                if spaceClosed { previewButton }
            }
        }
    }

    private var previewActions: some View {
        VStack(alignment: .leading, spacing: 24) {
            Divider()
            HStack(spacing: 24) {
                Button(completed ? "返回任务列表" : "暂不示教") { Task { await session.close() } }
                    .disabled(session.busy).accessibilityIdentifier("defer-teaching")
                if session.current?.result.samples.isEmpty == false {
                    Button("查看记录") { showingModelPreview = false }
                        .disabled(session.busy).accessibilityIdentifier("review-poses")
                }
                Spacer(minLength: 0)
                Button("进入空间示教") { Task { await toggleSpace() } }
                    .buttonStyle(.borderedProminent).tint(.cyan)
                    .disabled(session.busy || spatial.preparing || spatial.modelEntity == nil || !spatial.renderError.isEmpty)
                    .accessibilityIdentifier("toggle-space")
            }
        }
    }

    private var previewButton: some View {
        Button("预览模型") { showingModelPreview = true }
            .disabled(session.busy).accessibilityIdentifier("preview-model")
    }

    private var completionActions: some View {
        VStack(alignment: .leading, spacing: 24) {
            Divider()
            HStack(spacing: 24) {
                Button("完成并保存在本机") { syncOnFinish = false; finishConfirmation = true }
                    .disabled(session.busy || session.current?.result.samples.isEmpty != false || spatial.calibrating)
                    .accessibilityIdentifier("finish-local")
                Button("完成并同步") { syncOnFinish = true; finishConfirmation = true }
                    .disabled(spatial.isDemo || session.busy || session.current?.result.samples.isEmpty != false || spatial.calibrating)
                if spaceClosed { previewButton }
            }
        }
    }

    @ViewBuilder private var status: some View {
        if session.busy || !session.status.isEmpty || !session.error.isEmpty || !spatial.renderError.isEmpty {
            VStack(alignment: .leading, spacing: 20) {
                if !session.error.isEmpty {
                    HStack(spacing: 24) {
                        Text(session.error).foregroundStyle(.red).textSelection(.enabled)
                        Button("知道了") { session.error = "" }
                    }.accessibilityIdentifier("session-error")
                }
                if !spatial.renderError.isEmpty {
                    HStack(spacing: 24) {
                        Text(spatial.renderError).foregroundStyle(.red)
                        Button("重试显示") { if let model = session.geometry { spatial.render(model) } }
                    }
                }
                if session.busy || !session.status.isEmpty {
                    HStack {
                        if session.busy { ProgressView().controlSize(.small) }
                        if !session.status.isEmpty { Text(session.status).font(.body).foregroundStyle(.secondary) }
                    }
                }
            }
        }
    }

    private func toggleSpace() async {
        if !spaceClosed {
            spatial.stop(); spatial.spaceState = .closing; await dismissSpace()
        } else {
            spatial.spaceState = .opening
            switch await openSpace(id: "teaching-space") {
            case .opened:
                showingModelPreview = false; spatial.spaceState = .open
                openWindow(id: "spatial-controls", value: "spatial-controls")
                dismissWindow(id: "workspace")
            case .userCancelled: spatial.spaceState = .closed
            case .error: spatial.spaceState = .closed; session.error = "无法打开空间，请关闭其他沉浸式 App 后重试"
            @unknown default: spatial.spaceState = .closed
            }
        }
    }
}

struct VisionInteractionHint: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("注视按钮，拇指与食指轻捏并松开", systemImage: "hand.pinch")
            #if targetEnvironment(simulator)
            Text("模拟器：鼠标指向目标后单击，无需拉近面板。")
            #endif
        }
        .font(.callout).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
    }
}

struct VisionPoseList: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @State private var deletingID: String?
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach((session.current?.result.samples ?? []).reversed()) { sample in
                    HStack(spacing: 24) {
                        Button { spatial.selectRecordedTarget(sample.id) } label: { Image(systemName: "camera.fill").foregroundStyle(.yellow) }
                            .disabled(!spatial.placement.isCalibrated).accessibilityLabel("查看 " + sample.name)
                        VStack(alignment: .leading) {
                            Text(sample.name).font(.title3.weight(.medium))
                            Text(sample.cameraPose.frameName == VisionCameraTarget.frameName ? "空间相机视点" : "头显参考视点")
                                .font(.body.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if session.current?.result.completedAt == nil {
                            Button(role: .destructive) { deletingID = sample.id } label: { Image(systemName: "trash") }.accessibilityLabel("删除 \(sample.name)")
                        }
                    }.padding(12)
                }
            }
        }.disabled(session.busy)
        .confirmationDialog("删除这个 Pose？", isPresented: Binding(get: { deletingID != nil }, set: { if !$0 { deletingID = nil } }), titleVisibility: .visible) {
            Button("删除", role: .destructive) { if let id = deletingID { session.deleteSample(id) }; deletingID = nil }
            Button("取消", role: .cancel) { deletingID = nil }
        }
    }
}
