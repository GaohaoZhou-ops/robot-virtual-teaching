import SwiftUI
import UIKit

struct VisionIPv4AddressField: UIViewRepresentable {
    @Binding var host: String
    @Binding var error: String
    var replacementID: UUID
    var onEdit: () -> Void
    var onSubmit: () -> Void

    func makeUIView(context: Context) -> VisionIPv4AddressInput { VisionIPv4AddressInput() }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: VisionIPv4AddressInput, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? 440, height: proposal.height ?? 64)
    }
    func updateUIView(_ view: VisionIPv4AddressInput, context: Context) {
        view.onChange = { host = $0; error = "" }
        view.onReject = { error = $0 }
        view.onEdit = onEdit
        view.onSubmit = onSubmit
        view.setHost(host, replacementID: replacementID)
        if view.isEnabled != context.environment.isEnabled { view.isEnabled = context.environment.isEnabled }
        view.alpha = view.isEnabled ? 1 : 0.5
    }
}

// Keep one keyboard session while moving between the four large tap targets.
// Switching native first responders for each octet can lose rapid input on visionOS.
final class VisionIPv4AddressInput: UITextField, UITextFieldDelegate {
    var onChange: (String) -> Void = { _ in }
    var onReject: (String) -> Void = { _ in }
    var onEdit: () -> Void = {}
    var onSubmit: () -> Void = {}
    private(set) var octets = Array(repeating: "", count: 4)
    private let cells = (0..<4).map { _ in UIButton(type: .system) }
    private let dots = (0..<3).map { _ in UILabel() }
    private var appliedHost = ""
    private var appliedReplacementID: UUID?
    private var activeIndex = 0
    private var replaceOctet = true
    private var skipSeparator = false
    private var applyingReplacement = false
    private let accent = UIColor.systemCyan
    private let cellSpacing: CGFloat = 16

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        font = .monospacedSystemFont(ofSize: 29, weight: .medium)
        textColor = .clear; tintColor = .clear; borderStyle = .none
        keyboardType = .decimalPad; returnKeyType = .next
        autocorrectionType = .no; spellCheckingType = .no; smartInsertDeleteType = .no
        accessibilityIdentifier = "server-address"
        accessibilityLabel = "电脑 IPv4 地址"
        accessibilityHint = "四个独立数字格，每段为 0 到 255，也可粘贴完整 IPv4 地址"
        for (index, cell) in cells.enumerated() {
            cell.tag = index; cell.titleLabel?.font = font
            cell.accessibilityIdentifier = "server-address-octet-\(index)"
            cell.accessibilityLabel = "IPv4 地址第 \(index + 1) 段"
            cell.accessibilityHint = "轻点后输入可替换整段，输入三位后自动进入下一段"
            cell.addTarget(self, action: #selector(selectCellButton(_:)), for: .touchUpInside)
            cell.layer.cornerRadius = 18; cell.layer.masksToBounds = true
            addSubview(cell)
        }
        for dot in dots {
            dot.text = "."; dot.font = font; dot.textAlignment = .center
            dot.textColor = .secondaryLabel; dot.isAccessibilityElement = false
            addSubview(dot)
        }
        refreshCells()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override var isEnabled: Bool {
        didSet {
            cells.forEach { $0.isEnabled = isEnabled }
            if !isEnabled { resignFirstResponder() }
        }
    }
    override var intrinsicContentSize: CGSize { CGSize(width: 440, height: 64) }
    override func layoutSubviews() {
        super.layoutSubviews()
        let gap = cellSpacing, width = max(0, (bounds.width - gap * 3) / 4)
        for (index, cell) in cells.enumerated() {
            cell.frame = CGRect(x: CGFloat(index) * (width + gap), y: 0, width: width, height: bounds.height)
            bringSubviewToFront(cell)
            if index < 3 { dots[index].frame = CGRect(x: cell.frame.maxX, y: 0, width: gap, height: bounds.height) }
        }
    }
    override func caretRect(for position: UITextPosition) -> CGRect { .zero }
    override func selectionRects(for range: UITextRange) -> [UITextSelectionRect] { [] }
    override func closestPosition(to point: CGPoint) -> UITextPosition? {
        selectCell(min(3, max(0, Int(point.x / max((bounds.width + cellSpacing) / 4, 1)))))
        return endOfDocument
    }
    func selectCell(_ index: Int) {
        activeIndex = min(3, max(0, index)); replaceOctet = true; skipSeparator = false
        refreshCells()
    }
    @objc private func selectCellButton(_ sender: UIButton) {
        selectCell(sender.tag); onEdit(); becomeFirstResponder(); updateCursor(); refreshCells()
    }
    func setHost(_ host: String, replacementID: UUID) {
        let externalReplacement = appliedReplacementID != replacementID
        // Delayed SwiftUI snapshots cannot overwrite an active native edit.
        // Search/selection explicitly increments the ID so it can still fill a focused field.
        guard externalReplacement || (!isFirstResponder && host != appliedHost) else { return }
        applyingReplacement = true
        if externalReplacement { resignFirstResponder() }
        appliedReplacementID = replacementID; appliedHost = host
        octets = IPv4Input.octets(host, allowingEmpty: true) ?? Array(repeating: "", count: 4)
        text = octets.allSatisfy(\.isEmpty) ? "" : octets.joined(separator: ".")
        activeIndex = 0; replaceOctet = true; skipSeparator = false
        applyingReplacement = false
        updateCursor(); refreshCells()
    }
    private func publish() {
        appliedHost = octets.allSatisfy(\.isEmpty) ? "" : octets.joined(separator: ".")
        text = appliedHost
        updateCursor(); refreshCells(); onChange(appliedHost)
    }
    private func updateCursor() { selectedTextRange = textRange(from: endOfDocument, to: endOfDocument) }
    private func refreshCells() {
        for (index, cell) in cells.enumerated() {
            let active = isFirstResponder && index == activeIndex
            cell.setTitle(octets[index].isEmpty ? "—" : octets[index], for: .normal)
            cell.setTitleColor(octets[index].isEmpty ? .tertiaryLabel : .label, for: .normal)
            cell.accessibilityValue = octets[index].isEmpty ? "未输入" : octets[index]
            cell.backgroundColor = active ? accent.withAlphaComponent(0.12) : UIColor.black.withAlphaComponent(0.18)
            cell.layer.borderColor = (active ? accent : UIColor.white.withAlphaComponent(0.3)).cgColor
            cell.layer.borderWidth = active ? 2 : 1
        }
    }
    private func normalizeOctet() {
        if let number = Int(octets[activeIndex]) { octets[activeIndex] = String(number) }
    }
    private func advance() {
        guard !octets[activeIndex].isEmpty else { return }
        normalizeOctet(); publish()
        if activeIndex < 3 { selectCell(activeIndex + 1) }
        else { resignFirstResponder(); onSubmit() }
    }
    override func deleteBackward() {
        guard isEnabled else { return }
        skipSeparator = false
        if octets[activeIndex].isEmpty && activeIndex > 0 {
            activeIndex -= 1; replaceOctet = false
        }
        octets[activeIndex] = replaceOctet ? "" : String(octets[activeIndex].dropLast())
        replaceOctet = false; publish()
    }
    func textFieldDidBeginEditing(_ field: UITextField) { onEdit(); refreshCells() }
    func textFieldDidEndEditing(_ field: UITextField) {
        if !applyingReplacement {
            let previous = octets
            octets = octets.map { Int($0).map(String.init) ?? "" }
            if previous != octets { publish() }
        }
        refreshCells()
    }
    func textFieldShouldReturn(_ field: UITextField) -> Bool { advance(); return false }
    func textField(_ field: UITextField, shouldChangeCharactersIn range: NSRange, replacementString replacement: String) -> Bool {
        guard isEnabled else { return false }
        if replacement.isEmpty { deleteBackward(); return false }
        if replacement == "." {
            if skipSeparator { skipSeparator = false } else { advance() }
            return false
        }
        let value = replacement.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.contains(".") {
            guard let parts = IPv4Input.octets(value) else {
                onReject("请输入完整 IPv4 地址，每段为 0–255。"); return false
            }
            octets = parts.map { String(Int($0)!) }
            selectCell(3); publish()
            return false
        }
        let updated = (replaceOctet ? "" : octets[activeIndex]) + value
        guard !value.isEmpty, IPv4Input.acceptsOctet(updated) else {
            onReject("每段只能输入 0–255 的数字。"); return false
        }
        skipSeparator = false
        octets[activeIndex] = updated; replaceOctet = false
        if updated.count == 3 {
            normalizeOctet()
            if activeIndex < 3 { selectCell(activeIndex + 1); skipSeparator = true }
        }
        publish()
        return false
    }
}
