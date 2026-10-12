import SwiftUI

struct VisionWorkspaceView: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @Environment(\.openImmersiveSpace) private var openSpace
    @Environment(\.dismissImmersiveSpace) private var dismissSpace
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var discovery = LANServiceDiscovery()
    @State private var finishConfirmation = false
    @State private var syncOnFinish = false
    @State private var autofillDiscovery = false
    @State private var hasSearched = false
    @State private var addressReplacementID = UUID()
    @State private var addressError = ""
    @State private var modelSyncPresented = false
    @State private var showingModelPreview = true
    @FocusState private var portFocused: Bool

    private var completed: Bool { session.current?.result.completedAt != nil }
    private var spaceClosed: Bool { spatial.spaceState == .closed }
    private var previewing: Bool { spaceClosed && showingModelPreview }
    private var canUseAddress: Bool {
        addressError.isEmpty && IPv4Input.octets(session.serverConnection.host) != nil && session.serverConnection.canConnect
    }
    private var discoveryMessage: String {
        if let selected = discovery.servers.first(where: { $0.address == session.serverAddress }) {
            return "已填入 \(selected.name) 的地址和端口。" + (discovery.servers.count > 1 ? "可选择下方其他电脑切换。" : "请输入电脑上的配对码。")
        }
        return discovery.message
    }

    var body: some View {
        HStack(spacing: 0) {
            library.frame(width: 280)
            Divider()
            VStack(alignment: .leading, spacing: 24) {
                header
                ScrollView {
                    VStack(alignment: .leading, spacing: 24) {
                        if session.current != nil { project }
                        else if let pending = session.pendingModel {
                            VStack(alignment: .leading, spacing: 24) {
                                Label("新模型待同步", systemImage: "arrow.down.circle").font(.title2)
                                VisionModelFileInfo(manifest: pending.session.manifest)
                                Button("查看文件并同步") { modelSyncPresented = true }
                                    .buttonStyle(.borderedProminent).tint(.cyan)
                                    .accessibilityIdentifier("review-model-sync")
                            }
                        } else { connection }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
                    .padding(.trailing, 8)
                }
                status
                if session.current != nil {
                    if previewing { previewActions }
                    else if !completed { completionActions }
                }
            }.padding(32)
        }
        .frame(minWidth: 1100, minHeight: 800)
        .controlSize(.extraLarge)
        .task { await session.reload() }
        .onChange(of: session.pendingModel?.id) { _, id in modelSyncPresented = id != nil }
        .sheet(isPresented: $modelSyncPresented) { VisionModelSyncView().environmentObject(session) }
        .onChange(of: session.current?.id) { _, _ in
            discovery.stop(); autofillDiscovery = false
            showingModelPreview = true
            addressReplacementID = UUID(); addressError = ""; portFocused = false
            if let model = session.geometry, let current = session.current {
                spatial.configure(model, samples: current.result.samples, demo: current.result.device.platform == "visionOS-simulator")
            }
        }
        .onChange(of: discovery.servers.map { $0.id + $0.address }) { _, _ in
            if autofillDiscovery, session.current == nil, let server = discovery.servers.first { selectServer(server) }
        }
        .onChange(of: discovery.isSearching) { _, searching in if !searching { autofillDiscovery = false } }
        .onChange(of: portFocused) { _, focused in if focused { autofillDiscovery = false } }
        .onChange(of: session.current?.result.samples.map(\.id)) { _, _ in spatial.refreshMarkers(session.current?.result.samples ?? []) }
        .onChange(of: spatial.quality) { _, _ in if let model = session.geometry { spatial.render(model) } }
        .onChange(of: spatial.displayMode) { _, _ in if let model = session.geometry { spatial.render(model) } }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background {
                session.backgroundSave(); spatial.stop()
                if !spaceClosed { spatial.spaceState = .closing; Task { await dismissSpace() } }
            }
        }
        .onDisappear {
            discovery.stop(); session.backgroundSave()
            if !spaceClosed { spatial.stop(); spatial.spaceState = .closing; Task { await dismissSpace() } }
        }
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

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                Text("ATLAS / SPATIAL TEACHING").font(.caption.weight(.semibold)).tracking(2).foregroundStyle(.secondary)
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
                                Text(item.session.manifest.name).font(.headline).lineLimit(2)
                                Text("\(displayed.result.samples.count) 个 Pose · \(displayed.syncedAt != nil ? "已同步" : displayed.result.completedAt != nil ? "待同步" : "草稿")")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                        }
                        .tint(item.id == session.current?.id ? Color.cyan : nil)
                        .disabled(session.busy || !spaceClosed || item.id == session.current?.id)
                    }
                }.padding(.horizontal, 20).padding(.vertical, 8)
            }
            Text("下载后可断网使用\n完成后再回到局域网同步").font(.caption).foregroundStyle(.secondary).padding(20)
        }.padding(.top, 30)
    }

    private var connection: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text("打开电脑端「iPad / Vision Pro」弹窗，输入其中的配对码。")
                .font(.title3)
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 24) {
                    Button {
                        portFocused = false; addressReplacementID = UUID(); addressError = ""
                        hasSearched = true; autofillDiscovery = true; discovery.start()
                    } label: { Label("搜索局域网电脑", systemImage: "wifi") }
                        .disabled(discovery.isSearching || session.busy)
                        .accessibilityIdentifier("discover-teaching-server")
                    if discovery.isSearching { ProgressView().controlSize(.small) }
                }
                if hasSearched {
                    Text(discoveryMessage).font(.caption).foregroundStyle(.secondary)
                        .accessibilityIdentifier("discovery-status")
                }
            }
            ForEach(discovery.servers) { server in
                let selected = server.address == session.serverAddress
                Button { selectServer(server) } label: {
                    HStack(spacing: 16) {
                        Label(server.name, systemImage: "desktopcomputer")
                        Text(LANAddressInput(address: server.address).displayAddress).monospacedDigit().foregroundStyle(.secondary)
                        if selected { Image(systemName: "checkmark.circle.fill").foregroundStyle(.cyan) }
                    }
                }.disabled(session.busy)
                    .accessibilityIdentifier("discovered-service-\(server.id)")
                    .accessibilityValue(selected ? "已填入" : "未选择")
            }
            addressFields
            VStack(alignment: .leading, spacing: 16) {
                Text("4 位配对码").font(.headline)
                HStack(spacing: 24) {
                    VisionPairingCodeField(code: $session.code).frame(width: 316, height: 64)
                    Button { discovery.stop(); Task { await session.pair(confirmNewModel: true) } } label: { Label("配对并检查模型", systemImage: "checkmark.shield") }
                        .buttonStyle(.borderedProminent).tint(.cyan)
                        .disabled(session.busy || !canUseAddress || !PairingCode.isValid(session.code))
                        .accessibilityIdentifier("pair-model")
                }
            }
            #if targetEnvironment(simulator)
            Divider()
            Button("打开本地演练") { Task { await VisionDemo.load(into: session) } }.disabled(session.busy)
                .accessibilityIdentifier("open-demo")
            Text("模拟器演练使用合成模型和位姿，不能同步到电脑。")
                .font(.caption).foregroundStyle(.secondary)
            #endif
        }.disabled(session.busy)
    }

    private func selectServer(_ server: DiscoveredTeachingServer) {
        autofillDiscovery = false; portFocused = false
        session.serverAddress = server.address
        addressReplacementID = UUID(); addressError = ""
    }

    private var addressFields: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 32) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("电脑 IPv4 地址").font(.callout).foregroundStyle(.secondary)
                    VisionIPv4AddressField(host: $session.serverConnection.host, error: $addressError,
                                           replacementID: addressReplacementID,
                                           onEdit: { autofillDiscovery = false }, onSubmit: { portFocused = true })
                        .frame(width: 440, height: 64)
                }
                VStack(alignment: .leading, spacing: 12) {
                    Text("端口").font(.callout).foregroundStyle(.secondary)
                    TextField(LANAddressInput.defaultPort, text: $session.serverConnection.port)
                        .focused($portFocused).keyboardType(.numberPad).submitLabel(.done)
                        .onSubmit { portFocused = false }
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .font(.system(size: 24, weight: .medium, design: .monospaced)).multilineTextAlignment(.center)
                        .textFieldStyle(.plain).padding(.horizontal, 12).frame(height: 64)
                        .background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 18))
                        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(portFocused ? .cyan : .white.opacity(0.3), lineWidth: portFocused ? 2 : 1))
                        .contentShape(RoundedRectangle(cornerRadius: 18)).onTapGesture { portFocused = true }
                        .accessibilityLabel("服务端口").accessibilityIdentifier("server-port")
                }.frame(width: 120)
            }
            if !addressError.isEmpty {
                Text(addressError).foregroundStyle(.orange).accessibilityIdentifier("server-address-error")
            } else if IPv4Input.octets(session.serverConnection.host, allowingEmpty: true) == nil {
                Text("已保存的地址不是 IPv4，请重新搜索电脑或手动填写。").foregroundStyle(.orange)
            } else {
                Text("每段 0–255，输入三位后自动跳转；也可粘贴完整 IPv4 地址。").foregroundStyle(.secondary)
            }
        }.font(.callout).disabled(session.busy)
    }

    private var project: some View {
        VStack(alignment: .leading, spacing: 24) {
            if spaceClosed, let current = session.current { VisionModelFileInfo(manifest: current.session.manifest) }
            HStack(spacing: 16) {
                Label(completed ? "已完成" : "本地草稿", systemImage: completed ? "checkmark.seal" : "square.and.pencil")
                Text("\(session.current?.result.samples.count ?? 0) 个 Pose").monospacedDigit().accessibilityIdentifier("pose-count")
                if !previewing { Text(spatial.renderSummary).font(.caption).foregroundStyle(.secondary) }
                if spatial.preparing { ProgressView().controlSize(.small) }
            }
            if spatial.isDemo { Label("模拟演练 · 不可同步", systemImage: "testtube.2").foregroundStyle(.orange) }
            if previewing {
                VisionModelPreview().id(session.current?.id)
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
                }.frame(width: 190)
                Spacer(minLength: 0)
                Button(spaceClosed ? "进入空间示教" : "退出空间") { Task { await toggleSpace() } }
                    .buttonStyle(.borderedProminent).tint(.cyan)
                    .disabled(session.busy || spatial.preparing || spatial.spaceState == .opening || spatial.spaceState == .closing)
                    .accessibilityIdentifier("toggle-space")
            }
            if !spaceClosed {
                VisionTeachingControls(compact: false)
                Text("可将任务窗口移到侧面，使用空间控制板记录 Pose。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            VisionPoseList().frame(height: 240)
            if completed {
                Divider()
                addressFields
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
                        if !session.status.isEmpty { Text(session.status).font(.caption).foregroundStyle(.secondary) }
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
            case .opened: showingModelPreview = false; spatial.spaceState = .open
            case .userCancelled: spatial.spaceState = .closed
            case .error: spatial.spaceState = .closed; session.error = "无法打开空间，请关闭其他沉浸式 App 后重试"
            @unknown default: spatial.spaceState = .closed
            }
        }
    }
}

struct VisionTeachingControls: View {
    @EnvironmentObject private var session: TeachingSession
    @EnvironmentObject private var spatial: VisionTrackingController
    @State private var nearby: NearbyPoseConfirmation?
    let compact: Bool
    private var readOnly: Bool { session.current?.result.completedAt != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                Label(spatial.tracking, systemImage: spatial.trackingNormal ? "location.fill" : "location.slash")
                    .foregroundStyle(spatial.trackingNormal ? .green : .orange)
                Spacer()
                if compact { Text("\(session.current?.result.samples.count ?? 0) Pose").monospacedDigit() }
            }.font(.callout)
            if !spatial.placement.isCalibrated {
                Text(spatial.message).font(.caption).foregroundStyle(.secondary)
                HStack(spacing: 24) {
                    Button("放到前方") { spatial.placeInFront() }.accessibilityIdentifier(compact ? "spatial-place-front" : "place-front")
                    Button(readOnly ? "确认显示位置" : "确认校准") {
                        Task {
                            do {
                                guard readOnly || (session.current?.result.calibrations.count ?? 0) < 1000 else { throw TeachingError("校准段已达上限，请完成此任务") }
                                let calibration = try await spatial.confirm()
                                if !readOnly { session.addCalibration(calibration) }
                            } catch is CancellationError {} catch { session.error = error.localizedDescription }
                        }
                    }.buttonStyle(.borderedProminent).tint(.cyan)
                        .disabled(spatial.placement.transform == nil || !spatial.trackingNormal || spatial.preparing || spatial.calibrating)
                        .accessibilityIdentifier(compact ? "spatial-confirm-placement" : "confirm-placement")
                    if spatial.canCancelAdjustment { Button("取消调整") { spatial.cancelAdjustment() }
                        .accessibilityIdentifier(compact ? "spatial-cancel-adjustment" : "cancel-adjustment") }
                }.disabled(spatial.calibrating)
                if !compact && !spatial.isDemo {
                    Button("沿头部朝向放到水平面") { spatial.placeOnObservedSurface() }
                        .disabled(spatial.planeCount == 0 || !spatial.trackingNormal || spatial.calibrating)
                }
                if !compact && spatial.placement.transform != nil {
                    HStack(spacing: 32) {
                        nudge("左右", axis: 0); nudge("高度", axis: 1); nudge("前后", axis: 2)
                    }
                    HStack(spacing: 32) {
                        angle("偏航", axis: 2, value: spatial.placement.yaw)
                        angle("俯仰", axis: 1, value: spatial.placement.pitch)
                        angle("翻滚", axis: 0, value: spatial.placement.roll)
                    }
                }
            } else {
                HStack(spacing: 24) {
                    if !readOnly { Button { capture() } label: { Label("记录 Pose", systemImage: "plus.circle.fill") }
                        .buttonStyle(.borderedProminent).tint(.cyan)
                        .disabled(!spatial.canRecord || (session.current?.result.samples.count ?? 0) >= maximumSamples)
                        .accessibilityIdentifier(compact ? "spatial-record-pose" : "record-pose")
                    } else { Label("已完成 · 空间回看", systemImage: "checkmark.seal") }
                    Button("调整模型") { nearby = nil; spatial.beginAdjustment() }.accessibilityIdentifier(compact ? "spatial-adjust-model" : "adjust-model")
                }
                Button("控制板移到面前") { spatial.recenterPanel() }
            }
            if !compact {
                Toggle("M70 虚拟视锥 · 0.3–1.3 m", isOn: $spatial.showFrustum).font(.callout).frame(minHeight: 64)
                Text("以头显参考点模拟相机视角，未包含实际相机外参标定。模型始终保持 1:1。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            #if targetEnvironment(simulator)
            if spatial.isDemo { Button("模拟向右移动 20 cm") { spatial.moveDemo() }.accessibilityIdentifier(compact ? "spatial-move-demo" : "move-demo") }
            #endif
        }
        .controlSize(.extraLarge)
        .disabled(session.busy || !session.error.isEmpty || spatial.spaceState != .open)
        .alert("距离上一个 Pose 小于 10 cm", isPresented: Binding(get: { nearby != nil }, set: { if !$0 { nearby = nil } })) {
            Button("仍然记录") {
                if let pending = nearby, spatial.canRecord,
                   pending.sample.segmentId == spatial.placement.calibration?.id { _ = session.addSample(pending.sample) }
                nearby = nil
            }
            Button("取消", role: .cancel) { nearby = nil }
        } message: { Text(nearby?.message ?? "") }
    }
    private func capture() {
        do {
            let sample = try spatial.capture()
            if let confirmation = NearbyPoseConfirmation(sample: sample, previousSample: session.current?.result.samples.last) { nearby = confirmation }
            else { _ = session.addSample(sample) }
        } catch { session.error = error.localizedDescription }
    }
    private func nudge(_ label: String, axis: Int) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("\(label) · 1 cm").font(.callout)
            HStack(spacing: 20) {
                Button { spatial.nudge(axis: axis, amount: -0.01) } label: { Image(systemName: "minus") }.accessibilityLabel("\(label)减 1 cm")
                Button { spatial.nudge(axis: axis, amount: 0.01) } label: { Image(systemName: "plus") }.accessibilityLabel("\(label)加 1 cm")
            }
        }.frame(maxWidth: .infinity, alignment: .leading).disabled(spatial.calibrating)
    }
    private func angle(_ label: String, axis: Int, value: Float) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("\(label) \(value, specifier: "%.0f")°").font(.callout).monospacedDigit()
            Slider(value: Binding(get: { value }, set: { spatial.setAngle(axis, degrees: $0) }), in: -180...180, step: 1)
                .frame(minHeight: 64)
                .accessibilityLabel(label)
        }.disabled(spatial.calibrating)
    }
}

struct VisionPoseList: View {
    @EnvironmentObject private var session: TeachingSession
    @State private var editingID: String?
    @State private var editedName = ""
    @State private var deletingID: String?
    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach((session.current?.result.samples ?? []).reversed()) { sample in
                    HStack(spacing: 24) {
                        Image(systemName: "location.north.circle").foregroundStyle(.yellow)
                        VStack(alignment: .leading) {
                            Text(sample.name).font(.headline)
                            Text(String(format: "x %.3f   y %.3f   z %.3f m", sample.cameraPose.position.x, sample.cameraPose.position.y, sample.cameraPose.position.z))
                                .font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if session.current?.result.completedAt == nil {
                            Button { editingID = sample.id; editedName = sample.name } label: { Image(systemName: "pencil") }.accessibilityLabel("重命名 \(sample.name)")
                            Button(role: .destructive) { deletingID = sample.id } label: { Image(systemName: "trash") }.accessibilityLabel("删除 \(sample.name)")
                        }
                    }.padding(12)
                }
            }
        }.disabled(session.busy)
        .alert("重命名 Pose", isPresented: Binding(get: { editingID != nil }, set: { if !$0 { editingID = nil } })) {
            TextField("名称", text: $editedName)
            Button("保存") { if let id = editingID { session.renameSample(id, name: editedName) }; editingID = nil }
            Button("取消", role: .cancel) { editingID = nil }
        }
        .confirmationDialog("删除这个 Pose？", isPresented: Binding(get: { deletingID != nil }, set: { if !$0 { deletingID = nil } }), titleVisibility: .visible) {
            Button("删除", role: .destructive) { if let id = deletingID { session.deleteSample(id) }; deletingID = nil }
            Button("取消", role: .cancel) { deletingID = nil }
        }
    }
}
