import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
CONNECTION = json.loads(Path(os.environ['VISION_WORKBENCH_CONNECTION']).read_text())
HOST = os.environ.get('VISION_WORKBENCH_HOST', 'http://127.0.0.1:22071')
FIXTURE = os.environ['VISION_WORKBENCH_FIXTURE']

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    host = browser.new_page(viewport={'width': 1440, 'height': 960})
    peer = browser.new_page(viewport={'width': 1440, 'height': 960})
    errors = []
    for page in [host, peer]: page.on('pageerror', lambda error: errors.append(str(error)))
    peer.add_init_script('window.AtlasVision = ' + json.dumps({'native': True, 'immersive': True, 'token': CONNECTION['token']}) + ''';
      window.nativeMessages=[];
      window.webkit={messageHandlers:{atlasWorkbench:{postMessage:async (m)=>{nativeMessages.push(m);return m.type==='ready'?null:true;}}}};
    ''')
    host.goto(HOST + '/workbench'); host.wait_for_load_state('networkidle')
    host.locator('[data-session-state="ready"]').wait_for(state='attached')
    host.locator('input[data-project-guide-input]').set_input_files(FIXTURE)
    host.locator('.loading-curtain').wait_for(state='hidden')
    expect(host.get_by_role('button', name='新建示教任务', exact=True)).to_be_enabled(timeout=30000)
    peer.goto(CONNECTION['origin'] + '/workbench'); peer.wait_for_load_state('networkidle')
    peer.locator('[data-session-state="ready"]').wait_for(state='attached')
    peer.evaluate('window.dispatchEvent(new CustomEvent("atlas-vision-command", {detail:{type:"sync"}}))')
    authorization = host.get_by_role('dialog', name='允许另一台设备同步作业？')
    expect(authorization).to_be_visible(timeout=20000)
    expect(authorization).to_contain_text('Vision Pro 工作台')
    assert not peer.evaluate('nativeMessages.some(m=>m.type==="openScene")'), 'Do not enter before Mac authorizes the new project'
    authorization.get_by_role('button', name='允许同步（5 分钟）').click()
    expect(peer.locator('.work-sync[data-sync-phase="connected"]')).to_be_visible(timeout=60000)
    expect(peer.locator('.map-identity')).to_contain_text('完整工作台演练.ply')
    expect(peer.get_by_role('button', name='新建示教任务', exact=True)).to_be_enabled(timeout=30000)
    peer.wait_for_function('nativeMessages.filter(m=>m.type==="openScene").length===1', timeout=60000)
    scene = peer.evaluate('nativeMessages.find(m=>m.type==="openScene").manifest')
    assert scene['robotRoot'] and scene['clips'], 'Synchronization must export the received complete project'

    def task(page, name):
        page.get_by_role('button', name='新建示教任务', exact=True).click()
        dialog = page.get_by_role('dialog', name='新建示教任务', exact=True)
        dialog.get_by_role('textbox', name='新示教任务名称').fill(name)
        dialog.get_by_role('button', name='创建任务', exact=True).click()
        expect(dialog).not_to_be_visible()

    task(peer, 'Vision Pro 双向同步')
    expect(host.locator('body')).to_contain_text('Vision Pro 双向同步', timeout=20000)
    task(host, 'Mac 回传任务')
    expect(peer.locator('body')).to_contain_text('Mac 回传任务', timeout=20000)
    peer.get_by_role('button', name='断开链接', exact=True).click()
    expect(peer.locator('.work-sync[data-sync-phase="idle"]')).to_be_visible()
    expect(peer.locator('body')).to_contain_text('Vision Pro 双向同步')
    peer.reload()
    peer.locator('[data-session-state="ready"]').wait_for(state='attached')
    expect(peer.get_by_role('button', name='新建示教任务', exact=True)).to_be_enabled(timeout=30000)
    expect(peer.locator('body')).to_contain_text('Mac 回传任务')
    assert not errors, errors
    browser.close()
print('Vision workbench sync: native proxy stays a peer; explicit Mac approval, complete project bootstrap, edits in both directions, disconnect and saved reload passed.')
