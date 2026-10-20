import Foundation
import Combine

@MainActor
final class VisionPairingAutofill: ObservableObject {
    @Published private(set) var code = ""
    @Published private(set) var replacementID = UUID()
    @Published private(set) var offers: [VisionPairingOffer] = []
    @Published private(set) var selected: VisionPairingOffer?
    @Published private(set) var server: DiscoveredTeachingServer?
    @Published private(set) var isLoading = false
    @Published private(set) var message = ""
    private var request: Task<Void, Never>?
    private var expiry: Task<Void, Never>?
    private var generation = UUID()
    private let lookup: (DiscoveredTeachingServer) async throws -> [VisionPairingOffer]

    init(lookup: @escaping (DiscoveredTeachingServer) async throws -> [VisionPairingOffer] = {
        try await LANClient(address: $0.address).visionPairingOffers(serverID: $0.id)
    }) { self.lookup = lookup }

    func load(from server: DiscoveredTeachingServer) {
        stop()
        self.server = server; offers = []; selected = nil
        code = ""; replacementID = UUID(); isLoading = true
        message = "正在获取 \(server.name) 的配对码…"
        let generation = generation, lookup = lookup
        request = Task { [weak self] in
            do {
                let offers = try await lookup(server)
                guard let self, self.generation == generation else { return }
                self.isLoading = false; self.offers = offers.filter { !$0.isExpired }
                if self.offers.count == 1, let offer = self.offers.first { self.select(offer) }
                else {
                    self.message = self.offers.isEmpty
                        ? "电脑上暂无待配对任务。请打开「设备 → Vision Pro」配对窗口，再点重新获取配对码。"
                        : "电脑上有多个待配对物体，请点选要接收的物体。"
                }
            } catch {
                guard let self, self.generation == generation else { return }
                self.isLoading = false
                self.message = "\(error.localizedDescription) 也可手动输入配对码。"
            }
        }
    }

    func select(_ offer: VisionPairingOffer) {
        guard offers.contains(where: { $0.id == offer.id }) else { return }
        expiry?.cancel()
        guard !offer.isExpired else {
            code = ""; replacementID = UUID(); selected = nil
            message = "配对码已过期，请在电脑更新后重新获取。"
            return
        }
        selected = offer; code = offer.code; replacementID = UUID()
        message = "已自动填入「\(offer.name)」的配对码，点击「配对并检查模型」即可继续。"
        let generation = generation
        expiry = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0, offer.expiresAt / 1000 - Date().timeIntervalSince1970))) }
            catch { return }
            guard let self, self.generation == generation else { return }
            self.validateExpiration()
        }
    }

    func validateExpiration() {
        guard let selected, selected.isExpired else { return }
        code = ""; replacementID = UUID(); self.selected = nil
        message = "配对码已过期，请在电脑更新后重新获取。"
    }

    func beginEditing() {
        stop(); selected = nil; offers = []; message = ""
    }
    func edit(_ value: String) { beginEditing(); code = value }

    func addressChanged() {
        if selected != nil { code = ""; replacementID = UUID() }
        beginEditing(); server = nil
    }

    func stop() {
        generation = UUID(); request?.cancel(); request = nil
        expiry?.cancel(); expiry = nil; isLoading = false
    }
    func reset() {
        stop(); code = ""; replacementID = UUID(); offers = []; selected = nil; server = nil; message = ""
    }
    deinit { request?.cancel(); expiry?.cancel() }
}
