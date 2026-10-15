import hashlib
import json
import os
import re
import uuid
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("BASE_URL", "http://127.0.0.1:22001")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"


def api(path, body=None, token=None):
    request = Request(BASE + "/__atlas/ipad" + path,
                      data=json.dumps(body).encode() if body is not None else None,
                      headers={"Content-Type": "application/json", **({"Authorization": "Bearer " + token} if token else {})})
    with urlopen(request) as response:
        return json.load(response)


def ready(page):
    page.locator('[data-session-state="ready"]').wait_for(state='attached', timeout=30000)
    page.locator('.loading-curtain').wait_for(state='hidden', timeout=30000)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True, executable_path=CHROME)
    page = browser.new_page(viewport={"width": 1600, "height": 1000})
    page.set_default_timeout(30000)
    errors = []
    creations = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: creations.append(request.url)
            if request.method == 'POST' and request.url == BASE + '/__atlas/ipad/sessions' else None)
    page.goto(BASE + '/workbench')
    page.wait_for_load_state('networkidle')
    ready(page)
    page.locator('[data-independent-teaching-input="true"]').set_input_files(str(Path(__file__).parent / 'fixtures/rotation-map.ply'))
    ready(page)
    page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    dialog = page.get_by_role('dialog', name='移动到 iPad 或 Vision Pro 上运行')
    expect(dialog).to_be_visible()
    expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
    expect(dialog.locator('.ipad-code')).to_have_text(re.compile(r'^[A-Z0-9]{4}$'))
    assert len(creations) == 1, 'opening under StrictMode must create only one transfer'
    page.screenshot(path='/tmp/atlas-ipad-pairing.png', full_page=True)
    ticket = page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
    page.get_by_role('button', name='关闭设备示教窗口').click()
    page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
    expect(dialog.locator('.ipad-code')).to_have_text(ticket['pairingCode'])
    assert len(creations) == 1, 'reopening must reuse the ready transfer'
    page.set_viewport_size({"width": 1280, "height": 800})
    page.screenshot(path='/tmp/atlas-ipad-qr-1280.png', full_page=True)
    qr_bounds = dialog.get_by_role('img', name='设备配对二维码').bounding_box()
    assert 0 <= qr_bounds['x'] and qr_bounds['x'] + qr_bounds['width'] <= 1280
    assert 0 <= qr_bounds['y'] and qr_bounds['y'] + qr_bounds['height'] <= 800
    page.set_viewport_size({"width": 1600, "height": 1000})

    # A saved expired code is renewed automatically before displaying the QR.
    page.get_by_role('button', name='关闭设备示教窗口').click()
    page.evaluate("""() => {
        const items = JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'));
        items[0].pairingExpiresAt = Date.now() - 1000;
        localStorage.setItem('atlas-ipad-handoffs-v1', JSON.stringify(items));
    }""")
    page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
    renewed = page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
    assert renewed['id'] == ticket['id'] and renewed['pairingCode'] != ticket['pairingCode']
    assert len(creations) == 1
    ticket = renewed

    # Pair while closed: opening must fetch the true status and keep the paired task.
    page.get_by_role('button', name='关闭设备示教窗口').click()
    device_id = str(uuid.uuid4())
    paired = api('/pair', {"code": ticket['pairingCode'], "deviceId": device_id, "deviceName": "iPad Pro UI test"})
    page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    expect(dialog.locator('[data-ipad-status="paired"]')).to_be_visible()
    expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
    expect(dialog).to_contain_text('扫描二维码，同步示教结果')
    page.get_by_role('button', name='更新配对码').click()
    expect(dialog.locator('.ipad-code')).not_to_have_text(ticket['pairingCode'])
    expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
    ticket = page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
    assert len(creations) == 1, 'opening must not replace a paired task'
    request = Request(BASE + '/__atlas/ipad/sessions/' + ticket['id'] + '/model', headers={"Authorization": "Bearer " + paired['deviceToken']})
    with urlopen(request) as response:
        model = response.read()
    assert hashlib.sha256(model).hexdigest() == ticket['manifest']['modelHash']
    assert api('/sessions/' + ticket['id'], token=ticket['ownerToken'])['status'] == 'paired'
    result = json.loads(Path('/tmp/atlas-ipad-swift-result.json').read_text())
    result['sessionId'] = ticket['id']
    result['modelHash'] = ticket['manifest']['modelHash']
    # Real Swift-encoded optical pose contract, with the transfer-specific identity filled in.
    second = json.loads(json.dumps(result['samples'][0]))
    second['id'] = str(uuid.uuid4())
    second['name'] = 'Pose 002'
    second['cameraPose']['position']['x'] += 0.5
    result['samples'].append(second)
    def sync_result(target, data):
        connection = api('/pair-result', {"code": target['pairingCode'], "sessionId": target['id'],
            "serverId": api('/info')['serverId'], "deviceId": device_id, "deviceName": "iPad Pro UI test",
            "resultId": data['id'], "modelIdentity": {"modelHash": data['modelHash'], "byteLength": target['manifest']['byteLength']}})
        outgoing = {**data, "sessionId": target['id']}
        assert api('/sessions/' + target['id'] + '/result', outgoing, connection['deviceToken'])['received']

    sync_result(ticket, result)
    page.locator('[data-ipad-status="completed"]').wait_for()
    page.get_by_role('button', name='接收示教结果', exact=True).click()
    page.locator('[data-ipad-status="imported"]').wait_for()
    page.get_by_role('button', name='再次接收（去重）').click()
    expect(page.get_by_role('button', name='再次接收（去重）')).to_be_enabled()
    # Reuse the ready QR from a new transfer for the same completed result.
    page.get_by_role('button', name='新建传输').click()
    expect(dialog.get_by_role('img', name='设备配对二维码')).to_be_visible()
    next_ticket = page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
    assert next_ticket['id'] != ticket['id']
    sync_result(next_ticket, result)
    page.locator('[data-ipad-status="completed"]').wait_for()
    page.get_by_role('button', name='接收示教结果', exact=True).click()
    page.locator('[data-ipad-status="imported"]').wait_for()
    page.get_by_role('button', name='关闭设备示教窗口').click()
    page.get_by_role('button', name='打开示教数据管理页').click()
    detail = page.get_by_role('region', name='iPad 示教结果')
    expect(detail).to_contain_text('2 个 Pose')
    assert page.locator('.teaching-data-page').get_attribute('data-teaching-task-count') == '1'
    page.screenshot(path='/tmp/atlas-ipad-result.png', full_page=True)
    with page.expect_download() as info:
        page.get_by_role('button', name='导出 iPad 示教 JSON').click()
    exported = json.loads(Path(info.value.path()).read_text())
    assert len(exported['samples']) == 2
    assert exported['samples'][0]['name'] == 'Pose 001'
    page.reload(wait_until='networkidle')
    ready(page)
    expect(page.get_by_role('region', name='iPad 示教结果')).to_contain_text('2 个 Pose')
    page.get_by_role('button', name='继续工作 · 返回主工作台继续示教').click()
    page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    expect(page.locator('[data-ipad-status="imported"]')).to_be_visible()
    # The imported label comes from localStorage on the initial render. Wait
    # for opening preparation to reach the network response before checking
    # that controls are enabled; otherwise Escape can race that operation.
    expect(dialog.get_by_label('电脑局域网地址')).to_be_visible()
    expect(page.get_by_role('button', name='关闭设备示教窗口')).to_be_enabled()
    dialog.press('Escape')
    expect(dialog).not_to_be_visible()
    # Narrow desktop viewport: the entry and dialog remain reachable.
    page.set_viewport_size({"width": 1280, "height": 800})
    page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    expect(dialog).to_be_visible()
    page.screenshot(path='/tmp/atlas-ipad-pairing-1280.png', full_page=True)
    assert len(creations) == 2, 'opening must preserve completed/imported tasks after the explicit new transfer'

    # A failed upload can resume the same transfer without creating an orphan task.
    retry_page = browser.new_page(viewport={"width": 1280, "height": 800})
    retry_page.set_default_timeout(30000)
    retry_page.on('pageerror', lambda error: errors.append(str(error)))
    retry_creations = []
    retry_page.on('request', lambda request: retry_creations.append(request.url)
                  if request.method == 'POST' and request.url == BASE + '/__atlas/ipad/sessions' else None)
    retry_page.goto(BASE + '/workbench', wait_until='networkidle')
    ready(retry_page)
    retry_page.locator('[data-independent-teaching-input="true"]').set_input_files(str(Path(__file__).parent / 'fixtures/rotation-map.ply'))
    ready(retry_page)
    retry_page.route('**/__atlas/ipad/sessions/*/model', lambda route: route.fulfill(
        status=503, content_type='application/json', body=json.dumps({'error': '测试模型上传中断'})))
    retry_page.get_by_role('button', name='移动到 iPad 或 Vision Pro 上运行').click()
    expect(retry_page.get_by_role('alert')).to_have_text('测试模型上传中断')
    failed = retry_page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
    retry_page.unroute('**/__atlas/ipad/sessions/*/model')
    retry_page.get_by_role('button', name='重试生成二维码').click()
    expect(retry_page.get_by_role('img', name='设备配对二维码')).to_be_visible()
    resumed = retry_page.evaluate("JSON.parse(localStorage.getItem('atlas-ipad-handoffs-v1'))[0]")
    assert failed['id'] == resumed['id'] and resumed['status'] == 'ready'
    assert len(retry_creations) == 1, 'retry must resume the preparing transfer'

    # Explicitly starting another transfer still prepares and displays its QR automatically.
    retry_page.get_by_role('button', name='新建传输').click()
    expect(retry_page.locator('.ipad-code')).not_to_have_text(resumed['pairingCode'])
    expect(retry_page.get_by_role('img', name='设备配对二维码')).to_be_visible()
    assert len(retry_creations) == 2
    assert not errors, errors
    browser.close()
print('Automatic QR, paired QR renewal, QR result sync to original/new transfer, automatic completion detection, import deduplication, export and reload passed.')
