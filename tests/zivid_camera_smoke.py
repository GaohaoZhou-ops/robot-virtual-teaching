from topbar_tools_helpers import topbar_action

import os
import math
from pathlib import Path

from playwright.sync_api import sync_playwright

from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:21990")
ROOT = Path(__file__).resolve().parents[1]


def vector_attribute(locator, name):
    return tuple(float(value) for value in locator.get_attribute(name).split(","))


def run():
    errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or None,
        )
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.set_default_timeout(180_000)
        page.on("pageerror", lambda error: errors.append(str(error)))

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        assert page.locator(".zivid-camera-panel").count() == 0

        page.locator('input[type="file"][accept=".ply"]').set_input_files(
            str(ROOT / "tests/fixtures/rotation-map.ply")
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        topbar_action(page, name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
            timeout=180_000,
        )

        main_canvas = page.locator(".three-canvas")
        camera_tab = page.get_by_role("tab", name="相机")
        camera_tab.click()
        assert camera_tab.get_attribute("aria-selected") == "true"
        assert page.get_by_label("全关节控制浮动窗口", exact=True).count() == 0
        panel = page.locator('.zivid-camera-panel[data-camera-slot="left"]')
        right_panel = page.locator('.zivid-camera-panel[data-camera-slot="right"]')
        panel.wait_for()
        right_panel.wait_for()
        page.wait_for_function("""() => {
          const panels = [...document.querySelectorAll('.zivid-camera-panel')];
          return panels.length === 2 && panels.every(panel => panel.dataset.rendererStatus === 'ready');
        }""")
        for width, height in ((980, 640), (1024, 768), (1440, 900), (1600, 1000)):
            page.set_viewport_size({"width": width, "height": height})
            page.wait_for_timeout(180)
            left_box, right_box = panel.bounding_box(), right_panel.bounding_box()
            area = page.locator('.inspector-scroll[data-page-scroll="camera"]').bounding_box()
            assert left_box["y"] + left_box["height"] + 9 <= right_box["y"]
            assert abs(left_box["height"] - right_box["height"]) < 1
            assert left_box["y"] >= area["y"]
            assert right_box["y"] + right_box["height"] <= area["y"] + area["height"]
            for camera in (panel, right_panel):
                box = camera.get_by_label("M70 相机画面交互区", exact=True).bounding_box()
                assert box["height"] > 100
                assert abs(box["width"] / box["height"] - 1944 / 1200) < 0.01
                projection = vector_attribute(camera.locator(".zivid-camera-canvas"), "data-projection")
                assert abs(2 * math.degrees(math.atan(1 / projection[0])) - 56.6) < 0.0001
                assert abs(2 * math.degrees(math.atan(1 / projection[5])) - 35.6) < 0.0001
            assert page.locator('.inspector-scroll[data-page-scroll="camera"]').evaluate(
                "element => element.scrollHeight <= element.clientHeight"
            )
            page.screenshot(path=f"/tmp/atlas-zivid-stereo-{width}x{height}.png", full_page=True)
        page.set_viewport_size({"width": 1440, "height": 900})
        assert page.get_by_label("主3D辅助视角").count() == 0
        assert panel.get_attribute("data-zivid-model") == "zivid-2-m70"
        assert panel.get_attribute("data-horizontal-fov") == "56.6"
        assert panel.get_attribute("data-vertical-fov") == "35.6"
        assert panel.get_attribute("data-working-near") == "0.3"
        assert panel.get_attribute("data-working-far") == "1.3"
        assert panel.get_attribute("data-native-resolution") == "1944x1200"
        assert panel.get_attribute("data-optical-frame") == "zivid_left_optical_frame"
        page.wait_for_function(
            "document.querySelector('[data-zivid-model=\"zivid-2-m70\"]')?.dataset.rendererStatus === 'ready'"
        )
        camera_canvas = panel.locator(".zivid-camera-canvas")
        assert camera_canvas.get_attribute("data-camera-ready") == "true"
        assert camera_canvas.get_attribute("data-render-mode") == "rgb"
        assert int(camera_canvas.get_attribute("data-render-point-count")) > 0
        assert camera_canvas.get_attribute("data-optical-frame") == "zivid_left_optical_frame"
        assert right_panel.locator(".zivid-camera-canvas").get_attribute("data-optical-frame") == "zivid_right_optical_frame"

        panel.get_by_role("button", name="点云", exact=True).click()
        page.wait_for_function(
            "document.querySelector('[data-camera-slot=\"left\"] .zivid-camera-canvas')?.dataset.renderMode === 'pointcloud'"
        )
        assert camera_canvas.get_attribute("data-render-mode") == "pointcloud"
        assert panel.get_by_label("点云深度色标").is_visible()
        assert right_panel.get_attribute("data-render-mode") == "rgb"

        panel.get_by_role("button", name="放大相机画面").click()
        panel.get_by_role("button", name="放大相机画面").click()
        page.wait_for_function(
            "Number(document.querySelector('[data-camera-slot=\"left\"] .zivid-camera-canvas')?.dataset.digitalZoom) > 2"
        )
        assert float(camera_canvas.get_attribute("data-digital-zoom")) > 2

        left_zoom = panel.get_attribute("data-zoom")
        assert right_panel.get_attribute("data-camera-side") == "right"
        assert right_panel.get_attribute("data-zoom") == "1.00"
        right_panel.get_by_role("button", name="放大相机画面").click()
        assert float(right_panel.get_attribute("data-zoom")) > 1
        assert panel.get_attribute("data-zoom") == left_zoom
        right_panel.get_by_role("button", name="重置相机缩放").click()

        before_position = vector_attribute(main_canvas, "data-zivid-right-optical-position")
        before_revision = int(main_canvas.get_attribute("data-zivid-camera-pose-revision"))
        viewer_tool(page, name="定位机器人模型").click()
        page.keyboard.press("w")
        page.wait_for_function(
            "([revision]) => Number(document.querySelector('.three-canvas')?.dataset.zividCameraPoseRevision) > revision",
            arg=[before_revision],
        )
        after_position = vector_attribute(main_canvas, "data-zivid-right-optical-position")
        assert any(abs(after - before) > 0.02 for after, before in zip(after_position, before_position))

        right_panel.get_by_role("button", name="放大 Zivid 相机视图").click()
        dialog = page.get_by_role("dialog", name="Zivid 2 M70 相机大图")
        dialog.wait_for()
        expanded_panel = dialog.get_by_label("Zivid 2 M70 相机视图")
        assert expanded_panel.is_visible()
        assert expanded_panel.get_attribute("data-camera-side") == "right"
        assert page.locator(".zivid-camera-panel").count() == 1
        expanded_panel.get_by_role("button", name="左臂 M70").click()
        assert expanded_panel.get_attribute("data-optical-frame") == "zivid_left_optical_frame"
        expanded_panel.get_by_role("button", name="右臂 M70").click()
        assert expanded_panel.get_attribute("data-optical-frame") == "zivid_right_optical_frame"
        assert expanded_panel.locator(".zivid-camera-canvas").is_visible()
        camera_stage = dialog.get_by_label("Zivid相机主画面", exact=True)
        side_stack = dialog.get_by_label("相机控制与主3D辅助区", exact=True)
        camera_controls = dialog.get_by_label("相机视角反算示教", exact=True)
        preview = dialog.get_by_label("主3D辅助视角", exact=True)
        preview.wait_for()
        camera_viewport = dialog.get_by_label("M70 相机画面交互区", exact=True)
        stage_bounds = camera_stage.bounding_box()
        side_stack_bounds = side_stack.bounding_box()
        controls_bounds = camera_controls.bounding_box()
        camera_bounds = camera_viewport.bounding_box()
        preview_bounds = preview.bounding_box()
        assert all((stage_bounds, side_stack_bounds, controls_bounds, camera_bounds, preview_bounds))
        assert abs(side_stack_bounds["x"] - (stage_bounds["x"] + stage_bounds["width"])) < 3
        assert stage_bounds["width"] > side_stack_bounds["width"] * 1.75
        assert controls_bounds["y"] < preview_bounds["y"]
        assert controls_bounds["y"] + controls_bounds["height"] <= preview_bounds["y"] + 3
        assert abs(controls_bounds["x"] - preview_bounds["x"]) < 3
        assert abs(controls_bounds["width"] - preview_bounds["width"]) < 3
        assert camera_bounds["x"] >= stage_bounds["x"] - 1
        assert camera_bounds["y"] >= stage_bounds["y"] - 1
        assert camera_bounds["x"] + camera_bounds["width"] <= stage_bounds["x"] + stage_bounds["width"] + 1
        assert camera_bounds["y"] + camera_bounds["height"] <= stage_bounds["y"] + stage_bounds["height"] + 1
        assert abs((camera_bounds["width"] / camera_bounds["height"]) - (1944 / 1200)) < 0.01
        assert camera_stage.get_attribute("data-native-aspect-ratio") == "1944:1200"
        assert camera_stage.get_attribute("data-view-layout") == "native-aspect-camera"
        assert side_stack.get_attribute("data-stack-order") == "camera-controls,main-3d"
        assert preview.get_attribute("data-preview-layout") == "below-camera-controls"
        assert expanded_panel.get_attribute("data-expanded-layout") == "camera-priority"
        assert expanded_panel.get_attribute("data-main-view-preview") == "below-camera-controls"
        expanded_camera_canvas = expanded_panel.locator(".zivid-camera-canvas")
        page.wait_for_function(
            """() => {
              const canvas = document.querySelector('.zivid-camera-panel.is-expanded .zivid-camera-canvas');
              return canvas?.height > 0 && Math.abs((canvas.width / canvas.height) - (1944 / 1200)) < 0.02;
            }"""
        )
        canvas_bounds = expanded_camera_canvas.bounding_box()
        assert canvas_bounds
        assert abs(canvas_bounds["width"] - camera_bounds["width"]) < 1
        assert abs(canvas_bounds["height"] - camera_bounds["height"]) < 1
        page.wait_for_function(
            """() => document.querySelector('.zivid-main-view-preview')
              ?.dataset.previewStatus === 'live'"""
        )
        assert preview.get_attribute("data-preview-transport") in {
            "capture-stream",
            "canvas-copy",
        }
        assert preview.get_attribute("data-preview-source") == "three-canvas"
        assert int(preview.get_attribute("data-preview-source-width")) > 0
        assert int(preview.get_attribute("data-preview-source-height")) > 0
        initial_preview_frame = int(preview.get_attribute("data-preview-frame-count"))
        page.wait_for_function(
            """frame => Number(document.querySelector('.zivid-main-view-preview')
              ?.dataset.previewFrameCount) > frame""",
            arg=initial_preview_frame,
        )
        page.wait_for_function(
            """() => {
              const preview = document.querySelector('.zivid-main-view-preview');
              const source = document.querySelector('.three-canvas');
              return Boolean(preview?.dataset.sourceViewSignature)
                && preview.dataset.sourceViewSignature === source?.dataset.viewSignature;
            }"""
        )
        assert preview.get_attribute("data-preview-zoom") == "1.00"
        assert preview.get_attribute("data-preview-max-zoom") == "8"
        camera_zoom_before = expanded_panel.get_attribute("data-zoom")
        preview.get_by_role("button", name="放大主3D视角").click()
        preview.get_by_role("button", name="放大主3D视角").click()
        page.wait_for_function(
            """() => Number(document.querySelector('.zivid-main-view-preview')
              ?.dataset.previewZoom) > 2"""
        )
        preview_transport = preview.get_attribute("data-preview-transport")
        preview_media = preview.locator(
            "video" if preview_transport == "capture-stream" else "canvas"
        )
        page.wait_for_timeout(220)
        assert preview_media.evaluate(
            "node => getComputedStyle(node).transform !== 'none'"
        )
        assert expanded_panel.get_attribute("data-zoom") == camera_zoom_before

        preview.get_by_role("button", name="重置主3D视角缩放").click()
        assert preview.get_attribute("data-preview-zoom") == "1.00"
        preview_frame = preview.locator(".zivid-main-view-preview__frame")
        frame_bounds = preview_frame.bounding_box()
        assert frame_bounds
        page.mouse.move(
            frame_bounds["x"] + frame_bounds["width"] * 0.32,
            frame_bounds["y"] + frame_bounds["height"] * 0.68,
        )
        page.mouse.wheel(0, -520)
        page.wait_for_function(
            """() => Number(document.querySelector('.zivid-main-view-preview')
              ?.dataset.previewZoom) > 1"""
        )
        assert expanded_panel.get_attribute("data-zoom") == camera_zoom_before
        page.screenshot(path="/tmp/atlas-zivid-m70-camera.png", full_page=True)
        preview_frame.dblclick(position={"x": 28, "y": frame_bounds["height"] - 28})
        assert preview.get_attribute("data-preview-zoom") == "1.00"

        assert preview.get_attribute("data-preview-interaction-mode") == "rotate"
        view_before_rotate = main_canvas.get_attribute("data-view-signature")
        rotate_count_before = int(
            main_canvas.get_attribute("data-preview-rotate-control-count") or 0
        )
        page.mouse.move(
            frame_bounds["x"] + frame_bounds["width"] * 0.46,
            frame_bounds["y"] + frame_bounds["height"] * 0.42,
        )
        page.mouse.down()
        page.mouse.move(
            frame_bounds["x"] + frame_bounds["width"] * 0.62,
            frame_bounds["y"] + frame_bounds["height"] * 0.53,
            steps=4,
        )
        page.mouse.up()
        page.wait_for_function(
            """([signature, count]) => {
              const canvas = document.querySelector('.three-canvas');
              return canvas?.dataset.viewSignature !== signature
                && Number(canvas?.dataset.previewRotateControlCount || 0) > count;
            }""",
            arg=[view_before_rotate, rotate_count_before],
        )
        assert main_canvas.get_attribute("data-preview-control-mode") == "rotate"

        preview.get_by_role("button", name="主3D视角平移模式").click()
        assert preview.get_attribute("data-preview-interaction-mode") == "pan"
        view_before_pan = main_canvas.get_attribute("data-view-signature")
        pan_count_before = int(
            main_canvas.get_attribute("data-preview-pan-control-count") or 0
        )
        page.mouse.move(
            frame_bounds["x"] + frame_bounds["width"] * 0.55,
            frame_bounds["y"] + frame_bounds["height"] * 0.46,
        )
        page.mouse.down()
        page.mouse.move(
            frame_bounds["x"] + frame_bounds["width"] * 0.43,
            frame_bounds["y"] + frame_bounds["height"] * 0.58,
            steps=4,
        )
        page.mouse.up()
        page.wait_for_function(
            """([signature, count]) => {
              const canvas = document.querySelector('.three-canvas');
              return canvas?.dataset.viewSignature !== signature
                && Number(canvas?.dataset.previewPanControlCount || 0) > count;
            }""",
            arg=[view_before_pan, pan_count_before],
        )
        assert main_canvas.get_attribute("data-preview-control-mode") == "pan"
        assert expanded_panel.get_attribute("data-zoom") == camera_zoom_before
        page.screenshot(path="/tmp/atlas-zivid-m70-camera.png", full_page=True)
        expanded_panel.get_by_role("button", name="关闭 Zivid 相机大图").click()
        dialog.wait_for(state="detached")
        panel.wait_for()
        right_panel.wait_for()
        assert panel.get_attribute("data-zoom") == left_zoom
        assert panel.get_attribute("data-render-mode") == "pointcloud"
        panel.get_by_role("button", name="放大 Zivid 相机视图").click()
        dialog.wait_for()
        assert dialog.locator(".zivid-camera-panel").get_attribute("data-camera-side") == "left"
        page.keyboard.press("Escape")
        dialog.wait_for(state="detached")
        panel.wait_for(state="visible")
        right_panel.wait_for(state="visible")
        assert panel.is_visible() and right_panel.is_visible()
        assert page.locator(".zivid-camera-panel").count() == 2

        page.get_by_role("tab", name="示教", exact=True).click()
        assert page.locator(".zivid-camera-canvas").count() == 0
        camera_tab.click()
        page.wait_for_function("document.querySelectorAll('.zivid-camera-canvas').length === 2")
        assert panel.get_attribute("data-zoom") == left_zoom
        assert panel.get_attribute("data-render-mode") == "pointcloud"

        assert not errors, errors
        print("stereo cameras: layout, independent modes/zoom, enlargement, switching and restore passed")
        browser.close()


if __name__ == "__main__":
    run()
