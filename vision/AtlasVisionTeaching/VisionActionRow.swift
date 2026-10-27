import SwiftUI

/// Measure short actions at their natural width. If the whole row cannot fit,
/// stack the controls so a neighbouring title never squeezes their labels.
/// Document names and descriptive cards should keep their own wrapping rules.
struct VisionActionRow<Content: View>: View {
    private let spacing: CGFloat
    private let alignment: HorizontalAlignment
    private let content: Content

    init(spacing: CGFloat = 12, alignment: HorizontalAlignment = .leading, @ViewBuilder content: () -> Content) {
        self.spacing = spacing; self.alignment = alignment; self.content = content()
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: spacing) { content }
                .lineLimit(1).fixedSize(horizontal: true, vertical: false)
            VStack(alignment: alignment, spacing: spacing) { content }
                .fixedSize(horizontal: false, vertical: true)
        }
        .multilineTextAlignment(.center)
    }
}
