"""Verify separate map/object GPU colors, shared legend and portable preferences."""
from viewer_tools_helpers import display_settings_section
import base64
import json
import subprocess
import tempfile
from pathlib import Path
from playwright.sync_api import sync_playwright, expect
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready, snapshot
from archive_helpers import read_exported_project, start_project_download
from export_separation_ui_smoke import load_project
from viewport_reference_ui_smoke import check_layout
from waypoint_names_ui_smoke import display_settings

SEED = '''async ({points, legacy}) => {
  const {teachingTransferFixture} = await import('/tests/teaching_transfer_helpers.mjs');
  const {placeTeachingWorkspace, identityTransferPose} = await import('/src/lib/teachingTransfer.js');
  const store = await import('/src/lib/sessionStore.js');
  const {sessionId} = await store.fetchServiceSession();
  const make = mode => {
    const f = teachingTransferFixture(mode), x = mode === 'map' ? -3 : 0;
    let positions = [x-1,0,0, x+1,0,0, x+1,0,2, x-1,0,2];
    if(points) {positions = []; for(let i=0;i<=100;i++) for(let j=0;j<=100;j++) positions.push(x-1+i/50,0,j/50);}
    const colors = new Uint8Array(positions.length);
    for(let i=0;i<colors.length;i+=3) colors.set(mode === 'map' ? [190,55,25] : [25,180,65],i);
    Object.assign(f.map, {positionBuffer: new Float32Array(positions).buffer, colorBuffer: colors.buffer,
      indexBuffer: points ? null : new Uint16Array([0,1,2,0,2,3]).buffer, pointCount:positions.length/3,
      faceCount:points?0:2, bounds:{min:{x:x-1,y:0,z:0},max:{x:x+1,y:0,z:2}}});
    Object.assign(f.config.config.project.map, {pointCount:f.map.pointCount, bounds:f.map.bounds, faceCount:f.map.faceCount});
    f.config.config.project.robot.origin.position = {x:0,y:0,z:-10};
    f.config.config.project.virtualTeaching.tasks = [];
    f.config.config.project.waypoints = []; f.config.config.project.paths = [];
    return f;
  };
  const background = make('map'), object = make('independent');
  const pose=identityTransferPose(); pose.position.x=3;
  const result=await placeTeachingWorkspace(object, background, {localToMap:pose});
  result.config.project.view3d = {position:{x:0,y:-12,z:1}, target:{x:0,y:0,z:1}, up:{x:0,y:0,z:1}, zoom:1};
  if(legacy) delete result.config.project.workspace.transfer.geometryLayers;
  await store.saveWorkspaceMap(sessionId, object.map.mapId, object.map.name, object.map, 'independent');
  await store.saveWorkspaceConfig(sessionId, object.map.mapId, object.config.config, 'independent');
  await store.saveWorkspaceMap(sessionId, result.map.mapId, result.map.name, result.map, 'map');
  await store.saveWorkspaceConfig(sessionId, result.map.mapId, result.config, 'map');
  await store.activateWorkspaceMode(sessionId,'map');
  return {count:object.map.pointCount, total:result.map.pointCount};
}'''

def colors(page):
    canvas = page.locator('.three-canvas')
    positions = page.evaluate('''async () => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const c=document.querySelector('.three-canvas'),d=c.dataset;
      const camera=new THREE.PerspectiveCamera(Number(d.cameraFov), c.clientWidth/c.clientHeight, .001,1000);
      camera.position.set(...['X','Y','Z'].map(a=>Number(d['camera'+a])));
      camera.up.set(0,0,1); camera.lookAt(...['X','Y','Z'].map(a=>Number(d['target'+a])));
      camera.zoom=Number(d.opticalZoom); camera.updateProjectionMatrix();camera.updateMatrixWorld();
      return [-3,3].map(x=>{const p=new THREE.Vector3(x,0,1).project(camera); return [(p.x+1)*c.clientWidth/2,(1-p.y)*c.clientHeight/2];});
    }''')
    payload = json.dumps({'png':base64.b64encode(canvas.screenshot()).decode(), 'positions':positions})
    result = subprocess.run(['node','--input-type=module','-e', '''import {PNG} from 'pngjs'; import fs from 'node:fs';
const {png,positions}=JSON.parse(fs.readFileSync(0,'utf8')); const im=PNG.sync.read(Buffer.from(png,'base64'));
console.log(JSON.stringify(positions.map(([x,y])=>{const i=(Math.round(y)*im.width+Math.round(x))*4;return Array.from(im.data.subarray(i,i+3));})));'''], input=payload, text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def select_color(page, layer, mode):
    panel = display_settings_section(page, '地图与对象')
    button = panel.get_by_role('button', name=f'切换{layer}颜色模式', exact=True)
    for _ in range(3):
        if button.get_attribute('data-color-mode') == mode:
            break
        button.click()
    expect(button).to_have_attribute('data-color-mode', mode)
    page.keyboard.press('Escape')


def run():
    errors = []
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='atlas-layer-colors-', dir='/tmp') as temporary:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            for points, legacy in ((False, False), (True, True)):
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.on('console', lambda message: errors.append(message.text) if message.type == 'error' else None)
                page.goto(BASE_URL, wait_until='networkidle')
                page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
                counts = page.evaluate(SEED, {'points': points, 'legacy': legacy})
                page.goto(BASE_URL + '/workbench', wait_until='networkidle')
                ready(page, 'map')
                canvas = page.locator('.three-canvas')
                expect(canvas).to_have_attribute('data-placed-object-point-count', str(counts['count']))
                before = snapshot(page, 'map')
                baseline = [{}, {}]
                # Read actual framebuffer pixels. Each layer must keep its
                # color when the other control changes, including point clouds.
                for map_color in ('height', 'source', 'white'):
                    select_color(page, '地图', map_color)
                    for object_color in ('height', 'source', 'white'):
                        select_color(page, '独立对象', object_color)
                        samples = colors(page)
                        for layer, color in enumerate((map_color, object_color)):
                            previous = baseline[layer].setdefault(color, samples[layer])
                            assert max(abs(a-b) for a,b in zip(previous, samples[layer])) <= 2, (points, color, previous, samples)
                        expect(page.locator('.height-color-legend')).to_have_count(
                            1 if 'height' in (map_color, object_color) else 0)
                        check_layout(page)
                for palette in baseline:
                    assert max(abs(a-b) for a,b in zip(palette['source'], palette['white'])) > 30
                    assert max(abs(a-b) for a,b in zip(palette['height'], palette['source'])) > 8
                assert baseline[0]['height'] == baseline[1]['height'], 'Equal world heights must share the palette'

                # Object-only elevation still has one shared, hideable legend.
                select_color(page, '独立对象', 'height')
                panel = display_settings(page)
                display_settings_section(page, '地图与对象').get_by_role('button', name='隐藏高程色卡', exact=True).click()
                expect(page.locator('.height-color-legend')).to_have_count(0)
                check_layout(page)
                display_settings_section(page, '地图与对象').get_by_role('button', name='显示高程色卡', exact=True).click()
                expect(page.locator('.height-color-legend')).to_have_count(1)
                page.screenshot(path=f'/tmp/atlas-layer-colors-settings-{points}.png', full_page=True)
                page.keyboard.press('Escape')
                changed_at = page.evaluate('Date.now()')
                select_color(page, '独立对象', 'source')
                for _ in range(50):
                    saved = page.evaluate("""async changedAt => {
                  const store = await import('/src/lib/sessionStore.js');
                  const {sessionId} = await store.fetchServiceSession();
                  const {config, savedAt} = await store.loadWorkspaceConfig(sessionId, 'map');
                  return savedAt >= changedAt && config.ui.pointColorMode === 'white'
                    && config.ui.placedObjectColorMode === 'source'
                    && config.project.workspace.pointColorMode === 'white'
                    && config.project.workspace.placedObjectColorMode === 'source'
                    && config.project.workspace.transfer.geometryLayers.complete;
                }""", changed_at)
                    if saved:
                        break
                    page.wait_for_timeout(100)
                assert saved, 'The final color pair must finish saving before reload'
                page.reload(wait_until='networkidle')
                ready(page, 'map')
                expect(canvas).to_have_attribute('data-placed-object-point-count', str(counts['count']))
                expect(page.locator('.height-color-legend')).to_have_count(0)
                assert colors(page) == [baseline[0]['white'], baseline[1]['source']]
                after = snapshot(page, 'map')
                for key in ('mapId', 'sourceHash', 'pointCount', 'positions'):
                    assert after[key] == before[key]
                assert after['project']['virtualTeaching'] == before['project']['virtualTeaching']
                assert after['project']['waypoints'] == before['project']['waypoints']
                with page.expect_download() as downloaded:
                    start_project_download(page, 'layer-colors')
                exported = read_exported_project(downloaded.value)
                assert exported['workspace']['placedObjectColorMode'] == 'source'
                assert exported['workspace']['pointColorMode'] == 'white'
                assert exported['workspace']['transfer']['geometryLayers']['complete']
                archive = Path(temporary) / f'layers-{points}.zip'
                downloaded.value.save_as(archive)
                restored = browser.new_page(viewport={'width': 1440, 'height': 1000})
                restored.on('pageerror', lambda error: errors.append(str(error)))
                load_project(restored, 'map', archive)
                ready(restored, 'map')
                expect(restored.locator('.three-canvas')).to_have_attribute('data-placed-object-point-count', str(counts['count']))
                assert colors(restored) == [baseline[0]['white'], baseline[1]['source']]
                select_color(restored, '地图', 'height')
                select_color(restored, '独立对象', 'height')
                expect(restored.locator('.height-color-legend')).to_have_count(1)
                assert colors(restored) == [baseline[0]['height'], baseline[1]['height']]
                restored.close()
                page.close()
                print(f'PASS: points={points}, legacy={legacy}, nine color pairs, one legend, immutable data, reload and ZIP round trip', flush=True)
            assert not errors, errors
        finally:
            browser.close()


if __name__ == '__main__':
    run()
