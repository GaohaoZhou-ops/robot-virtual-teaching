# 集群计算与物理后端

[文档目录](README.md) · [项目首页](../README.md)

文中的命令均从仓库根目录执行。

[🧮 停车点集群计算](#-停车点集群计算) · [⚙️ 可选 Isaac Sim / PhysX 物理后端](#-可选-isaac-sim--physx-物理后端)

<a id="停车点集群计算"></a>

## 🧮 停车点集群计算

用于将停车点合并计算交给高性能计算集群。完整参数见 [计算包使用说明](../src/cluster/README.md)。

1. 在 **示教数据中心** 选中任务，打开 **合并停车点-Server** 并导出计算 ZIP。
2. 将 ZIP 复制到集群，解压后执行：

   ```bash
   bash run_cluster.sh
   ```

3. 从 `output/` 取回结果 ZIP 或 JSON，在原任务的窗口中导入。
4. 校验通过后，在普通合并结果页勾选近邻簇，再确认合并。

> 默认检查合并后的**最终机器人姿态**与环境碰撞，并排除底盘 / 轮组；这不是整段运动轨迹的连续碰撞规划。

<details>
<summary>计算包内容、运行进度与结果校验</summary>

- “示教数据中心”选中任务后，“合并停车点”旁提供“合并停车点-Server”。
- 弹窗中的“导出”会生成可直接复制到高性能计算集群的 ZIP：包内包含冻结后的任务计算快照、完整环境 `float32` 点坐标与三角面索引、当前 URDF、非底盘碰撞网格、依赖清单、Python DLS/环境终态碰撞算法和 `run_cluster.sh` 一键脚本。
- 在集群解压后执行 `bash run_cluster.sh`，脚本会建立隔离虚拟环境、校验全部文件摘要并在 `output/` 同时生成结果 ZIP 与单文件 JSON。
- 执行过程中会显示总体百分比进度条、当前阶段、处理对象和累计用时；在 Slurm 等非交互日志中也会按进度或固定时间输出心跳。

- Server manifest 使用 SHA-256 同时绑定任务计算字段、原始地图来源、导出环境几何、机器人 URDF/碰撞网格和算法协议版本。
- 网页“导入”支持结果 ZIP/JSON；任务在导出后发生变化、地图或机器人不一致、资源被修改、算法版本不兼容或结果文件损坏时都会拒绝载入。
- 校验成功也不会立即覆盖任务，而是打开普通合并结果页，保留近邻簇勾选和最终确认步骤。
- Server 算法默认检查合并后最终机器人姿态与环境的碰撞并继续排除底盘/轮组；这不是整段运动轨迹的连续碰撞规划，可在弹窗导出前关闭，或在集群诊断时使用 `--skip-collision`。

</details>

<a id="可选-isaac-sim--physx-物理后端"></a>

## ⚙️ 可选 Isaac Sim / PhysX 物理后端

默认使用浏览器 Worker，无需启动 Isaac Sim。需要 PhysX 时，使用包含 `atlas.isaac.collision` 扩展的相邻 `../isaac-sim-server` 工程：

```bash
cd ../isaac-sim-server
./bin/start.sh

cd ../robot-virtual-teaching
ATLAS_PHYSICS_BACKEND=isaac ./scripts/start.sh
```

以上示例假定两个仓库位于同一父目录，且本工程使用克隆后的默认目录名；若本地目录名不同，请将第二个 `cd` 替换为实际路径。

| 配置项 | 默认值 / 行为 |
| --- | --- |
| `ATLAS_PHYSICS_BACKEND` | `local`；`auto` 在 Isaac 不可用时回退本地，`isaac` 不可用时明确报错 |
| `ISAAC_SIM_COLLISION_URL` | `http://127.0.0.1:49101` |
| `ISAAC_SIM_COLLISION_TOKEN` | Isaac API 非回环监听时需要，一般无需设置 |

碰撞保护默认开启，后端在地图与机器人就绪后建立会话；手动关闭时释放资源，刷新后恢复默认开启。

<details>
<summary>碰撞几何、接口与调试属性</summary>

- 碰撞保护默认使用浏览器 Worker，不启动 Isaac Sim 时也可使用。
- URDF 机器人优先装载 `<collision>` 几何；某个 link 没有可用碰撞模型时才回退到视觉几何，视觉显示本身不变。

- Isaac 模式通过本工程的 `/__atlas/physics/` 同源接口访问，浏览器无需直接连接端口 49101。
- Isaac 扩展将 PLY 三角面构建为静态 USD/PhysX 碰撞网格；纯点云使用与浏览器 Worker 等价的有界空间索引，并与 PhysX Mesh 查询合并结果。

- 若 URDF 的 collision 网格不是浏览器支持的 STL/GLB/GLTF，可在机器人包的 `web-model.json` 中用 `collisionMeshOverrides` 将原 URI 映射到等价的 Web 网格；该资源也会随便携工程归档一并收集。

- 后端在碰撞保护开启且地图与机器人就绪后建立会话，关闭开关即删除 USD 会话并释放资源；刷新后恢复默认开启。
- 画布调试属性 `data-collision-backend` 会显示 `local` 或 `isaac`，`data-collision-model-proxy-count` 表示实际使用的 URDF 碰撞体数。
- `data-collision-ignored-joints` 与 `data-collision-ignored-links` 分别记录忽略关节及对应部件。验证关节过滤与材质恢复：`npm run test:collision-backends`；验证距离变化、索引复用、刷新和工程恢复：`uv run --with playwright python tests/robot_collision_joint_ignore_ui_smoke.py`。

</details>

---

[文档目录](README.md) · [项目首页](../README.md)
