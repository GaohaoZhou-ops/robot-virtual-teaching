import Foundation

enum VisionToolsPresentationTests {
    static func run() {
        var state = VisionToolsPresentation()
        let first = state.start()
        precondition(state.start() == first, "Refreshing space must reuse its current control window")
        precondition(state.appeared(first) == nil)
        let recalled = state.recall(now: 10)!
        precondition(recalled != first, "Recall needs a fresh window identity to apply placement at the wearer")
        precondition(state.recall(now: 11) == nil, "Repeated taps must not open duplicate pending windows")
        precondition(!state.closed(first), "Closing the retired panel must not exit the immersive space")
        precondition(state.current == recalled)
        precondition(state.appeared(recalled) == first, "Retire the old panel only after the replacement appears")
        precondition(state.pending == nil && state.appeared(recalled) == nil)
        precondition(state.recall(now: 10.2) == nil, "A double pinch must not make another window after fast presentation")
        let next = state.recall(now: 12)!
        precondition(state.appeared(next) == recalled)
        precondition(!state.closed(first) && !state.closed(recalled), "Delayed callbacks cannot dismiss the newest panel")
        precondition(state.closed(next), "Closing the current panel still exits space intentionally")
        precondition(state.current == nil && state.pending == nil)

        let existing = state.start(), failed = state.recall(now: 20)!
        let request = state.cancelRecall(failed)
        precondition(request?.previous == existing && request?.replacement == failed)
        precondition(state.current == existing && state.pending == nil)
        precondition(state.appeared(failed) == nil && !state.closed(failed),
                     "A late replacement after timeout is obsolete and cannot exit space")
        let interrupted = state.recall(now: 22)!
        precondition(!state.closed(interrupted) && state.current == existing,
                     "A replacement that disappears before appearing restores the old panel")
        let exiting = state.recall(now: 24)!
        state.end()
        precondition(state.cancelRecall(exiting) == nil && state.appeared(exiting) == nil && !state.closed(exiting),
                     "Leaving space cancels recall; late callbacks must never reopen controls")
        precondition(state.start() != existing, "A new immersive session gets a fresh control window")
        print("Control recall: current-view placement identity, debounce, late callbacks, timeout recovery and immersive-session isolation passed.")
    }
}
