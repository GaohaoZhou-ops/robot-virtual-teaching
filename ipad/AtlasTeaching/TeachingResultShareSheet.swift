import SwiftUI
import UIKit

struct TeachingResultShareItem: Identifiable {
    let url: URL
    var id: URL { url }
}

// SwiftUI presents this controller in a popover anchored to the iPad share button.
struct TeachingResultShareSheet: UIViewControllerRepresentable {
    let url: URL
    let onCompletion: (UIActivity.ActivityType?, Bool, Error?) -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        controller.completionWithItemsHandler = { activity, completed, _, error in
            Task { @MainActor in onCompletion(activity, completed, error) }
        }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
