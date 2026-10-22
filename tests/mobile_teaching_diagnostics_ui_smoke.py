"""Render stored failure reports against a Vite dev server in an isolated browser."""
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:21990').rstrip('/')
CHROME = os.environ.get('CHROME_EXECUTABLE', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
ARTIFACTS = ROOT / 'test-artifacts/mobile-teaching-diagnostics'

HARNESS = '''
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MobileTeachingSolveDialog from '../../src/components/MobileTeachingSolveDialog.jsx';
import MobileTeachingPoseList from '../../src/components/MobileTeachingPoseList.jsx';
import { DEFAULT_MOBILE_SOLVE_OPTIONS, MOBILE_SOLVE_VERSION } from '../../src/lib/mobileTeachingSolver.js';
import '../../src/styles.css';
const mapPose = { position: {x:0,y:0,z:0}, rpy:{roll:0,pitch:0,yaw:0} };
const measured = { feasible:false, mapPose, frameName:'zivid_left_optical_frame',
  positionError:{x:.01,y:-.02,z:.03}, rotationError:{roll:1,pitch:-2,yaw:3}, chestTilt:.4, chestTiltLowerBound:.27195, chestHeight:1.2,
  collision:{checked:false,clear:false} };
const rows = [
  { sampleId:'sample7', name:'Pose 007', feasible:false, mapPose, solutions:{
    left:measured, right:{...measured,frameName:'zivid_right_optical_frame',chestTilt:.01,
      collision:{checked:true,clear:false,selfPairs:[['right_L4','waist_yaw_L']],environmentLinks:[],groundLinks:[],
        armBodyClearance:{checked:true,clear:false,minimum:.02,required:.05,bySide:{left:.1,right:.02},limitingPair:['right_L4','waist_yaw_L']}}}}},
  { sampleId:'boundary', name:'临界超差', feasible:false, mapPose, solutions:{
    left:{...measured,chestTilt:.01,positionError:{x:.05000002,y:0,z:0},rotationError:{roll:0,pitch:0,yaw:5.0000002}}}},
  { sampleId:'missing', name:'缺少末端', feasible:false, mapPose, solutions:{
    left:{feasible:false,mapPose,reason:'该机械臂或目标坐标系不存在'}}},
  { sampleId:'unknown', name:'旧报告缺少原因', feasible:false, mapPose, solutions:{
    left:{...measured,chestTilt:.01,collision:{checked:true,clear:true}}}},
  { sampleId:'pass', name:'通过示例', feasible:true, selectedSide:'left', mapPose, solutions:{
    left:{...measured,feasible:true,chestTilt:.01,collision:{checked:true,clear:true}},
    right:{feasible:false,skipped:true,mapPose,reason:'未分配'}}},
];
const task = {id:'diagnostic-fixture',name:'失败原因回归样例',coordinateFrame:'virtual_origin',mobileCapture:{id:'capture',samples:rows.map(row=>({
  id:row.sampleId,name:row.name,kind:'keyframe',cameraPose:{position:{x:0,y:0,z:1},quaternion:{x:0,y:0,z:0,w:1}}
}))},mobileSolve:{version:MOBILE_SOLVE_VERSION,computedAt:'2026-10-23T00:00:00Z',options:DEFAULT_MOBILE_SOLVE_OPTIONS,
  mapPose,rows,feasibleCount:1,parkingCount:1,motionCount:1,dualMotionCount:0}};
function Harness() {
  const [open,setOpen]=useState(true),[sampleId,setSampleId]=useState('sample7');
  return <main style={{padding:24,maxWidth:400}}>
    <MobileTeachingPoseList task={task} robotTasks={[]} selection={{taskId:task.id,sampleId}}
      onSelect={(_,id)=>setSampleId(id)} onSolve={(_,id)=>{setSampleId(id);setOpen(true);}} />
    {open && <MobileTeachingSolveDialog task={task} robot={{id:'fixture',name:'测试机器人'}} robotPose={mapPose}
      robotLoadState={{status:'loaded'}} ready initialSampleId={sampleId} onClose={()=>setOpen(false)}
      onCalculate={(_,options)=>{window.submittedSolveOptions=options;}} />}
  </main>;
}
createRoot(document.getElementById('root')).render(<Harness/>);
'''


def run():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    html, entry = ARTIFACTS / 'index.html', ARTIFACTS / 'entry.jsx'
    html.write_text('<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>'
                    '<body><div id="root"></div><script type="module" src="./entry.jsx"></script></body></html>')
    entry.write_text(HARNESS)
    errors = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, executable_path=CHROME)
            try:
                page = browser.new_page(viewport={'width': 1440, 'height': 1000})
                page.on('pageerror', lambda error: errors.append(str(error)))
                page.goto(BASE + '/test-artifacts/mobile-teaching-diagnostics/index.html', wait_until='domcontentloaded')
                dialog = page.get_by_role('dialog', name='计算机器人姿态', exact=True)
                expect(dialog).to_be_visible()
                left = dialog.get_by_role('region', name='左臂未通过原因')
                right = dialog.get_by_role('region', name='右臂未通过原因')
                expect(left).to_contain_text('XYZ / RPY 均在容差内，仍未通过')
                expect(left).to_contain_text('倾角 0.40° > 0.25°')
                expect(left).to_contain_text('底盘侧倾使前胸倾角至少为 0.27°')
                expect(left).to_contain_text('放宽相机 XYZ / RPY 容差对此无效')
                expect(right).to_contain_text('机器人自身干涉：right_L4 ↔ waist_yaw_L')
                expect(right).to_contain_text('保守下界 2.00 cm，要求 ≥ 5.00 cm')
                expect(dialog.locator('.mobile-solve-error-grid .is-exceeded')).to_have_count(0)
                expect(dialog.get_by_role('button', name='应用左臂解', exact=True)).to_be_disabled()
                page.screenshot(path=str(ARTIFACTS / 'within-tolerance-failure.png'), full_page=True)

                # The new control is independent, reaches the calculation, and
                # does not retroactively pass a stored 0.25-degree report.
                chest_tolerance = dialog.get_by_role('spinbutton', name='前胸垂直容差 (°)')
                expect(chest_tolerance).to_have_value('0.25')
                chest_tolerance.fill('0.5')
                expect(left).to_contain_text('倾角 0.40° > 0.25°')
                expect(dialog.get_by_role('button', name='保存可达姿态', exact=True)).to_be_disabled()
                dialog.get_by_role('button', name='重新计算', exact=True).click()
                assert page.evaluate('window.submittedSolveOptions.chestTiltTolerance') == 0.5
                assert page.evaluate('window.submittedSolveOptions.checkCollisions') is True
                chest_tolerance.fill('0')
                expect(dialog.get_by_role('button', name='重新计算', exact=True)).to_be_disabled()
                expect(dialog.get_by_role('alert')).to_contain_text('前胸垂直容差')
                chest_tolerance.fill('0.5')

                dialog.get_by_role('button', name='临界超差', exact=True).click()
                expect(left).to_contain_text('位置容差超限')
                expect(left).to_contain_text('角度容差超限')
                expect(left).not_to_contain_text('均在容差内')
                expect(dialog.locator('.mobile-solve-error-grid .is-exceeded')).to_have_count(2)
                expect(dialog.locator('.mobile-solve-error-grid')).to_contain_text('5.000002')
                # Changing form tolerances does not reinterpret the stored report.
                dialog.get_by_role('spinbutton', name='X 位置容差 (cm)').fill('10')
                expect(left).to_contain_text('5.000002 cm > 5.000000 cm')
                expect(dialog.locator('.mobile-solve-error-grid .is-exceeded')).to_have_count(2)
                expect(dialog).to_contain_text('配置已修改，请重新计算')
                page.screenshot(path=str(ARTIFACTS / 'boundary-precision.png'), full_page=True)

                dialog.get_by_role('button', name='缺少末端', exact=True).click()
                expect(left).to_contain_text('该机械臂或目标坐标系不存在')
                expect(dialog.locator('.mobile-solve-error-grid')).to_have_count(0)
                dialog.get_by_role('button', name='旧报告缺少原因', exact=True).click()
                expect(left).to_contain_text('未记录具体失败原因，请重新计算')
                dialog.get_by_role('button', name='通过示例', exact=True).click()
                expect(dialog.locator('.mobile-solve-failure')).to_have_count(0)
                expect(dialog.locator('.mobile-solve-detail article')).to_have_count(1)

                dialog.get_by_role('button', name='Pose 007', exact=True).click()
                page.set_viewport_size({'width': 390, 'height': 844})
                left.scroll_into_view_if_needed()
                expect(left).to_be_visible()
                page.screenshot(path=str(ARTIFACTS / 'failure-mobile.png'), full_page=True)
                for selector in ['.mobile-solve-dialog', '.mobile-solve-results', '.mobile-solve-failure', '.mobile-solve-error-grid']:
                    sizes = page.locator(selector).evaluate_all('(els)=>els.map(el=>({width:el.clientWidth,scroll:el.scrollWidth}))')
                    assert all(size['scroll'] <= size['width'] + 1 for size in sizes), (selector, sizes)

                dialog.get_by_role('button', name='关闭姿态计算').click()
                detail = page.get_by_role('region', name='采样 Pose 详情')
                expect(detail).to_contain_text('XYZ / RPY 均在容差内，但仍未通过')
                expect(detail).to_contain_text('前胸未满足垂直约束')
                expect(detail).to_contain_text('right_L4 ↔ waist_yaw_L')
                detail.get_by_role('button', name='查看此 Pose 的计算结果').click()
                expect(left).to_contain_text('倾角 0.40° > 0.25°')
                assert not errors, errors
                print('Diagnostic UI: stored reasons, full constraint details, exact boundaries, edited settings, missing data, passing rows, pose list and narrow layout passed.')
            finally:
                browser.close()
    finally:
        html.unlink(missing_ok=True)
        entry.unlink(missing_ok=True)


if __name__ == '__main__':
    run()
