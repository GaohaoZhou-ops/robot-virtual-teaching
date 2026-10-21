"""Two isolated browser devices, real UI edits and independently persisted results.

Run against an isolated Vite server: BASE_URL=http://127.0.0.1:21991 python tests/work_sync_ui_smoke.py
"""
import os
import time
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from teaching_transfer_ui_smoke import ready, snapshot, CHROME
from topbar_tools_helpers import topbar_action

MODE = os.environ.get("SYNC_TEST_MODE", "map")
BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21991").rstrip("/")


def home(page):
    if page.locator('[data-app-page="home"]:visible').count() == 0:
        page.get_by_role("button", name="主页面", exact=True).click() if page.locator('[data-app-page="teaching-data"]:visible').count() else topbar_action(page, name="返回主页面").click()
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()


def control(page):
    return page.locator('.work-sync:visible')


def approve(host, peer):
    peer.get_by_role("button", name="同步作业", exact=True).click()
    dialog = host.get_by_role("dialog", name="允许另一台设备同步作业？", exact=True)
    dialog.wait_for()
    dialog.get_by_role("button", name="允许同步（5 分钟）", exact=True).click()
    expect(control(peer)).to_have_attribute("data-sync-phase", "connected", timeout=60_000)
    expect(control(host)).to_have_attribute("data-sync-phase", "connected")


def teaching(page):
    if page.locator('[data-app-page="home"]:visible').count():
        page.get_by_role("button", name="继续工作", exact=True).first.click()
    topbar_action(page, name="打开示教数据管理页").click()
    tree = page.locator('[data-app-page="teaching-data"] .teaching-archive-tree')
    tree.wait_for()
    return tree


def rename_parking(tree, old, new):
    tree.get_by_role("button", name=f"选择停车点 {old}", exact=True).click()
    tree.get_by_label("停车点名称", exact=True).fill(new)
    tree.get_by_label("停车点名称", exact=True).press("Enter")


def rename_pose(tree, pose_id, new):
    tree.locator(f'[data-teaching-point-id="{pose_id}"] button').click()
    tree.get_by_label("机械臂姿态名称", exact=True).fill(new)
    tree.get_by_label("机械臂姿态名称", exact=True).press("Enter")


def shared_snapshots(host, peer):
    deadline = time.monotonic() + 12
    while True:
        left, right = snapshot(host, MODE), snapshot(peer, MODE)
        if left["project"]["virtualTeaching"] == right["project"]["virtualTeaching"]:
            return left, right
        assert time.monotonic() < deadline, "teaching results did not converge"
        host.wait_for_timeout(250)


def seed_host(page):
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate("""async mode => {
      const { teachingTransferFixture } = await import('/tests/teaching_transfer_helpers.mjs');
      const store = await import('/src/lib/sessionStore.js');
      const { sessionId } = await store.fetchServiceSession();
      const fixture = teachingTransferFixture(mode);
      fixture.config.config.project.virtualTeaching.jointPoses[0].joints.source = 'robot-preset';
      await store.saveWorkspaceMap(sessionId, fixture.map.mapId, fixture.map.name, fixture.map, mode);
      await store.saveWorkspaceConfig(sessionId, fixture.map.mapId, fixture.config.config, mode);
      await store.activateWorkspaceMode(sessionId, mode);
    }""", MODE)
    page.goto(BASE_URL + '/workbench', wait_until="networkidle")
    ready(page, MODE)


def insert_pose(page, tree):
    tree.get_by_role('button', name='插入动作', exact=True).click()
    dialog = page.get_by_role('dialog', name='插入动作', exact=True)
    dialog.get_by_role('button', name='确认插入', exact=True).click()


def run():
    errors, intervals = [], {"host": [], "peer": []}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=str(CHROME) if CHROME.exists() else None)
        host_context = browser.new_context(viewport={"width": 1440, "height": 1000})
        peer_context = browser.new_context(viewport={"width": 1440, "height": 1000})
        host, peer = host_context.new_page(), peer_context.new_page()
        peer.route("**/__atlas/work-sync/capabilities", lambda route: route.fulfill(json={"local": False}))
        for name, page in [("host", host), ("peer", peer)]:
            page.set_default_timeout(30_000)
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on("request", lambda request, device=name: intervals[device].append(time.monotonic()) if request.url.endswith('/exchange') else None)
        try:
            seed_host(host)
            home(host)
            expect(control(host)).to_have_attribute("data-sync-role", "host", timeout=70_000)
            peer.goto(BASE_URL, wait_until="networkidle")
            peer.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
            button = peer.get_by_role("button", name="同步作业", exact=True)
            expect(button).to_be_enabled()
            lan = peer.locator('.start-page__system > span').last.bounding_box()
            assert button.bounding_box()["x"] > lan["x"] + lan["width"]
            button.click()
            dialog = host.get_by_role("dialog", name="允许另一台设备同步作业？", exact=True)
            dialog.wait_for()
            host.screenshot(path="/tmp/atlas-work-sync-authorization.png", animations="disabled")
            dialog.get_by_role("button", name="拒绝", exact=True).click()
            expect(control(peer).get_by_role("status")).to_contain_text("未授权")
            assert snapshot(peer, MODE)["project"] is None, "no teaching data before approval"
            approve(host, peer)
            ready(peer, MODE)
            home(peer)
            expect(host.get_by_role("button", name="断开链接", exact=True)).to_be_visible()
            expect(peer.get_by_role("button", name="断开链接", exact=True)).to_be_visible()
            first_host, first_peer = shared_snapshots(host, peer)
            Path('/tmp/atlas-work-sync-initial-snapshots.json').write_text(json.dumps({"host": first_host, "peer": first_peer}, ensure_ascii=False))
            assert first_host["positions"] == first_peer["positions"]
            assert first_host["project"]["virtualTeaching"] == first_peer["project"]["virtualTeaching"]
            assert first_peer["project"]["robot"]["relativePath"] == "transfer/robot.urdf"
            peer.screenshot(path="/tmp/atlas-work-sync-connected.png", animations="disabled")
            peer.get_by_role("button", name="重新申请授权", exact=True).click()
            renewal = host.get_by_role("dialog", name="重新授权同步作业", exact=True)
            renewal.wait_for()
            renewal.get_by_role("button", name="允许同步（5 分钟）", exact=True).click()
            expect(control(peer).get_by_role("status")).to_contain_text("授权剩余")

            host_tree, peer_tree = teaching(host), teaching(peer)
            rename_parking(host_tree, f"{MODE}-inside", "Mac 停车点 A")
            rename_parking(peer_tree, f"{MODE}-outside", "协作停车点 B")
            expect(host_tree.get_by_role("button", name="选择停车点 协作停车点 B", exact=True)).to_be_visible(timeout=12_000)
            expect(peer_tree.get_by_role("button", name="选择停车点 Mac 停车点 A", exact=True)).to_be_visible(timeout=12_000)
            expect(host_tree).to_have_attribute("data-active-parking-point", f"{MODE}-inside")
            expect(peer_tree).to_have_attribute("data-active-parking-point", f"{MODE}-outside")
            rename_pose(host_tree, f"{MODE}-inside-pose", "Mac 已示教姿态")
            rename_pose(peer_tree, f"{MODE}-outside-pose", "协作端已示教姿态")
            for tree, name in [(host_tree, '协作停车点 B'), (peer_tree, 'Mac 停车点 A')]:
                expand = tree.get_by_role("button", name=f"展开停车点 {name}", exact=True)
                if expand.count():
                    expand.click()
            expect(host_tree.get_by_role("button", name="查看机械臂姿态 协作端已示教姿态", exact=True)).to_be_visible(timeout=12_000)
            expect(peer_tree.get_by_role("button", name="查看机械臂姿态 Mac 已示教姿态", exact=True)).to_be_visible(timeout=12_000)
            insert_pose(host, host_tree)
            insert_pose(peer, peer_tree)
            expect(host_tree).to_have_attribute('data-teaching-point-count', '4', timeout=12_000)
            expect(peer_tree).to_have_attribute('data-teaching-point-count', '4', timeout=12_000)
            # Save both browser databases before comparing actual result data.
            home(host); home(peer)
            host.wait_for_timeout(500)
            shared_host, shared_peer = shared_snapshots(host, peer)
            assert shared_host["project"]["virtualTeaching"] == shared_peer["project"]["virtualTeaching"]
            assert shared_peer["project"]["virtualTeaching"]["tasks"][0]["parkingPoints"][0]["poses"][0]["cameraCapture"]
            peer.get_by_role("button", name="断开链接", exact=True).click()
            expect(control(host)).to_have_attribute("data-sync-phase", "idle", timeout=8_000)
            expect(control(peer)).to_have_attribute("data-sync-phase", "idle")
            assert snapshot(host, MODE)["project"]["virtualTeaching"] == shared_host["project"]["virtualTeaching"]
            assert snapshot(peer, MODE)["project"]["virtualTeaching"] == shared_peer["project"]["virtualTeaching"]

            peer_tree = teaching(peer)
            rename_pose(peer_tree, f"{MODE}-outside-pose", "断开后继续示教")
            home(peer)
            host.wait_for_timeout(3500)
            assert snapshot(host, MODE)["project"]["virtualTeaching"]["tasks"][0]["parkingPoints"][1]["poses"][0]["name"] == "协作端已示教姿态"
            peer_map_id = snapshot(peer, MODE)["mapId"]
            approve(host, peer)
            host.wait_for_timeout(6500)
            assert snapshot(peer, MODE)["mapId"] == peer_map_id, "reauthorization retains the local workspace"
            assert snapshot(host, MODE)["project"]["virtualTeaching"]["tasks"][0]["parkingPoints"][1]["poses"][0]["name"] == "断开后继续示教"
            host.get_by_role("button", name="断开链接", exact=True).click()
            expect(control(peer)).to_have_attribute("data-sync-phase", "idle", timeout=8_000)
            persisted = snapshot(peer, MODE)["project"]["virtualTeaching"]
            peer.reload(wait_until="networkidle")
            peer.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
            assert snapshot(peer, MODE)["project"]["virtualTeaching"] == persisted
            peer.set_viewport_size({"width": 640, "height": 900})
            expect(peer.get_by_role("button", name="同步作业", exact=True)).to_be_visible()
            peer.screenshot(path="/tmp/atlas-work-sync-narrow.png", animations="disabled")
            for device, timestamps in intervals.items():
                gaps = [b - a for a, b in zip(timestamps, timestamps[1:]) if 2 < b - a < 4]
                assert len(gaps) >= 3, (device, timestamps)
                assert 2.7 < sum(gaps) / len(gaps) < 3.3, (device, gaps)
            assert not errors, errors
            print(f"work sync UI ({MODE}): initial resources, approval/rejection/renewal, 3s bilateral edits, independent selection, disconnect from either side, offline resume, reload persistence and narrow layout passed")
        except Exception:
            for label, page in [('host', host), ('peer', peer)]:
                print(label, page.locator('.work-sync').first.evaluate("element => ({ phase: element.dataset.syncPhase, role: element.dataset.syncRole, message: element.textContent })"))
            raise
        finally:
            if errors:
                print("page errors:", errors)
            host.screenshot(path="/tmp/atlas-work-sync-host-final.png", animations="disabled")
            peer.screenshot(path="/tmp/atlas-work-sync-peer-final.png", animations="disabled")
            host.goto('about:blank'); peer.goto('about:blank')
            browser.close()


if __name__ == "__main__":
    run()
