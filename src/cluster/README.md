# Robot Virtual Teaching · 停车点集群计算

本计算包用于 [Robot Virtual Teaching（机器人虚拟示教工程）](https://github.com/GaohaoZhou-ops/robot-virtual-teaching) 的停车点合并：在“示教数据中心”选中任务后，通过“合并停车点-Server → 导出”生成包含冻结任务、环境几何、机器人资源与算法脚本的 ZIP。

本说明随计算包导出。以下命令在 ZIP 解压后的任务目录执行，该目录中的输入是导出时的只读计算快照。

计算包同时保存“机器人”菜单中的关节软限位和关节6–7角度耦合设置。耦合默认开启，对左右臂分别要求 `|J6 + J7| < 1.8 rad`，在 IK 迭代与最终可行性判断中生效；网页当前的耦合设置须与导入结果一致。

软限位默认保留各双臂关节硬限位的中间 95%。腰部四个关节（`ankle_pitch_J`、`knee_pitch_J`、`waist_pitch_J`、`waist_yaw_J`）默认保留原硬限位的 100%，以兼容旧工程姿态，单独设置后使用指定范围。双臂与腰部的单独范围均以兼容字段 `armSoftLimitOverrides` 保存，键为关节名，`lower` / `upper` 为从硬限位下限至上限的比例（0～1），允许非对称范围。网页当前的软限位设置须与导入结果一致；此规则同样用于浏览器内规划与预设姿态检查。

## 一键执行

```bash
bash run_cluster.sh
```

脚本会创建隔离的 `.atlas-merge-venv`、安装 `requirements.txt`，校验 `manifest.json`
列出的所有 SHA-256，然后执行近邻聚类、双臂光学位姿 DLS 重规划和最终姿态环境碰撞校验。
计算期间终端会持续显示总体百分比进度条、当前阶段、正在处理的资源/姿态以及累计用时；即使单个
候选位姿耗时较长，进度条旁的活动标记和用时也会持续刷新。在 Slurm 等非交互式任务日志中，
则每跨越 5% 或 15 秒输出一行心跳，便于判断进程仍在运行。

完成后，`output/` 会同时生成：

- `parking-merge-…-result.zip`：推荐带回网页导入；
- `parking-merge-…-result.json`：内容相同的单文件结果。

将结果带回虚拟示教平台，在原任务的“合并停车点-Server”窗口导入；校验通过后，在合并结果页选择近邻簇并确认合并。

可选参数：

```bash
bash run_cluster.sh --workers 8
bash run_cluster.sh --skip-collision
```

`--skip-collision` 仅用于诊断，不建议把该模式生成的结果用于正式归档。计算包绑定示教任务、
地图来源 SHA-256、导出环境几何摘要、机器人 URDF/碰撞网格摘要和算法版本。任意一项不匹配，
网页都会拒绝导入。
