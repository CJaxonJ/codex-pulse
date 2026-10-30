# Windows 内部验收包

本包只供隔离开发验收，不是已发布的 Windows 安装器。暂不向普通用户分发。

包含 Node 22 x64、原生 Windows 组件、产品源文件、产品及 Node 许可证和逐文件完整性清单。解压后保留完整目录，不要单独移动 exe。

尚缺双击安装界面、安装后快捷入口和中断清理修复；活跃托管任务在升级／卸载停机时的保护也未验收。不要用于正在执行真实托管任务的安装。验收通过这些项目后才提供面向普通用户的安装包和操作说明。

开发验收必须使用独立的 CODEX_HOME 和 CODEX_PULSE_DATA_DIR。安装代码入口为 `runtime\node.exe scripts\install-windows.mjs`；卸载为 `runtime\node.exe scripts\uninstall-windows.mjs`。不能从已安装的 app 目录替换或删除自身运行时。

默认保留任务计划、偏好、额度历史和用卡账本。安装不会授予 Hook 信任，不会自动消费重置卡。不把未知状态当成已停止，不强删未核实文件。

SHA256SUMS.txt 和包内清单用于校验完整性，不等于 Windows 代码签名或发布者认证。请仅使用本项目可信构建来源的文件。
