import os

from playwright.sync_api import expect, sync_playwright

from viewer_tools_helpers import viewer_tool


BASE_URL = os.environ.get("BASE_URL", "http://127.0.0.1:22120")


def ply_payload(name, points, faces=None):
    faces = faces or []
    rows = "\n".join(f"{x:.9f} {y:.9f} {z:.9f}" for x, y, z in points)
    face_rows = "\n".join(
        f"{len(face)} {' '.join(str(index) for index in face)}" for face in faces
    )
    source = (
        "ply\n"
        "format ascii 1.0\n"
        f"element vertex {len(points)}\n"
        "property float x\n"
        "property float y\n"
        "property float z\n"
        f"element face {len(faces)}\n"
        "property list uchar int vertex_indices\n"
        "end_header\n"
        f"{rows}\n{face_rows}\n"
    )
    return {
        "name": name,
        "mimeType": "application/octet-stream",
        "buffer": source.encode("utf-8"),
    }


def wait_for_robot(page):
    page.wait_for_function(
        "document.querySelector('.three-canvas')?.dataset.robotModelState === 'loaded'",
        timeout=180_000,
    )


def run():
    page_errors = []
    console_errors = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            headless=True,
            executable_path=os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE") or None,
        )
        context = browser.new_context(viewport={"width": 1600, "height": 960})
        page = context.new_page()
        page.set_default_timeout(30_000)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )

        page.goto(f"{BASE_URL.rstrip('/')}/workbench", wait_until="networkidle")
        page.locator('[data-session-state="ready"]').wait_for()
        page.get_by_role("tab", name="示教").click()
        assert page.get_by_label("全关节控制浮动窗口", exact=True).count() == 0

        panel = page.get_by_label("虚拟示教", exact=True)
        assert panel.is_visible()
        assert page.get_by_label("自碰撞保护", exact=True).count() == 0
        assert panel.get_attribute("data-capture-surface") == "task-actions"
        assert viewer_tool(page, name="开启碰撞保护").count() == 0

        map_input = page.locator('input[type="file"][accept=".ply"]')
        map_input.set_input_files(
            ply_payload(
                "collision-safe-map.ply",
                [(20, 20, 20), (20.1, 20, 20), (20, 20.1, 20), (20, 20, 20.1)],
            )
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        toggle = viewer_tool(page, name="关闭碰撞保护")
        assert toggle.is_visible()
        assert toggle.count() == 1
        expect(toggle).to_have_attribute("aria-pressed", "true")
        canvas = page.locator(".three-canvas")
        expect(canvas).to_have_attribute("data-collision-state", "waiting")
        expect(canvas).to_have_attribute("data-collision-worker", "inactive")
        expect(page.get_by_label("碰撞保护距离", exact=True)).to_have_text("等待检测")
        # The default can still be disabled while waiting for a robot.
        toggle.click()
        expect(viewer_tool(page, name="开启碰撞保护")).to_be_disabled()
        expect(page.get_by_label("碰撞保护距离", exact=True)).to_have_count(0)
        page.get_by_role("button", name="加载机器人", exact=True).click()
        page.get_by_role("option", name="加载机器人 botx_abx_zivid_m70").click()
        wait_for_robot(page)
        page.get_by_role("tab", name="相机", exact=True).click()

        canvas = page.locator(".three-canvas")
        toggle = viewer_tool(page, name="关闭碰撞保护")
        assert not toggle.is_disabled()
        assert toggle.get_attribute("aria-pressed") == "true"
        assert page.get_by_role("group", name="机器人控制", exact=True).get_by_role(
            "button", name="关闭碰撞保护"
        ).is_visible()
        assert canvas.get_attribute("data-collision-protection-enabled") == "true"

        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.collisionState === 'safe'"
        )
        assert canvas.get_attribute("data-collision-worker") == "dedicated"
        assert canvas.get_attribute("data-collision-safety-distance") == "0.1"
        assert int(canvas.get_attribute("data-collision-indexed-points")) >= 4
        assert int(canvas.get_attribute("data-collision-monitored-link-count")) > 0
        assert int(canvas.get_attribute("data-collision-monitored-proxy-count")) > 0
        excluded = canvas.get_attribute("data-collision-excluded-links").split(",")
        assert "base_link" in excluded
        assert any(name.startswith("wheel_") for name in excluded)
        assert "arm_right_baselink" not in excluded
        distance_readout = page.locator(".panel-3d .panel-heading").get_by_label("碰撞保护距离", exact=True)
        expect(distance_readout).to_have_attribute("data-collision-state", "safe")
        assert "非底盘结构安全" in distance_readout.get_attribute("title")
        assert distance_readout.inner_text() == "≥100 mm"
        expect(page.get_by_label("机器人距离警告", exact=True)).to_have_count(0)
        distance_box = distance_readout.bounding_box()
        settings_box = page.get_by_role("button", name="显示设置", exact=True).bounding_box()
        assert distance_box["x"] + distance_box["width"] < settings_box["x"]
        assert abs(distance_box["y"] - settings_box["y"]) < 1
        print("default protection waits for a robot, then automatically displays the safe distance", flush=True)

        probe = tuple(
            float(value)
            for value in canvas.get_attribute("data-collision-probe-point").split(",")
        )
        probe_link = canvas.get_attribute("data-collision-probe-link")
        assert len(probe) == 3
        assert probe_link
        assert probe_link not in excluded

        viewer_tool(page, name="关闭碰撞保护").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.collisionProtectionEnabled === 'false'"
        )
        assert canvas.get_attribute("data-collision-worker") == "inactive"
        assert canvas.get_attribute("data-collision-highlighted-links") == ""
        expect(page.get_by_label("机器人距离警告", exact=True)).to_have_count(0)
        expect(distance_readout).to_have_count(0)
        viewer_tool(page, name="开启碰撞保护").click()
        expect(canvas).to_have_attribute("data-collision-state", "safe")
        viewer_tool(page, name="关闭碰撞保护").click()
        expect(canvas).to_have_attribute("data-collision-worker", "inactive")

        epsilon = 0.001
        collision_points = [
            probe,
            (probe[0] + epsilon, probe[1], probe[2]),
            (probe[0], probe[1] + epsilon, probe[2]),
            (probe[0], probe[1], probe[2] + epsilon),
        ]
        page.once("dialog", lambda dialog: dialog.accept())
        map_input.set_input_files(
            ply_payload("collision-probe-map.ply", collision_points, [(0, 1, 2)])
        )
        page.locator(".loading-curtain").wait_for(state="hidden")
        page.wait_for_function(
            "document.querySelector('.map-identity')?.textContent.includes('collision-probe-map.ply')"
        )
        wait_for_robot(page)
        canvas = page.locator(".three-canvas")
        expect(viewer_tool(page, name="关闭碰撞保护")).to_have_attribute("aria-pressed", "true")
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.collisionState === 'collision'"
        )
        collision_links = canvas.get_attribute("data-collision-links").split(",")
        assert probe_link in collision_links
        assert int(canvas.get_attribute("data-collision-mesh-samples")) > 0
        assert canvas.get_attribute("data-collision-highlight-color") == "#ff4545"
        expect(distance_readout).to_have_attribute("data-collision-state", "collision")
        assert "检测到环境干涉" in distance_readout.get_attribute("title")
        assert "红色部件" in distance_readout.get_attribute("title")
        assert distance_readout.inner_text() == "0 mm"
        warning = page.locator(".point-cloud-view").get_by_label("机器人距离警告", exact=True)
        expect(warning).to_be_visible()
        expect(warning).to_have_attribute("data-collision-state", "collision")
        assert probe_link in warning.get_attribute("data-collision-links")
        assert "检测到环境干涉" in warning.inner_text()
        assert page.locator(".zivid-camera-collision-alert").count() == 0
        print("collision distance and robot highlights updated", flush=True)
        camera_panel = page.locator('.zivid-camera-panel[data-camera-slot="left"]')
        camera_panel.get_by_role("button", name="放大 Zivid 相机视图").click()
        camera_dialog = page.get_by_role("dialog", name="Zivid 2 M70 相机大图")
        camera_dialog.wait_for()
        assert camera_dialog.get_by_label("机器人距离警告", exact=True).count() == 0
        assert camera_dialog.locator(".zivid-camera-collision-alert").count() == 0
        camera_dialog.screenshot(path="/tmp/atlas-zivid-camera-unobstructed.png")
        camera_dialog.get_by_role("button", name="关闭 Zivid 相机大图").click()
        camera_dialog.wait_for(state="detached")
        viewer_tool(page, name="定位机器人模型").click()
        page.wait_for_function(
            "document.querySelector('.three-canvas')?.dataset.robotControlEnabled === 'true'"
        )
        canvas.focus()
        observed_near = False
        observed_safe_after_near = False
        observed_states = set()
        for _ in range(80):
            page.keyboard.press("w", delay=120)
            # The detector intentionally coalesces rapid scene updates. Sample
            # at a little over its 160 ms cadence instead of requiring one
            # worker response for every individual keyboard step.
            page.wait_for_timeout(260)
            snapshot = page.evaluate(
                """() => ({ ...document.querySelector('.three-canvas')?.dataset })"""
            )
            state = snapshot.get("collisionState")
            observed_states.add(state)
            if state == "near" and not observed_near:
                observed_near = True
                distance = float(snapshot["collisionMinimumDistance"])
                assert 0.008 < distance < 0.1
                assert snapshot["collisionNearLinks"]
                assert snapshot["collisionHighlightColor"] == "#ffc84a"
                expect(distance_readout).to_have_attribute("data-collision-state", "near")
                assert "进入 100 mm 安全边界" in distance_readout.get_attribute("title")
                displayed_distance = float(distance_readout.inner_text().removesuffix(" mm"))
                assert abs(displayed_distance - distance * 1000) <= 0.501
                expect(warning).to_have_attribute("data-collision-state", "near")
                assert "距离低于 10 cm 安全阈值" in warning.inner_text()
                assert page.locator(".zivid-camera-collision-alert").count() == 0
                page.screenshot(path="/tmp/atlas-distance-warning-near.png", full_page=True)
                page.get_by_role("button", name="显示设置", exact=True).click()
                warning_switch = page.get_by_role("switch", name="显示距离警告", exact=True)
                expect(warning_switch).to_be_checked()
                warning_switch.click()
                expect(warning_switch).not_to_be_checked()
                expect(warning).to_have_count(0)
                expect(canvas).to_have_attribute("data-collision-protection-enabled", "true")
                expect(canvas).to_have_attribute("data-collision-worker", "dedicated")
                expect(canvas).to_have_attribute("data-collision-highlight-color", "#ffc84a")
                warning_switch.click()
                expect(warning).to_be_visible()
                page.get_by_role("button", name="关闭显示设置", exact=True).click()
                canvas.focus()
            if observed_near and state == "safe":
                observed_safe_after_near = True
                break

        assert observed_near, {
            "states": sorted(observed_states),
            "pose": snapshot.get("robotPosition"),
            "owner": snapshot.get("keyboardControlOwner"),
            "distance": snapshot.get("collisionMinimumDistance"),
            "checks": snapshot.get("collisionCheckCount"),
            "probe": probe_link,
        }
        assert observed_safe_after_near
        assert canvas.get_attribute("data-collision-highlighted-links") == ""
        assert canvas.get_attribute("data-collision-highlight-color") == "none"
        expect(distance_readout).to_have_attribute("data-collision-state", "safe")
        expect(warning).to_have_count(0)
        assert page.locator(".zivid-camera-collision-alert").count() == 0
        page.screenshot(path="/tmp/atlas-collision-protection.png", full_page=True)

        # Refresh restores the enabled default even after a manual disable.
        viewer_tool(page, name="关闭碰撞保护").click()
        expect(canvas).to_have_attribute("data-collision-worker", "inactive")
        page.reload(wait_until="domcontentloaded")
        page.locator('[data-session-state="ready"]').wait_for()
        page.locator(".loading-curtain").wait_for(state="hidden")
        wait_for_robot(page)
        page.get_by_role("tab", name="示教").click(force=True)
        canvas = page.locator(".three-canvas")
        assert page.get_by_label("自碰撞保护", exact=True).count() == 0
        expect(canvas).to_have_attribute("data-collision-worker", "dedicated")
        expect(canvas).to_have_attribute("data-collision-protection-enabled", "true")
        expect(distance_readout).to_be_visible()
        assert viewer_tool(page, name="关闭碰撞保护").get_attribute(
            "aria-pressed"
        ) == "true"

        print("probe_link=", probe_link)
        print("excluded_links=", excluded)
        print("collision_links=", collision_links)
        print("near_transition=", observed_near)
        print("refresh_default_on=", True)
        print("page_errors=", page_errors)
        print("console_errors=", console_errors)
        assert not page_errors
        assert not console_errors
        browser.close()


if __name__ == "__main__":
    run()
