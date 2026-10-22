import XCTest
import CryptoKit
import UIKit
import SceneKit
import SwiftUI
import Metal

@MainActor
final class AtlasTeachingUITests: XCTestCase {
    private func renderedButtonPixels(_ button: XCUIElement) throws -> [UInt8] {
        let image = try XCTUnwrap(button.screenshot().image.cgImage)
        let context = try XCTUnwrap(CGContext(data: nil, width: image.width, height: image.height,
            bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        let data = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
        return Array(UnsafeBufferPointer(start: data, count: image.width * image.height * 4))
    }

    func testUSBRefreshAnimationStops() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let refresh = app.buttons["refresh-usb-connection"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 15))
        for _ in 0..<8 where !refresh.isHittable { app.scrollViews["library-pairing-scroll"].swipeUp() }
        XCTAssertTrue(refresh.isHittable)
        for attempt in 0..<3 {
            refresh.tap()
            let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                refresh.isEnabled && (refresh.value as? String) != "正在刷新"
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 5), .completed)
            RunLoop.current.run(until: Date().addingTimeInterval(0.3))
            let reference = try renderedButtonPixels(refresh)
            for interval in [0.19, 0.37, 0.23] {
                RunLoop.current.run(until: Date().addingTimeInterval(interval))
                let pixels = try renderedButtonPixels(refresh)
                XCTAssertEqual(reference.count, pixels.count)
                let changed = zip(reference, pixels).filter { abs(Int($0) - Int($1)) > 8 }.count
                XCTAssertLessThan(changed, 32, "The rendered refresh icon must stop after completion, attempt \(attempt)")
            }
        }
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "USB refresh returns to a stationary icon after repeated taps"; shot.lifetime = .keepAlways; add(shot)
    }

    func testServerGlobeAnimationStops() throws {
        guard let address = ProcessInfo.processInfo.environment["ATLAS_PROBE_ANIMATION_ADDRESS"] else {
            throw XCTSkip("Provide a directed-probe fixture with a short delayed response")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launchArguments = ["-serverAddress", address]; app.launch()
        let search = app.buttons["discover-services"]
        XCTAssertTrue(search.waitForExistence(timeout: 15))
        let initiallyIdle = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (search.value as? String) != "正在搜索"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [initiallyIdle], timeout: 4), .completed)
        search.tap()
        XCTAssertTrue(search.isEnabled, "searching keeps the button's normal appearance")
        XCTAssertEqual(search.value as? String, "正在搜索")
        let moving = try renderedButtonPixels(search)
        for index in 0..<2 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.12))
            let shot = XCTAttachment(screenshot: search.screenshot())
            shot.name = "Globe self rotation frame \(index)"; shot.lifetime = .keepAlways; add(shot)
        }
        let next = try renderedButtonPixels(search)
        XCTAssertEqual(moving.count, next.count)
        XCTAssertGreaterThan(zip(moving, next).filter { abs(Int($0) - Int($1)) > 8 }.count, 32,
                             "the globe must actually animate during discovery")
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (search.value as? String) != "正在搜索"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 4), .completed)
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        let stopped = try renderedButtonPixels(search)
        RunLoop.current.run(until: Date().addingTimeInterval(0.23))
        let still = try renderedButtonPixels(search)
        XCTAssertEqual(stopped.count, still.count)
        XCTAssertLessThan(zip(stopped, still).filter { abs(Int($0) - Int($1)) > 8 }.count, 32,
                          "the globe must become stationary when discovery ends")
        XCTAssertTrue(search.isEnabled)
    }

    func testUSBWelcomeAndModelReceiving() throws {
        guard let id = ProcessInfo.processInfo.environment["ATLAS_USB_TRANSFER_ID"], UUID(uuidString: id) != nil else {
            throw XCTSkip("Provide a disposable USB transfer for the device receiving check")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let receive = app.buttons["receive-usb-model-\(id)"]
        XCTAssertTrue(receive.waitForExistence(timeout: 15))
        XCTAssertTrue(receive.label.contains("数据线接收验证（临时）"), "only import the dedicated test fixture")
        XCTAssertTrue(app.staticTexts["方式三"].exists)
        for _ in 0..<8 where !receive.isHittable { app.scrollViews["library-pairing-scroll"].swipeUp() }
        XCTAssertTrue(receive.isHittable)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "USB connected and complete model ready to receive"; shot.lifetime = .keepAlways; add(shot)
        receive.tap()
        let back = app.buttons["本地项目"]
        XCTAssertTrue(back.waitForExistence(timeout: 20), "USB reception opens the existing teaching workflow")
        back.tap()
        let row = app.buttons["local-project-\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        XCTAssertFalse(receive.exists, "successful reception removes its temporary inbox copy")
        app.terminate(); app.launch()
        XCTAssertTrue(row.waitForExistence(timeout: 15), "the USB model survives relaunch")
        for _ in 0..<8 where !row.isHittable { app.scrollViews["library-projects-scroll"].swipeUp() }
        row.tap(); XCTAssertTrue(back.waitForExistence(timeout: 15)); back.tap()
        for _ in 0..<8 where !row.isHittable { app.scrollViews["library-projects-scroll"].swipeUp() }
        XCTAssertTrue(row.label.contains("数据线接收验证（临时）"))
        row.swipeLeft()
        app.buttons["swipe-delete-local-project-\(id)"].firstMatch.tap()
        app.buttons["confirm-delete-local-project"].firstMatch.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: row)], timeout: 10), .completed)
    }

    func testLocalProjectDeleteImmediatelyAfterSwipe() throws {
        guard let id = ProcessInfo.processInfo.environment["ATLAS_SWIPE_TAP_FIXTURE_ID"], UUID(uuidString: id) != nil else {
            throw XCTSkip("Provide a disposable local project for rapid swipe/tap checks")
        }
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        let row = app.buttons["local-project-\(id)"]
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            for index in 0..<6 {
                for _ in 0..<8 where !row.isHittable { app.scrollViews["library-projects-scroll"].swipeUp() }
                let frame = row.frame
                let origin = app.coordinate(withNormalizedOffset: .zero)
                let start = origin.withOffset(CGVector(dx: frame.maxX - 120, dy: frame.midY))
                let end = start.withOffset(CGVector(dx: index % 2 == 0 ? -72 : -220, dy: 0))
                let tap = origin.withOffset(CGVector(dx: frame.maxX - 44,
                    dy: frame.midY + CGFloat(index % 3 - 1) * frame.height * 0.25))
                // Precompute the tap coordinate: no element queries, sleeps or
                // waits for the button/scroll animation between these events.
                start.press(forDuration: 0.03, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0)
                tap.tap()
                let cancel = app.buttons["cancel-delete-local-project"].firstMatch
                XCTAssertTrue(cancel.waitForExistence(timeout: 3), "Immediate delete tap \(index), orientation \(orientation.rawValue): \(app.debugDescription)")
                if index == 0 {
                    let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                    shot.name = "Immediate swipe delete confirmation - \(orientation.rawValue)"; shot.lifetime = .keepAlways; add(shot)
                }
                cancel.tap()
                XCTAssertTrue(row.exists, "cancel preserves the fixture")
            }
        }
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    func testLocalProjectSwipeDeletionStaysOnIPad() throws {
        continueAfterFailure = false
        let ids = (ProcessInfo.processInfo.environment["ATLAS_DISPOSABLE_DELETE_IDS"] ?? "").split(separator: ",").map(String.init)
        guard (1...2).contains(ids.count), ids.allSatisfy({ UUID(uuidString: $0) != nil }) else {
            throw XCTSkip("Provide one or two disposable local projects; this test deletes only those fixtures")
        }
        let protectedIDs = (ProcessInfo.processInfo.environment["ATLAS_DELETE_PROTECTED_IDS"] ?? "").split(separator: ",").map(String.init)
        let app = XCUIApplication(); app.launch()
        func reveal(_ row: XCUIElement) {
            for _ in 0..<8 where !row.isHittable { app.scrollViews["library-projects-scroll"].swipeUp() }
            XCTAssertTrue(row.isHittable, app.debugDescription)
            row.swipeLeft()
        }
        for (index, id) in ids.enumerated() {
            XCUIDevice.shared.orientation = index == 0 && ids.count > 1 ? .landscapeLeft : .portrait
            let row = app.buttons["local-project-\(id)"]
            XCTAssertTrue(row.waitForExistence(timeout: 15))
            reveal(row)
            let action = app.buttons["swipe-delete-local-project-\(id)"]
            XCTAssertTrue(action.waitForExistence(timeout: 5), app.debugDescription)
            XCTAssertTrue(action.isHittable, "swiping reveals a tappable delete action")
            // Use the page's outside margin. The enlarged QR button now occupies
            // the old fixed "whitespace" coordinate in portrait orientation.
            app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: 8, dy: app.windows.firstMatch.frame.midY)).tap()
            XCTAssertFalse(action.isHittable, "tapping page whitespace closes the action")
            XCTAssertTrue(row.exists)
            reveal(row)
            XCTAssertTrue(action.waitForExistence(timeout: 5))
            app.staticTexts["保存在此 iPad"].tap()
            XCTAssertFalse(action.isHittable, "tapping other content closes the action")
            reveal(row)
            XCTAssertTrue(action.waitForExistence(timeout: 5))
            app.buttons["scan-pairing-code"].tap()
            let cancelScan = app.buttons["cancel-pairing-scan"].firstMatch
            XCTAssertTrue(cancelScan.waitForExistence(timeout: 10), "outside buttons still perform their action")
            cancelScan.tap()
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            XCTAssertFalse(action.isHittable, "outside button taps also close the action")
            reveal(row)
            XCTAssertTrue(action.waitForExistence(timeout: 5))
            row.swipeRight()
            XCTAssertFalse(action.isHittable, "swiping back closes the action")
            reveal(row)
            XCTAssertTrue(action.waitForExistence(timeout: 5))
            if index == 0 && ids.count > 1 {
                let sibling = app.buttons["local-project-\(ids[1])"]
                reveal(sibling)
                XCTAssertTrue(app.buttons["swipe-delete-local-project-\(ids[1])"].isHittable)
                XCTAssertFalse(action.isHittable, "revealing another row closes the previous action")
                reveal(row)
                XCTAssertTrue(action.waitForExistence(timeout: 5))
            }
            XCTAssertTrue(row.exists, "even a full left swipe only reveals the action")
            let swipeAttachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            swipeAttachment.name = "Local deletion swipe - \(index)"; swipeAttachment.lifetime = .keepAlways; add(swipeAttachment)
            print("Local deletion layout: card=\(row.frame), action=\(action.frame)")
            action.tap()
            let confirm = app.buttons["confirm-delete-local-project"].firstMatch
            XCTAssertTrue(confirm.waitForExistence(timeout: 5))
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "电脑上的工程和已同步结果不受影响")).firstMatch.exists)
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "Local deletion confirmation - \(index)"; attachment.lifetime = .keepAlways; add(attachment)
            app.buttons["cancel-delete-local-project"].firstMatch.tap()
            XCTAssertTrue(row.exists, "cancelling preserves the project")
            row.tap()
            XCTAssertTrue(app.buttons["display-settings"].waitForExistence(timeout: 30), "the cancelled project still opens")
            app.buttons["本地项目"].tap()
            XCTAssertTrue(row.waitForExistence(timeout: 10))
            reveal(row)
            XCTAssertTrue(action.waitForExistence(timeout: 5)); action.tap()
            XCTAssertTrue(confirm.waitForExistence(timeout: 5)); confirm.tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: row)], timeout: 10), .completed)
            for protectedID in protectedIDs { XCTAssertTrue(app.buttons["local-project-\(protectedID)"].exists) }
            if index == 0 && ids.count > 1 { XCTAssertTrue(app.buttons["local-project-\(ids[1])"].exists) }
            app.terminate(); app.launch()
            XCTAssertTrue(app.buttons["scan-pairing-code"].waitForExistence(timeout: 15))
            XCTAssertFalse(row.exists, "deleted projects stay removed after relaunch")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        for protectedID in protectedIDs { XCTAssertTrue(app.buttons["local-project-\(protectedID)"].exists) }
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = "Library after deleting test fixtures"; attachment.lifetime = .keepAlways; add(attachment)
    }

    func testCompletedProjectContinuationStartsCamera() throws {
        continueAfterFailure = false
        guard let sourceID = ProcessInfo.processInfo.environment["ATLAS_CONTINUE_SOURCE_ID"],
              UUID(uuidString: sourceID) != nil else {
            throw XCTSkip("Provide a completed project; this test preserves it and creates a continuation without recording Poses")
        }
        let expectedCount = try XCTUnwrap(ProcessInfo.processInfo.environment["ATLAS_CONTINUE_POSE_COUNT"].flatMap(Int.init))
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let source = app.buttons["local-project-\(sourceID)"]
        XCTAssertTrue(source.waitForExistence(timeout: 15))
        let localProjects = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-"))
        let originalIDs = Set(localProjects.allElementsBoundByIndex.map(\.identifier))
        source.tap()
        let resume = app.buttons["continue-teaching"]
        XCTAssertTrue(resume.waitForExistence(timeout: 60))
        XCTAssertEqual(app.staticTexts["teaching-tracking-status"].label, "已完成 · 结果预览")
        XCTAssertEqual(app.staticTexts["teaching-depth-status"].label, "相机 / LiDAR 未启用")
        XCTAssertFalse(app.staticTexts["等待相机"].exists)
        XCTAssertFalse(app.staticTexts["等待 LiDAR"].exists)
        XCTAssertFalse(app.buttons["capture-pose"].exists)
        func snapshot(_ name: String) {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        for orientation in [UIDeviceOrientation.portrait, .landscapeLeft] {
            XCUIDevice.shared.orientation = orientation
            XCTAssertTrue(resume.isHittable)
            XCTAssertTrue(app.windows.firstMatch.frame.contains(app.staticTexts["teaching-depth-status"].frame))
            snapshot("Completed project preview - \(orientation.rawValue)")
        }
        resume.tap()
        let capture = app.buttons["capture-pose"]
        XCTAssertTrue(capture.waitForExistence(timeout: 60), app.debugDescription)
        XCTAssertTrue(app.staticTexts["LiDAR 已就绪"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(capture.isEnabled, "continuation requires a fresh placement before recording")
        XCTAssertFalse(resume.exists)
        app.buttons["review-poses"].tap()
        let closeReview = app.buttons["close-pose-review"]
        XCTAssertTrue(closeReview.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["pose-review-count"].label.hasPrefix("\(expectedCount) "))
        closeReview.tap()
        snapshot("Continuation with live camera and LiDAR")
        app.buttons["本地项目"].tap()
        XCTAssertTrue(source.waitForExistence(timeout: 15))
        let created = localProjects.allElementsBoundByIndex.filter { !originalIDs.contains($0.identifier) }
        XCTAssertEqual(created.count, 1, "the completed project remains beside one new draft")
        let draftID = try XCTUnwrap(created.first?.identifier)
        source.tap()
        XCTAssertTrue(resume.waitForExistence(timeout: 60), "the original result stays completed")
        XCTAssertEqual(app.staticTexts["teaching-depth-status"].label, "相机 / LiDAR 未启用")
        app.buttons["本地项目"].tap()
        app.terminate(); app.launch()
        let draft = app.buttons[draftID]
        XCTAssertTrue(draft.waitForExistence(timeout: 15)); draft.tap()
        XCTAssertTrue(capture.waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts["LiDAR 已就绪"].waitForExistence(timeout: 30))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(app.staticTexts["LiDAR 已就绪"].waitForExistence(timeout: 30))
        XCTAssertFalse(capture.isEnabled, "background recovery cannot reuse the old calibration")
        snapshot("Reopened continuation after background recovery")
    }

    func testResultSyncScannerAndCancel() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_RESULT_SYNC_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a completed project; this test opens and cancels scanning without presenting a QR")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let sync = app.buttons["sync-teaching-result"]
        XCTAssertTrue(sync.waitForExistence(timeout: 30))
        XCTAssertEqual(sync.label, "同步数据")
        for (index, orientation) in [UIDeviceOrientation.landscapeLeft, .portrait, .landscapeLeft].enumerated() {
            XCUIDevice.shared.orientation = orientation
            for _ in 0..<5 where !sync.isHittable {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.82))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.35)))
            }
            XCTAssertFalse(app.buttons["局域网同步到电脑"].exists)
            XCTAssertFalse(app.buttons["AirDrop / 导出结果"].exists)
            XCTAssertFalse(app.buttons["扫码同步到电脑"].exists)
            XCTAssertFalse(app.textFields["server-port"].exists)
            XCTAssertTrue(sync.isEnabled); sync.tap()
            XCTAssertTrue(app.navigationBars["同步数据"].waitForExistence(timeout: 10))
            let methods = app.segmentedControls["result-sync-method"]
            XCTAssertTrue(methods.waitForExistence(timeout: 5), app.debugDescription)
            let scan = app.buttons["scan-sync-result"]
            XCTAssertTrue(scan.exists)
            XCTAssertFalse(app.staticTexts["scanner-status"].exists, "selecting a method does not open the camera")
            methods.buttons["Wi-Fi"].tap()
            let port = app.textFields["server-port"]
            XCTAssertTrue(port.waitForExistence(timeout: 5))
            XCTAssertFalse(scan.exists)
            let originalPort = port.value as? String ?? "21990"
            if index == 0 {
                port.tap()
                port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: originalPort.count) + "65536")
                XCTAssertFalse(app.buttons["wifi-sync-result"].isEnabled, "invalid ports cannot upload")
            }
            methods.buttons["AirDrop 导出"].tap()
            XCTAssertTrue(app.buttons["share-teaching-result"].waitForExistence(timeout: 5))
            XCTAssertFalse(port.exists)
            XCTAssertFalse(app.buttons["wifi-sync-result"].exists)
            XCTAssertFalse(app.staticTexts["result-sync-status"].exists, "changing methods does not export or sync")
            methods.buttons["Wi-Fi"].tap()
            XCTAssertEqual(port.value as? String, index == 0 ? "65536" : originalPort, "switching methods retains the address")
            if index == 0 {
                port.tap()
                port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + originalPort + "\n")
            }
            let dialog = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            dialog.name = "Wi-Fi sync options - \(orientation.rawValue)"; dialog.lifetime = .keepAlways; add(dialog)
            methods.buttons["扫码"].tap()
            XCTAssertTrue(scan.isEnabled); scan.tap()
            XCTAssertTrue(app.navigationBars["扫码同步到电脑"].waitForExistence(timeout: 10), app.debugDescription)
            XCTAssertTrue(app.staticTexts["scanner-status"].exists)
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "Result QR scanner - \(orientation.rawValue)"; attachment.lifetime = .keepAlways; add(attachment)
            app.buttons["cancel-pairing-scan"].tap()
            XCTAssertTrue(scan.waitForExistence(timeout: 5)); XCTAssertTrue(scan.isEnabled)
            XCTAssertTrue(app.navigationBars["同步数据"].exists, "cancel returns to the method selector")
            app.buttons["close-result-sync"].tap()
            XCTAssertTrue(sync.waitForExistence(timeout: 5))
            XCTAssertFalse(app.buttons["finish-teaching"].exists)
            XCTAssertFalse(app.buttons["share-teaching-result"].exists)
        }
    }

    func testFinishDisposableDraftAndOpenSyncScanner() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_DISPOSABLE_FINISH_SCAN_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable draft; this test finishes it before opening the scanner")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let finish = app.buttons["finish-teaching"]
        XCTAssertTrue(finish.waitForExistence(timeout: 30))
        for _ in 0..<5 where !finish.isHittable {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.82))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.35)))
        }
        finish.tap()
        let action = app.buttons["完成并同步数据"]
        XCTAssertTrue(action.waitForExistence(timeout: 8)); action.tap()
        XCTAssertTrue(app.navigationBars["同步数据"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["scan-sync-result"].tap()
        XCTAssertTrue(app.navigationBars["扫码同步到电脑"].waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["cancel-pairing-scan"].tap()
        XCTAssertTrue(app.buttons["scan-sync-result"].waitForExistence(timeout: 5))
        app.buttons["close-result-sync"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        XCTAssertTrue(app.buttons["sync-teaching-result"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["capture-pose"].exists)
    }

    func testFinishTeachingOpensOptionsWithoutChangingDraft() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_FINISH_DRAFT_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide an existing draft; this test only opens and cancels completion")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let finish = app.buttons["完成示教"]
        XCTAssertTrue(finish.waitForExistence(timeout: 30))
        for _ in 0..<5 where !finish.isHittable {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.82))
                .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.35)))
        }
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait, .landscapeLeft] {
            XCUIDevice.shared.orientation = orientation
            if !finish.isHittable {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.82))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.35)))
            }
            XCTAssertTrue(finish.isEnabled, app.debugDescription)
            finish.tap()
            let save = app.buttons["仅完成并保存在 iPad"]
            let opened = save.waitForExistence(timeout: 8)
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "Draft completion options - \(orientation.rawValue)"
            attachment.lifetime = .keepAlways; add(attachment)
            XCTAssertTrue(opened, app.debugDescription)
            XCTAssertTrue(app.buttons["完成并同步数据"].exists)
            let cancel = app.buttons["继续示教"]
            if cancel.exists && cancel.isHittable { cancel.tap() }
            else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.25)).tap() }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: save)], timeout: 5), .completed)
            XCTAssertTrue(finish.exists, "cancel preserves the editable draft")
            XCTAssertFalse(app.buttons["sync-teaching-result"].exists, "opening completion must not lock the project")
        }
    }

    func testFinishDisposableDraftsAndShare() throws {
        continueAfterFailure = false
        let fixtureIDs = (ProcessInfo.processInfo.environment["ATLAS_DISPOSABLE_FINISH_FIXTURE_IDS"] ?? "")
            .split(separator: ",").map(String.init)
        guard fixtureIDs.count == 2, fixtureIDs.allSatisfy({ UUID(uuidString: $0) != nil }) else {
            throw XCTSkip("Provide two disposable drafts; this test completes and locks both projects")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        for (index, fixtureID) in fixtureIDs.enumerated() {
            app.launch()
            let project = app.buttons["local-project-\(fixtureID)"]
            XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
            let finish = app.buttons["finish-teaching"]
            XCTAssertTrue(finish.waitForExistence(timeout: 30))
            for _ in 0..<5 where !finish.isHittable {
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.82))
                    .press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.88, dy: 0.35)))
            }
            finish.tap()
            let action = app.buttons[index == 0 ? "仅完成并保存在 iPad" : "完成并同步数据"]
            XCTAssertTrue(action.waitForExistence(timeout: 8)); action.tap()
            let sync = app.buttons["sync-teaching-result"]
            XCTAssertTrue(sync.waitForExistence(timeout: 15), app.debugDescription)
            XCTAssertFalse(app.buttons["capture-pose"].exists)
            if index == 1 {
                XCTAssertTrue(app.navigationBars["同步数据"].waitForExistence(timeout: 10))
                app.segmentedControls["result-sync-method"].buttons["AirDrop 导出"].tap()
                let share = app.buttons["share-teaching-result"]
                XCTAssertTrue(share.waitForExistence(timeout: 5)); share.tap()
                let copy = app.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", ["Copy", "拷贝", "复制"])).firstMatch
                XCTAssertTrue(copy.waitForExistence(timeout: 15), "completion must open the share sheet: \(app.debugDescription)")
                let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
                attachment.name = "Share immediately after completion"; attachment.lifetime = .keepAlways; add(attachment)
                let close = app.buttons.matching(NSPredicate(format: "label IN %@ AND identifier != %@", ["Close", "关闭"], "close-result-sync")).firstMatch
                if close.exists { close.tap() }
                else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.25)).tap() }
                XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                    predicate: NSPredicate(format: "exists == false"), object: copy)], timeout: 5), .completed)
                XCTAssertTrue(share.isEnabled, "cancelled sharing can be retried")
                app.buttons["close-result-sync"].tap()
            }
            app.terminate(); app.launch()
            XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
            XCTAssertTrue(sync.waitForExistence(timeout: 15), "completed state survives relaunch")
            XCTAssertFalse(app.buttons["finish-teaching"].exists)
            XCTAssertFalse(app.buttons["capture-pose"].exists)
            app.terminate()
        }
    }

    func testResultFileShareAndCancel() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_RESULT_SHARE_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable completed project for result sharing")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let sync = app.buttons["sync-teaching-result"]
        XCTAssertTrue(sync.waitForExistence(timeout: 30))
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            if !sync.isHittable { app.swipeUp() }
            sync.tap()
            let methods = app.segmentedControls["result-sync-method"]
            XCTAssertTrue(methods.waitForExistence(timeout: 5))
            methods.buttons["AirDrop 导出"].tap()
            let share = app.buttons["share-teaching-result"]
            XCTAssertTrue(share.isEnabled); share.tap()
            let copy = app.descendants(matching: .any).matching(NSPredicate(format: "label IN %@", ["Copy", "拷贝", "复制"])).firstMatch
            XCTAssertTrue(copy.waitForExistence(timeout: 15), app.debugDescription)
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "Result share sheet - \(orientation.rawValue)"
            attachment.lifetime = .keepAlways; add(attachment)
            let close = app.buttons.matching(NSPredicate(format: "label IN %@ AND identifier != %@", ["Close", "关闭"], "close-result-sync")).firstMatch
            if close.exists { close.tap() }
            else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.03, dy: 0.25)).tap() }
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: copy)], timeout: 5), .completed)
            XCTAssertTrue(share.waitForExistence(timeout: 5))
            XCTAssertTrue(share.isEnabled, "cancelled sharing can be retried")
            XCTAssertFalse(app.buttons["capture-pose"].exists, "completed results stay locked")
            app.buttons["close-result-sync"].tap()
        }
    }

    private func expectAutomaticPlacement(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
        let capture = app.buttons["capture-pose"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "enabled == true"), object: capture)], timeout: 15), .completed,
            "valid placement must enable recording without another tap", file: file, line: line)
        XCTAssertFalse(app.buttons["confirm-model-calibration"].exists, file: file, line: line)
        XCTAssertFalse(app.buttons["finish-placement-adjustment"].exists, file: file, line: line)
        XCTAssertTrue(app.buttons["adjust-model-placement"].exists, file: file, line: line)
    }

    func testPoseMarkersStaySmallWhenCameraCrossesRecordedPosition() throws {
        let ar = ARController()
        let sample = TeachingSample(segmentId: "marker-render-test", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(.zero), quaternion: Rotation4(simd_quatf())))
        ar.refreshMarkers([sample])
        let markers = try XCTUnwrap(ar.view.scene.rootNode.childNode(withName: "recorded-pose-markers", recursively: true))
        XCTAssertEqual(markers.childNodes.count, 1)
        let scene = SCNScene(); scene.background.contents = UIColor.black
        // Render the production markers on the device GPU without needing to
        // move the physical iPad through a millimetre-sized recorded position.
        scene.rootNode.addChildNode(markers.clone())
        let camera = SCNNode(); camera.camera = SCNCamera()
        camera.camera?.fieldOfView = 60; camera.camera?.zFar = 10
        scene.rootNode.addChildNode(camera)
        let renderer = SCNRenderer(device: try XCTUnwrap(MTLCreateSystemDefaultDevice()), options: nil)
        renderer.scene = scene; renderer.pointOfView = camera
        func capture(_ name: String? = nil) throws -> (count: Int, width: Int, height: Int, limit: Int) {
            let image = renderer.snapshot(atTime: 0, with: CGSize(width: 320, height: 240), antialiasingMode: .none)
            let cgImage = try XCTUnwrap(image.cgImage)
            let context = try XCTUnwrap(CGContext(data: nil, width: cgImage.width, height: cgImage.height,
                bitsPerComponent: 8, bytesPerRow: cgImage.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
            let pixels = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
            var count = 0, minX = cgImage.width, maxX = -1, minY = cgImage.height, maxY = -1
            for y in 0..<cgImage.height {
                for x in 0..<cgImage.width {
                    let offset = (y * cgImage.width + x) * 4
                    if pixels[offset] > 150 && pixels[offset + 1] > 100 && pixels[offset + 2] < 100 {
                        count += 1; minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y)
                    }
                }
            }
            if let name {
                let attachment = XCTAttachment(image: image)
                attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
            }
            return (count, max(0, maxX - minX + 1), max(0, maxY - minY + 1), Int(ceil(12 * image.scale)))
        }
        for near in [0.001, 0.01] {
            camera.camera?.zNear = near
            for distance: Float in [-0.03, 0, 0.0005, 0.004, 0.009, 0.012, 0.02, 0.05, 0.1, 0.5] {
                camera.simdPosition = SIMD3(0, 0, distance)
                let shot = try capture(near == 0.001 && distance == 0.012 ? "Pose marker 12 mm from camera" : nil)
                XCTAssertLessThanOrEqual(shot.width, shot.limit, "near=\(near), distance=\(distance): no large yellow patch")
                XCTAssertLessThanOrEqual(shot.height, shot.limit)
                XCTAssertLessThanOrEqual(shot.count, shot.limit * shot.limit)
                if distance <= 0 { XCTAssertEqual(shot.count, 0, "points at/behind the camera are clipped") }
                if distance >= 0.02 { XCTAssertGreaterThan(shot.count, 0, "the fix must retain visible Pose markers") }
            }
        }
        // Markers still respect the model's depth, instead of drawing over it.
        let occluder = SCNNode(geometry: SCNPlane(width: 1, height: 1))
        occluder.position.z = 0.25
        occluder.geometry?.firstMaterial?.diffuse.contents = UIColor.blue
        occluder.geometry?.firstMaterial?.lightingModel = .constant
        scene.rootNode.addChildNode(occluder)
        XCTAssertEqual(try capture().count, 0, "a foreground model surface must hide the marker")
        occluder.removeFromParentNode()
        XCTAssertGreaterThan(try capture().count, 0)
        ar.refreshMarkers([])
        XCTAssertTrue(markers.childNodes.isEmpty, "deleting Poses clears their markers")
    }

    func testSpatialAxesAlignmentRendering() throws {
        func reading(_ angle: Float) -> SpatialLevelReading {
            SpatialLevelReading.measure(screenFromWorld: simd_float4x4(simd_quatf(angle: angle * .pi / 180, axis: SIMD3(0, 0, 1))).inverse)!
        }
        let cases: [(String, SpatialLevelReading?, Bool)] = [
            ("Upright", reading(0), true), ("Inclusive 1.50 degree boundary", reading(1.5), true),
            ("Outside 1.51 degree boundary", reading(1.51), false), ("Tilted 35 degrees", reading(35), false),
            ("Inverted 180 degrees", reading(180), false), ("Tracking unavailable", nil, false)
        ]
        for (name, value, expectedGreen) in cases {
            let renderer = ImageRenderer(content: SpatialLevelView(reading: value).frame(width: 232)
                .environment(\.colorScheme, .dark).padding(16).background(Color.black))
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.uiImage)
            let cgImage = try XCTUnwrap(image.cgImage)
            let colorSpace = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
            let context = try XCTUnwrap(CGContext(data: nil, width: cgImage.width, height: cgImage.height,
                bitsPerComponent: 8, bytesPerRow: cgImage.width * 4, space: colorSpace,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: cgImage.width, height: cgImage.height))
            let pixels = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
            let offset = ((cgImage.height / 2) * cgImage.width + 24 * 2) * 4
            let red = Double(pixels[offset]), green = Double(pixels[offset + 1]), blue = Double(pixels[offset + 2])
            XCTAssertEqual(green > red * 1.5 && green > blue * 1.5, expectedGreen,
                "\(name): the card itself is green only when gravity alignment is valid")
            let attachment = XCTAttachment(image: image)
            attachment.name = "Device axes - \(name)"; attachment.lifetime = .keepAlways; add(attachment)
        }
    }

    func testPoseSwipeAndBulkDeletion() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_REVIEW_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project with at least six Poses for deletion testing")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let review = app.buttons["review-poses"]
        XCTAssertTrue(review.waitForExistence(timeout: 30)); review.tap()
        let close = app.buttons["close-pose-review"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        let count = app.staticTexts["pose-review-count"]
        let initialCount = try XCTUnwrap(Int(count.label.split(separator: " ").first ?? ""))
        XCTAssertGreaterThanOrEqual(initialCount, 6)
        func expectCount(_ expected: Int) {
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label BEGINSWITH %@", "\(expected) "), object: count)], timeout: 5), .completed)
        }
        func screenshot(_ name: String) {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "review-pose-"))
        let firstID = rows.element(boundBy: 0).identifier
        let secondID = rows.element(boundBy: 1).identifier
        let thirdID = rows.element(boundBy: 2).identifier
        let first = app.buttons[firstID]
        first.swipeLeft()
        let swipeDelete = app.buttons["swipe-delete-pose-\(firstID.dropFirst("review-pose-".count))"]
        XCTAssertTrue(swipeDelete.waitForExistence(timeout: 5))
        expectCount(initialCount)
        XCTAssertTrue(first.exists, "even a full left swipe only reveals the delete button")
        screenshot("Left swipe reveals single Pose delete")
        swipeDelete.tap()
        expectCount(initialCount - 1)
        XCTAssertFalse(first.exists)
        XCTAssertTrue(app.otherElements["pose-review-preview"].exists, "deleting the current Pose selects a remaining preview")

        let enter = app.buttons["select-poses"], bulk = app.buttons["delete-selected-poses"]
        XCTAssertTrue(enter.isHittable, "multi-select is always available above the list")
        let all = app.buttons["select-all-poses"], selectedCount = app.staticTexts["selected-poses-count"]
        enter.tap()
        XCTAssertTrue(all.waitForExistence(timeout: 5))
        XCTAssertEqual(selectedCount.label, "已选 0/\(initialCount - 1)")
        XCTAssertFalse(bulk.isEnabled)
        expectCount(initialCount - 1)
        app.buttons[secondID].tap(); app.buttons[thirdID].tap()
        XCTAssertEqual(selectedCount.label, "已选 2/\(initialCount - 1)")
        XCTAssertEqual(app.buttons[secondID].value as? String, "已勾选")
        XCTAssertEqual(app.buttons[thirdID].value as? String, "已勾选")
        screenshot("Landscape Pose selection")
        app.buttons["cancel-pose-selection"].tap()
        expectCount(initialCount - 1)
        XCTAssertFalse(all.exists)
        XCTAssertTrue(app.buttons[secondID].exists); XCTAssertTrue(app.buttons[thirdID].exists)

        enter.tap()
        XCTAssertEqual(selectedCount.label, "已选 0/\(initialCount - 1)", "cancel clears selection without deleting")
        all.tap()
        XCTAssertEqual(selectedCount.label, "已选 \(initialCount - 1)/\(initialCount - 1)", "select all includes offscreen rows")
        XCTAssertEqual(all.value as? String, "已全选")
        app.buttons[thirdID].tap()
        XCTAssertEqual(selectedCount.label, "已选 \(initialCount - 2)/\(initialCount - 1)")
        XCTAssertEqual(all.value as? String, "部分选择")
        all.tap(); XCTAssertEqual(all.value as? String, "已全选")
        all.tap(); XCTAssertEqual(all.value as? String, "未选择")
        XCTAssertFalse(bulk.isEnabled)
        app.buttons[secondID].tap(); app.buttons[thirdID].tap()
        XCUIDevice.shared.orientation = .portrait
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.windows.firstMatch.frame.height > app.windows.firstMatch.frame.width
        }, object: nil)], timeout: 10), .completed)
        XCTAssertTrue(all.isHittable); XCTAssertTrue(bulk.isHittable)
        XCTAssertEqual(selectedCount.label, "已选 2/\(initialCount - 1)")
        screenshot("Portrait Pose selection")
        bulk.tap()
        expectCount(initialCount - 3)
        XCTAssertFalse(app.buttons[secondID].exists); XCTAssertFalse(app.buttons[thirdID].exists)
        XCTAssertFalse(all.exists)
        XCTAssertTrue(app.otherElements["pose-review-preview"].exists)
        close.tap()
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        app.terminate(); app.launch()
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        XCTAssertTrue(review.waitForExistence(timeout: 30)); review.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        expectCount(initialCount - 3)
        XCTAssertFalse(app.buttons[firstID].exists)
        XCTAssertFalse(app.buttons[secondID].exists); XCTAssertFalse(app.buttons[thirdID].exists)
        XCTAssertFalse(all.exists, "selection mode does not persist across sessions")

        enter.tap(); all.tap(); bulk.tap()
        expectCount(0)
        XCTAssertTrue(app.staticTexts["还没有 Pose"].exists)
        XCTAssertFalse(app.otherElements["pose-review-preview"].exists)
        XCTAssertFalse(all.exists); XCTAssertFalse(enter.isEnabled)
        screenshot("Pose review after deleting all")
        close.tap()
        XCTAssertFalse(review.isEnabled)
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testCompletedPoseBatchDeletionPreservesOriginal() throws {
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_BATCH_COMPLETED_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable completed project named UI-Batch-Completed; this test removes its fixtures")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        XCTAssertTrue(project.label.contains("UI-Batch-Completed"))
        project.tap()
        let review = app.buttons["review-poses"], close = app.buttons["close-pose-review"]
        XCTAssertTrue(review.waitForExistence(timeout: 30)); review.tap()
        let enter = app.buttons["select-poses"]
        XCTAssertTrue(enter.waitForExistence(timeout: 10)); XCTAssertTrue(enter.isHittable)
        let count = app.staticTexts["pose-review-count"]
        let initial = try XCTUnwrap(Int(count.label.split(separator: " ").first ?? ""))
        XCTAssertGreaterThanOrEqual(initial, 6)
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "review-pose-"))
        let firstID = rows.element(boundBy: 0).identifier, secondID = rows.element(boundBy: 1).identifier
        let selectedCount = app.staticTexts["selected-poses-count"]
        let all = app.buttons["select-all-poses"], remove = app.buttons["delete-selected-poses"]
        enter.tap()
        XCTAssertTrue(app.staticTexts["completed-pose-edit-note"].exists)
        XCTAssertFalse(remove.isEnabled)
        app.buttons[firstID].tap(); app.buttons[secondID].tap()
        XCTAssertEqual(selectedCount.label, "已选 2/\(initial)")
        all.tap()
        XCTAssertEqual(selectedCount.label, "已选 \(initial)/\(initial)")
        XCTAssertEqual(all.value as? String, "已全选")
        all.tap()
        XCTAssertEqual(selectedCount.label, "已选 0/\(initial)")
        XCTAssertFalse(remove.isEnabled)
        app.buttons[firstID].tap(); app.buttons[secondID].tap()
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            XCTAssertTrue(all.isHittable); XCTAssertTrue(remove.isHittable)
            XCTAssertEqual(selectedCount.label, "已选 2/\(initial)")
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "Pose batch selection \(orientation.isLandscape ? "landscape" : "portrait")"
            shot.lifetime = .keepAlways; add(shot)
        }
        app.buttons["cancel-pose-selection"].tap()
        XCTAssertEqual(count.label, "\(initial) 个 Pose")
        XCTAssertFalse(app.textFields["review-pose-name"].exists)
        enter.tap()
        XCTAssertEqual(selectedCount.label, "已选 0/\(initial)")
        app.buttons[firstID].tap(); app.buttons[secondID].tap(); remove.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "\(initial - 2) 个 Pose"), object: count)], timeout: 30), .completed)
        XCTAssertTrue(app.textFields["review-pose-name"].waitForExistence(timeout: 10), "the result is an editable draft")
        XCTAssertFalse(app.buttons[firstID].exists); XCTAssertFalse(app.buttons[secondID].exists)
        XCTAssertFalse(all.exists)
        close.tap(); app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        app.terminate(); app.launch()
        let copies = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "local-project-", "UI-Batch-Completed"))
        XCTAssertEqual(copies.count, 2, "a completed edit creates one copy and retains the original")
        let copy = (0..<copies.count).map { copies.element(boundBy: $0) }.first { $0.identifier != project.identifier }!
        let copyID = String(copy.identifier.dropFirst("local-project-".count))
        copy.tap(); XCTAssertTrue(review.waitForExistence(timeout: 30)); review.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCTAssertEqual(count.label, "\(initial - 2) 个 Pose", "batch deletion survives reopening")
        XCTAssertFalse(app.buttons[firstID].exists); XCTAssertFalse(app.buttons[secondID].exists)
        close.tap(); app.buttons["本地项目"].tap()
        project.tap(); XCTAssertTrue(review.waitForExistence(timeout: 30)); review.tap()
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCTAssertEqual(count.label, "\(initial) 个 Pose")
        XCTAssertTrue(app.buttons[firstID].exists); XCTAssertTrue(app.buttons[secondID].exists)
        XCTAssertFalse(app.textFields["review-pose-name"].exists, "the original is still completed")
        close.tap(); app.buttons["本地项目"].tap()
        XCUIDevice.shared.orientation = .landscapeLeft
        for id in [copyID, fixtureID] {
            let row = app.buttons["local-project-\(id)"]
            XCTAssertTrue(row.label.contains("UI-Batch-Completed"))
            row.swipeLeft(); app.buttons["swipe-delete-local-project-\(id)"].tap()
            let confirm = app.buttons["confirm-delete-local-project"].firstMatch
            XCTAssertTrue(confirm.waitForExistence(timeout: 5)); confirm.tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: row)], timeout: 10), .completed)
        }
    }

    func testRemoveDisposablePoseBatchFixtures() throws {
        let ids = (ProcessInfo.processInfo.environment["ATLAS_BATCH_CLEANUP_IDS"] ?? "").split(separator: ",").map(String.init)
        guard !ids.isEmpty, ids.allSatisfy({ UUID(uuidString: $0) != nil }) else {
            throw XCTSkip("Provide explicit disposable batch fixture IDs for cleanup")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.otherElements["library-content"].waitForExistence(timeout: 15))
        for id in ids {
            let row = app.buttons["local-project-\(id)"]
            for _ in 0..<5 where !row.isHittable { app.scrollViews["library-projects-scroll"].swipeUp() }
            XCTAssertTrue(row.exists)
            XCTAssertTrue(row.label.contains("UI-Batch-"), "cleanup is limited to marked test fixtures")
            row.swipeLeft(); app.buttons["swipe-delete-local-project-\(id)"].tap()
            let confirm = app.buttons["confirm-delete-local-project"].firstMatch
            XCTAssertTrue(confirm.waitForExistence(timeout: 5)); confirm.tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: row)], timeout: 10), .completed)
        }
    }

    func testPoseLeftSwipeAcrossRowAndRefresh() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_REVIEW_FIXTURE_ID"], UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable Pose project for swipe regression")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        XCTAssertTrue(app.buttons["display-settings"].waitForExistence(timeout: 30))
        // Reproduce the user's full-resolution Mesh rather than just the opening preview.
        app.buttons["display-settings"].tap()
        let quality = app.buttons["mesh-quality"]
        XCTAssertTrue(quality.waitForExistence(timeout: 10)); quality.tap(); app.buttons["全量"].tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"),
            object: app.progressIndicators["model-render-progress"])], timeout: 60), .completed)
        app.buttons["close-display-settings"].tap()
        app.buttons["review-poses"].tap()
        let close = app.buttons["close-pose-review"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        let count = app.staticTexts["pose-review-count"].label
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "review-pose-"))
        let ids = (0..<2).map { rows.element(boundBy: $0).identifier }
        for (index, startX) in [0.92, 0.6, 0.35].enumerated() {
            let row = app.buttons[ids[index % 2]]
            row.tap()
            let rowFrame = row.frame
            let start = row.coordinate(withNormalizedOffset: CGVector(dx: startX, dy: 0.5))
            start.press(forDuration: 0.05, thenDragTo: start.withOffset(CGVector(dx: -72, dy: 0)),
                withVelocity: .slow, thenHoldForDuration: 0.1)
            let action = app.buttons["swipe-delete-pose-\(row.identifier.dropFirst("review-pose-".count))"]
            XCTAssertTrue(action.waitForExistence(timeout: 5), "left swipe starting at \(startX) must reveal delete")
            XCTAssertTrue(action.isHittable)
            let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == false"), object: action)
            hidden.isInverted = true
            XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 1.5), .completed,
                "background AR attitude updates must not close the swipe action")
            XCTAssertEqual(app.staticTexts["pose-review-count"].label, count, "swiping never deletes")
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = "Slow left swipe from row \(startX)"; attachment.lifetime = .keepAlways; add(attachment)
            // Once revealed, the native cell extends offscreen; use its original visible position to close it.
            let closeStart = app.coordinate(withNormalizedOffset: .zero).withOffset(
                CGVector(dx: rowFrame.minX + rowFrame.width * 0.3, dy: rowFrame.midY))
            closeStart.press(forDuration: 0.05, thenDragTo: closeStart.withOffset(CGVector(dx: 100, dy: 0)),
                withVelocity: .slow, thenHoldForDuration: 0.1)
            XCTAssertFalse(action.isHittable)
        }
        close.tap()
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testPosePreviewKeepsRecordedImageAndCameraIndependent() throws {
        let geometry = SCNBox(width: 0.5, height: 0.4, length: 0.2, chamferRadius: 0)
        let material = SCNMaterial(); material.lightingModel = .constant; material.diffuse.contents = UIColor.orange
        geometry.materials = [material]
        var transform = matrix_identity_float4x4; transform.columns.3 = SIMD4(0, 0, 1, 1)
        let projection = simd_float4x4(columns: (
            SIMD4(1.3, 0, 0, 0), SIMD4(0, 1.73, 0, 0), SIMD4(0.08, -0.04, -1.00002, -1), SIMD4(0, 0, -0.0200002, 0)))
        var sample = TeachingSample(segmentId: "preview-test", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0, 0, 1)), quaternion: Rotation4(simd_quatf(angle: .pi, axis: SIMD3(1, 0, 0)))),
            previewCameraTransform: transform.elements, previewProjection: projection.elements, previewAspect: 4 / 3)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let original = try encoder.encode(sample)
        let view = PosePreviewSurface(); view.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        func update(_ mode: PosePreviewMode, reset: Int = 0) {
            view.update(rendered: geometry, sample: sample, mode: mode, resetRevision: reset)
            view.layoutIfNeeded()
        }
        update(.image)
        let recordedImage = try XCTUnwrap(view.imageView.image)
        XCTAssertEqual(recordedImage.size.width / recordedImage.size.height, ZividFieldOfView.nativeAspect, accuracy: 0.005)
        XCTAssertEqual(view.sceneView.frame.width / view.sceneView.frame.height, ZividFieldOfView.nativeAspect, accuracy: 0.0001)
        let recordedPNG = try XCTUnwrap(recordedImage.pngData())
        let screenshot = XCTAttachment(image: recordedImage); screenshot.name = "Recorded 2D model image"
        screenshot.lifetime = .keepAlways; add(screenshot)
        XCTAssertTrue(view.sceneView.isHidden)
        XCTAssertFalse(view.sceneView.isUserInteractionEnabled)
        update(.interactive)
        view.zoom(by: 2)
        XCTAssertEqual(view.camera.simdPosition.z, 0.5, accuracy: 0.001, "pinch must dolly with a custom projection")
        let inspectionLens = try XCTUnwrap(view.camera.camera)
        XCTAssertEqual(simd_float4x4(inspectionLens.projectionTransform)[0].x, ZividFieldOfView.projectionMatrix[0].x)
        XCTAssertEqual(simd_float4x4(inspectionLens.projectionTransform)[1].y, ZividFieldOfView.projectionMatrix[1].y)
        XCTAssertLessThan(inspectionLens.zNear, Double(ZividFieldOfView.near))
        XCTAssertGreaterThan(inspectionLens.zFar, Double(ZividFieldOfView.far))
        view.translate(by: CGPoint(x: 35, y: -20))
        XCTAssertNotEqual(view.camera.simdPosition.x, 0)
        let inspected = view.camera.simdTransform.elements
        update(.image)
        view.zoom(by: 2); view.translate(by: CGPoint(x: 10, y: 10))
        XCTAssertEqual(view.camera.simdTransform.elements, inspected, "2D must ignore model gestures")
        XCTAssertEqual(view.imageView.image?.pngData(), recordedPNG, "2D is the saved view, not the manipulated camera")
        update(.interactive)
        XCTAssertEqual(view.camera.simdTransform.elements, inspected, "switching back preserves the 3D view")
        XCTAssertEqual(try encoder.encode(sample), original)
        sample.name = "Renamed without changing the view"
        update(.interactive)
        XCTAssertEqual(view.camera.simdTransform.elements, inspected, "unrelated SwiftUI updates must not reset the camera")
        update(.interactive, reset: 1)
        for (actual, expected) in zip(view.camera.simdTransform.elements, transform.elements) {
            XCTAssertEqual(actual, expected, accuracy: 0.00001)
        }
        // Force a fresh snapshot after interaction and resizing, not only a cache hit.
        view.frame.size = CGSize(width: 800, height: 600); update(.image, reset: 1)
        XCTAssertNotNil(view.imageView.image)
        view.frame.size = CGSize(width: 400, height: 300); update(.image, reset: 1)
        XCTAssertEqual(view.imageView.image?.pngData(), recordedPNG)
        sample.id = UUID().uuidString; sample.previewCameraTransform = nil; sample.previewProjection = nil
        sample.cameraPose.position = Point3(SIMD3(0.4, 0.2, 0.9))
        update(.interactive, reset: 1)
        XCTAssertEqual(view.camera.simdPosition, SIMD3(0.4, 0.2, 0.9))
        let legacyLens = simd_float4x4(try XCTUnwrap(view.camera.camera).projectionTransform)
        XCTAssertEqual(legacyLens[0].x, ZividFieldOfView.projectionMatrix[0].x)
        XCTAssertEqual(legacyLens[1].y, ZividFieldOfView.projectionMatrix[1].y,
                       "legacy samples start at their captured framing with an independent inspection camera")
        view.frame.size = CGSize(width: 300, height: 600); update(.interactive, reset: 1)
        XCTAssertEqual(view.sceneView.frame.width / view.sceneView.frame.height, ZividFieldOfView.nativeAspect, accuracy: 0.0001)
        view.stop()
    }

    func testPoseInspectionMovesFreelyWithoutRecapturingCloud() throws {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        let geometry = SCNPlane(width: 4, height: 3)
        let material = SCNMaterial(); material.lightingModel = .constant
        material.diffuse.contents = UIColor.orange; material.isDoubleSided = true
        geometry.materials = [material]
        let sample = TeachingSample(segmentId: "fixed-capture", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0, 0, 1)),
                quaternion: Rotation4(simd_quatf(angle: .pi, axis: SIMD3(1, 0, 0)))))
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let original = try encoder.encode(sample)
        var frame = try XCTUnwrap(TeachingCoveragePose(sample.cameraPose)).cameraFromModel
        let frames = try XCTUnwrap(device.makeBuffer(bytes: &frame, length: MemoryLayout<simd_float4x4>.stride, options: .storageModeShared))
        let values = [Float](repeating: 1, count: TeachingCoverageProfile.columns * TeachingCoverageProfile.rows)
        let depths = try XCTUnwrap(values.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
        let footprint = TeachingCoverageSnapshot(frames: frames, depths: depths, frameCount: 1)
        let view = PosePreviewSurface(); view.frame = CGRect(x: 0, y: 0, width: 648, height: 400)
        defer { view.stop() }
        func update(_ mode: PosePreviewMode) {
            view.update(rendered: geometry, footprint: footprint, sample: sample, mode: mode, resetRevision: 0)
            view.layoutIfNeeded()
        }
        update(.image)
        let capturedImage = try XCTUnwrap(view.imageView.image?.pngData())
        update(.interactive)
        let renderer = SCNRenderer(device: device, options: nil)
        renderer.scene = view.sceneView.scene; renderer.pointOfView = view.camera
        func assertSurfaceVisible(_ label: String) throws {
            let image = renderer.snapshot(atTime: 0, with: CGSize(width: 324, height: 200), antialiasingMode: .none)
            let cg = try XCTUnwrap(image.cgImage)
            var rgba = [UInt8](repeating: 0, count: 4)
            try rgba.withUnsafeMutableBytes { raw in
                let context = try XCTUnwrap(CGContext(data: raw.baseAddress, width: 1, height: 1,
                    bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
                context.draw(cg, in: CGRect(x: -cg.width / 2, y: -cg.height / 2, width: cg.width, height: cg.height))
            }
            XCTAssertGreaterThan(rgba[0], 200, label)
            XCTAssertGreaterThan(rgba[1], 70, label)
            XCTAssertLessThan(rgba[2], 40, label)
        }
        try assertSurfaceVisible("captured surface at the original Pose")
        view.zoom(by: 0.25)
        XCTAssertGreaterThan(view.camera.simdPosition.z, ZividFieldOfView.far)
        try assertSurfaceVisible("zooming out beyond M70 range keeps the captured cloud visible")
        view.zoom(by: 20)
        XCTAssertLessThan(view.camera.simdPosition.z, ZividFieldOfView.near)
        try assertSurfaceVisible("zooming in closer than M70 range keeps the captured cloud visible")
        view.camera.simdPosition = SIMD3(2, 0, 2)
        view.camera.look(at: SCNVector3Zero)
        try assertSurfaceVisible("orbiting the captured surface never recalculates its acquisition mask")
        XCTAssertEqual(frames.contents().load(as: simd_float4x4.self).elements, frame.elements)
        update(.image)
        XCTAssertEqual(view.imageView.image?.pngData(), capturedImage, "inspection cannot change the recorded 2D result")
        XCTAssertEqual(try encoder.encode(sample), original, "inspection cannot change the saved Pose or camera parameters")
    }

    func testRecordedPoseColorsPlacedModelImmediately() async throws {
        let points: [SIMD3<Float>] = [SIMD3(-1, -1, 0), SIMD3(1, -1, 0), SIMD3(1, 1, 0), SIMD3(-1, 1, 0)]
        let indices: [UInt32] = [0, 1, 2, 0, 2, 3]
        var data = Data(count: 32 + points.count * 16 + indices.count * 4)
        data.withUnsafeMutableBytes { raw in
            let words = raw.bindMemory(to: UInt32.self)
            words[0] = 0x534c5441; words[1] = 1; words[2] = UInt32(points.count); words[3] = UInt32(indices.count)
            for (index, point) in points.enumerated() {
                for axis in 0..<3 { words[8 + index * 3 + axis] = point[axis].bitPattern }
                words[8 + points.count * 3 + index] = 0xff808080
            }
            for (index, value) in indices.enumerated() { words[8 + points.count * 4 + index] = value }
        }
        let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        let manifest = ModelManifest(protocol: teachingProtocol, modelHash: hash, name: "Coverage regression",
            sourceHash: hash, sourceMapId: "coverage-regression", coordinateFrame: "virtual_origin",
            distanceUnit: "meter", verticalAxis: "Z", vertices: points.count, indices: indices.count,
            sampled: false, originalVertices: points.count, byteLength: data.count,
            bounds: ModelBounds(min: Point3(SIMD3(-1, -1, 0)), max: Point3(SIMD3(1, 1, 0))))
        let model = try ModelGeometry(data: data, manifest: manifest)
        let geometry = try model.makeGeometry(settings: ModelDisplaySettings(meshQuality: .full))
        let ar = ARController(); ar.load(manifest: manifest, samples: [])
        ar.display(geometry); ar.trackingNormal = true; ar.yaw = 37; ar.pitch = 16; ar.roll = -21
        ar.applyPlacement(at: SIMD3(2, 0.4, -3))
        let object = try XCTUnwrap(ar.view.scene.rootNode.childNode(withName: "independent-teaching-object", recursively: true))
        let camera = SCNNode(); camera.camera = SCNCamera(); camera.camera?.zNear = 0.01; camera.camera?.zFar = 10
        var modelFromCamera = matrix_identity_float4x4; modelFromCamera.columns.3.z = 1
        camera.simdTransform = object.simdWorldTransform * modelFromCamera
        ar.view.scene.rootNode.addChildNode(camera)
        let renderer = SCNRenderer(device: try XCTUnwrap(MTLCreateSystemDefaultDevice()), options: nil)
        renderer.scene = ar.view.scene; renderer.pointOfView = camera
        func coveragePixels(_ name: String, origin: TeachingPoseOrigin = .ipad) throws -> Int {
            let image = renderer.snapshot(atTime: 0, with: CGSize(width: 320, height: 240), antialiasingMode: .none)
            let cg = try XCTUnwrap(image.cgImage)
            let context = try XCTUnwrap(CGContext(data: nil, width: cg.width, height: cg.height,
                bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
            let pixels = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
            let count = (0..<(cg.width * cg.height)).filter { index in
                let offset = index * 4
                if origin == .ipad {
                    return Int(pixels[offset]) > Int(pixels[offset + 1]) + 20 && Int(pixels[offset + 1]) > Int(pixels[offset + 2]) + 30
                }
                return Int(pixels[offset + 1]) > Int(pixels[offset]) + 40 && Int(pixels[offset + 1]) > Int(pixels[offset + 2]) + 15
            }.count
            let attachment = XCTAttachment(image: image); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
            return count
        }
        let coverage = TeachingCoverageRenderer(); coverage.attach(to: geometry); coverage.opacity = 1
        coverage.update(model: model, samples: [])
        let baseline = try coveragePixels("Placed model before recording")
        let sample = TeachingSample(segmentId: "coverage-regression", kind: "keyframe",
            cameraPose: TeachingCoordinates.opticalPose(camera: camera.simdWorldTransform, worldFromModel: object.simdWorldTransform))
        var mac = sample; mac.id = "mac-coverage-regression"; mac.origin = .desktop
        coverage.update(model: model, samples: [mac])
        for _ in 0..<500 where coverage.preparing { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertGreaterThan(try coveragePixels("Placed Mac coverage", origin: .desktop), 5000)
        let macFraction = coverage.coveredFraction
        ar.refreshMarkers([mac, sample])
        let markers = try XCTUnwrap(ar.view.scene.rootNode.childNode(withName: "recorded-pose-markers", recursively: true))
        XCTAssertEqual(markers.childNodes.count, 2)
        for (marker, origin) in zip(markers.childNodes, [TeachingPoseOrigin.desktop, .ipad]) {
            let color = try XCTUnwrap(marker.geometry?.firstMaterial?.diffuse.contents as? UIColor)
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            color.getRed(&r, green: &g, blue: &b, alpha: &a)
            XCTAssertEqual(r, CGFloat(origin.rgb.x), accuracy: 0.001)
            XCTAssertEqual(g, CGFloat(origin.rgb.y), accuracy: 0.001)
        }
        coverage.update(model: model, samples: [mac, sample])
        for _ in 0..<500 where coverage.preparing { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(coverage.error.isEmpty, coverage.error)
        XCTAssertEqual(coverage.hitCount, 2)
        XCTAssertEqual(coverage.coveredFraction, macFraction, "recording the same area must not double-count Mac references")
        XCTAssertGreaterThan(try coveragePixels("Placed model after recording") - baseline, 5000,
                             "recording must color the already displayed and arbitrarily placed model")
        coverage.enabled = false
        XCTAssertLessThan(abs(try coveragePixels("Placed model coverage hidden") - baseline), 100)
    }

    func testPoseImageExcludesCoverageWhileGlobalModelKeepsIt() throws {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        func makeGeometry() -> SCNGeometry {
            let geometry = SCNPlane(width: 4, height: 3)
            let material = SCNMaterial(); material.lightingModel = .constant
            material.diffuse.contents = UIColor.lightGray; material.isDoubleSided = true
            geometry.materials = [material]
            return geometry
        }
        var geometry = makeGeometry()
        var sample = TeachingSample(segmentId: "image-coverage-isolation", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0, 0, 1)),
                quaternion: Rotation4(simd_quatf(angle: .pi, axis: SIMD3(1, 0, 0)))))
        var matrix = try XCTUnwrap(TeachingCoveragePose(sample.cameraPose)).cameraFromModel
        let frames = try XCTUnwrap(device.makeBuffer(bytes: &matrix, length: MemoryLayout<simd_float4x4>.stride, options: .storageModeShared))
        let values = [Float](repeating: 1, count: TeachingCoverageProfile.columns * TeachingCoverageProfile.rows)
        let depths = try XCTUnwrap(values.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
        let footprint = TeachingCoverageSnapshot(frames: frames, depths: depths, frameCount: 1)
        let baseline = PosePreviewSurface(); baseline.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        defer { baseline.stop() }
        baseline.update(rendered: geometry, sample: sample, mode: .image, resetRevision: 0)
        baseline.layoutIfNeeded()
        let originalImage = try XCTUnwrap(baseline.imageView.image)
        let originalPNG = try XCTUnwrap(originalImage.pngData())

        func centerPixel(_ image: UIImage) throws -> [UInt8] {
            let cg = try XCTUnwrap(image.cgImage)
            var pixel = [UInt8](repeating: 0, count: 4)
            try pixel.withUnsafeMutableBytes { raw in
                let context = try XCTUnwrap(CGContext(data: raw.baseAddress, width: 1, height: 1,
                    bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
                context.draw(cg, in: CGRect(x: -cg.width / 2, y: -cg.height / 2, width: cg.width, height: cg.height))
            }
            return pixel
        }
        func render(_ geometry: SCNGeometry) -> UIImage {
            let scene = SCNScene(); scene.rootNode.addChildNode(SCNNode(geometry: geometry))
            let camera = SCNNode(); camera.camera = SCNCamera(); camera.position.z = 1
            camera.camera?.zNear = 0.01; camera.camera?.zFar = 1000
            scene.rootNode.addChildNode(camera)
            let renderer = SCNRenderer(device: device, options: nil)
            renderer.scene = scene; renderer.pointOfView = camera
            return renderer.snapshot(atTime: 0, with: CGSize(width: 400, height: 300), antialiasingMode: .multisampling4X)
        }

        // Open a fresh preview with coverage already attached, as in the real review page.
        XCTAssertEqual(try centerPixel(render(geometry)), try centerPixel(originalImage))
        TeachingCoverageRenderer.apply(footprint, opacity: 0.8, to: geometry.firstMaterial!)
        let view = PosePreviewSurface(); view.frame = baseline.frame
        defer { view.stop() }
        func update(_ mode: PosePreviewMode = .image) {
            view.update(rendered: geometry, overview: geometry, footprint: footprint,
                        sample: sample, mode: mode, resetRevision: 0)
            view.layoutIfNeeded()
        }
        update()
        XCTAssertEqual(view.imageView.image?.pngData(), originalPNG, "2D must preserve original colors when live coverage is enabled")
        let livePixel = try centerPixel(render(geometry))
        let globalPixel = try centerPixel(render(XCTUnwrap(view.overviewObject.geometry)))
        XCTAssertGreaterThan(Int(livePixel[2]), Int(livePixel[0]) + 15, "opening 2D must preserve purple iPad coverage")
        XCTAssertGreaterThan(Int(globalPixel[2]), Int(globalPixel[0]) + 15, "the global 3D overview keeps the selected iPad Pose purple")
        XCTAssertTrue(geometry.firstMaterial?.value(forKey: "atlasCoverageFrames") as? MTLBuffer === frames)

        // Force new snapshots after material changes and Pose selection; cached images can hide a shared-material leak.
        for opacity: Float in [0, 0.25, 1] {
            TeachingCoverageRenderer.apply(footprint, opacity: opacity, to: geometry.firstMaterial!)
            sample.id = UUID().uuidString
            update(.interactive); view.setCameraPoseVisible(true); view.setOverviewExpanded(true)
            update()
            XCTAssertEqual(view.imageView.image?.pngData(), originalPNG, "coverage changes and 3D overlays cannot tint 2D")
        }
        geometry = makeGeometry()
        TeachingCoverageRenderer.apply(footprint, opacity: 1, to: geometry.firstMaterial!)
        update()
        XCTAssertEqual(view.imageView.image?.pngData(), originalPNG, "replacement display geometry must also use original colors")
        view.imageScrollView.setZoomScale(2.5, animated: false)
        view.scrollViewDidEndZooming(view.imageScrollView, with: view.imageView, atScale: 2.5)
        XCTAssertEqual(try centerPixel(XCTUnwrap(view.imageView.image)), try centerPixel(originalImage),
                       "higher-resolution 2D rerenders must stay free of coverage tint")
        let shot = XCTAttachment(image: try XCTUnwrap(view.imageView.image))
        shot.name = "Original-color 2D image with coverage enabled"; shot.lifetime = .keepAlways; add(shot)
    }

    func testPoseImageZoomPanRestoreAndResize() throws {
        var geometry: SCNGeometry = SCNBox(width: 0.5, height: 0.4, length: 0.2, chamferRadius: 0)
        var sample = TeachingSample(segmentId: "image-detail", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0, 0, 1)),
                quaternion: Rotation4(simd_quatf(angle: .pi, axis: SIMD3(1, 0, 0)))))
        let view = PosePreviewSurface(); view.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        func update(_ mode: PosePreviewMode, reset: Int = 0) {
            view.update(rendered: geometry, sample: sample, mode: mode, resetRevision: reset)
            view.layoutIfNeeded()
        }
        update(.interactive)
        view.zoom(by: 2)
        let inspected = view.camera.simdTransform.elements
        update(.image)
        let initialPixels = try XCTUnwrap(view.imageView.image?.cgImage).width
        let scroll = view.imageScrollView
        scroll.setZoomScale(2.5, animated: false)
        scroll.setContentOffset(CGPoint(x: 180, y: 120), animated: false)
        let offset = scroll.contentOffset
        XCTAssertEqual(scroll.zoomScale, 2.5, accuracy: 0.001)
        XCTAssertGreaterThan(offset.x, 0); XCTAssertGreaterThan(offset.y, 0)
        geometry = geometry.copy() as! SCNGeometry
        update(.image)
        XCTAssertEqual(scroll.zoomScale, 2.5, accuracy: 0.001)
        XCTAssertEqual(scroll.contentOffset, offset, "replacing the display geometry retains the inspected image region")
        XCTAssertEqual(view.camera.simdTransform.elements, inspected, "display quality changes preserve the 3D camera")
        update(.interactive); XCTAssertEqual(view.camera.simdTransform.elements, inspected)
        update(.image)
        XCTAssertEqual(scroll.zoomScale, 2.5, accuracy: 0.001)
        XCTAssertEqual(scroll.contentOffset, offset, "mode switching retains the inspected image region")
        let center = CGPoint(x: (offset.x + 200) / scroll.contentSize.width,
                             y: (offset.y + 150) / scroll.contentSize.height)
        view.frame.size = CGSize(width: 800, height: 600); update(.image)
        XCTAssertEqual(scroll.zoomScale, 2.5, accuracy: 0.001)
        XCTAssertEqual((scroll.contentOffset.x + 400) / scroll.contentSize.width, center.x, accuracy: 0.001)
        XCTAssertEqual((scroll.contentOffset.y + 300) / scroll.contentSize.height, center.y, accuracy: 0.001)
        view.scrollViewDidEndZooming(scroll, with: view.imageView, atScale: 2.5)
        XCTAssertGreaterThan(try XCTUnwrap(view.imageView.image?.cgImage).width, initialPixels,
                             "zooming refines the recorded image instead of only stretching the initial bitmap")
        XCTAssertEqual(view.camera.simdTransform.elements, inspected)
        update(.image, reset: 1)
        XCTAssertEqual(scroll.zoomScale, 1, accuracy: 0.001); XCTAssertEqual(scroll.contentOffset, .zero)
        XCTAssertEqual(view.camera.simdTransform.elements, inspected, "fitting the image does not reset the 3D camera")
        scroll.setZoomScale(2, animated: false)
        update(.interactive, reset: 2)
        XCTAssertEqual(view.camera.simdPosition.z, 1, accuracy: 0.001)
        XCTAssertEqual(scroll.zoomScale, 2, accuracy: 0.001, "resetting 3D leaves the image zoom alone")
        sample.id = UUID().uuidString
        update(.image, reset: 2)
        XCTAssertEqual(scroll.zoomScale, 1, accuracy: 0.001); XCTAssertEqual(scroll.contentOffset, .zero)
        XCTAssertNotNil(view.imageView.image, "a different Pose starts with its complete recorded frame")
        view.stop()
    }

    func testPosePreviewLocalGeometryAndSynchronizedOverview() throws {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        let geometry = SCNBox(width: 4, height: 3, length: 0.1, chamferRadius: 0)
        let material = SCNMaterial(); material.lightingModel = .constant; material.diffuse.contents = UIColor.orange
        geometry.materials = [material]
        var sample = TeachingSample(segmentId: "local-preview", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0, 0, 1)),
                quaternion: Rotation4(simd_quatf(angle: .pi, axis: SIMD3(1, 0, 0)))))
        var matrix = try XCTUnwrap(TeachingCoveragePose(sample.cameraPose)).cameraFromModel
        let frames = try XCTUnwrap(device.makeBuffer(bytes: &matrix, length: MemoryLayout<simd_float4x4>.stride, options: .storageModeShared))
        let values = [Float](repeating: 1, count: TeachingCoverageProfile.columns * TeachingCoverageProfile.rows)
        let depths = try XCTUnwrap(values.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
        let footprint = TeachingCoverageSnapshot(frames: frames, depths: depths, frameCount: 1)
        TeachingCoverageRenderer.apply(footprint, opacity: 0.25, to: material)
        let liveShader = material.shaderModifiers?[.fragment]
        let view = PosePreviewSurface(); view.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        view.update(rendered: geometry, overview: geometry, sample: sample, mode: .interactive, resetRevision: 0)
        XCTAssertNil(view.object.geometry, "pending selection must never flash the entire model")
        view.update(rendered: geometry, overview: geometry, footprint: footprint, sample: sample, mode: .interactive, resetRevision: 0)
        view.layoutIfNeeded()
        let local = try XCTUnwrap(view.object.geometry)
        XCTAssertFalse(local === geometry); XCTAssertFalse(local.firstMaterial === material)
        XCTAssertNotNil(local.firstMaterial?.shaderModifiers)
        XCTAssertEqual(material.shaderModifiers?[.fragment], liveShader, "preview clipping must not change the live model")
        XCTAssertTrue(material.value(forKey: "atlasCoverageFrames") as? MTLBuffer === frames)
        XCTAssertFalse(view.overviewObject.geometry === geometry)
        XCTAssertLessThan(local.boundingBox.max.x - local.boundingBox.min.x, 1.2, "the orbit bounds cover only the selected surface")
        XCTAssertEqual(view.overviewObject.boundingBox.max.x - view.overviewObject.boundingBox.min.x, 4, accuracy: 0.001)
        view.camera.simdOrientation = simd_quatf(angle: 1.1, axis: simd_normalize(SIMD3<Float>(1, 2, 3)))
        view.syncOverviewCamera()
        XCTAssertLessThan(simd_length(view.camera.simdWorldFront - view.overviewCamera.simdWorldFront), 0.0001)
        XCTAssertLessThan(simd_length(view.camera.simdWorldUp - view.overviewCamera.simdWorldUp), 0.0001)
        let overviewTransform = view.overviewCamera.simdTransform.elements
        let scale = view.overviewCamera.camera!.orthographicScale
        view.translate(by: CGPoint(x: 20, y: 15)); view.zoom(by: 2); view.syncOverviewCamera()
        XCTAssertEqual(view.overviewCamera.simdTransform.elements, overviewTransform, "global context stays centered while inspecting locally")
        XCTAssertEqual(view.overviewCamera.camera!.orthographicScale, scale)
        view.restoreRecordedView()
        XCTAssertLessThan(simd_length(view.camera.simdWorldFront - view.overviewCamera.simdWorldFront), 0.0001)
        XCTAssertNotEqual(view.overviewCamera.simdTransform.elements, overviewTransform)
        sample.id = UUID().uuidString
        view.update(rendered: geometry, overview: geometry, sample: sample, mode: .interactive, resetRevision: 0)
        XCTAssertNil(view.object.geometry, "switching Poses clears the previous selection immediately")
        XCTAssertNil(view.overviewObject.geometry?.firstMaterial?.shaderModifiers)
        let empty = TeachingCoverageSnapshot(frames: nil, depths: nil, frameCount: 0)
        view.update(rendered: geometry, overview: geometry, footprint: empty, sample: sample, mode: .interactive, resetRevision: 0)
        XCTAssertNil(view.object.geometry, "an empty footprint does not fall back to the entire model")
        view.stop()
    }

    func testExpandedOverviewKeepsLocalCameraAndResumesSynchronization() throws {
        let geometry = SCNBox(width: 4, height: 3, length: 1, chamferRadius: 0)
        geometry.widthSegmentCount = 8; geometry.heightSegmentCount = 6
        let thumbnail = SCNBox(width: 4, height: 3, length: 1, chamferRadius: 0)
        let sample = TeachingSample(segmentId: "expanded-overview", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0, 0, 5)),
                quaternion: Rotation4(simd_quatf(angle: .pi, axis: SIMD3(1, 0, 0)))))
        let view = PosePreviewSurface(); view.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        view.update(rendered: geometry, overview: thumbnail, sample: sample, mode: .interactive, resetRevision: 0)
        view.layoutIfNeeded(); view.zoom(by: 1.5); view.translate(by: CGPoint(x: 20, y: 15))
        let localTransform = view.camera.simdTransform.elements
        let smallFrame = view.overviewView.frame
        let thumbnailCount = thumbnail.elements[0].primitiveCount
        view.setOverviewExpanded(true)
        XCTAssertTrue(view.overviewExpanded); XCTAssertFalse(view.overviewCollapseButton.isHidden)
        XCTAssertEqual(view.overviewView.bounds.size, view.bounds.size)
        XCTAssertEqual(view.overviewObject.geometry?.elements[0].primitiveCount, geometry.elements[0].primitiveCount,
                       "the large view uses the selected display quality rather than the small thumbnail budget")
        let fittedScale = view.overviewCamera.camera!.orthographicScale
        view.zoomOverview(by: 2); view.translateOverview(by: CGPoint(x: 40, y: 30))
        view.overviewCamera.simdOrientation = simd_quatf(angle: 0.7, axis: SIMD3(0, 0, 1))
        let inspected = view.overviewCamera.simdTransform.elements
        view.syncOverviewCamera(); view.setNeedsLayout(); view.layoutIfNeeded()
        XCTAssertEqual(view.overviewCamera.simdTransform.elements, inspected)
        XCTAssertEqual(view.overviewCamera.camera!.orthographicScale, fittedScale / 2, accuracy: 0.001)
        view.zoom(by: 2); view.translate(by: CGPoint(x: 10, y: 10))
        XCTAssertEqual(view.camera.simdTransform.elements, localTransform, "expanded inspection does not move the local Pose camera")
        let replacement = geometry.copy() as! SCNGeometry
        view.update(rendered: replacement, overview: thumbnail, sample: sample, mode: .interactive, resetRevision: 0)
        view.layoutIfNeeded()
        XCTAssertEqual(view.overviewCamera.simdTransform.elements, inspected, "quality updates preserve the global inspection camera")
        view.frame.size = CGSize(width: 600, height: 450); view.layoutIfNeeded()
        XCTAssertEqual(view.overviewView.bounds.size, view.bounds.size)
        XCTAssertEqual(view.overviewCamera.simdTransform.elements, inspected)
        view.setOverviewExpanded(false)
        XCTAssertFalse(view.overviewExpanded); XCTAssertTrue(view.overviewCollapseButton.isHidden)
        XCTAssertLessThan(view.overviewView.frame.width, smallFrame.width + 1)
        XCTAssertEqual(view.overviewObject.geometry?.elements[0].primitiveCount, thumbnailCount)
        XCTAssertEqual(view.camera.simdTransform.elements, localTransform)
        XCTAssertLessThan(simd_length(view.overviewCamera.simdWorldFront - view.camera.simdWorldFront), 0.0001)
        view.setOverviewExpanded(true)
        view.update(rendered: replacement, overview: thumbnail, sample: sample, mode: .image, resetRevision: 0)
        XCTAssertFalse(view.overviewExpanded); XCTAssertTrue(view.overviewCollapseButton.isHidden)
        view.setOverviewExpanded(true)
        XCTAssertFalse(view.overviewExpanded, "2D mode cannot leave an interactive global overlay on the image")
        view.stop()
    }

    func testModelOriginTogglePreservesViewAndRecordedImage() throws {
        let geometry = SCNBox(width: 4, height: 3, length: 1, chamferRadius: 0)
        geometry.firstMaterial?.lightingModel = .constant
        geometry.firstMaterial?.diffuse.contents = UIColor.lightGray
        var sample = TeachingSample(segmentId: "model-origin", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0, 0, 5)),
                quaternion: Rotation4(simd_quatf(angle: .pi, axis: SIMD3(1, 0, 0)))))
        let view = PosePreviewSurface(); view.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        defer { view.stop() }
        func update(_ mode: PosePreviewMode) {
            view.update(rendered: geometry, overview: geometry, sample: sample, mode: mode, resetRevision: 0)
            view.layoutIfNeeded()
        }
        update(.image)
        let recorded = try XCTUnwrap(view.imageView.image?.pngData())
        update(.interactive); view.setOverviewExpanded(true)
        XCTAssertFalse(view.modelOriginSwitch.isOn); XCTAssertTrue(view.overviewOrigin.isHidden)
        let originControl = try XCTUnwrap(view.modelOriginSwitch.superview)
        let cameraControl = try XCTUnwrap(view.cameraPoseSwitch.superview)
        var selection: Bool?
        view.onModelOriginVisibilityChange = { selection = $0 }
        view.zoomOverview(by: 1.3); view.translateOverview(by: CGPoint(x: 20, y: 15))
        let camera = view.overviewCamera.simdTransform.elements
        let scale = try XCTUnwrap(view.overviewCamera.camera).orthographicScale
        let local = view.camera.simdTransform.elements
        view.modelOriginSwitch.setOn(true, animated: false)
        view.modelOriginSwitch.sendActions(for: .valueChanged)
        XCTAssertEqual(selection, true); XCTAssertTrue(view.showsModelOrigin)
        XCTAssertFalse(view.overviewOrigin.isHidden)
        XCTAssertTrue(view.overviewOrigin.parent === view.overviewView.scene?.rootNode)
        XCTAssertNil(view.sceneView.scene?.rootNode.childNode(withName: "model-coordinate-origin", recursively: true))
        XCTAssertEqual(view.overviewCamera.simdTransform.elements, camera)
        XCTAssertEqual(view.overviewCamera.camera?.orthographicScale, scale, "showing the origin cannot reframe the model")
        XCTAssertEqual(view.camera.simdTransform.elements, local)
        for size in [CGSize(width: 800, height: 600), CGSize(width: 600, height: 800), CGSize(width: 320, height: 240)] {
            view.frame.size = size; view.layoutIfNeeded()
            XCTAssertFalse(originControl.isHidden)
            XCTAssertTrue(view.bounds.contains(originControl.frame))
            XCTAssertGreaterThan(originControl.frame.minY, cameraControl.frame.maxY)
            XCTAssertFalse(originControl.frame.intersects(view.overviewCollapseButton.frame))
            XCTAssertEqual(view.overviewCamera.simdTransform.elements, camera, "resizing must retain global inspection")
        }
        view.frame.size = CGSize(width: 800, height: 600); view.layoutIfNeeded()
        view.setCameraPoseVisible(true); XCTAssertFalse(view.overviewOrigin.isHidden)
        view.setCameraPoseVisible(false); XCTAssertFalse(view.overviewOrigin.isHidden)
        view.setOverviewExpanded(false)
        XCTAssertTrue(originControl.isHidden); XCTAssertFalse(view.overviewOrigin.isHidden, "the thumbnail keeps the origin visible")
        sample.id = UUID().uuidString; sample.cameraPose.position.x = 0.2
        update(.interactive); view.setOverviewExpanded(true)
        XCTAssertTrue(view.modelOriginSwitch.isOn); XCTAssertFalse(view.overviewOrigin.isHidden)
        view.update(rendered: geometry.copy() as? SCNGeometry, overview: geometry,
                    sample: sample, mode: .interactive, resetRevision: 0)
        XCTAssertEqual(view.overviewOrigin.simdPosition, .zero, "quality and Pose changes never move the model origin")
        sample.cameraPose.position.x = 0
        update(.image)
        XCTAssertEqual(view.imageView.image?.pngData(), recorded, "model axes never enter the recorded 2D image")
        XCTAssertTrue(originControl.isHidden); XCTAssertFalse(view.overviewExpanded)
        update(.interactive); view.setOverviewExpanded(true)
        XCTAssertTrue(view.modelOriginSwitch.isOn)
        view.modelOriginSwitch.setOn(false, animated: false)
        view.modelOriginSwitch.sendActions(for: .valueChanged)
        XCTAssertEqual(selection, false); XCTAssertTrue(view.overviewOrigin.isHidden)
    }

    func testModelOriginAxesRenderAtModelZero() throws {
        let geometry = SCNBox(width: 4, height: 3, length: 1, chamferRadius: 0)
        geometry.firstMaterial?.lightingModel = .constant
        geometry.firstMaterial?.diffuse.contents = UIColor.lightGray
        let sample = TeachingSample(segmentId: "origin-render", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0, 0, 5)),
                quaternion: Rotation4(simd_quatf(angle: .pi, axis: SIMD3(1, 0, 0)))))
        let view = PosePreviewSurface(); view.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        defer { view.stop() }
        view.update(rendered: geometry, overview: geometry, sample: sample, mode: .interactive, resetRevision: 0)
        view.layoutIfNeeded(); view.setOverviewExpanded(true); view.setModelOriginVisible(true)
        view.overviewCamera.position = SCNVector3(5, -7, 6)
        view.overviewCamera.look(at: SCNVector3Zero, up: SCNVector3(0, 0, 1), localFront: SCNVector3(0, 0, -1))
        let renderer = SCNRenderer(device: MTLCreateSystemDefaultDevice(), options: nil)
        renderer.scene = view.overviewView.scene; renderer.pointOfView = view.overviewCamera
        let image = renderer.snapshot(atTime: 0, with: view.bounds.size, antialiasingMode: .multisampling4X)
        let cg = try XCTUnwrap(image.cgImage)
        let context = try XCTUnwrap(CGContext(data: nil, width: cg.width, height: cg.height,
            bitsPerComponent: 8, bytesPerRow: cg.width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
        context.draw(cg, in: CGRect(x: 0, y: 0, width: cg.width, height: cg.height))
        let pixels = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
        var counts = [0, 0, 0]
        for index in 0..<(cg.width * cg.height) {
            let rgb = (0..<3).map { Int(pixels[index * 4 + $0]) }
            for axis in 0..<3 where rgb[axis] > 100 && rgb[axis] > rgb[(axis + 1) % 3] + 45 && rgb[axis] > rgb[(axis + 2) % 3] + 45 {
                counts[axis] += 1
            }
        }
        for count in counts { XCTAssertGreaterThan(count, 10, "all three colored axes render even with the origin inside the model") }
        let shot = XCTAttachment(image: image); shot.name = "Global model with RGB model origin"
        shot.lifetime = .keepAlways; add(shot)
        view.setModelOriginVisible(false)
        XCTAssertNotEqual(renderer.snapshot(atTime: 0, with: view.bounds.size, antialiasingMode: .multisampling4X).pngData(), image.pngData())

        // A model whose geometry is offset from zero must not recenter its coordinate frame.
        let offset = SCNGeometry(sources: [SCNGeometrySource(vertices: [SCNVector3(2, -1, 0),
            SCNVector3(4, -1, 0), SCNVector3(4, 1, 0), SCNVector3(2, 1, 0)])],
            elements: [SCNGeometryElement(indices: [Int32(0), 1, 2, 0, 2, 3], primitiveType: .triangles)])
        view.update(rendered: offset, overview: offset, sample: sample, mode: .interactive, resetRevision: 0)
        view.setModelOriginVisible(true)
        XCTAssertEqual(view.overviewOrigin.simdWorldPosition, .zero)
        for (name, direction) in [("X", SIMD3<Float>(1, 0, 0)), ("Y", SIMD3<Float>(0, 1, 0)), ("Z", SIMD3<Float>(0, 0, 1))] {
            let axis = try XCTUnwrap(view.overviewOrigin.childNode(withName: "model-origin-\(name)", recursively: false))
            let tip = simd_normalize(axis.simdConvertPosition(SIMD3(0, 1, 0), to: view.overviewView.scene?.rootNode))
            XCTAssertLessThan(simd_length(tip - direction), 0.00001, "axes stay in the model frame, not the camera frame")
        }
    }

    func testCameraProjectionMatchesM70LensAndSurfaceDepth() throws {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        var transform = simd_float4x4(simd_quatf(angle: 0.8, axis: simd_normalize(SIMD3<Float>(1, 2, 3))))
        transform.columns.3 = SIMD4(2, -1, 3, 1)
        let oldLens = simd_float4x4(columns: (
            SIMD4(1.2, 0, 0, 0), SIMD4(0, 1.8, 0, 0), SIMD4(0.15, -0.1, -1.00002, -1), SIMD4(0, 0, -0.0200002, 0)))
        var sample = TeachingSample(segmentId: "projection", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(transform.translation), quaternion: Rotation4(simd_quatf(transform))),
            previewCameraTransform: matrix_identity_float4x4.elements, previewProjection: oldLens.elements, previewAspect: 4 / 3)
        let lens = ZividFieldOfView.projectionMatrix
        let recorded = try TeachingCoverageFrustum.recordedView(sample)
        var frame = recorded.cameraFromModel
        let frames = try XCTUnwrap(device.makeBuffer(bytes: &frame, length: MemoryLayout<simd_float4x4>.stride, options: .storageModeShared))
        var values = [Float](repeating: 0.7, count: recorded.frustum.columns * recorded.frustum.rows)
        values[0] = 1.1; values[1] = .nan; values[2] = 0; values[3] = 1.31
        let depths = try XCTUnwrap(values.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
        let snapshot = TeachingCoverageSnapshot(frames: frames, depths: depths, frameCount: 1, frustum: recorded.frustum)
        let projection = try XCTUnwrap(PoseCameraProjection(sample: sample, footprint: snapshot))
        XCTAssertEqual(projection.surfaceDepth, 1.1, "empty, invalid and out-of-range depth cells cannot stretch the cone")
        let expectedTransform = transform
        for (actual, expected) in zip(projection.modelFromCamera.elements, expectedTransform.elements) {
            XCTAssertEqual(actual, expected, accuracy: 0.00001)
        }
        let expectedCorners = [SIMD2<Float>(-1, 1), SIMD2(1, 1), SIMD2(1, -1), SIMD2(-1, -1)]
        XCTAssertEqual(projection.corners.count, 4)
        for (corner, expected) in zip(projection.corners, expectedCorners) {
            let world = projection.modelFromCamera * SIMD4(corner, 1)
            let clip = lens * (transform * TeachingCoordinates.opticalToARCamera).inverse * world
            XCTAssertEqual(clip.x / clip.w, expected.x, accuracy: 0.00001)
            XCTAssertEqual(clip.y / clip.w, expected.y, accuracy: 0.00001,
                           "the global cone must map to M70 image corners at the saved optical Pose, ignoring old native iPad intrinsics")
        }
        sample.cameraPose.position.x += 1
        XCTAssertNil(PoseCameraProjection(sample: sample, footprint: snapshot)?.surfaceDepth,
                     "a stale depth map cannot draw a cone from a different camera")
        sample.previewCameraTransform = nil; sample.previewProjection = nil
        sample.cameraPose = CameraPose(position: Point3(SIMD3(1, 2, 3)),
            quaternion: Rotation4(simd_quatf(angle: 0.6, axis: SIMD3(0, 1, 0))))
        let legacy = try XCTUnwrap(PoseCameraProjection(sample: sample, footprint: nil))
        XCTAssertLessThan(simd_length(legacy.modelFromCamera.translation - SIMD3(1, 2, 3)), 0.00001)
        XCTAssertEqual(legacy.frustum.tangents.y, ZividFieldOfView.tangentY, accuracy: 0.00001)
        XCTAssertTrue(legacy.corners.isEmpty, "without visible surface depths, show only the camera and axes")
        sample.cameraPose.position.x = .nan
        XCTAssertNil(PoseCameraProjection(sample: sample, footprint: nil))
    }

    func testCameraProjectionTogglePreservesCamerasAndFollowsPose() throws {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        let geometry = SCNBox(width: 1, height: 0.8, length: 0.2, chamferRadius: 0)
        geometry.firstMaterial?.diffuse.contents = UIColor.lightGray
        geometry.firstMaterial?.lightingModel = .constant
        var sample = TeachingSample(segmentId: "projection-state", kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0, 0, 1)),
                quaternion: Rotation4(simd_quatf(angle: .pi, axis: SIMD3(1, 0, 0)))))
        func snapshot() throws -> TeachingCoverageSnapshot {
            let recorded = try TeachingCoverageFrustum.recordedView(sample)
            var frame = recorded.cameraFromModel
            let frames = try XCTUnwrap(device.makeBuffer(bytes: &frame, length: MemoryLayout<simd_float4x4>.stride, options: .storageModeShared))
            let values = [Float](repeating: 1, count: recorded.frustum.columns * recorded.frustum.rows)
            let depths = try XCTUnwrap(values.withUnsafeBytes { device.makeBuffer(bytes: $0.baseAddress!, length: $0.count, options: .storageModeShared) })
            return TeachingCoverageSnapshot(frames: frames, depths: depths, frameCount: 1, frustum: recorded.frustum)
        }
        let footprint = try snapshot()
        let view = PosePreviewSurface(); view.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
        view.update(rendered: geometry, overview: geometry, footprint: footprint, sample: sample, mode: .interactive, resetRevision: 0)
        view.layoutIfNeeded(); view.setOverviewExpanded(true)
        XCTAssertTrue(view.overviewPose.isHidden); XCTAssertFalse(view.cameraPoseSwitch.isOn)
        let local = view.camera.simdTransform.elements
        let orientation = simd_quatf(angle: 0.65, axis: SIMD3(0, 1, 0))
        view.overviewCamera.simdOrientation = orientation
        let overviewLens = try XCTUnwrap(view.overviewCamera.camera)
        let originalOverview = view.overviewCamera.simdTransform.elements
        let originalScale = overviewLens.orthographicScale
        view.setCameraPoseVisible(true)
        XCTAssertFalse(view.overviewPose.isHidden); XCTAssertTrue(view.cameraPoseSwitch.isOn)
        XCTAssertEqual(view.overviewCamera.simdTransform.elements, originalOverview, "showing an off-model camera must preserve the cloud's framing")
        XCTAssertEqual(overviewLens.orthographicScale, originalScale, "camera overlays must not shrink the point cloud")
        let cameraNode = try XCTUnwrap(view.overviewPose.childNodes.first)
        XCTAssertLessThan(simd_length(cameraNode.simdWorldPosition - sample.cameraPose.position.simd), 0.00001)
        XCTAssertNotNil(cameraNode.childNode(withName: "camera-projection", recursively: false))
        let renderer = SCNRenderer(device: device, options: nil)
        renderer.scene = view.overviewView.scene; renderer.pointOfView = view.overviewCamera
        let shot = XCTAttachment(image: renderer.snapshot(atTime: 0, with: CGSize(width: 800, height: 600), antialiasingMode: .multisampling4X))
        shot.name = "Camera projection without reframing the model"; shot.lifetime = .keepAlways; add(shot)
        view.zoomOverview(by: 1.3); view.translateOverview(by: CGPoint(x: 25, y: 15))
        let inspected = view.overviewCamera.simdTransform.elements
        let inspectedScale = overviewLens.orthographicScale
        for _ in 0..<3 {
            view.setCameraPoseVisible(false)
            XCTAssertEqual(view.overviewCamera.simdTransform.elements, inspected)
            XCTAssertEqual(overviewLens.orthographicScale, inspectedScale)
            view.setCameraPoseVisible(true)
            XCTAssertEqual(view.overviewCamera.simdTransform.elements, inspected)
            XCTAssertEqual(overviewLens.orthographicScale, inspectedScale, "repeated toggles retain the user's zoom and pan")
        }
        view.update(rendered: geometry.copy() as? SCNGeometry, overview: geometry, footprint: footprint,
                    sample: sample, mode: .interactive, resetRevision: 0)
        view.layoutIfNeeded()
        XCTAssertEqual(view.overviewCamera.simdTransform.elements, inspected, "quality changes cannot reset global inspection")
        XCTAssertEqual(overviewLens.orthographicScale, inspectedScale)
        XCTAssertEqual(view.camera.simdTransform.elements, local)
        view.setOverviewExpanded(false)
        XCTAssertFalse(view.overviewPose.isHidden, "the thumbnail keeps the camera overlay enabled")
        XCTAssertTrue(try XCTUnwrap(view.cameraPoseSwitch.superview).isHidden)
        XCTAssertLessThan(simd_length(view.overviewCamera.simdWorldFront - view.camera.simdWorldFront), 0.00001)
        let thumbnailCamera = view.overviewCamera.simdTransform.elements
        let thumbnailScale = overviewLens.orthographicScale
        view.setCameraPoseVisible(false); view.syncOverviewCamera()
        XCTAssertEqual(view.overviewCamera.simdTransform.elements, thumbnailCamera)
        XCTAssertEqual(overviewLens.orthographicScale, thumbnailScale)
        view.setCameraPoseVisible(true); view.syncOverviewCamera()
        XCTAssertEqual(view.overviewCamera.simdTransform.elements, thumbnailCamera)
        XCTAssertEqual(overviewLens.orthographicScale, thumbnailScale, "thumbnail fitting also uses only model bounds")
        view.update(rendered: geometry, overview: geometry, footprint: footprint, sample: sample, mode: .image, resetRevision: 0)
        view.layoutIfNeeded()
        let recordedImage = try XCTUnwrap(view.imageView.image?.pngData())
        view.setCameraPoseVisible(false); view.setCameraPoseVisible(true)
        view.layoutIfNeeded()
        XCTAssertEqual(view.imageView.image?.pngData(), recordedImage, "camera overlays never appear in the saved 2D image")
        sample.id = UUID().uuidString; sample.cameraPose.position.x = 0.5
        view.update(rendered: geometry, overview: geometry, sample: sample, mode: .interactive, resetRevision: 0)
        let next = try XCTUnwrap(view.overviewPose.childNodes.first)
        XCTAssertEqual(next.simdWorldPosition.x, 0.5, accuracy: 0.00001)
        XCTAssertNil(next.childNode(withName: "camera-projection", recursively: false), "old rays disappear immediately when changing Pose")
        view.layoutIfNeeded(); view.setOverviewExpanded(true)
        view.zoomOverview(by: 1.2); view.translateOverview(by: CGPoint(x: -20, y: 10))
        let awaitingProjection = view.overviewCamera.simdTransform.elements
        let awaitingProjectionScale = overviewLens.orthographicScale
        view.update(rendered: geometry, overview: geometry, footprint: try snapshot(), sample: sample, mode: .interactive, resetRevision: 0)
        view.layoutIfNeeded()
        XCTAssertNotNil(view.overviewPose.childNode(withName: "camera-projection", recursively: true))
        XCTAssertTrue(view.showsCameraPose)
        XCTAssertEqual(view.overviewCamera.simdTransform.elements, awaitingProjection, "delayed projection data must preserve the current view")
        XCTAssertEqual(overviewLens.orthographicScale, awaitingProjectionScale)
        view.setCameraPoseVisible(false); XCTAssertTrue(view.overviewPose.isHidden)
        let recreated = PosePreviewSurface()
        recreated.update(rendered: geometry, overview: geometry, footprint: try snapshot(), sample: sample, mode: .interactive, resetRevision: 0)
        recreated.setCameraPoseVisible(true); recreated.setOverviewExpanded(true)
        recreated.frame = view.frame; recreated.layoutIfNeeded()
        XCTAssertTrue(recreated.overviewExpanded); XCTAssertTrue(recreated.cameraPoseSwitch.isOn)
        XCTAssertEqual(try XCTUnwrap(recreated.overviewCamera.camera).orthographicScale, originalScale, accuracy: 0.000001,
                       "restoring an expanded view before layout must fit only the model in its final viewport")
        recreated.stop()
        view.stop()
    }

    func testM70ExistingProjectReadOnly() throws {
        guard let projectID = ProcessInfo.processInfo.environment["ATLAS_M70_REVIEW_PROJECT_ID"],
              UUID(uuidString: projectID) != nil else {
            throw XCTSkip("Provide an existing project for read-only M70 review")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(projectID)"]
        XCTAssertTrue(app.otherElements["library-content"].waitForExistence(timeout: 15))
        for _ in 0..<6 where !project.isHittable { app.scrollViews["library-projects-scroll"].swipeUp() }
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let review = app.buttons["review-poses"]
        XCTAssertTrue(review.waitForExistence(timeout: 30)); review.tap()
        let profile = app.staticTexts["pose-camera-profile"]
        let imageMode = app.buttons["pose-preview-mode-2d"]
        XCTAssertTrue(imageMode.waitForExistence(timeout: 10))
        XCTAssertFalse(profile.exists, "free 3D inspection does not display capture camera parameters")
        imageMode.tap()
        XCTAssertTrue(profile.waitForExistence(timeout: 10))
        XCTAssertTrue(profile.label.contains("Zivid 2 M70"))
        XCTAssertTrue(profile.label.contains("1944 × 1200"))
        XCTAssertTrue(app.buttons["select-poses"].isHittable)
        let count = app.staticTexts["pose-review-count"].label
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "review-pose-"))
        XCTAssertGreaterThan(rows.count, 0)
        if rows.count > 6 { rows.element(boundBy: 6).tap() }
        for (orientation, mode) in [(UIDeviceOrientation.landscapeLeft, "2d"), (.landscapeLeft, "3d"),
                                    (.portrait, "3d"), (.landscapeLeft, "3d")] {
            XCUIDevice.shared.orientation = orientation
            app.buttons["pose-preview-mode-\(mode)"].tap()
            let pending = app.staticTexts["正在提取当前 Pose 点云…"]
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: pending)], timeout: 30), .completed)
            let preview = app.otherElements["pose-review-preview"]
            XCTAssertTrue(preview.exists)
            if mode == "2d" {
                XCTAssertEqual(preview.frame.width / preview.frame.height, ZividFieldOfView.nativeAspect, accuracy: 0.01)
            } else {
                let viewport = app.otherElements["pose-review-viewport"]
                let thumbnail = app.descendants(matching: .any)["pose-global-thumbnail"].firstMatch
                XCTAssertTrue(thumbnail.isHittable)
                XCTAssertEqual(viewport.frame.maxX - thumbnail.frame.maxX, 12, accuracy: 2)
                XCTAssertEqual(viewport.frame.maxY - thumbnail.frame.maxY, 12, accuracy: 2)
            }
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "Existing Pose M70 \(mode) \(orientation.isLandscape ? "landscape" : "portrait")"
            shot.lifetime = .keepAlways; add(shot)
            XCTAssertEqual(app.staticTexts["pose-review-count"].label, count)
        }
    }

    func testPosePreviewInteractionAndImageSwitching() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_PREVIEW_DISPOSABLE_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable completed project with two Poses; the test removes only this fixture afterward")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let review = app.buttons["review-poses"]
        XCTAssertTrue(review.waitForExistence(timeout: 30)); review.tap()
        let preview = app.otherElements["pose-review-preview"]
        let image = app.buttons["pose-preview-mode-2d"], interactive = app.buttons["pose-preview-mode-3d"]
        let reset = app.buttons["reset-pose-preview"]
        let close = app.buttons["close-pose-review"]
        XCTAssertTrue(image.waitForExistence(timeout: 10)); XCTAssertTrue(preview.exists)
        XCTAssertFalse(app.navigationBars.staticTexts["查看 / 编辑 Pose"].exists)
        XCTAssertGreaterThanOrEqual(close.frame.minX, reset.frame.maxX)
        XCTAssertEqual(close.frame.midY, reset.frame.midY, accuracy: 2)
        XCTAssertTrue(reset.isEnabled)
        XCTAssertFalse(app.buttons["delete-review-pose"].exists, "inspection remains available for locked projects")
        let quality = app.sliders["pose-preview-quality"]
        XCTAssertTrue(quality.isHittable); XCTAssertTrue(quality.isEnabled)
        let initialQuality = quality.value as? String
        let lowQuality = preview.screenshot().pngRepresentation
        quality.adjust(toNormalizedSliderPosition: 0.65)
        XCTAssertNotEqual(quality.value as? String, initialQuality)
        func waitForQualityUpdate() {
            let progress = app.descendants(matching: .any)["pose-preview-quality-progress"].firstMatch
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: progress)], timeout: 20), .completed)
        }
        waitForQualityUpdate()
        XCTAssertNotEqual(preview.screenshot().pngRepresentation, lowQuality, "the quality slider changes the rendered 3D density")
        let quality3D = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        quality3D.name = "Pose quality slider 3D"; quality3D.lifetime = .keepAlways; add(quality3D)
        let thumbnail = app.descendants(matching: .any)["pose-global-thumbnail"].firstMatch
        let overview = app.descendants(matching: .any)["pose-global-overview"].firstMatch
        let collapse = app.buttons["collapse-pose-overview"]
        XCTAssertTrue(thumbnail.isHittable)
        let thumbnailWidth = thumbnail.frame.width
        func comparisonPixels(_ screenshot: XCUIScreenshot) throws -> [UInt8] {
            let image = try XCTUnwrap(screenshot.image.cgImage)
            let width = 512, height = max(1, 512 * image.height / image.width)
            let context = try XCTUnwrap(CGContext(data: nil, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return Array(UnsafeBufferPointer(start: try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self), count: width * height * 4))
        }
        let beforeOverview = try comparisonPixels(preview.screenshot())
        thumbnail.doubleTap()
        XCTAssertTrue(collapse.waitForExistence(timeout: 5)); XCTAssertTrue(collapse.isHittable)
        XCTAssertGreaterThan(overview.frame.width, thumbnailWidth * 2)
        XCTAssertLessThan(collapse.frame.midX, overview.frame.midX)
        XCTAssertLessThan(collapse.frame.midY, overview.frame.midY)
        let poseSwitch = app.switches["pose-camera-projection-toggle"]
        XCTAssertTrue(poseSwitch.isHittable); XCTAssertEqual(poseSwitch.value as? String, "0")
        let beforeProjection = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        beforeProjection.name = "Global overview before camera overlay"; beforeProjection.lifetime = .keepAlways; add(beforeProjection)
        poseSwitch.tap(); XCTAssertEqual(poseSwitch.value as? String, "1")
        XCTAssertTrue((overview.value as? String)?.contains("相机姿态与投影已显示") == true)
        let afterProjection = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        afterProjection.name = "Global overview with camera overlay"; afterProjection.lifetime = .keepAlways; add(afterProjection)
        let fittedOverview = overview.screenshot().pngRepresentation
        overview.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: overview.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6)))
        let rotatedOverview = overview.screenshot().pngRepresentation
        XCTAssertNotEqual(rotatedOverview, fittedOverview, "the expanded global view rotates independently")
        overview.pinch(withScale: 1.6, velocity: 1)
        XCTAssertNotEqual(overview.screenshot().pngRepresentation, rotatedOverview, "the expanded global view supports pinch zoom")
        let expanded = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        expanded.name = "Expanded interactive global overview"; expanded.lifetime = .keepAlways; add(expanded)
        poseSwitch.tap(); XCTAssertEqual(poseSwitch.value as? String, "0")
        collapse.tap()
        XCTAssertTrue(thumbnail.isHittable)
        let afterOverview = try comparisonPixels(preview.screenshot())
        XCTAssertEqual(afterOverview.count, beforeOverview.count)
        // Recreating the thumbnail can change subpixel antialiasing. Compare
        // rendered pixels with a small tolerance instead of compressed PNG bytes.
        let pixelError = zip(beforeOverview, afterOverview).reduce(0.0) { $0 + Double(abs(Int($1.0) - Int($1.1))) }
            / Double(beforeOverview.count)
        XCTAssertLessThan(pixelError, 0.05, "collapsing returns to the unchanged local Pose view")
        let original = preview.screenshot().pngRepresentation
        preview.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .press(forDuration: 0.1, thenDragTo: preview.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6)))
        XCTAssertNotEqual(preview.screenshot().pngRepresentation, original, "single-finger drag rotates the visible model")
        let rotated = preview.screenshot().pngRepresentation
        preview.pinch(withScale: 1.5, velocity: 1)
        XCTAssertNotEqual(preview.screenshot().pngRepresentation, rotated, "pinch changes the rendered model size")
        image.tap()
        XCTAssertEqual(preview.value as? String, "2D 记录视角图像"); XCTAssertTrue(reset.isEnabled)
        XCTAssertTrue(reset.label.contains("恢复完整画幅"))
        let denseImage = preview.screenshot().pngRepresentation
        quality.adjust(toNormalizedSliderPosition: 0)
        waitForQualityUpdate()
        XCTAssertNotEqual(preview.screenshot().pngRepresentation, denseImage, "2D snapshots also update with display quality")
        let fullImage = preview.screenshot().pngRepresentation
        let initial2D = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        initial2D.name = "Pose 2D before pinch"; initial2D.lifetime = .keepAlways; add(initial2D)
        // XCTest starts with closely spaced touches; a deliberate pinch travels
        // far enough for UIScrollView's native zoom recognizer to engage.
        preview.pinch(withScale: 4, velocity: 1)
        let magnified = preview.screenshot().pngRepresentation
        let zoomed2D = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        zoomed2D.name = "Pose 2D after pinch"; zoomed2D.lifetime = .keepAlways; add(zoomed2D)
        XCTAssertNotEqual(magnified, fullImage, "2D supports pinch-to-zoom")
        preview.swipeLeft()
        let panned = preview.screenshot().pngRepresentation
        XCTAssertNotEqual(panned, magnified, "one-finger dragging moves the magnified image")
        let detail = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        detail.name = "Pose 2D zoomed and panned"; detail.lifetime = .keepAlways; add(detail)
        reset.tap()
        XCTAssertNotEqual(preview.screenshot().pngRepresentation, panned, "fit restores the complete image")
        for orientation: UIDeviceOrientation in [.portrait, .landscapeLeft] {
            XCUIDevice.shared.orientation = orientation
            XCTAssertTrue(image.isHittable); XCTAssertTrue(interactive.isHittable)
            XCTAssertTrue(close.isHittable)
            XCTAssertTrue(quality.isHittable)
            XCTAssertGreaterThanOrEqual(close.frame.minX, reset.frame.maxX)
            XCTAssertEqual(close.frame.midY, reset.frame.midY, accuracy: 2)
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "Pose 2D image \(orientation.isLandscape ? "landscape" : "portrait")"
            screenshot.lifetime = .keepAlways; add(screenshot)
        }
        interactive.tap(); XCTAssertEqual(preview.value as? String, "3D 交互视图")
        reset.tap()
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "review-pose-"))
        XCTAssertGreaterThanOrEqual(rows.count, 2)
        let firstLabel = preview.label
        image.tap(); rows.element(boundBy: 1).tap()
        XCTAssertNotEqual(preview.label, firstLabel)
        XCTAssertEqual(preview.value as? String, "2D 记录视角图像")
        interactive.tap(); XCTAssertTrue(reset.isEnabled)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Interactive Pose point cloud"; screenshot.lifetime = .keepAlways; add(screenshot)
        thumbnail.doubleTap(); XCTAssertTrue(poseSwitch.waitForExistence(timeout: 5)); poseSwitch.tap()
        rows.element(boundBy: 0).tap()
        XCTAssertEqual(poseSwitch.value as? String, "1", "switching Pose keeps its camera visible")
        for orientation: UIDeviceOrientation in [.portrait, .landscapeLeft] {
            XCUIDevice.shared.orientation = orientation
            XCTAssertTrue(poseSwitch.isHittable); XCTAssertTrue(collapse.isHittable)
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "Pose camera projection \(orientation.isLandscape ? "landscape" : "portrait")"
            shot.lifetime = .keepAlways; add(shot)
        }
        collapse.tap(); XCTAssertTrue((thumbnail.value as? String)?.contains("相机姿态与投影已显示") == true)
        app.buttons["close-pose-review"].tap()
        XCTAssertTrue(review.waitForExistence(timeout: 10))
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.swipeLeft(); app.buttons["swipe-delete-local-project-\(fixtureID)"].tap()
        app.buttons["confirm-delete-local-project"].firstMatch.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: project)], timeout: 10), .completed)
    }

    func testFullScreenPoseReviewLayoutEditingAndReturn() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_REVIEW_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project with at least two Poses for full-screen review testing")
        }
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let aid = app.switches["ground-assistance"]
        XCTAssertTrue(aid.waitForExistence(timeout: 30)); aid.tap()
        let place = app.buttons["place-model"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)], timeout: 30), .completed)
        app.otherElements["teaching-render-surface"].coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7)).tap()
        expectAutomaticPlacement(app)
        let capture = app.buttons["capture-pose"]
        XCTAssertTrue(capture.isEnabled)
        app.buttons["review-poses"].tap()
        let page = app.otherElements["pose-review-page"], viewport = app.otherElements["pose-review-viewport"]
        let preview = app.otherElements["pose-review-preview"], close = app.buttons["close-pose-review"]
        XCTAssertTrue(close.waitForExistence(timeout: 10)); XCTAssertTrue(page.exists)
        func checkFullScreen(_ orientation: UIDeviceOrientation) {
            XCUIDevice.shared.orientation = orientation
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let frame = app.windows.firstMatch.frame
                return orientation.isLandscape ? frame.width > frame.height : frame.height > frame.width
            }, object: nil)], timeout: 10), .completed)
            let window = app.windows.firstMatch.frame
            XCTAssertEqual(page.frame.width, window.width, accuracy: 2, "review must use the full app width")
            XCTAssertGreaterThan(page.frame.height, window.height * 0.8, "review must fill the screen below its toolbar")
            XCTAssertTrue(window.contains(close.frame)); XCTAssertTrue(close.isHittable)
            XCTAssertTrue(preview.exists); XCTAssertGreaterThan(preview.frame.width, 300)
            if orientation.isLandscape {
                XCTAssertGreaterThan(viewport.frame.width, window.width * 0.7)
                XCTAssertGreaterThan(viewport.frame.height, window.height * 0.8)
            } else {
                XCTAssertEqual(viewport.frame.width, window.width, accuracy: 2, "portrait preview spans the whole row")
            }
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "Full-screen Pose review \(orientation.isLandscape ? "landscape" : "portrait")"
            screenshot.lifetime = .keepAlways; add(screenshot)
        }
        checkFullScreen(.portrait)
        let name = app.textFields["review-pose-name"]
        XCTAssertTrue(name.exists); name.tap()
        let priorName = name.value as? String ?? ""
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: priorName.count) + "Review renamed Pose")
        XCTAssertEqual(name.value as? String, "Review renamed Pose")
        app.buttons["save-pose-name"].tap()
        let renamed = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "review-pose-", "Review renamed Pose")).firstMatch
        XCTAssertTrue(renamed.exists, "rename updates the list without leaving review")
        checkFullScreen(.landscapeLeft)
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "review-pose-"))
        XCTAssertGreaterThanOrEqual(rows.count, 2)
        let secondID = rows.element(boundBy: 1).identifier
        app.buttons[secondID].tap()
        XCTAssertFalse(preview.label.contains("Review renamed Pose"), "selecting another Pose changes the preview")
        app.buttons["select-poses"].tap()
        app.buttons[secondID].tap()
        app.buttons["delete-selected-poses"].tap()
        XCTAssertFalse(app.buttons[secondID].exists, "delete updates the list immediately")
        XCTAssertTrue(renamed.exists)
        close.tap()
        XCTAssertTrue(capture.waitForExistence(timeout: 10))
        XCTAssertTrue(capture.isEnabled, "returning from full-screen review must preserve calibration and rendering")
        XCTAssertTrue(app.buttons["adjust-model-placement"].exists)
        app.buttons["review-poses"].tap()
        XCTAssertTrue(close.waitForExistence(timeout: 10)); XCTAssertTrue(renamed.exists)
        XCTAssertFalse(app.buttons[secondID].exists, "edits survive closing and reopening review")
        close.tap()
        XCTAssertTrue(capture.isEnabled)
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testFullScreenPoseReviewBackgroundRequiresRecalibration() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_REVIEW_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable Pose review fixture for the hardware lifecycle test")
        }
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let aid = app.switches["ground-assistance"]
        XCTAssertTrue(aid.waitForExistence(timeout: 30)); aid.tap()
        let place = app.buttons["place-model"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)], timeout: 30), .completed)
        app.otherElements["teaching-render-surface"].coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7)).tap()
        expectAutomaticPlacement(app)
        XCTAssertTrue(app.buttons["capture-pose"].isEnabled)
        app.buttons["review-poses"].tap()
        let close = app.buttons["close-pose-review"]
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(close.waitForExistence(timeout: 10))
        XCTAssertTrue(app.otherElements["pose-review-preview"].exists)
        close.tap()
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled, "backgrounding during review still requires recalibration")
        XCTAssertTrue(place.waitForExistence(timeout: 10))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)], timeout: 30), .completed,
            "the live camera must resume so the user can recalibrate")
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testNearbyPoseConfirmationOnDevice() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_PROXIMITY_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable empty fixture for the Pose proximity hardware test")
        }
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication(); app.launch()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.windows.firstMatch.frame.height > app.windows.firstMatch.frame.width
        }, object: nil)], timeout: 10), .completed)
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let aid = app.switches["ground-assistance"]
        XCTAssertTrue(aid.waitForExistence(timeout: 15)); aid.tap()
        let place = app.buttons["place-model"]
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)], timeout: 30), .completed)
        app.otherElements["teaching-render-surface"].coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7)).tap()
        expectAutomaticPlacement(app)
        let capture = app.buttons["capture-pose"], alert = app.alerts["当前 Pose 与上一个距离很近"]
        XCTAssertTrue(capture.isEnabled); capture.tap()
        XCTAssertFalse(alert.exists, "the first Pose must record directly")
        app.buttons["collapse-teaching-panel"].tap()
        let count = app.staticTexts["floating-pose-count"]
        XCTAssertEqual(count.label, "1 个 Pose")
        capture.tap(); XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCTAssertTrue(alert.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "小于 10 cm")).firstMatch.exists)
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Nearby Pose distance confirmation"; screenshot.lifetime = .keepAlways; add(screenshot)
        alert.buttons["取消"].tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: alert)], timeout: 5), .completed)
        XCTAssertEqual(count.label, "1 个 Pose", "cancel does not append a Pose")
        capture.tap(); XCTAssertTrue(alert.waitForExistence(timeout: 5)); alert.buttons["仍然记录"].tap()
        XCTAssertEqual(count.label, "2 个 Pose", "confirmation appends exactly one Pose")

        app.buttons["expand-teaching-panel"].tap()
        capture.tap(); XCTAssertTrue(alert.waitForExistence(timeout: 5)); alert.buttons["取消"].tap()
        capture.tap(); XCTAssertTrue(alert.waitForExistence(timeout: 5)); alert.buttons["仍然记录"].tap()
        app.buttons["collapse-teaching-panel"].tap()
        XCTAssertEqual(count.label, "3 个 Pose", "expanded and collapsed buttons share the same confirmation")
        capture.tap(); XCTAssertTrue(alert.waitForExistence(timeout: 5))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(capture.waitForExistence(timeout: 10))
        XCTAssertFalse(alert.exists, "backgrounding discards an unconfirmed capture")
        XCTAssertFalse(capture.isEnabled, "resume still requires recalibration")
        XCTAssertEqual(count.label, "3 个 Pose")
        app.buttons["expand-teaching-panel"].tap()
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testFrozenPoseCommitRequiresCurrentCalibrationAndAcceptedSave() throws {
        let ar = ARController()
        var calibrations: [Calibration] = [], accepted: [TeachingSample] = []
        ar.onCalibration = { calibrations.append($0) }
        ar.onSample = { sample in
            guard !accepted.contains(where: { $0.id == sample.id }) else { return false }
            accepted.append(sample); return true
        }
        ar.trackingNormal = true
        ar.applyPlacement(at: SIMD3(0, -1, -2))
        let calibration = try XCTUnwrap(calibrations.last)
        let sample = TeachingSample(segmentId: calibration.id, kind: "keyframe",
            cameraPose: CameraPose(position: Point3(SIMD3(0.03, 0.04, 0)), quaternion: Rotation4(simd_quatf())),
            surfacePoint: Point3(SIMD3(1, 2, 3)), previewCameraTransform: matrix_identity_float4x4.elements,
            previewProjection: matrix_identity_float4x4.elements, previewAspect: 4.0 / 3.0)
        let previous = TeachingSample(segmentId: calibration.id, kind: "keyframe",
            cameraPose: CameraPose(position: Point3(.zero), quaternion: Rotation4(simd_quatf())))
        let confirmation = try XCTUnwrap(NearbyPoseConfirmation(sample: sample, previousSample: previous))
        XCTAssertTrue(accepted.isEmpty, "preparing an alert cannot save a sample")
        let model = try XCTUnwrap(ar.view.scene.rootNode.childNode(withName: "independent-teaching-object", recursively: true))
        let root = try XCTUnwrap(model.parent)
        let markerRoot = try XCTUnwrap(root.childNodes.first { $0 !== model && $0.name != "virtual-origin-axes" })
        XCTAssertTrue(markerRoot.childNodes.isEmpty, "pending/cancelled poses have no marker")
        root.simdPosition += SIMD3(0.5, 0, 0)
        ar.recordKeyframe(confirmation.sample)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(try encoder.encode(accepted.first), try encoder.encode(Optional(sample)),
            "a later AR transform must not change the captured pose or preview")
        XCTAssertEqual(markerRoot.childNodes.count, 1)
        ar.recordKeyframe(confirmation.sample)
        XCTAssertEqual(accepted.count, 1); XCTAssertEqual(markerRoot.childNodes.count, 1, "rejected saves add no duplicate marker")

        var next = sample; next.id = UUID().uuidString
        ar.trackingNormal = false; ar.recordKeyframe(next)
        XCTAssertEqual(accepted.count, 1, "tracking loss blocks a pending confirmation")
        ar.trackingNormal = true; ar.beginPlacementAdjustment(); ar.recordKeyframe(next)
        XCTAssertEqual(accepted.count, 1, "placement adjustment blocks recording")
        ar.confirmCalibration(); ar.recordKeyframe(next)
        XCTAssertEqual(accepted.count, 1, "recalibration invalidates the old sample")
        next.segmentId = try XCTUnwrap(calibrations.last?.id)
        ar.onSample = { _ in false }; ar.recordKeyframe(next)
        XCTAssertEqual(markerRoot.childNodes.count, 1, "a failed save cannot show a recorded marker")
        ar.onSample = { accepted.append($0); return true }
        ar.suspend(); ar.recordKeyframe(next)
        XCTAssertEqual(accepted.count, 1, "suspension invalidates a pending sample")
    }

    func testInitialPlacementAutomaticallyCalibratesAfterTapOrDrag() throws {
        let ar = ARController()
        var calibrations: [Calibration] = [], poseWrites = 0
        ar.onCalibration = { calibrations.append($0) }
        ar.onSample = { _ in poseWrites += 1; return true }
        let first = SIMD3<Float>(0.2, -1, -2), last = SIMD3<Float>(0.8, -1, -3)
        ar.applyPlacement(at: first)
        XCTAssertFalse(ar.placed); XCTAssertTrue(calibrations.isEmpty, "tracking is required")
        ar.trackingNormal = true
        ar.placeObject() // No measured surface/camera frame in this isolated test.
        ar.applyPlacement(at: SIMD3(.nan, -1, -2))
        XCTAssertFalse(ar.calibrated); XCTAssertTrue(calibrations.isEmpty)

        ar.yaw = 35; ar.pitch = 12; ar.roll = -8
        ar.applyPlacement(at: first)
        XCTAssertTrue(ar.calibrated, "a valid tap/button placement enters teaching immediately")
        XCTAssertEqual(calibrations.count, 1)
        XCTAssertEqual(calibrations[0].yawDegrees, 35)
        XCTAssertEqual(calibrations[0].pitchDegrees, 12)
        XCTAssertEqual(calibrations[0].rollDegrees, -8)
        ar.confirmCalibration(); ar.applyPlacement(at: last)
        XCTAssertEqual(calibrations.count, 1, "duplicate events cannot recalibrate a locked model")

        ar.suspend(); ar.trackingNormal = true
        ar.beginPlacementDrag(); ar.applyPlacement(at: first); ar.applyPlacement(at: last)
        let root = try XCTUnwrap(ar.view.scene.rootNode.childNode(withName: "independent-teaching-object", recursively: true)?.parent)
        XCTAssertTrue(ar.placed); XCTAssertFalse(ar.calibrated)
        ar.confirmCalibration()
        XCTAssertEqual(calibrations.count, 1, "drag updates must not commit or hide the ground before release")
        let finalTransform = root.simdTransform.elements
        ar.finishPlacementDrag(); ar.finishPlacementDrag()
        XCTAssertTrue(ar.calibrated); XCTAssertEqual(calibrations.count, 2)
        XCTAssertEqual(calibrations[1].worldFromModel, finalTransform, "release commits the last valid drag target once")

        ar.beginPlacementAdjustment()
        ar.beginPlacementDrag(); ar.applyPlacement(at: first); ar.finishPlacementDrag()
        XCTAssertTrue(ar.adjustingPlacement); XCTAssertFalse(ar.calibrated)
        XCTAssertEqual(calibrations.count, 2, "editing still allows multiple moves before Finish")
        ar.cancelPlacementAdjustment()
        XCTAssertTrue(ar.calibrated); XCTAssertEqual(root.simdTransform.elements, finalTransform)
        XCTAssertEqual(calibrations.count, 2)

        for cancelled in [true, false] {
            ar.suspend(); ar.trackingNormal = true
            ar.beginPlacementDrag(); ar.applyPlacement(at: first)
            if !cancelled { ar.trackingNormal = false }
            ar.finishPlacementDrag(cancelled: cancelled)
            XCTAssertFalse(ar.placed); XCTAssertFalse(ar.calibrated); XCTAssertTrue(root.isHidden)
            XCTAssertEqual(calibrations.count, 2, "cancelled or untracked drags cannot leave a pending confirmation")
        }
        ar.trackingNormal = true
        ar.beginPlacementDrag(); ar.applyPlacement(at: first); ar.suspend(); ar.finishPlacementDrag()
        XCTAssertFalse(ar.calibrated); XCTAssertFalse(ar.placed)
        XCTAssertEqual(calibrations.count, 2, "backgrounding discards the pending drag")
        XCTAssertEqual(poseWrites, 0, "placing a model never records a Pose")
    }

    func testAdjustingCalibratedPlacementCanCommitOrCancel() {
        let ar = ARController()
        var calibrations: [Calibration] = []
        ar.onCalibration = { calibrations.append($0) }
        ar.trackingNormal = true
        ar.referenceX = 2; ar.referenceY = 3; ar.referenceZ = 0.5
        ar.yaw = 42; ar.roll = 30; ar.pitch = -25
        ar.applyPlacement(at: SIMD3(0.3, -1, -2))
        XCTAssertTrue(ar.calibrated); XCTAssertEqual(calibrations.count, 1)
        let root = ar.view.scene.rootNode.childNode(withName: "independent-teaching-object", recursively: true)!.parent!
        root.simdOrientation = simd_quatf(angle: 0.03, axis: SIMD3(0, 1, 0)) * root.simdOrientation
        root.simdPosition += SIMD3(0.02, 0.01, -0.01)
        let original = root.simdTransform

        ar.beginPlacementAdjustment()
        XCTAssertTrue(ar.adjustingPlacement); XCTAssertFalse(ar.calibrated); XCTAssertFalse(root.isHidden)
        XCTAssertEqual(root.simdTransform.elements, original.elements, "unlocking must not move the model")
        ar.yaw = 70; ar.roll = 10; ar.pitch = 15; ar.referenceX = 1
        ar.applyPlacement(at: SIMD3(1.2, -1, -3))
        XCTAssertTrue(ar.adjustingPlacement, "a new hit is still a draft until confirmed")
        ar.beginRepositioning()
        ar.confirmCalibration()
        XCTAssertEqual(calibrations.count, 1, "selection cannot commit the hidden old placement")
        ar.cancelPlacementAdjustment()
        XCTAssertFalse(ar.adjustingPlacement); XCTAssertFalse(ar.repositioning); XCTAssertTrue(ar.calibrated)
        XCTAssertFalse(root.isHidden); XCTAssertEqual(root.simdTransform.elements, original.elements)
        XCTAssertEqual(ar.yaw, 42); XCTAssertEqual(ar.roll, 30); XCTAssertEqual(ar.pitch, -25)
        XCTAssertEqual(ar.referenceX, 2); XCTAssertEqual(calibrations.count, 1, "cancel adds no calibration")

        ar.beginPlacementAdjustment()
        let hit = SIMD3<Float>(0.8, -1, -3)
        ar.applyPlacement(at: hit)
        let rotation = root.simdTransform
        for column in 0..<3 {
            for row in 0..<3 { XCTAssertEqual(rotation[column][row], original[column][row], accuracy: 0.00001) }
        }
        let reference = rotation * SIMD4<Float>(2, 3, 0.5, 1)
        XCTAssertEqual(reference.x, hit.x, accuracy: 0.00001)
        XCTAssertEqual(reference.y, hit.y, accuracy: 0.00001)
        XCTAssertEqual(reference.z, hit.z, accuracy: 0.00001)
        ar.confirmCalibration()
        XCTAssertTrue(ar.calibrated); XCTAssertFalse(ar.adjustingPlacement)
        XCTAssertEqual(calibrations.count, 2); XCTAssertNotEqual(calibrations[0].id, calibrations[1].id)
        XCTAssertEqual(calibrations[1].worldFromModel, root.simdTransform.elements)
        ar.beginPlacementAdjustment(); ar.suspend(); ar.cancelPlacementAdjustment()
        XCTAssertFalse(ar.calibrated); XCTAssertFalse(ar.adjustingPlacement); XCTAssertFalse(ar.placed)
        XCTAssertTrue(root.isHidden, "cancellation cannot restore an anchor after the AR session is lost")
    }

    func testAutomaticPlacementFromButtonAndDrag() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"], UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project for automatic placement testing")
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        for useDrag in [false, true] {
            XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
            let aid = app.switches["ground-assistance"], place = app.buttons["place-model"]
            XCTAssertTrue(aid.waitForExistence(timeout: 15)); aid.tap()
            XCTAssertFalse(app.buttons["confirm-model-calibration"].exists)
            XCTAssertFalse(app.buttons["capture-pose"].isEnabled)
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "enabled == true"), object: place)], timeout: 30), .completed)
            if useDrag {
                let surface = app.otherElements["teaching-render-surface"]
                let start = surface.coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7))
                start.press(forDuration: 0.05,
                    thenDragTo: surface.coordinate(withNormalizedOffset: CGVector(dx: 0.57, dy: 0.73)),
                    withVelocity: .slow, thenHoldForDuration: 0.2)
            } else {
                // Tracking can become normal before LiDAR has a reliable hit
                // at the reticle. Retry failed hits while depth data warms up.
                for _ in 0..<6 {
                    guard place.exists, place.isEnabled else { break }
                    place.tap()
                    let captured = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"),
                        object: app.buttons["capture-pose"])
                    if XCTWaiter.wait(for: [captured], timeout: 2) == .completed { break }
                }
            }
            expectAutomaticPlacement(app)
            XCTAssertFalse(aid.exists, "ground controls disappear after automatic placement")
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = useDrag ? "Teaching immediately after placement drag" : "Teaching immediately after Place button"
            screenshot.lifetime = .keepAlways; add(screenshot)
            app.buttons["本地项目"].tap()
        }
    }

    func testAdjustPlacementWhileTeachingWithoutLeavingPage() throws {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        // Deliberately never fall back to the user's project: this test records
        // Poses, and requires a disposable copy installed for hardware testing.
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"], UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project for placement adjustment testing")
        }
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()
        let aid = app.switches["ground-assistance"], surface = app.otherElements["teaching-render-surface"]
        XCTAssertTrue(aid.waitForExistence(timeout: 15)); aid.tap()
        let place = app.buttons["place-model"], finish = app.buttons["finish-placement-adjustment"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7)).tap()
        expectAutomaticPlacement(app)
        let adjust = app.buttons["adjust-model-placement"], capture = app.buttons["capture-pose"]
        XCTAssertTrue(adjust.waitForExistence(timeout: 5)); XCTAssertTrue(adjust.isHittable)
        func recordPose() {
            capture.tap()
            let nearby = app.alerts["当前 Pose 与上一个距离很近"]
            if nearby.waitForExistence(timeout: 1) { nearby.buttons["仍然记录"].tap() }
        }
        recordPose() // First Pose at the original confirmed placement.
        app.buttons["collapse-teaching-panel"].tap()
        XCTAssertTrue(adjust.isHittable)
        let initialCount = app.staticTexts["floating-pose-count"].label
        let originalFrame = surface.frame
        adjust.tap()
        let cancel = app.buttons["cancel-placement-adjustment"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        XCTAssertEqual(finish.label, "完成调整")
        XCTAssertFalse(capture.exists, "pose capture is replaced by finish/cancel controls during editing")
        XCTAssertEqual(surface.frame, originalFrame, "editing does not resize the camera")
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.58, dy: 0.74)).tap()
        XCTAssertEqual(app.staticTexts["floating-pose-count"].label, initialCount)
        finish.tap()
        XCTAssertTrue(adjust.waitForExistence(timeout: 5)); XCTAssertTrue(capture.isEnabled)
        recordPose() // Second Pose must use the new calibration segment.
        let countAfterMove = app.staticTexts["floating-pose-count"].label
        XCTAssertNotEqual(countAfterMove, initialCount)

        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            adjust.tap()
            XCTAssertTrue(cancel.waitForExistence(timeout: 5)); XCTAssertTrue(finish.isHittable)
            XCTAssertTrue(app.windows.firstMatch.frame.contains(cancel.frame))
            if orientation.isLandscape {
                surface.coordinate(withNormalizedOffset: CGVector(dx: 0.46, dy: 0.68)).tap()
            }
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "Adjust placement during teaching \(orientation.rawValue)"; screenshot.lifetime = .keepAlways; add(screenshot)
            cancel.tap()
            XCTAssertTrue(adjust.waitForExistence(timeout: 5)); XCTAssertTrue(capture.isEnabled)
            XCTAssertEqual(app.staticTexts["floating-pose-count"].label, countAfterMove)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        recordPose() // Cancellation resumes the second calibration segment.
        app.buttons["expand-teaching-panel"].tap()
        XCTAssertTrue(adjust.isHittable, "the expanded panel has a fixed, visible adjustment entry")
        adjust.tap()
        XCTAssertTrue(cancel.waitForExistence(timeout: 5)); XCTAssertTrue(finish.isHittable)
        cancel.tap()
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    func testRepositioningRetainsPlacementUntilValidTarget() {
        let ar = ARController()
        var calibrationWrites = 0, poseWrites = 0
        ar.onCalibration = { _ in calibrationWrites += 1 }
        ar.onSample = { _ in poseWrites += 1; return true }
        ar.trackingNormal = true
        ar.referenceX = 2; ar.referenceY = 3; ar.referenceZ = 0.5
        ar.yaw = 42; ar.roll = 30; ar.pitch = -25
        let oldHit = SIMD3<Float>(0.3, -1, -2), newHit = SIMD3<Float>(0.8, -1, -3)
        ar.applyPlacement(at: oldHit)
        let root = ar.view.scene.rootNode.childNode(withName: "independent-teaching-object", recursively: true)!.parent!
        // AR can refine a confirmed anchor before the user unlocks calibration.
        // Cancellation must retain that actual transform, not the original hit.
        root.simdPosition += SIMD3(0.02, 0.01, -0.01)
        let original = root.simdTransform
        ar.beginPlacementAdjustment()
        XCTAssertFalse(ar.groundTargetAvailable)
        XCTAssertTrue(ar.placementActionEnabled, "an existing model can be repositioned even when the center misses the floor")

        ar.trackingNormal = false
        XCTAssertTrue(ar.placementActionEnabled, "entering selection does not move the model or require a tracked hit")
        ar.beginRepositioning()
        XCTAssertTrue(ar.repositioning); XCTAssertTrue(root.isHidden)
        XCTAssertFalse(ar.placementActionEnabled, "committing a target still needs normal tracking")
        ar.applyPlacement(at: newHit)
        XCTAssertTrue(ar.repositioning)
        XCTAssertEqual(root.simdTransform.elements, original.elements)
        ar.trackingNormal = true
        ar.applyPlacement(at: SIMD3(.nan, -1, -2))
        ar.placeObject() // No camera frame/ground hit in this isolated controller.
        ar.confirmCalibration(); XCTAssertNil(ar.captureKeyframe())
        XCTAssertTrue(ar.repositioning); XCTAssertFalse(ar.calibrated)
        XCTAssertFalse(ar.placementActionEnabled, "no observed floor means no placement at the center")
        ar.cancelRepositioning()
        XCTAssertFalse(ar.repositioning); XCTAssertFalse(root.isHidden)
        XCTAssertEqual(root.simdTransform.elements, original.elements, "cancel restores the exact previous placement")
        XCTAssertTrue(ar.placementActionEnabled)

        ar.beginRepositioning()
        ar.updatePlacement()
        XCTAssertTrue(root.isHidden, "UI refreshes cannot reveal the old model while selecting")
        ar.applyPlacement(at: newHit)
        XCTAssertFalse(ar.repositioning); XCTAssertFalse(root.isHidden)
        let expected = TeachingCoordinates.placement(hit: newHit, reference: SIMD3(2, 3, 0.5), yaw: 42, roll: 30, pitch: -25)
        for column in 0..<4 {
            for row in 0..<4 { XCTAssertEqual(root.simdTransform[column][row], expected[column][row], accuracy: 0.00001) }
        }
        XCTAssertNotEqual(root.simdTransform.elements, original.elements, "a valid second hit really moves the model")
        XCTAssertEqual(ar.yaw, 42); XCTAssertEqual(ar.roll, 30); XCTAssertEqual(ar.pitch, -25)
        ar.confirmCalibration()
        ar.beginRepositioning(); ar.applyPlacement(at: oldHit)
        XCTAssertFalse(ar.repositioning); XCTAssertFalse(ar.placementActionEnabled)
        for column in 0..<4 {
            for row in 0..<4 { XCTAssertEqual(root.simdTransform[column][row], expected[column][row], accuracy: 0.00001) }
        }
        ar.beginCalibration(); ar.beginRepositioning(); ar.suspend()
        XCTAssertFalse(ar.placed); XCTAssertFalse(ar.repositioning); XCTAssertTrue(root.isHidden)
        XCTAssertEqual(calibrationWrites, 2); XCTAssertEqual(poseWrites, 0)
    }

    func testLiveModelRepositioningAndCancel() throws {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"], UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project for automatic placement testing")
        }
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()
        let aid = app.switches["ground-assistance"], place = app.buttons["place-model"]
        XCTAssertTrue(aid.waitForExistence(timeout: 15))
        // Use measured depth for a repeatable live placement; then enable floor
        // assistance to verify that re-entering selection is never floor-gated.
        aid.tap()
        let tracked = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)
        XCTAssertEqual(XCTWaiter.wait(for: [tracked], timeout: 30), .completed)
        let surface = app.otherElements["teaching-render-surface"]
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.48, dy: 0.7)).tap()
        expectAutomaticPlacement(app)
        app.buttons["adjust-model-placement"].tap()
        let finish = app.buttons["finish-placement-adjustment"]
        XCTAssertTrue(finish.waitForExistence(timeout: 5))
        XCTAssertEqual(place.label, "重新放置物体")
        aid.tap()
        XCTAssertTrue(place.isEnabled)
        place.tap()
        let cancel = app.buttons["cancel-model-repositioning"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        XCTAssertEqual(place.label, "放到准星位置")
        XCTAssertFalse(finish.isEnabled)
        XCTAssertFalse(app.buttons["capture-pose"].exists, "adjustment hides the recording control")
        XCTAssertNotEqual(app.staticTexts["spatial-level-angle"].label, "—", "device attitude remains available during model relocation")
        cancel.tap()
        XCTAssertFalse(cancel.exists); XCTAssertTrue(finish.isEnabled); XCTAssertTrue(place.isEnabled)
        XCTAssertEqual(place.label, "重新放置物体")
        let restored = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        restored.name = "Cancel relocation restores the existing model"; restored.lifetime = .keepAlways; add(restored)

        place.tap()
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        aid.tap()
        XCTAssertTrue(place.isEnabled)
        place.tap()
        // The center may be a reflective/distant surface. A rejected hit must
        // retain selection; a successful hit may be followed by another move.
        if !cancel.exists { place.tap() }
        XCTAssertTrue(cancel.waitForExistence(timeout: 5))
        surface.coordinate(withNormalizedOffset: CGVector(dx: 0.58, dy: 0.74)).tap()
        XCTAssertFalse(cancel.exists, "scene taps must pass through the toolbar's transparent area")
        XCTAssertTrue(finish.isEnabled)
        XCTAssertEqual(place.label, "重新放置物体")
        let moved = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        moved.name = "Model placed again from measured depth"; moved.lifetime = .keepAlways; add(moved)
        XCTAssertFalse(app.buttons["capture-pose"].exists, "recording resumes only after finishing or cancelling adjustment")
        app.buttons["cancel-placement-adjustment"].tap() // Preserve the initial placement; no Pose writes.
        app.buttons["本地项目"].tap()
    }

    func testMixedPoseOriginsInDraftAndCompletedReview() throws {
        let ids = (ProcessInfo.processInfo.environment["ATLAS_POSE_ORIGIN_FIXTURE_IDS"] ?? "").split(separator: ",").map(String.init)
        guard ids.count == 2, ids.allSatisfy({ UUID(uuidString: $0) != nil }) else {
            throw XCTSkip("Provide two disposable UI-Pose-Origins projects, draft then completed")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        func shot(_ name: String) {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        for (index, id) in ids.enumerated() {
            let row = app.buttons["local-project-\(id)"]
            XCTAssertTrue(row.waitForExistence(timeout: 15)); XCTAssertTrue(row.label.contains("UI-Pose-Origins"))
            row.tap()
            let review = app.buttons["review-poses"]
            XCTAssertTrue(review.waitForExistence(timeout: 30))
            for category in ["leftArm", "rightArm", "ipad"] {
                let count = app.descendants(matching: .any).matching(identifier: "pose-count-\(category)").firstMatch
                XCTAssertTrue(count.exists && count.label.contains("1 个 Pose"), count.label)
            }
            if index == 1 {
                for _ in 0..<3 {
                    app.sliders["teaching-coverage-opacity"].adjust(toNormalizedSliderPosition: 1)
                    if app.staticTexts["teaching-coverage-opacity-value"].label == "100%" { break }
                }
                let progress = app.staticTexts["teaching-coverage-percentage"]
                let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    progress.exists && progress.label.contains("%") && progress.label != "0%"
                }, object: nil)
                XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
            }
            shot(index == 0 ? "Draft arm counts and palette" : "Completed cyan gold and purple coverage")
            review.tap()
            let mac = app.buttons["review-pose-mac-fixture"], right = app.buttons["review-pose-mac-right-fixture"], ipad = app.buttons["review-pose-ipad-fixture"]
            XCTAssertTrue(mac.waitForExistence(timeout: 10))
            XCTAssertTrue(mac.label.contains("Mac 左臂")); XCTAssertTrue(right.label.contains("Mac 右臂")); XCTAssertTrue(ipad.label.contains("iPad 示教"))
            for (button, label) in [(mac, "Mac 左臂"), (right, "Mac 右臂"), (ipad, "iPad 示教")] {
                button.tap()
                let badge = app.descendants(matching: .any).matching(identifier: "pose-selected-origin").firstMatch
                XCTAssertTrue(badge.waitForExistence(timeout: 5)); XCTAssertTrue(badge.label.contains(label))
                RunLoop.current.run(until: Date().addingTimeInterval(1))
                shot("\(index == 0 ? "Draft" : "Completed") review \(label)")
            }
            app.buttons["close-pose-review"].tap(); app.buttons["本地项目"].tap()
        }
        // Delete only the explicit temporary fixtures after inspecting both workflows.
        for id in ids {
            let row = app.buttons["local-project-\(id)"]
            XCTAssertTrue(row.label.contains("UI-Pose-Origins"))
            row.swipeLeft(); app.buttons["swipe-delete-local-project-\(id)"].tap()
            app.buttons["confirm-delete-local-project"].firstMatch.tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: row)], timeout: 10), .completed)
        }
    }

    func testStoredMacArmPoseCounts() throws {
        guard let id = ProcessInfo.processInfo.environment["ATLAS_ARM_PROJECT_ID"], UUID(uuidString: id) != nil else {
            throw XCTSkip("Provide a downloaded project with three Mac Poses per arm for read-only verification")
        }
        let total = Int(ProcessInfo.processInfo.environment["ATLAS_ARM_PROJECT_POSE_COUNT"] ?? "6") ?? 6
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(id)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); XCTAssertTrue(project.label.contains("\(total) 个 Pose"))
        XCTAssertTrue(project.label.contains("左臂 3 · 右臂 3")); project.tap()
        let review = app.buttons["review-poses"]
        XCTAssertTrue(review.waitForExistence(timeout: 30))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            app.staticTexts["teaching-coverage-percentage"].label.contains("%")
                && !app.descendants(matching: .any).matching(identifier: "teaching-coverage-progress").firstMatch.exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
        func groupLabels() -> [String: String] {
            var labels: [String: String] = [:]
            for (category, expected) in [("leftArm", 3), ("rightArm", 3), ("ipad", total - 6)] {
                let row = app.descendants(matching: .any).matching(identifier: "pose-count-\(category)").firstMatch
                XCTAssertTrue(row.exists && row.label.contains("\(expected) 个 Pose"), row.label)
                XCTAssertTrue(row.label.contains("表面覆盖率") && row.label.contains("%"), row.label)
                XCTAssertLessThanOrEqual(row.frame.maxX, app.windows.firstMatch.frame.maxX)
                labels[category] = row.label
            }
            return labels
        }
        let initialLabels = groupLabels()
        let initialShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        initialShot.name = "Stored project — per-group coverage"; initialShot.lifetime = .keepAlways; add(initialShot)
        review.tap()
        XCTAssertEqual(app.staticTexts["pose-review-count"].label, "\(total) 个 Pose")
        XCTAssertEqual(groupLabels(), initialLabels, "review and teaching show the same category coverage")
        for (sample, label) in [("mac-1", "Mac 左臂"), ("mac-2", "Mac 右臂")] {
            let row = app.buttons["review-pose-\(sample)"]
            XCTAssertTrue(row.waitForExistence(timeout: 10)); XCTAssertTrue(row.label.contains(label)); row.tap()
            let badge = app.descendants(matching: .any).matching(identifier: "pose-selected-origin").firstMatch
            XCTAssertTrue(badge.label.contains(label))
            let percentage = app.staticTexts["pose-selected-coverage-percentage"]
            XCTAssertTrue(percentage.waitForExistence(timeout: 10))
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label CONTAINS %@", "%"), object: percentage)], timeout: 20), .completed)
            let details = app.descendants(matching: .any).matching(identifier: "pose-review-details").firstMatch
            XCTAssertTrue(details.frame.contains(percentage.frame) && percentage.isHittable,
                          "selected Pose coverage fits in the details panel")
            XCTAssertFalse(app.staticTexts["本次示教已完成。可通过上方「多选」在副本中批量删除。"].exists)
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "Stored project — \(label)"; shot.lifetime = .keepAlways; add(shot)
        }
        app.buttons["close-pose-review"].tap(); app.buttons["本地项目"].tap()
    }

    func testStoredProjectSurfaceCoverageAndFullOpacity() throws {
        guard let id = ProcessInfo.processInfo.environment["ATLAS_COVERAGE_PROJECT_ID"] else {
            throw XCTSkip("Provide a completed project whose latest Pose covers the visible model")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launch()
        let project = app.buttons["local-project-\(id)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let toggle = app.switches["teaching-coverage-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 15))
        let preview = app.descendants(matching: .any).matching(identifier: "teaching-model-preview").firstMatch
        XCTAssertTrue(preview.waitForExistence(timeout: 10), app.debugDescription)
        func assertPreviewBounds(panelExpanded: Bool) {
            let window = app.windows.firstMatch.frame
            XCTAssertEqual(preview.frame.minX, window.minX, accuracy: 1)
            XCTAssertEqual(preview.frame.width, window.width - (panelExpanded ? 340 : 0), accuracy: 1,
                           "the free preview must use the visible canvas, never the area behind the sidebar")
            if panelExpanded {
                XCTAssertEqual(preview.frame.maxX, app.scrollViews.firstMatch.frame.minX, accuracy: 1)
            }
            XCTAssertFalse(app.switches["zivid-fov-toggle"].exists)
            XCTAssertFalse(app.otherElements["zivid-fov-aperture"].exists,
                           "a free camera preview must not apply the recording viewfinder")
        }
        assertPreviewBounds(panelExpanded: true)
        let status = app.staticTexts["teaching-coverage-status"]
        let percentage = app.staticTexts["teaching-coverage-percentage"]
        func waitForColoring() {
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                percentage.exists && percentage.label.contains("%") && percentage.label != "0%"
                    && !app.descendants(matching: .any)["teaching-coverage-progress"].firstMatch.exists
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
            XCTAssertFalse(status.exists, "successful coverage does not add a Pose status caption")
        }
        waitForColoring()
        XCTAssertTrue(percentage.exists)
        let initialPercentage = percentage.label
        XCTAssertTrue(initialPercentage.contains("%") && initialPercentage != "0%", "the saved Poses cover part of this model")
        // XCTest occasionally releases one slider step short of the endpoint.
        for _ in 0..<3 {
            app.sliders["teaching-coverage-opacity"].adjust(toNormalizedSliderPosition: 1)
            if app.staticTexts["teaching-coverage-opacity-value"].label == "100%" { break }
        }
        XCTAssertEqual(app.staticTexts["teaching-coverage-opacity-value"].label, "100%")
        XCTAssertEqual(percentage.label, initialPercentage, "color strength must not change coverage progress")
        func coloredPixels(_ name: String) throws -> Int {
            RunLoop.current.run(until: Date().addingTimeInterval(0.5))
            let shot = XCUIScreen.main.screenshot()
            let attachment = XCTAttachment(screenshot: shot); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
            let image = try XCTUnwrap(shot.image.cgImage)
            // Exclude the sidebar and toolbars so labels and switches cannot
            // satisfy the surface-color check.
            let crop = try XCTUnwrap(image.cropping(to: CGRect(x: 0, y: CGFloat(image.height) * 0.18,
                width: CGFloat(image.width) * 0.68, height: CGFloat(image.height) * 0.65)))
            let context = try XCTUnwrap(CGContext(data: nil, width: crop.width, height: crop.height,
                bitsPerComponent: 8, bytesPerRow: crop.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue))
            context.draw(crop, in: CGRect(x: 0, y: 0, width: crop.width, height: crop.height))
            let pixels = try XCTUnwrap(context.data).assumingMemoryBound(to: UInt8.self)
            return (0..<(crop.width * crop.height)).filter { index in
                let offset = index * 4
                return Int(pixels[offset]) > Int(pixels[offset + 1]) + 20 && Int(pixels[offset + 1]) > Int(pixels[offset + 2]) + 30
            }.count
        }
        let colored = try coloredPixels("Stored model with 100 percent surface coverage")
        toggle.tap(); XCTAssertFalse(status.exists)
        XCTAssertEqual(percentage.label, initialPercentage, "progress remains visible when surface colors are hidden")
        let original = try coloredPixels("Stored model original colors")
        XCTAssertGreaterThan(colored - original, 100, "the app must color the model itself, not just its controls")
        toggle.tap(); waitForColoring()
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let window = app.windows.firstMatch.frame
                return orientation.isLandscape ? window.width > window.height : window.height > window.width
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            assertPreviewBounds(panelExpanded: true)
            let before = preview.screenshot().pngRepresentation
            preview.coordinate(withNormalizedOffset: CGVector(dx: 0.4, dy: 0.5)).press(forDuration: 0.1,
                thenDragTo: preview.coordinate(withNormalizedOffset: CGVector(dx: 0.65, dy: 0.5)))
            XCTAssertNotEqual(preview.screenshot().pngRepresentation, before, "the bounded preview remains interactive")
            assertPreviewBounds(panelExpanded: true)
            let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            shot.name = "Bounded completed model preview \(orientation.rawValue)"; shot.lifetime = .keepAlways; add(shot)
            app.buttons["collapse-teaching-panel"].tap()
            XCTAssertTrue(app.buttons["expand-teaching-panel"].waitForExistence(timeout: 5))
            assertPreviewBounds(panelExpanded: false)
            XCTAssertTrue(app.staticTexts["floating-coverage-percentage"].label.contains(initialPercentage))
            app.buttons["expand-teaching-panel"].tap()
            XCTAssertTrue(app.buttons["collapse-teaching-panel"].waitForExistence(timeout: 5))
            assertPreviewBounds(panelExpanded: true)
        }
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10)); project.tap()
        waitForColoring()
        XCTAssertEqual(percentage.label, initialPercentage, "reopening a local result restores the same coverage progress")
        app.buttons["本地项目"].tap()
    }

    func testTeachingSurfaceCoverageControlsAndPreview() throws {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a local model with recorded Poses") }
        project.tap()
        let toggle = app.switches["teaching-coverage-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(toggle.value as? String, "1")
        let status = app.staticTexts["teaching-coverage-status"]
        func waitForCoverage() {
            let progress = app.descendants(matching: .any)["teaching-coverage-progress"].firstMatch
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: progress)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 60), .completed)
            XCTAssertTrue(app.staticTexts["teaching-coverage-percentage"].exists)
            if status.exists {
                XCTAssertFalse(status.label.contains("已在模型表面着色"), "only guidance or missed-coverage reasons remain")
            }
        }
        waitForCoverage()
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled, "displaying old footprints cannot calibrate or capture")
        let intensity = app.sliders["teaching-coverage-opacity"]
        intensity.adjust(toNormalizedSliderPosition: 1)
        func snapshot(_ name: String) {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        snapshot("Coverage controls with recorded poses")
        app.buttons["display-settings"].tap()
        XCTAssertTrue(app.buttons["close-display-settings"].waitForExistence(timeout: 10))
        snapshot("Surface coverage on the actual local model")
        app.buttons["close-display-settings"].tap()
        toggle.tap()
        XCTAssertFalse(status.exists)
        XCTAssertFalse(intensity.exists)
        app.buttons["display-settings"].tap()
        XCTAssertTrue(app.buttons["close-display-settings"].waitForExistence(timeout: 10))
        snapshot("Original local model with coverage hidden")
        app.buttons["close-display-settings"].tap()
        toggle.tap()
        waitForCoverage()
        intensity.adjust(toNormalizedSliderPosition: 0.364)
        app.buttons["collapse-teaching-panel"].tap()
        XCTAssertTrue(app.buttons["expand-teaching-panel"].waitForExistence(timeout: 5))
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.buttons["capture-pose"].exists)
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled)
        app.buttons["expand-teaching-panel"].tap()
        XCTAssertEqual(toggle.value as? String, "1")
        waitForCoverage()
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(toggle.waitForExistence(timeout: 15))
        waitForCoverage()
        app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
    }

    private func ipv4Address(in app: XCUIApplication) -> String {
        (0..<4).map { index in
            let field = app.textFields["server-address-octet-\(index)"]
            return field.value as? String ?? ""
        }.joined(separator: ".")
    }

    func testSegmentedIPv4InputLimitsAndNavigation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", "http://192.168.100.7:22001"]
        app.launch()
        let fields = (0..<4).map { app.textFields["server-address-octet-\($0)"] }
        XCTAssertTrue(fields[0].waitForExistence(timeout: 15))
        XCTAssertEqual(ipv4Address(in: app), "192.168.100.7")
        fields[0].tap(); fields[0].typeText("10.")
        fields[1].typeText("256")
        XCTAssertEqual(fields[1].value as? String, "25", "reject the digit that would make an octet exceed 255")
        XCTAssertTrue(app.staticTexts["server-address-error"].exists)
        fields[1].typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 2))
        XCTAssertEqual(fields[1].value as? String, "", "an empty octet remains incomplete")
        fields[1].typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertEqual(fields[0].value as? String, "1", "backspace from an empty cell edits the preceding octet")
        fields[0].typeText("92")
        fields[1].typeText("168.")
        fields[2].typeText("0.")
        fields[3].typeText("255")
        XCTAssertEqual(ipv4Address(in: app), "192.168.0.255", "three digits advance once; the following dot must not skip an octet")
        fields[3].typeText("6")
        XCTAssertEqual(fields[3].value as? String, "255", "a fourth digit cannot change the valid octet")
        fields[3].typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 3)); fields[3].typeText("0")
        XCTAssertEqual(ipv4Address(in: app), "192.168.0.0")
        XCTAssertEqual(app.textFields["server-port"].value as? String, "22001", "octet editing preserves the port")
        app.buttons["完成"].tap()
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Segmented IPv4 with independent port"; screenshot.lifetime = .keepAlways; add(screenshot)
        XCTAssertFalse(app.buttons["capture-pose"].exists)
    }

    func testSegmentedIPv4WholeAddressEditIsAtomic() {
        // Exercise UIKit's whole-string edit transaction without relying on a
        // background UI-test runner having access to the device clipboard.
        let view = IPv4InputView(frame: CGRect(x: 0, y: 0, width: 260, height: 44))
        view.setHost("192.168.100.7")
        let fields = view.subviews.compactMap { $0 as? UITextField }
        XCTAssertEqual(fields.count, 4)
        var updates: [String] = [], error = ""
        view.onChange = { updates.append($0) }
        view.onReject = { error = $0 }
        func paste(_ value: String) {
            let first = fields[0]
            XCTAssertEqual(first.delegate?.textField?(first,
                shouldChangeCharactersIn: NSRange(location: 0, length: (first.text ?? "").utf16.count),
                replacementString: value), false)
        }
        paste(" 010.002.003.255 ")
        XCTAssertEqual(updates, ["10.2.3.255"])
        XCTAssertEqual(fields.map { $0.text ?? "" }, ["10", "2", "3", "255"])
        for invalid in ["10.2.3.256", "10.2..3", "10.2.3.4.5", "10.a.3.4", "10.2.3.9999"] {
            paste(invalid)
            XCTAssertFalse(error.isEmpty)
            XCTAssertEqual(updates, ["10.2.3.255"], "a rejected paste must never publish a partial address")
            XCTAssertEqual(fields.map { $0.text ?? "" }, ["10", "2", "3", "255"])
        }
        paste("0.0.0.0")
        XCTAssertEqual(updates.last, "0.0.0.0")
        paste("255.255.255.255")
        XCTAssertEqual(updates.last, "255.255.255.255")
    }

    private func openPairingCodePrompt(in app: XCUIApplication) -> XCUIElement {
        let port = app.textFields["server-port"]
        XCTAssertTrue(port.waitForExistence(timeout: 15))
        port.tap(); port.typeText("\n")
        let code = app.textFields["pairing-code"]
        XCTAssertTrue(code.waitForExistence(timeout: 5), app.debugDescription)
        return code
    }

    func testPairingScannerCanCancelWithoutChangingManualInput() {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", "http://192.168.100.7:21990"]
        app.launch()
        XCTAssertTrue(app.buttons["scan-pairing-code"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.textFields["pairing-code"].exists)
        app.buttons["scan-pairing-code"].tap()
        let cancel = app.buttons["cancel-pairing-scan"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["允许", "好", "OK", "Allow"])).firstMatch
        if allow.waitForExistence(timeout: 3) { allow.tap() }
        XCTAssertTrue(app.staticTexts["scanner-status"].exists)
        #if !targetEnvironment(simulator)
        XCTAssertFalse(app.staticTexts["scanner-camera-help"].exists, "The connected iPad Pro must display the real camera scanner")
        #endif
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "Native QR pairing scanner"; shot.lifetime = .keepAlways; add(shot)
        cancel.tap()
        XCTAssertTrue(app.buttons["scan-pairing-code"].waitForExistence(timeout: 5))
        // VisionKit can restore the physical device orientation after dismissal.
        // Wait for the rotation before editing so the next tap uses stable coordinates.
        XCUIDevice.shared.orientation = .portrait
        let portrait = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let frame = app.windows.firstMatch.frame
            return frame.height > frame.width
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [portrait], timeout: 10), .completed)
        let code = openPairingCodePrompt(in: app)
        code.tap(); code.typeText("Q7Z")
        app.buttons["cancel-wifi-pairing"].tap()
        app.buttons["scan-pairing-code"].tap()
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        cancel.tap()
        XCTAssertTrue(app.buttons["scan-pairing-code"].waitForExistence(timeout: 5))
        XCTAssertFalse(code.exists, "cancelled Wi-Fi input stays dismissed after scanning")
        XCTAssertEqual(ipv4Address(in: app), "192.168.100.7")
        XCTAssertEqual(app.textFields["server-port"].value as? String, "21990")
        XCTAssertFalse(app.buttons["capture-pose"].exists)
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    func testDiscoveredServerOpensPairingPrompt() throws {
        guard let serverID = ProcessInfo.processInfo.environment["ATLAS_DISCOVERY_SERVER_ID"],
              let address = ProcessInfo.processInfo.environment["ATLAS_DISCOVERY_ADDRESS"] else {
            throw XCTSkip("Provide the running LAN service ID and address for a directed-probe test")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", address]
        app.launch()
        let code = app.textFields["pairing-code"]
        XCTAssertTrue(app.staticTexts["Wifi连接"].waitForExistence(timeout: 15))
        XCTAssertFalse(code.exists, "the welcome page has no pairing-code input")
        let service = app.buttons["discovered-service-\(serverID)"]
        XCTAssertTrue(service.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(ipv4Address(in: app), URLComponents(string: address)?.host ?? "", "search only probes the entered address")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "discovered-service-")).count, 1)
        XCTAssertNotEqual(app.buttons["discover-services"].value as? String, "正在搜索", "results appear after search feedback completes")
        service.tap()
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        XCTAssertEqual(code.value as? String, "")
        code.tap(); code.typeText("q7z")
        XCTAssertEqual(code.value as? String, "Q7Z")
        XCTAssertFalse(app.buttons["confirm-wifi-pairing"].isEnabled)
        XCTAssertTrue(code.isEnabled)
        XCTAssertFalse(app.buttons["capture-pose"].exists, "discovery never pairs or opens a teaching session")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Selected LAN server opens pairing-code dialog"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.buttons["cancel-wifi-pairing"].tap()
        XCTAssertFalse(code.exists)
        XCTAssertFalse(app.staticTexts["model-transfer-stage"].exists, "cancelling must not connect")
        XCTAssertEqual(ipv4Address(in: app), URLComponents(string: address)?.host ?? "")
        XCTAssertTrue(service.waitForExistence(timeout: 5)); service.tap()
        XCTAssertTrue(code.waitForExistence(timeout: 5))
        XCTAssertEqual(code.value as? String, "", "reopening starts with a fresh code")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(code.isHittable)
        let portrait = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        portrait.name = "Pairing-code dialog in portrait"; portrait.lifetime = .keepAlways; add(portrait)
        app.buttons["cancel-wifi-pairing"].tap()
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    func testServerProbeClearsCardWhenPortChanges() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let serverID = environment["ATLAS_DISCOVERY_SERVER_ID"],
              let address = environment["ATLAS_DISCOVERY_ADDRESS"] else {
            throw XCTSkip("Provide a running service to verify address editing and retry")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launchArguments = ["-serverAddress", address]; app.launch()
        let service = app.buttons["discovered-service-\(serverID)"]
        XCTAssertTrue(service.waitForExistence(timeout: 15))
        let port = app.textFields["server-port"], search = app.buttons["discover-services"]
        let originalPort = String(URLComponents(string: address)?.port ?? 21990)
        port.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: originalPort.count) + "65536")
        XCTAssertFalse(service.exists, "the old card disappears as soon as its port changes")
        search.tap()
        XCTAssertEqual(search.value as? String, "正在搜索", "invalid input also keeps feedback visible")
        XCTAssertTrue(app.staticTexts["请先填写有效的电脑地址和端口。"].waitForExistence(timeout: 4))
        XCTAssertNotEqual(search.value as? String, "正在搜索")
        port.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + originalPort)
        search.tap()
        XCTAssertEqual(search.value as? String, "正在搜索", "a fast success still shows search feedback")
        XCTAssertTrue(service.waitForExistence(timeout: 5), "retry probes the corrected endpoint")
        XCTAssertNotEqual(search.value as? String, "正在搜索")
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "Directed search finishes after minimum feedback with one matching server"; shot.lifetime = .keepAlways; add(shot)
    }

    func testFourCharacterPairingInput() {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", "http://192.168.100.7:21990"]
        app.launch()
        let code = openPairingCodePrompt(in: app)
        XCTAssertFalse(app.buttons["receive-model"].exists)
        code.tap(); code.typeText("q7z")
        XCTAssertEqual(code.value as? String, "Q7Z")
        XCTAssertFalse(app.staticTexts["model-transfer-stage"].exists, "three characters are incomplete")
        code.typeText("29")
        XCTAssertEqual(code.value as? String, "Q7Z29", "do not truncate a longer code into a different valid code")
        XCTAssertTrue(app.staticTexts["请输入 4 位字母或数字"].exists)
        code.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        code.typeText("12-4"); XCTAssertTrue(app.staticTexts["请输入 4 位字母或数字"].exists, "punctuation is rejected")
        code.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4))
        XCTAssertFalse(app.staticTexts["model-transfer-stage"].exists, "incomplete and invalid codes cannot connect")
        XCTAssertFalse(app.buttons["capture-pose"].exists)
        let shot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        shot.name = "Four-character alphanumeric pairing input"; shot.lifetime = .keepAlways; add(shot)
        app.buttons["cancel-wifi-pairing"].tap()
        XCTAssertFalse(code.exists)
    }

    func testSeparateIPv4AndPortInputs() {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", "192.168.100.7"]
        app.launch()
        let host = app.textFields["server-address-octet-0"], port = app.textFields["server-port"]
        XCTAssertTrue(host.waitForExistence(timeout: 15))
        XCTAssertEqual(ipv4Address(in: app), "192.168.100.7")
        XCTAssertEqual(port.value as? String, "21990")
        port.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5)); port.typeText("22001")
        XCTAssertEqual(ipv4Address(in: app), "192.168.100.7", "editing the port keeps the IPv4 address")
        XCTAssertEqual(port.value as? String, "22001")
        port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5)); port.typeText("65536")
        XCTAssertEqual(port.value as? String, "65536")
        port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        XCTAssertEqual(port.value as? String, "21990", "a blank port displays the default placeholder")
        port.typeText("21990\n")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "IPv4 address and default port"; screenshot.lifetime = .keepAlways; add(screenshot)
        XCTAssertFalse(app.buttons["capture-pose"].exists)
    }

    func testLocalModelThumbnailLoadsWithoutOpeningProject() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launch()
        let project = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a locally received model") }
        let id = String(project.identifier.dropFirst("local-project-".count))
        let preview = app.images["model-thumbnail-\(id)"]
        XCTAssertTrue(preview.waitForExistence(timeout: 45), app.debugDescription)
        XCTAssertTrue(project.frame.contains(preview.frame), "The thumbnail stays inside its model card")
        XCTAssertFalse(app.buttons["capture-pose"].exists, "Generating a thumbnail must not open or calibrate the project")
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Local model card with actual cached preview"; screenshot.lifetime = .keepAlways; add(screenshot)
        app.terminate(); app.launch()
        XCTAssertTrue(preview.waitForExistence(timeout: 15), "The preview remains available after relaunch")
        XCTAssertFalse(app.buttons["capture-pose"].exists)
    }

    func testLibraryFillsWindowAndAdaptsToRotation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.textFields["server-address-octet-0"].waitForExistence(timeout: 15))
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let window = app.windows.firstMatch.frame
                return orientation.isLandscape ? window.width > window.height : window.height > window.width
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            let pairing = app.otherElements["library-pairing-panel"]
            let projects = app.otherElements["library-projects-panel"]
            XCTAssertTrue(pairing.waitForExistence(timeout: 5))
            XCTAssertTrue(projects.exists)
            let window = app.windows.firstMatch.frame
            let left = pairing.frame, right = projects.frame
            if window.width >= 1000 && window.width > window.height {
                XCTAssertEqual(left.minY, right.minY, accuracy: 2)
                XCTAssertGreaterThan(right.minX, left.maxX)
                XCTAssertLessThanOrEqual(window.maxX - right.maxX, 32, "Use the width of the iPad instead of a centered fixed-width column")
            } else {
                XCTAssertGreaterThan(right.minY, left.maxY)
                XCTAssertEqual(left.width, right.width, accuracy: 2)
                XCTAssertLessThanOrEqual(window.maxX - left.maxX, 32)
            }
            XCTAssertLessThanOrEqual(left.minX - window.minX, 32)
            let scan = app.buttons["scan-pairing-code"]
            XCTAssertFalse(app.buttons["receive-model"].exists)
            XCTAssertTrue(window.contains(scan.frame))
            XCTAssertEqual(scan.frame.width, left.width - 48, accuracy: 1)
            XCTAssertGreaterThanOrEqual(scan.frame.height, 44)
            XCTAssertTrue(app.staticTexts["方式一"].exists)
            XCTAssertTrue(app.staticTexts["方式二"].exists)
            XCTAssertTrue(app.staticTexts["方式三"].exists)
            XCTAssertEqual(app.buttons["discover-services"].label, "搜索服务器")
            XCTAssertGreaterThan(app.staticTexts["Wifi连接"].frame.minY, scan.frame.maxY)
            XCTAssertFalse(app.textFields["pairing-code"].exists)
            print("Library window: \(window), pairing panel: \(left), project panel: \(right)")
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = orientation.isLandscape ? "Full-width library landscape" : "Full-width library portrait"
            screenshot.lifetime = .keepAlways; add(screenshot)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    func testModelTransferProgressAndRetry() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ATLAS_PROGRESS_ADDRESS"],
              let pairingCode = environment["ATLAS_PROGRESS_CODE"],
              let fixtureID = environment["ATLAS_PROGRESS_SESSION"], UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Run tests/ipad_transfer_progress_fixture.mjs for a disposable, throttled transfer")
        }
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication(); app.launchArguments = ["-serverAddress", address]; app.launch()
        XCTAssertTrue(app.textFields["server-port"].waitForExistence(timeout: 15))
        let fixture = app.buttons["local-project-\(fixtureID)"]
        func removeFixture() {
            XCTAssertTrue(fixture.label.contains("进度验证（临时）"), "only remove the dedicated transfer fixture")
            for _ in 0..<8 where !fixture.isHittable { app.scrollViews["library-projects-scroll"].swipeUp() }
            fixture.swipeLeft()
            app.buttons["swipe-delete-local-project-\(fixtureID)"].firstMatch.tap()
            app.buttons["confirm-delete-local-project"].firstMatch.tap()
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: fixture)], timeout: 10), .completed)
        }
        if fixture.exists { removeFixture() }
        let code = openPairingCodePrompt(in: app)
        code.tap(); code.typeText("ABCDE")
        XCTAssertEqual(code.value as? String, "ABCDE")
        XCTAssertFalse(app.staticTexts["model-transfer-stage"].exists, "a longer code must not submit its first four characters")
        code.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5))
        code.typeText("12-4")
        XCTAssertFalse(app.staticTexts["model-transfer-stage"].exists, "invalid characters do not start a connection")
        code.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 4))
        code.typeText(String(pairingCode.prefix(3)))
        XCTAssertFalse(app.staticTexts["model-transfer-stage"].exists, "an incomplete code does not connect")
        code.typeText(String(pairingCode.suffix(1)))
        let stage = app.staticTexts["model-transfer-stage"]
        XCTAssertTrue(stage.waitForExistence(timeout: 5))
        XCTAssertEqual(stage.label, "正在连接电脑并配对")
        XCTAssertFalse(app.buttons["scan-pairing-code"].isEnabled)
        func snapshot(_ name: String) {
            let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
        }
        snapshot("Pairing progress on physical iPad")
        let failure = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "测试下载失败，请重试")).firstMatch
        XCTAssertTrue(failure.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertFalse(stage.exists)
        let retry = app.buttons["retry-pairing"]
        XCTAssertTrue(retry.isEnabled); XCTAssertTrue(app.buttons["scan-pairing-code"].isEnabled)
        retry.tap()
        let percent = app.staticTexts["model-download-percent"]
        XCTAssertTrue(percent.waitForExistence(timeout: 15), app.debugDescription)
        XCTAssertFalse(failure.exists, "retry clears the old error")
        func percentage() -> Int { Int(percent.label.replacingOccurrences(of: "%", with: "")) ?? -1 }
        let initial = percentage()
        XCTAssertGreaterThanOrEqual(initial, 0); XCTAssertLessThan(initial, 100)
        XCTAssertTrue(app.staticTexts["model-download-bytes"].label.contains(" / "))
        let advancing = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            percent.exists && percentage() > initial && percentage() < 100
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [advancing], timeout: 15), .completed)
        snapshot("Live download percentage and bytes - landscape")
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(app.windows.firstMatch.frame.contains(percent.frame), "progress stays visible after rotation")
        snapshot("Live download percentage and bytes - portrait")
        let capture = app.buttons["capture-pose"]
        XCTAssertTrue(capture.waitForExistence(timeout: 90), app.debugDescription)
        XCTAssertFalse(stage.exists)
        app.buttons["本地项目"].tap()
        XCTAssertTrue(fixture.waitForExistence(timeout: 15))
        app.terminate(); app.launch()
        XCTAssertTrue(fixture.waitForExistence(timeout: 15)); fixture.tap()
        XCTAssertTrue(capture.waitForExistence(timeout: 30), "completed transfer persists locally")
        app.buttons["本地项目"].tap()
        removeFixture()
        XCUIDevice.shared.orientation = .landscapeLeft
    }

    func testCollapsibleTeachingPanelAndFloatingPose() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"], UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project for automatic placement testing")
        }
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()
        let collapse = app.buttons["collapse-teaching-panel"], expand = app.buttons["expand-teaching-panel"]
        XCTAssertTrue(collapse.waitForExistence(timeout: 15))
        let scene = app.otherElements["teaching-viewport"], capture = app.buttons["capture-pose"]
        guard capture.exists else { throw XCTSkip("Requires an unfinished project") }
        let maskToggle = app.switches["zivid-fov-toggle"]
        XCTAssertEqual(maskToggle.value as? String, "1")
        maskToggle.tap()
        let surface = app.otherElements["teaching-render-surface"]
        let target = app.images["teaching-placement-target"]
        func assertFrame(_ element: XCUIElement, _ expected: CGRect, file: StaticString = #filePath, line: UInt = #line) {
            let actual = element.frame
            XCTAssertEqual(actual.minX, expected.minX, accuracy: 1, file: file, line: line)
            XCTAssertEqual(actual.minY, expected.minY, accuracy: 1, file: file, line: line)
            XCTAssertEqual(actual.width, expected.width, accuracy: 1, file: file, line: line)
            XCTAssertEqual(actual.height, expected.height, accuracy: 1, file: file, line: line)
        }
        func snapshot(_ name: String) {
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = name; screenshot.lifetime = .keepAlways; add(screenshot)
        }
        let originalFrame = scene.frame
        XCTAssertEqual(originalFrame.width, app.windows.firstMatch.frame.width, accuracy: 1)
        assertFrame(surface, originalFrame)
        XCTAssertFalse(expand.exists)
        XCTAssertFalse(app.otherElements["floating-pose-controls"].exists)
        XCTAssertFalse(capture.isEnabled)
        // Without the M70 mask, folding must also preserve the native camera's
        // bounds and center. Covering the image is allowed; changing its crop is not.
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait, .landscapeRight] {
            XCUIDevice.shared.orientation = orientation
            let expandedSurface = surface.frame, expandedTarget = target.frame
            XCTAssertEqual(expandedTarget.midX, expandedSurface.midX, accuracy: 1)
            XCTAssertEqual(expandedTarget.midY, expandedSurface.midY, accuracy: 1)
            snapshot("Stable camera expanded \(orientation.rawValue)")
            collapse.tap()
            XCTAssertTrue(expand.waitForExistence(timeout: 5))
            assertFrame(surface, expandedSurface)
            assertFrame(target, expandedTarget)
            snapshot("Stable camera collapsed \(orientation.rawValue)")
            expand.tap()
            XCTAssertTrue(collapse.waitForExistence(timeout: 5))
            assertFrame(surface, expandedSurface)
            assertFrame(target, expandedTarget)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        maskToggle.tap()
        let aperture = app.otherElements["zivid-fov-aperture"]
        XCTAssertTrue(aperture.waitForExistence(timeout: 10))
        let originalAperture = aperture.frame, maskedSurface = surface.frame

        // Place automatically in a disposable project without recording a Pose.
        // This catches accidental AR/view recreation during the layout change.
        var placed = false, tilt = ""
        let place = app.buttons["place-model"]
        let floorReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)
        if XCTWaiter.wait(for: [floorReady], timeout: 10) == .completed {
            app.buttons["model-tilt-controls"].tap()
            app.sliders["model-pitch"].adjust(toNormalizedSliderPosition: 0.54)
            tilt = app.staticTexts["model-pitch-value"].label
            place.tap()
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: capture)
            placed = XCTWaiter.wait(for: [ready], timeout: 10) == .completed
        }
        XCTAssertTrue(collapse.isHittable, "the fixed header stays available when the panel is scrolled")
        collapse.tap()
        XCTAssertTrue(expand.waitForExistence(timeout: 5))
        XCTAssertFalse(collapse.isHittable, "the retained sidebar cannot receive touches while folded")
        XCTAssertEqual(app.buttons.matching(identifier: "capture-pose").count, 1)
        XCTAssertTrue(app.otherElements["floating-pose-controls"].exists)
        assertFrame(scene, originalFrame)
        assertFrame(surface, maskedSurface)
        assertFrame(aperture, originalAperture)
        let count = app.staticTexts["floating-pose-count"].label
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let window = app.windows.firstMatch.frame
                return orientation.isLandscape ? window.width > window.height : window.height > window.width
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            let window = app.windows.firstMatch.frame
            XCTAssertEqual(scene.frame.width, window.width, accuracy: 2)
            XCTAssertTrue(window.contains(capture.frame))
            XCTAssertGreaterThan(capture.frame.midX, window.midX)
            XCTAssertGreaterThan(capture.frame.midY, window.height * 0.75)
            XCTAssertLessThan(window.maxX - capture.frame.maxX, 55)
            XCTAssertEqual(capture.isEnabled, placed, "collapsing preserves automatic placement state")
            XCTAssertTrue(expand.isHittable)
            XCTAssertEqual(app.staticTexts["floating-pose-count"].label, count)
            XCTAssertEqual(aperture.value as? String, "完整视野")
            let collapsedSurface = surface.frame, collapsedAperture = aperture.frame, collapsedTarget = target.frame
            snapshot("Stable M70 camera collapsed \(orientation.rawValue)")
            expand.tap()
            XCTAssertTrue(collapse.waitForExistence(timeout: 5))
            assertFrame(surface, collapsedSurface)
            assertFrame(aperture, collapsedAperture)
            assertFrame(target, collapsedTarget)
            snapshot("Stable M70 camera expanded \(orientation.rawValue)")
            collapse.tap()
            XCTAssertTrue(expand.waitForExistence(timeout: 5))
            assertFrame(surface, collapsedSurface)
            assertFrame(aperture, collapsedAperture)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        expand.tap()
        XCTAssertTrue(collapse.waitForExistence(timeout: 5))
        assertFrame(scene, originalFrame)
        XCTAssertFalse(app.otherElements["floating-pose-controls"].exists)
        XCTAssertEqual(maskToggle.value as? String, "1", "panel visibility preserves viewfinder settings")
        if placed {
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: capture)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed, "placement survives collapsing and rotating")
            app.buttons["adjust-model-placement"].tap()
            XCTAssertEqual(app.staticTexts["model-pitch-value"].label, tilt)
            app.buttons["cancel-placement-adjustment"].tap()
        }
        collapse.tap()
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(expand.waitForExistence(timeout: 15))
        XCTAssertFalse(capture.isEnabled, "resuming must still require calibration")
        expand.tap()
        app.buttons["本地项目"].tap()
    }

    func testSharedDisplayQualityAcrossSettingsAndPoseReview() throws {
        continueAfterFailure = false
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_SHARED_QUALITY_FIXTURE_ID"],
              UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable completed project with Poses; this test removes only that fixture")
        }
        let app = XCUIApplication(); XCUIDevice.shared.orientation = .landscapeLeft; app.launch()
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        let settings = app.buttons["display-settings"], review = app.buttons["review-poses"]
        XCTAssertTrue(settings.waitForExistence(timeout: 30))
        let summary = app.staticTexts["model-render-summary"]
        let quality = app.sliders["pose-preview-quality"]
        var retainedSummary = ""
        for (mode, picker, preset, full, prefix, unit) in [
            ("points", "point-density", "25%", "100%", "点云", "点"),
            ("mesh", "mesh-quality", "流畅", "全量", "Mesh", "面")
        ] {
            settings.tap()
            XCTAssertTrue(app.buttons["display-mode-\(mode)"].waitForExistence(timeout: 10))
            app.buttons["display-mode-\(mode)"].tap()
            app.buttons[picker].tap(); app.buttons[preset].tap()
            let rendered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                summary.label.hasPrefix("\(prefix) · ")
                    && !app.descendants(matching: .any)["model-render-progress"].firstMatch.exists
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rendered], timeout: 60), .completed)
            let selectedSummary = summary.label
            let parts = selectedSummary.components(separatedBy: " / ")
            XCTAssertEqual(parts.count, 2)
            let count = try XCTUnwrap(Int(parts[0].filter(\.isNumber)))
            let total = try XCTUnwrap(Int(parts[1].filter(\.isNumber)))
            XCTAssertGreaterThan(total, count, "fixture must expose more than one quality level")
            let percentage = (Double(count) / Double(total)).formatted(.percent.precision(.fractionLength(0...1)))
            app.buttons["close-display-settings"].tap()
            review.tap()
            XCTAssertTrue(quality.waitForExistence(timeout: 15))
            XCTAssertEqual(quality.value as? String, percentage, "Pose review inherits the actual teaching quality")
            quality.adjust(toNormalizedSliderPosition: 1)
            let progress = app.descendants(matching: .any)["pose-preview-quality-progress"].firstMatch
            XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: progress)], timeout: 60), .completed)
            XCTAssertEqual(quality.value as? String, "100%")
            let poseShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            poseShot.name = "Shared \(mode) quality in Pose review"; poseShot.lifetime = .keepAlways; add(poseShot)
            app.buttons["close-pose-review"].tap()
            let fullSummary = "\(prefix) · \(total.formatted()) / \(total.formatted()) \(unit)"
            settings.tap(); waitForRenderSummary(app, label: fullSummary)
            retainedSummary = summary.label
            XCTAssertTrue(app.buttons[picker].label.contains(full), "the settings picker reflects the Pose slider")
            let settingsShot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            settingsShot.name = "Shared \(mode) quality in display settings"; settingsShot.lifetime = .keepAlways; add(settingsShot)
            app.buttons["close-display-settings"].tap()
        }
        app.buttons["本地项目"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        XCTAssertTrue(settings.waitForExistence(timeout: 30)); settings.tap()
        waitForRenderSummary(app, label: retainedSummary)
        XCTAssertTrue(app.buttons["point-density"].label.contains("100%"))
        XCTAssertTrue(app.buttons["mesh-quality"].label.contains("全量"))
        app.buttons["close-display-settings"].tap(); review.tap()
        XCTAssertTrue(quality.waitForExistence(timeout: 15)); XCTAssertEqual(quality.value as? String, "100%")
        app.buttons["close-pose-review"].tap(); app.buttons["本地项目"].tap()
        XCTAssertTrue(project.waitForExistence(timeout: 10))
        project.swipeLeft(); app.buttons["swipe-delete-local-project-\(fixtureID)"].tap()
        app.buttons["confirm-delete-local-project"].firstMatch.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"), object: project)], timeout: 10), .completed)
    }

    func testLightweightDefaultAndRetainedManualQuality() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        XCUIDevice.shared.orientation = .landscapeLeft
        let project = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"].map {
            app.buttons["local-project-\($0)"]
        } ?? app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a locally received model") }
        let projectID = project.identifier
        let started = Date()
        project.tap()
        XCTAssertTrue(app.buttons["display-settings"].waitForExistence(timeout: 10))
        print("Model page opened in \(Date().timeIntervalSince(started)) seconds including XCTest tap/idle overhead")
        app.buttons["display-settings"].tap()
        let summary = app.staticTexts["model-render-summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 10))
        let originalMode = app.buttons["display-mode-points"].isSelected ? "points" : "mesh"
        XCTAssertTrue(app.buttons["point-density"].label.contains("轻量"))
        XCTAssertTrue(app.buttons["mesh-quality"].label.contains("轻量"))
        let mesh = app.buttons["display-mode-mesh"]
        if mesh.isEnabled {
            mesh.tap()
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                summary.label.hasPrefix("Mesh") && !app.progressIndicators["model-render-progress"].exists
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 15), .completed)
            let light = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            light.name = "Lightweight initial Mesh"; light.lifetime = .keepAlways; add(light)
            let total = summary.label.components(separatedBy: " / ").last!.components(separatedBy: " ").first!
            app.buttons["mesh-quality"].tap(); app.buttons["全量"].tap()
            waitForRenderSummary(app, label: "Mesh · \(total) / \(total) 面")
            let full = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            full.name = "Explicit full-quality Mesh"; full.lifetime = .keepAlways; add(full)
        }
        app.buttons["display-mode-points"].tap()
        app.buttons["point-density"].tap(); app.buttons["25%"].tap()
        let dense = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            summary.label.hasPrefix("点云") && !app.progressIndicators["model-render-progress"].exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [dense], timeout: 30), .completed)
        app.buttons["close-display-settings"].tap()
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled, "display upgrades cannot calibrate or create poses")
        app.buttons["本地项目"].tap()
        let reopened = app.buttons[projectID]
        XCTAssertTrue(reopened.waitForExistence(timeout: 10)); reopened.tap()
        XCTAssertTrue(app.buttons["display-settings"].waitForExistence(timeout: 10))
        app.buttons["display-settings"].tap()
        XCTAssertTrue(app.buttons["display-mode-points"].isSelected, "opening retains the last display mode")
        XCTAssertTrue(app.buttons["point-density"].label.contains("25%"), "reopening retains the selected point density")
        if mesh.isEnabled {
            XCTAssertTrue(app.buttons["mesh-quality"].label.contains("全量"), "reopening retains the selected Mesh quality")
        }
        app.buttons["display-mode-\(originalMode)"].tap()
        app.buttons["close-display-settings"].tap()
        app.buttons["本地项目"].tap()
    }

    func testZividFieldOfViewMaskAndRotation() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        app.launch()
        let project = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"].map {
            app.buttons["local-project-\($0)"]
        } ?? app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "local-project-")).firstMatch
        guard project.waitForExistence(timeout: 15) else { throw XCTSkip("Requires a locally received model on a LiDAR iPad") }
        project.tap()
        let toggle = app.switches["zivid-fov-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 60))
        XCTAssertEqual(toggle.value as? String, "1")
        let aperture = app.otherElements["zivid-fov-aperture"]
        XCTAssertTrue(aperture.waitForExistence(timeout: 15))
        toggle.tap()
        XCTAssertFalse(aperture.exists)
        toggle.tap()
        XCTAssertEqual(toggle.value as? String, "1")
        XCTAssertTrue(aperture.waitForExistence(timeout: 15))
        let capture = app.buttons["capture-pose"]
        XCTAssertFalse(capture.isEnabled, "a viewfinder cannot confirm calibration or create poses")
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait, .landscapeRight] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let frame = aperture.frame
                return frame.width > 0 && (orientation.isLandscape ? frame.width > frame.height : frame.height > frame.width)
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            XCTAssertEqual(aperture.value as? String, "完整视野", "the connected iPad camera must cover the full nominal M70 aperture")
            XCTAssertTrue(app.windows.firstMatch.frame.contains(aperture.frame))
            XCTAssertTrue(app.windows.firstMatch.frame.contains(toggle.frame))
            let status = app.staticTexts["zivid-fov-status"]
            XCTAssertFalse(status.exists)
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "M70 field of view \(orientation.rawValue)"; screenshot.lifetime = .keepAlways; add(screenshot)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        toggle.tap()
        XCTAssertFalse(aperture.exists)
        toggle.tap()
        XCTAssertTrue(aperture.waitForExistence(timeout: 10))
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(toggle.waitForExistence(timeout: 15))
        XCTAssertEqual(toggle.value as? String, "1")
        XCTAssertTrue(aperture.waitForExistence(timeout: 15), "camera intrinsics must be refreshed after resuming")
        XCTAssertFalse(capture.isEnabled)
        app.buttons["本地项目"].tap()
    }

    func testGroundAssistanceControlsAndLifecycle() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        app.launch()
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"], UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project for automatic placement testing")
        }
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()
        let aid = app.switches["ground-assistance"], fieldOfView = app.switches["zivid-fov-toggle"]
        guard aid.waitForExistence(timeout: 60) else { throw XCTSkip("Requires an unfinished project on a LiDAR iPad") }
        XCTAssertEqual(aid.value as? String, "1")
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled, "floor detection never calibrates or records automatically")
        aid.tap()
        XCTAssertEqual(aid.value as? String, "0")
        aid.tap()
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let window = app.windows.firstMatch.frame
                return orientation.isLandscape ? window.width > window.height : window.height > window.width
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            XCTAssertTrue(app.windows.firstMatch.frame.contains(aid.frame))
            XCTAssertTrue(app.windows.firstMatch.frame.contains(fieldOfView.frame))
            XCTAssertLessThanOrEqual(aid.frame.maxY, fieldOfView.frame.minY)
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = orientation.isLandscape ? "Ground assistance landscape" : "Ground assistance portrait"
            screenshot.lifetime = .keepAlways; add(screenshot)
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        let place = app.buttons["place-model"]
        let groundReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: place)
        if XCTWaiter.wait(for: [groundReady], timeout: 20) == .completed {
            app.buttons["model-tilt-controls"].tap()
            app.sliders["model-pitch"].adjust(toNormalizedSliderPosition: 0.58)
            let tilt = app.staticTexts["model-pitch-value"].label
            XCTAssertNotEqual(tilt, "0.0°")
            place.tap()
            expectAutomaticPlacement(app)
            XCTAssertFalse(aid.exists, "automatic placement hides the ground helper")
            app.buttons["adjust-model-placement"].tap()
            XCTAssertEqual(app.staticTexts["model-pitch-value"].label, tilt, "floor placement preserves the requested tilt")
            app.buttons["cancel-placement-adjustment"].tap()
            XCTAssertTrue(app.buttons["capture-pose"].isEnabled)
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = "Live LiDAR floor placement with free tilt"; screenshot.lifetime = .keepAlways; add(screenshot)
            print("Live classified ground target, placement and free tilt verified")
        } else {
            print("Ground controls verified; no classified floor at the center for the live placement check")
        }
        XCUIDevice.shared.press(.home); app.activate()
        XCTAssertTrue(aid.waitForExistence(timeout: 15))
        XCTAssertEqual(aid.value as? String, "1")
        XCTAssertFalse(app.buttons["capture-pose"].isEnabled)
        XCTAssertFalse(app.buttons["adjust-model-placement"].exists, "resuming must not reuse a placement from the old AR session")
        app.buttons["本地项目"].tap()
    }

    func testSpatialLevelDeviceAxesAndLifecycle() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .landscapeLeft }
        app.launch()
        guard let fixtureID = ProcessInfo.processInfo.environment["ATLAS_HARDWARE_SESSION"], UUID(uuidString: fixtureID) != nil else {
            throw XCTSkip("Provide a disposable project for live device attitude testing")
        }
        let project = app.buttons["local-project-\(fixtureID)"]
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        project.tap()
        let capture = app.buttons["capture-pose"]
        XCTAssertTrue(capture.waitForExistence(timeout: 60), app.debugDescription)
        let groundAid = app.switches["ground-assistance"]
        if groundAid.exists, groundAid.value as? String == "1" { groundAid.tap() }
        let angle = app.staticTexts["spatial-level-angle"]
        XCTAssertTrue(angle.waitForExistence(timeout: 15))
        let measured = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", "—"), object: angle)
        XCTAssertEqual(XCTWaiter.wait(for: [measured], timeout: 30), .completed,
            "device attitude is available before model placement")
        XCTAssertFalse(app.buttons["confirm-model-calibration"].exists)
        XCTAssertFalse(capture.isEnabled)
        let toggle = app.buttons["toggle-spatial-level"]
        for orientation in [UIDeviceOrientation.landscapeLeft, .portrait] {
            XCUIDevice.shared.orientation = orientation
            let rotated = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                let window = app.windows.firstMatch.frame
                return orientation.isLandscape ? window.width > window.height : window.height > window.width
            }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [rotated], timeout: 10), .completed)
            let window = app.windows.firstMatch.frame
            XCTAssertTrue(window.contains(app.otherElements["spatial-level"].frame))
            XCTAssertTrue(window.contains(toggle.frame))
            toggle.tap(); XCTAssertFalse(angle.exists)
            toggle.tap(); XCTAssertTrue(angle.waitForExistence(timeout: 5))
            XCTAssertTrue(app.staticTexts["X 前  ·  Y 左  ·  Z 上"].exists)
            let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
            screenshot.name = orientation.isLandscape ? "Device attitude axes landscape" : "Device attitude axes portrait"
            screenshot.lifetime = .keepAlways; add(screenshot)
        }
        let sidebar = app.scrollViews.firstMatch
        func reveal(_ element: XCUIElement) {
            for _ in 0..<5 {
                if element.exists, element.isHittable,
                   sidebar.frame.insetBy(dx: 0, dy: 16).contains(element.frame) { return }
                sidebar.swipeUp()
            }
            XCTAssertTrue(element.isHittable, "sidebar control must be visible before tapping")
        }
        let tilt = app.buttons["model-tilt-controls"]
        reveal(tilt); tilt.tap()
        let pitch = app.sliders["model-pitch"], roll = app.sliders["model-roll"]
        XCTAssertTrue(pitch.waitForExistence(timeout: 5), app.debugDescription)
        reveal(pitch); pitch.adjust(toNormalizedSliderPosition: 0.6)
        reveal(roll); roll.adjust(toNormalizedSliderPosition: 0.4)
        XCTAssertNotEqual(app.staticTexts["model-pitch-value"].label, "0.0°")
        XCTAssertNotEqual(app.staticTexts["model-roll-value"].label, "0.0°")
        XCTAssertFalse(capture.isEnabled, "The reference aid never calibrates or records automatically")
        XCTAssertFalse(app.buttons["adjust-model-placement"].exists, "device attitude does not invent a model placement")
        let value = Float(angle.label.replacingOccurrences(of: "°", with: ""))
        XCTAssertNotNil(value); XCTAssertTrue((0...180).contains(value ?? -1))
        toggle.tap(); XCTAssertFalse(capture.isEnabled, "Hiding the reference does not change calibration eligibility")
        toggle.tap()
        let screenshot = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        screenshot.name = "Live device axes with freely tilted model"; screenshot.lifetime = .keepAlways; add(screenshot)
        XCUIDevice.shared.press(.home); app.activate()
        let resumed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label != %@", "—"), object: angle)
        XCTAssertEqual(XCTWaiter.wait(for: [resumed], timeout: 30), .completed,
            "device attitude resumes with fresh tracking even though model calibration was reset")
        XCTAssertFalse(capture.isEnabled)
        XCTAssertFalse(app.buttons["adjust-model-placement"].exists)
        // Exit without placing a model or creating a Pose in the disposable fixture.
        app.buttons["本地项目"].tap()
    }

    func testHardwareLANAndLiDAR() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let address = environment["ATLAS_HARDWARE_ADDRESS"],
              let pairingCode = environment["ATLAS_HARDWARE_CODE"],
              let name = environment["ATLAS_HARDWARE_MODEL"] else {
            throw XCTSkip("Provide a LAN test fixture to run on a physical LiDAR iPad")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        func allowPermissions() {
            for alert in springboard.alerts.allElementsBoundByIndex {
                let button = alert.buttons.matching(NSPredicate(format: "label IN %@", ["允许", "好", "OK", "Allow"])).firstMatch
                if button.exists { button.tap() }
            }
        }
        addUIInterruptionMonitor(withDescription: "Camera and local network access") { alert in
            let button = alert.buttons.matching(NSPredicate(format: "label IN %@", ["允许", "好", "OK", "Allow"])).firstMatch
            guard button.exists else { return false }
            button.tap(); return true
        }
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launchArguments = ["-serverAddress", address]
        app.launch()
        XCTAssertTrue(app.textFields["server-address-octet-0"].waitForExistence(timeout: 15))
        if environment["ATLAS_HARDWARE_LOCAL_ONLY"] == "1", let id = environment["ATLAS_HARDWARE_SESSION"] {
            let project = app.buttons["local-project-\(id)"]
            XCTAssertTrue(project.waitForExistence(timeout: 15)); project.tap()
        } else {
            let code = openPairingCodePrompt(in: app)
            code.tap(); code.typeText(pairingCode)
        }
        let capture = app.buttons["capture-pose"]
        let deadline = Date().addingTimeInterval(120)
        var retriedAfterPermission = false
        while !capture.exists && Date() < deadline {
            allowPermissions()
            if app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "接收失败：")).firstMatch.exists,
               app.buttons["retry-pairing"].isEnabled {
                if retriedAfterPermission { break }
                retriedAfterPermission = true; app.buttons["retry-pairing"].tap()
            }
            RunLoop.current.run(until: Date().addingTimeInterval(1))
        }
        XCTAssertTrue(capture.exists, app.debugDescription)
        XCTAssertTrue(app.staticTexts[name].exists)
        allowPermissions()
        XCTAssertTrue(app.staticTexts["LiDAR 已就绪"].waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertFalse(capture.isEnabled, "A real iPad must require calibration before recording")
        XCTAssertTrue(app.windows.firstMatch.frame.contains(capture.frame))
        let workspace = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        workspace.name = "Physical iPad LAN model and LiDAR"; workspace.lifetime = .keepAlways; add(workspace)
        if let vertices = environment["ATLAS_DISPLAY_VERTICES"].flatMap(Int.init),
           let faces = environment["ATLAS_DISPLAY_FACES"].flatMap(Int.init) {
            try verifyDisplaySettings(app, vertices: vertices, faces: faces)
        }
        app.buttons["本地项目"].tap()
        app.terminate(); app.launch()
        let localProject = environment["ATLAS_HARDWARE_SESSION"].map { app.buttons["local-project-\($0)"] } ?? app.staticTexts[name]
        XCTAssertTrue(localProject.waitForExistence(timeout: 15))
        localProject.tap()
        XCTAssertTrue(capture.waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts["LiDAR 已就绪"].waitForExistence(timeout: 30))
        if let vertices = environment["ATLAS_DISPLAY_VERTICES"].flatMap(Int.init),
           let faces = environment["ATLAS_DISPLAY_FACES"].flatMap(Int.init) {
            app.buttons["display-settings"].tap()
            waitForRenderSummary(app, label: "点云 · \(PointDensity.quarter.count(for: vertices).formatted()) / \(vertices.formatted()) 点")
            XCTAssertTrue(app.buttons["point-density"].label.contains("25%"), "opening preserves the selected point density")
            app.buttons["display-mode-mesh"].tap()
            waitForRenderSummary(app, label: "Mesh · \(faces.formatted()) / \(faces.formatted()) 面")
            app.buttons["mesh-quality"].tap(); app.buttons["自动"].tap()
            app.buttons["close-display-settings"].tap()
            XCTAssertFalse(capture.isEnabled, "display changes never calibrate or record a Pose")
        }
        app.buttons["本地项目"].tap()
    }

    private func waitForRenderSummary(_ app: XCUIApplication, label: String) {
        let summary = app.staticTexts["model-render-summary"]
        XCTAssertTrue(summary.waitForExistence(timeout: 15))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", label), object: summary)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 60), .completed, app.debugDescription)
    }

    private func verifyDisplaySettings(_ app: XCUIApplication, vertices: Int, faces: Int) throws {
        app.buttons["display-settings"].tap()
        XCTAssertTrue(app.buttons["mesh-quality"].waitForExistence(timeout: 10))
        app.buttons["display-mode-mesh"].tap()
        let meshReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: app.buttons["mesh-quality"])
        XCTAssertEqual(XCTWaiter.wait(for: [meshReady], timeout: 10), .completed)
        XCTAssertTrue(app.buttons["mesh-quality"].isEnabled)
        XCTAssertFalse(app.buttons["point-density"].isEnabled)
        app.buttons["mesh-quality"].tap(); app.buttons["流畅"].tap()
        waitForRenderSummary(app, label: "Mesh · \(min(faces, 180_000).formatted()) / \(faces.formatted()) 面")
        app.buttons["mesh-quality"].tap(); app.buttons["全量"].tap()
        waitForRenderSummary(app, label: "Mesh · \(faces.formatted()) / \(faces.formatted()) 面")
        let mesh = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        mesh.name = "Current workpiece full source mesh on iPad"; mesh.lifetime = .keepAlways; add(mesh)
        app.buttons["display-mode-points"].tap()
        XCTAssertFalse(app.buttons["mesh-quality"].isEnabled)
        app.buttons["point-density"].tap(); app.buttons["5%"].tap()
        waitForRenderSummary(app, label: "点云 · \(Int(ceil(Double(vertices) * 0.05)).formatted()) / \(vertices.formatted()) 点")
        app.buttons["point-density"].tap(); app.buttons["100%"].tap()
        waitForRenderSummary(app, label: "点云 · \(vertices.formatted()) / \(vertices.formatted()) 点")
        let cloud = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        cloud.name = "Current workpiece point density on iPad"; cloud.lifetime = .keepAlways; add(cloud)
        app.buttons["point-density"].tap(); app.buttons["25%"].tap()
        waitForRenderSummary(app, label: "点云 · \(Int(ceil(Double(vertices) * 0.25)).formatted()) / \(vertices.formatted()) 点")
        app.buttons["close-display-settings"].tap()
    }

    func testReceiveAndReopenOfflineProject() async throws {
        continueAfterFailure = false
        let base = "http://127.0.0.1:21990/__atlas/ipad"
        func request(_ path: String, method: String = "POST", token: String? = nil, body: Data? = nil) async throws -> [String: Any] {
            var request = URLRequest(url: URL(string: base + path)!)
            request.httpMethod = method; request.httpBody = body
            if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
            let (data, response) = try await URLSession.shared.data(for: request)
            XCTAssertTrue((200...299).contains((response as! HTTPURLResponse).statusCode), String(decoding: data, as: UTF8.self))
            return try JSONSerialization.jsonObject(with: data) as! [String: Any]
        }
        var model = Data()
        func append(_ value: UInt32) { var little = value.littleEndian; withUnsafeBytes(of: &little) { model.append(contentsOf: $0) } }
        for header: UInt32 in [0x534c5441, 1, 3, 3, 0, 0, 0, 0] { append(header) }
        for value: Float in [0, 0, 0, 0.5, 0, 0, 0, 0.5, 0] { append(value.bitPattern) }
        model.append(contentsOf: [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255])
        [UInt32(0), 1, 2].forEach { append($0) }
        let name = "iPad UI Test \(UUID().uuidString.prefix(8))"
        let manifest: [String: Any] = ["protocol": "atlas-ipad-teaching/1", "modelHash": SHA256.hash(data: model).map { String(format: "%02x", $0) }.joined(),
            "name": name, "sourceHash": "ui-test-model", "sourceMapId": "ui-test-model", "coordinateFrame": "virtual_origin",
            "distanceUnit": "meter", "verticalAxis": "Z", "vertices": 3, "indices": 3, "sampled": false, "originalVertices": 3, "byteLength": model.count,
            "bounds": ["min": ["x": 0, "y": 0, "z": 0], "max": ["x": 0.5, "y": 0.5, "z": 0]]]
        let ticket = try await request("/sessions", body: JSONSerialization.data(withJSONObject: ["manifest": manifest]))
        let id = ticket["id"] as! String, token = ticket["ownerToken"] as! String
        _ = try await request("/sessions/\(id)/model", method: "PUT", token: token, body: model)
        let app = XCUIApplication()
        XCUIDevice.shared.orientation = .landscapeLeft
        app.launch()
        let landscape = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in app.windows.firstMatch.frame.width > app.windows.firstMatch.frame.height }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [landscape], timeout: 10), .completed)
        let address = app.textFields["server-address-octet-0"]
        XCTAssertTrue(address.waitForExistence(timeout: 15))
        address.tap()
        address.typeText("127.0.0.1")
        let port = app.textFields["server-port"]; port.tap()
        if let current = port.value as? String, current != port.placeholderValue { port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count)) }
        port.typeText("21990\n")
        let code = app.textFields["pairing-code"]; code.tap(); code.typeText(ticket["pairingCode"] as! String)
        let capture = app.buttons["capture-pose"]
        XCTAssertTrue(capture.waitForExistence(timeout: 20))
        XCTAssertFalse(capture.isEnabled, "Simulator must not pretend to provide LiDAR poses")
        XCTAssertTrue(app.staticTexts[name].exists)
        XCTAssertTrue(app.windows.firstMatch.frame.contains(capture.frame), "Pose controls must fit inside the application window")
        print("Workspace window: \(app.windows.firstMatch.frame), Pose button: \(capture.frame), screen: \(XCUIScreen.main.screenshot().image.size)")
        let workspace = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); workspace.name = "iPad teaching workspace"; workspace.lifetime = .keepAlways; add(workspace)
        app.buttons["本地项目"].tap()
        XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: 10))
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts[name].waitForExistence(timeout: 15))
        app.staticTexts[name].tap()
        XCTAssertTrue(capture.waitForExistence(timeout: 15))
        XCUIDevice.shared.orientation = .portrait
        XCTAssertTrue(capture.waitForExistence(timeout: 5))
        XCTAssertTrue(app.windows.firstMatch.frame.contains(capture.frame), "Pose controls must remain visible in portrait")
        let status = try await request("/sessions/\(id)", method: "GET", token: token)
        XCTAssertEqual(status["status"] as? String, "paired", "Opening local work never uploads completion")
        app.buttons["本地项目"].tap()
        let home = XCTAttachment(screenshot: app.screenshot()); home.name = "iPad local library"; home.lifetime = .keepAlways; add(home)
    }
}
