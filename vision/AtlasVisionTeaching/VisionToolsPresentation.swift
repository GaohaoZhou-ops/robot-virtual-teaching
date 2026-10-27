import Foundation

/// Window identity is separate from the immersive session. A retired window's
/// delayed disappearance must never stop the scene or a newer control window.
struct VisionToolsPresentation {
    struct Recall: Equatable {
        let previous: String?
        let replacement: String
    }
    private(set) var current: String?
    private(set) var pending: Recall?
    private var lastRecall: Double?

    mutating func start() -> String {
        if let current { return current }
        let id = UUID().uuidString; current = id; return id
    }

    mutating func recall(now: Double) -> String? {
        guard pending == nil, lastRecall.map({ now - $0 >= 0.8 }) ?? true else { return nil }
        let id = UUID().uuidString
        pending = Recall(previous: current, replacement: id)
        current = id; lastRecall = now
        return id
    }

    /// Acknowledge the replacement before closing the old window, keeping the
    /// document engine and a working control panel available during the handoff.
    mutating func appeared(_ id: String) -> String? {
        guard current == id, let pending, pending.replacement == id else { return nil }
        self.pending = nil
        return pending.previous
    }

    mutating func cancelRecall(_ id: String) -> Recall? {
        guard let pending, pending.replacement == id else { return nil }
        current = pending.previous; self.pending = nil
        return pending
    }

    /// Only an intentional close of the current, presented window exits space.
    mutating func closed(_ id: String) -> Bool {
        guard current == id else { return false }
        if cancelRecall(id) != nil { return false }
        end(); return true
    }

    mutating func end() {
        current = nil; pending = nil; lastRecall = nil
    }
}
