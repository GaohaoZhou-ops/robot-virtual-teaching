"""Exercise real GPU occlusion of routes, markers and names, plus saved preferences."""
import json
import subprocess
import tempfile
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

from archive_helpers import read_exported_project, start_project_download
from export_separation_ui_smoke import load_project
from teaching_transfer_ui_smoke import BASE_URL, CHROME, ready, snapshot
from viewer_tools_helpers import display_settings_section
from waypoint_names_ui_smoke import switch_mode


def seed(page):
    page.goto(BASE_URL, wait_until='networkidle')
    page.locator('[data-app-page="home"][data-session-state="ready"]').wait_for()
    page.evaluate('''async () => {
      const {teachingTransferFixture} = await import('/tests/teaching_transfer_helpers.mjs');
      const store = await import('/src/lib/sessionStore.js');
      const {sessionId} = await store.fetchServiceSession();
      for (const mode of ['map', 'independent']) {
        const f = teachingTransferFixture(mode), project = f.config.config.project;
        Object.assign(f.map, {positionBuffer:new Float32Array([-4,0,0, -1,0,0, -1,0,3, -4,0,3]).buffer,
          colorBuffer:null, indexBuffer:new Uint16Array([0,1,2,0,2,3]).buffer,
          indexComponentType:'uint16', pointCount:4, faceCount:2,
          bounds:{min:{x:-4,y:0,z:0},max:{x:-1,y:0,z:3}}});
        Object.assign(project.map, {pointCount:4,faceCount:2,bounds:f.map.bounds});
        f.map.portableRobotPackage.files[0].bytes = new TextEncoder().encode(
          '<robot name="occluder"><link name="base_link"><visual><origin xyz="0 0 1.5"/>'
          + '<geometry><box size="3 1 3"/></geometry></visual></link></robot>');
        project.robot.origin = {position:{x:2,y:0,z:0}, rpy:{roll:0,pitch:0,yaw:0}};
        project.virtualTeaching.tasks = [];
        project.workspace.activeTeachingTaskId = null;
        project.workspace.activeTeachingParkingPointId = null;
        project.waypoints = [['M1',-3],['M2',-2],['R1',1.5],['R2',2.5],['E1',4.7],['E2',5.7]]
          .map(([id,x]) => ({id,name:id,pose:{x,y:1,z:1.3,roll:0,pitch:0,yaw:0}}));
        project.paths = ['M','R','E'].map(id => ({id,from:id+'1',to:id+'2',directed:true,connectivity:'connected'}));
        project.view3d = {position:{x:0,y:-22,z:1.5},target:{x:0,y:0,z:1.5},up:{x:0,y:0,z:1},zoom:1};
        Object.assign(project.workspace, {pointColorMode:'white',showPathNames3D:true,collapsedPanel:'2d',inspectorCollapsed:true});
        Object.assign(f.config.config.ui, project.workspace, {selectedRobot:project.robot});
        delete project.workspace.annotationsOnTop3D;
        delete f.config.config.ui.annotationsOnTop3D;
        await store.saveWorkspaceMap(sessionId,f.map.mapId,f.map.name,f.map,mode);
        await store.saveWorkspaceConfig(sessionId,f.map.mapId,f.config.config,mode);
      }
      await store.activateWorkspaceMode(sessionId,'map');
    }''')
    page.goto(BASE_URL + '/workbench', wait_until='networkidle')
    ready(page, 'map')


def toggle(page, label, value):
    button = display_settings_section(page, '路径与标注').get_by_role('switch', name=label, exact=True)
    if button.get_attribute('aria-checked') != str(value).lower():
        button.click()
    expect(button).to_have_attribute('aria-checked', str(value).lower())
    page.get_by_role('button', name='显示设置', exact=True).click()


def regions(page):
    return page.evaluate('''async () => {
      const THREE = await import('/node_modules/three/build/three.module.js');
      const c = document.querySelector('.three-canvas'), d=c.dataset, box=c.getBoundingClientRect();
      const camera = new THREE.PerspectiveCamera(Number(d.cameraFov), c.clientWidth/c.clientHeight,
        Number(d.cameraNear),Number(d.cameraFar));
      camera.position.set(...['X','Y','Z'].map(a=>Number(d['camera'+a])));
      camera.up.set(...['X','Y','Z'].map(a=>Number(d['cameraUp'+a])));
      camera.lookAt(...['X','Y','Z'].map(a=>Number(d['target'+a])));
      camera.zoom=Number(d.opticalZoom);camera.updateProjectionMatrix();camera.updateMatrixWorld();
      const result = {};
      const project = (x,z) => {
        const p=new THREE.Vector3(x,1,z).project(camera);
        return [(p.x+1)*c.clientWidth/2,(1-p.y)*c.clientHeight/2];
      };
      const elevation=Number(d.waypointRadius)/Math.cbrt(.14)*.25;
      for(const [id,x] of [['M',-2.5],['R',2],['E',5.2]]) {
        const [sx,sy]=project(x,1.3+elevation);
        result[id+'-route']=[sx-12,sy-4,24,8];
        const [mx,my]=project(x-.5,1.3);
        result[id+'-marker']=[mx-6,my-6,12,12];
      }
      for (const el of document.querySelectorAll('.waypoint-name-label,.path-name-label')) {
        const r=el.getBoundingClientRect(), id=el.dataset.edgeId||el.dataset.waypointId;
        result[id+'-label']=[r.left-box.left,r.top-box.top,r.width,r.height];
      }
      return {regions:result,width:box.width};
    }''')


def differences(before, after, boxes):
    result = subprocess.run(['node', '--input-type=module', '-e', '''
      import fs from 'node:fs';import {PNG} from 'pngjs';
      const {before,after,regions,width}=JSON.parse(fs.readFileSync(0,'utf8'));
      const a=PNG.sync.read(fs.readFileSync(before)),b=PNG.sync.read(fs.readFileSync(after)),scale=a.width/width;
      const output={};
      for(const [id,[x,y,w,h]] of Object.entries(regions)) {
        let changed=0;
        for(let j=Math.max(0,Math.floor(y*scale));j<Math.min(a.height,Math.ceil((y+h)*scale));j++)
          for(let i=Math.max(0,Math.floor(x*scale));i<Math.min(a.width,Math.ceil((x+w)*scale));i++) {
            const offset=(j*a.width+i)*4;
            if(Math.max(...[0,1,2].map(k=>Math.abs(a.data[offset+k]-b.data[offset+k])))>20) changed++;
          }
        output[id]=changed;
      }
      console.log(JSON.stringify(output));
    '''], input=json.dumps({'before':str(before),'after':str(after),**boxes}), text=True,
        capture_output=True, check=True)
    return json.loads(result.stdout)


def wait_saved(page, value):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if page.evaluate('''async value => {
          const store=await import('/src/lib/sessionStore.js');
          const s=await store.loadWorkspaceSnapshot((await store.fetchServiceSession()).sessionId,'map');
          return s.config?.config.ui.annotationsOnTop3D===value
            && s.config.config.project.workspace.annotationsOnTop3D===value;
        }''', value):
            return
        page.wait_for_timeout(100)
    raise AssertionError('Annotation preference was not saved')


def run():
    errors = []
    with sync_playwright() as p, tempfile.TemporaryDirectory(prefix='atlas-annotation-depth-') as directory:
        browser = p.chromium.launch(headless=True, executable_path=str(CHROME))
        try:
            page = browser.new_page(viewport={'width':1600,'height':1000}, device_scale_factor=2)
            page.on('pageerror', lambda error: errors.append(str(error)))
            seed(page)
            canvas=page.locator('.three-canvas')
            expect(canvas).to_have_attribute('data-annotations-on-top','true')
            original=snapshot(page,'map')
            page.wait_for_function("document.querySelector('.path-name-label')?.style.visibility==='visible'")
            boxes=regions(page)
            on=Path(directory)/'on.png';off=Path(directory)/'off.png';none=Path(directory)/'none.png'
            canvas.screenshot(path=str(on))
            toggle(page,'路径与标注置顶显示',False)
            expect(canvas).to_have_attribute('data-annotations-on-top','false')
            canvas.screenshot(path=str(off))
            page.screenshot(path='/tmp/atlas-annotations-depth.png',full_page=True)
            toggle(page,'显示路径',False)
            toggle(page,'显示停车点',False)
            canvas.screenshot(path=str(none))
            top_diffs=differences(on,none,boxes)
            depth_diffs=differences(off,none,boxes)
            for name in boxes['regions']:
                assert top_diffs[name]>10,(name,'missing top annotation',top_diffs)
                if name.startswith(('M','R')):
                    assert depth_diffs[name]<=5,(name,'annotation painted over model or robot',depth_diffs)
                else:
                    assert depth_diffs[name]>10,(name,'unoccluded annotation disappeared',depth_diffs)
            print('PASS: HiDPI framebuffer verifies routes, markers and names behind mesh/robot; exposed annotations remain',flush=True)
            toggle(page,'显示路径',True)
            toggle(page,'显示停车点',True)
            wait_saved(page,False)
            switch_mode(page,'independent')
            expect(canvas).to_have_attribute('data-annotations-on-top','true')
            switch_mode(page,'map')
            expect(canvas).to_have_attribute('data-annotations-on-top','false')
            page.reload(wait_until='networkidle');ready(page,'map')
            expect(canvas).to_have_attribute('data-annotations-on-top','false')
            restored=snapshot(page,'map')
            for key in ('mapId','pointCount','sourceHash','positions'):
                assert original[key]==restored[key],key
            for key in ('waypoints','paths','virtualTeaching','robot'):
                assert original['project'][key]==restored['project'][key],key
            with page.expect_download() as downloaded:
                start_project_download(page,'annotation-depth')
            assert read_exported_project(downloaded.value)['workspace']['annotationsOnTop3D'] is False
            archive=Path(directory)/'annotations.zip';downloaded.value.save_as(archive)
            imported=browser.new_page(viewport={'width':1600,'height':1000})
            imported.on('pageerror',lambda error:errors.append(str(error)))
            load_project(imported,'map',archive);ready(imported,'map')
            expect(imported.locator('.three-canvas')).to_have_attribute('data-annotations-on-top','false')
            toggle(imported,'路径与标注置顶显示',True)
            expect(imported.locator('.three-canvas')).to_have_attribute('data-annotations-on-top','true')
            assert not errors,errors
            print('PASS: legacy defaults, independent preferences, reload, ZIP import/export and immutable project data',flush=True)
        finally:
            browser.close()


if __name__=='__main__':
    run()
