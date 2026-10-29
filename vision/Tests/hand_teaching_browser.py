"""Exercise the Vision-only built bundle against the real native local server."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright

connection = json.loads(Path(os.environ['VISION_WORKBENCH_CONNECTION']).read_text())
root = Path(__file__).resolve().parents[2]
artifacts = root / 'vision/build/hand-teaching'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors, robot_requests = [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: robot_requests.append(request.url) if '/robot-twin/' in request.url and request.method != 'GET' else None)
    page.add_init_script('window.AtlasVision=' + json.dumps({'native': True, 'immersive': True, 'token': connection['token']}) + ''';
      window.nativeMessages=[];
      window.webkit={messageHandlers:{atlasWorkbench:{postMessage:async message=>{
        nativeMessages.push(message); return message.type==='ready' ? {type:'resume',generation:7} : true;
      }}}};
      window.showSaveFilePicker=undefined;
    ''')
    page.goto(connection['origin'] + '/workbench')
    page.locator('[data-session-state="ready"]').wait_for(state='attached', timeout=30000)
    page.evaluate('(detail)=>window.dispatchEvent(new CustomEvent("atlas-vision-command",{detail}))',
                  {'type': 'import', 'id': connection['importID'], 'name': 'vision-hands.zip', 'generation': 7})
    page.wait_for_function('nativeMessages.some(m=>m.type==="openScene")', timeout=90000)
    # Native builds the same request from its displayed hierarchy after playback.
    page.evaluate('''() => {
      const scene = nativeMessages.findLast(m=>m.type==='openScene').manifest;
      const baseMatrix = scene.nodes.find(n=>n.id===scene.robotRoot).transform;
      window.handRequest = {token:'browser-hands', joints:Object.fromEntries(scene.nodes.filter(n=>n.joint).map(n=>[n.joint.name,n.joint.value])),
        baseMatrix, basePose:{position:{x:0.4,y:-0.3,z:0},rpy:{roll:0,pitch:0,yaw:20}}};
    }''')
    setup = page.evaluate('AtlasVisionHands.start(handRequest)')
    assert len(setup['jointNames']['left']) == 7 and len(setup['jointNames']['right']) == 7, setup
    original = page.evaluate('handRequest.joints')
    failed = page.evaluate('AtlasVisionHands.solve({...handRequest, targets:{left:{position:[100,100,100],quaternion:[0,0,0,1],epoch:1}}})')
    assert failed['left']['status'] == 'unreachable' and failed['left']['joints'] == {}
    stopped = page.evaluate('''async () => {
      AtlasVisionHands.stop();
      try { AtlasVisionHands.solve({...handRequest, targets:{}}); return false; } catch { return true; }
    }''')
    assert stopped, 'Closed sessions must reject delayed requests'
    page.evaluate('AtlasVisionHands.start(handRequest)')
    saved = page.evaluate('AtlasVisionHands.record({...handRequest,name:"Vision 双手记录"})')
    assert saved['name'] == 'Vision 双手记录'
    # Refresh must still resolve portable robot resources without any catalog
    # robot files on disk, and contain the recorded task/cameras.
    count = page.evaluate('nativeMessages.filter(m=>m.type==="openScene").length')
    page.evaluate('window.dispatchEvent(new CustomEvent("atlas-vision-command",{detail:{type:"scene",generation:7}}))')
    page.wait_for_function('(count)=>nativeMessages.filter(m=>m.type==="openScene").length>count', arg=count, timeout=90000)
    scene = page.evaluate('nativeMessages.findLast(m=>m.type==="openScene").manifest')
    assert any(node['name'] == 'tool_left' for node in scene['nodes'])
    assert any(node['name'] == 'zivid_right_optical_frame' for node in scene['nodes'])
    assert any(clip['taskId'] == saved['taskId'] for clip in scene['clips']), scene['clips']
    restored_joints = {node['joint']['name']: node['joint']['value'] for node in scene['nodes'] if node.get('joint')}
    assert restored_joints.keys() == original.keys()
    assert all(abs(restored_joints[name] - original[name]) < 0.0001 for name in original)
    # Reopen autosaved document in this isolated browser context.
    page.reload()
    page.wait_for_function('nativeMessages.some(m=>m.type==="openScene")', timeout=90000)
    reopened = page.evaluate('nativeMessages.findLast(m=>m.type==="openScene").manifest')
    assert any(clip['taskId'] == saved['taskId'] for clip in reopened['clips'])
    assert any(node['name'] == 'tool_right' for node in reopened['nodes'])
    assert len(reopened['clips']) >= 2, 'Original tasks must survive recording'
    assert not errors, errors
    assert not robot_requests, robot_requests
    page.screenshot(path=str(artifacts / 'document-roundtrip.png'), full_page=True)
    browser.close()
print('Vision built bridge: portable dual-arm import, unreachable hold, record, scene refresh, cameras, reload and zero robot actuation requests passed.')
