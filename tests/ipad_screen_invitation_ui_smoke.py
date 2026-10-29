"""USB invitation E2E; coordinate with testLiveUSBBidirectionalInvitations on a real iPad.

Run against an isolated Vite service with the updated native app installed.
Uses a fresh browser profile and fixture model; never changes the user's project.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from topbar_tools_helpers import topbar_action

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:22041')
OUT = ROOT / 'build/ipad-screen-invitations'
DEVICE = os.environ.get('ATLAS_SCREEN_DEVICE_ID', '00008122-0014118A2223801C')


def native_status():
    result = subprocess.run([sys.executable, str(ROOT / 'src/server/devices/ipadScreenUSB.py')], input=json.dumps({
        'action': 'request', 'deviceId': DEVICE, 'method': 'GET', 'path': '/status'}) + '\n',
        capture_output=True, text=True, timeout=8, check=True)
    return json.loads(result.stdout)['value']['body']


def run():
    if os.environ.get('ATLAS_SCREEN_LIVE') != '1':
        raise SystemExit('Set ATLAS_SCREEN_LIVE=1 to test the connected iPad.')
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'ready').unlink(missing_ok=True)
    errors, frames = [], []
    expect.set_options(timeout=30000)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=os.environ.get('PLAYWRIGHT_CHROMIUM_EXECUTABLE') or None,
                                    args=['--use-angle=metal', '--enable-gpu'] if sys.platform == 'darwin' else [])
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        page.set_default_timeout(60000)
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: frames.append(request.url) if '/ipad-screen/session/' in request.url
                and request.url.endswith(('/frame', '/workspace')) else None)
        page.goto(BASE + '/workbench', wait_until='networkidle')
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator('input[type="file"][accept=".ply"]').set_input_files(str(ROOT / 'tests/fixtures/ipad-screen-targets.ply'))
        page.locator('.loading-curtain').wait_for(state='hidden')
        topbar_action(page, name='加载机器人', exact=True).click()
        page.get_by_role('option', name='加载机器人 botx_abx_zivid_m70').click()
        page.wait_for_function("document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'")
        (OUT / 'ready').write_text('ready')
        print('INVITATION_BROWSER_READY', flush=True)
        incoming = page.get_by_role('dialog', name='接受 iPad 的协作邀请？', exact=True)
        expect(incoming).to_be_visible(timeout=180000)
        assert len(frames) == 0 and not native_status()['active']
        page.screenshot(path=str(OUT / 'desktop-incoming.png'))
        incoming.get_by_role('button', name='拒绝', exact=True).click()
        expect(incoming).not_to_be_visible()
        expect(incoming).to_be_visible()
        assert len(frames) == 0, 'refusal does not start streaming'
        incoming.get_by_role('button', name='接受邀请', exact=True).click()
        expect(incoming).not_to_be_visible()
        deadline = time.monotonic() + 45
        while len(frames) < 6 and time.monotonic() < deadline:
            page.wait_for_timeout(200)
        assert len(frames) >= 6 and native_status()['active']
        page.screenshot(path=str(OUT / 'desktop-accepted.png'))
        page.get_by_role('button', name='结束画面协作', exact=True).click()
        deadline = time.monotonic() + 10
        while native_status()['active'] and time.monotonic() < deadline:
            page.wait_for_timeout(200)
        assert not native_status()['active']
        topbar_action(page, name='iPad / iPhone', exact=True).click()
        page.get_by_role('menuitem', name='画面协作', exact=True).click()
        dialog = page.get_by_role('dialog', name='画面协作', exact=True)
        expect(dialog).to_be_visible()
        expect(dialog.get_by_role('button', name='发起邀请', exact=True)).to_be_enabled()
        before = len(frames)
        page.wait_for_timeout(700)
        assert len(frames) == before and not native_status()['active'], 'opening the window never auto-invites'
        dialog.get_by_role('button', name='发起邀请', exact=True).click()
        expect(dialog.get_by_text(re.compile(r'^等待 .+ 接受邀请$'))).to_be_visible()
        page.wait_for_timeout(700)
        assert len(frames) == before and not native_status()['active'], 'consent is required before sharing'
        page.screenshot(path=str(OUT / 'desktop-waiting.png'))
        expect(dialog.get_by_text('iPad 已拒绝此次协作邀请。', exact=True)).to_be_visible()
        assert len(frames) == before
        dialog.get_by_role('button', name='发起邀请', exact=True).click()
        page.wait_for_timeout(700)
        assert len(frames) == before and not native_status()['active']
        expect(dialog.get_by_text('正在共享双臂画面', exact=True)).to_be_visible()
        assert len(frames) > before
        expect(dialog.get_by_role('button', name='发起邀请', exact=True)).to_be_visible(timeout=30000)
        expect(incoming).to_be_visible()
        before_cancel = len(frames)
        expect(incoming).not_to_be_visible(timeout=15000)
        # XCTest may close the app immediately after its cancellation assertion.
        assert len(frames) == before_cancel, 'iPad cancellation withdraws the desktop popup without sharing'
        assert not errors, errors
        print('PASS: iPad invites with the desktop dialog closed; both sides accept/reject; no frames before consent; tablet cancellation withdraws the popup.', flush=True)
        browser.close()


if __name__ == '__main__':
    run()
