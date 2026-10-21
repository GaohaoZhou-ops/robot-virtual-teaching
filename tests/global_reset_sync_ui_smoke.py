"""Reset a synced host in disposable profiles without erasing the peer's work."""
from playwright.sync_api import sync_playwright, expect
from work_sync_ui_smoke import BASE_URL, CHROME, seed_host, home, approve, control, shared_snapshots
from teaching_transfer_ui_smoke import snapshot


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        host = browser.new_context(viewport={'width': 1440, 'height': 1000}).new_page()
        peer = browser.new_context(viewport={'width': 1440, 'height': 1000}).new_page()
        errors = []
        for page in (host, peer):
            page.set_default_timeout(30000)
            page.on('pageerror', lambda error: errors.append(str(error)))
        peer.route('**/__atlas/work-sync/capabilities', lambda route: route.fulfill(json={'local': False}))
        try:
            seed_host(host); home(host)
            expect(control(host)).to_have_attribute('data-sync-role', 'host')
            peer.goto(BASE_URL, wait_until='networkidle')
            peer.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
            approve(host, peer)
            expect(peer.get_by_role('button', name='断开链接', exact=True)).to_be_visible()
            _, before = shared_snapshots(host, peer)
            host.get_by_role('button', name='全局重置', exact=True).click()
            dialog = host.get_by_role('alertdialog', name='确认全局重置？', exact=True)
            with host.expect_navigation(wait_until='networkidle'):
                dialog.get_by_role('button', name='确认全局重置', exact=True).click()
            expect(host.locator('[data-app-page="home"]')).to_have_attribute('data-map-workspace', 'empty')
            expect(control(peer)).to_have_attribute('data-sync-phase', 'idle', timeout=8000)
            assert snapshot(peer, 'map')['project']['virtualTeaching'] == before['project']['virtualTeaching']
            host.wait_for_timeout(3500)
            expect(host.locator('[data-app-page="home"]')).to_have_attribute('data-map-workspace', 'empty')
            assert snapshot(peer, 'map')['project']['virtualTeaching'] == before['project']['virtualTeaching']
            assert not errors, errors
            print('Global reset disconnects synchronization, preserves peer results and does not restore host data')
        finally:
            host.goto('about:blank'); peer.goto('about:blank')
            browser.close()


if __name__ == '__main__':
    run()
