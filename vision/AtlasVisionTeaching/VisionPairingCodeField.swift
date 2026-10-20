import SwiftUI
import UIKit

struct VisionPairingCodeField: UIViewRepresentable {
    @Binding var code: String
    var replacementID: UUID? = nil
    var onEdit: () -> Void = {}

    func makeUIView(context: Context) -> VisionPairingCodeInput { VisionPairingCodeInput() }
    func updateUIView(_ view: VisionPairingCodeInput, context: Context) {
        view.onChange = { code = $0 }
        view.onEdit = onEdit
        view.setCode(code, replacementID: replacementID)
        if view.isEnabled != context.environment.isEnabled { view.isEnabled = context.environment.isEnabled }
        view.alpha = view.isEnabled ? 1 : 0.5
    }
}

// Four individually selectable cells share a native keyboard session. Changing
// first responders between characters on visionOS can drop rapid keystrokes.
final class VisionPairingCodeInput: UITextField, UITextFieldDelegate {
    var onChange: (String) -> Void = { _ in }
    var onEdit: () -> Void = {}
    private(set) var characters = Array(repeating: "", count: 4)
    private let cells = (0..<4).map { _ in UIButton(type: .system) }
    private var appliedCode = ""
    private var appliedReplacementID: UUID?
    private var activeIndex = 0
    private let accent = UIColor.systemCyan

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        font = .monospacedSystemFont(ofSize: 32, weight: .semibold)
        textColor = .clear; tintColor = .clear; borderStyle = .none
        keyboardType = .asciiCapable; textContentType = .oneTimeCode
        autocapitalizationType = .allCharacters
        autocorrectionType = .no; spellCheckingType = .no; smartInsertDeleteType = .no
        returnKeyType = .done
        accessibilityIdentifier = "pairing-code"
        accessibilityLabel = "4 位配对码"
        accessibilityHint = "四个独立格，轻点任一格修改；支持字母、数字及完整配对码粘贴"
        for (index, cell) in cells.enumerated() {
            cell.tag = index; cell.titleLabel?.font = font; cell.setTitleColor(.label, for: .normal)
            cell.accessibilityIdentifier = "pairing-code-cell-\(index)"
            cell.accessibilityLabel = "配对码第 \(index + 1) 位"
            cell.addTarget(self, action: #selector(selectCellButton(_:)), for: .touchUpInside)
            cell.layer.cornerRadius = 18; cell.layer.masksToBounds = true
            addSubview(cell)
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
    override var intrinsicContentSize: CGSize { CGSize(width: 316, height: 64) }
    override func layoutSubviews() {
        super.layoutSubviews()
        let gap: CGFloat = 20, width = max(0, (bounds.width - gap * 3) / 4)
        for (index, cell) in cells.enumerated() {
            cell.frame = CGRect(x: CGFloat(index) * (width + gap), y: 0, width: width, height: bounds.height)
            bringSubviewToFront(cell)
        }
    }
    override func caretRect(for position: UITextPosition) -> CGRect { .zero }
    override func selectionRects(for range: UITextRange) -> [UITextSelectionRect] { [] }
    override func closestPosition(to point: CGPoint) -> UITextPosition? {
        selectCell(min(3, max(0, Int(point.x / max((bounds.width + 20) / 4, 1)))))
        return position(from: beginningOfDocument, offset: min(activeIndex, (text ?? "").utf16.count))
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        super.touchesEnded(touches, with: event)
        if let point = touches.first?.location(in: self) { _ = closestPosition(to: point); updateCursor() }
    }
    func selectCell(_ index: Int) {
        activeIndex = min(3, max(0, index)); refreshCells()
    }
    @objc private func selectCellButton(_ sender: UIButton) {
        selectCell(sender.tag); becomeFirstResponder(); updateCursor(); refreshCells()
    }
    func setCode(_ code: String, replacementID: UUID? = nil) {
        if replacementID != appliedReplacementID {
            appliedReplacementID = replacementID
            resignFirstResponder()
        }
        // The native edit transaction owns the value while the keyboard is
        // active; a delayed SwiftUI snapshot must not overwrite newer input.
        guard !isFirstResponder, code != appliedCode else { return }
        appliedCode = code
        let incoming = Array(code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased().prefix(4)).map(String.init)
        characters = incoming + Array(repeating: "", count: 4 - incoming.count)
        text = characters.joined(); activeIndex = min(incoming.count, 3)
        updateCursor(); refreshCells()
    }
    private func publish() {
        appliedCode = characters.joined(); text = appliedCode
        updateCursor(); refreshCells(); onChange(appliedCode)
    }
    private func updateCursor() {
        if let cursor = position(from: beginningOfDocument, offset: min(activeIndex, (text ?? "").utf16.count)) {
            selectedTextRange = textRange(from: cursor, to: cursor)
        }
    }
    private func refreshCells() {
        for (index, cell) in cells.enumerated() {
            let active = isFirstResponder && index == activeIndex
            cell.setTitle(characters[index].isEmpty ? " " : characters[index], for: .normal)
            cell.accessibilityValue = characters[index].isEmpty ? "未输入" : characters[index]
            cell.backgroundColor = active ? accent.withAlphaComponent(0.12) : UIColor.black.withAlphaComponent(0.18)
            cell.layer.borderColor = (active ? accent : UIColor.white.withAlphaComponent(0.3)).cgColor
            cell.layer.borderWidth = active ? 2 : 1
        }
    }
    override func deleteBackward() {
        if characters[activeIndex].isEmpty && activeIndex > 0 { activeIndex -= 1 }
        characters[activeIndex] = ""; publish()
    }
    func textFieldDidBeginEditing(_ field: UITextField) { onEdit(); refreshCells() }
    func textFieldDidEndEditing(_ field: UITextField) { refreshCells() }
    func textFieldShouldReturn(_ field: UITextField) -> Bool { resignFirstResponder(); return false }
    func textField(_ field: UITextField, shouldChangeCharactersIn range: NSRange, replacementString replacement: String) -> Bool {
        guard isEnabled else { return false }
        if replacement.isEmpty { deleteBackward(); return false }
        // Filter before uppercasing so non-ASCII characters (for example ß)
        // cannot expand into valid code letters. Ignored characters consume no cell.
        let value = replacement.compactMap { character -> String? in
            guard let ascii = character.asciiValue else { return nil }
            switch ascii {
            case 48...57, 65...90: return String(character)
            case 97...122: return String(character).uppercased()
            default: return nil
            }
        }
        guard !value.isEmpty, value.count <= 4 else { return false }
        let start = value.count == 4 ? 0 : activeIndex
        guard start + value.count <= 4 else { return false }
        for (offset, character) in value.enumerated() { characters[start + offset] = character }
        activeIndex = min(start + value.count, 3); publish()
        return false
    }
}
