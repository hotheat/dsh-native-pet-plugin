# dsh-native-pet

将 DSH 实时 `session` / `agent` 事件通过本地 Unix socket 传给 macOS 桌面宠物。
事件先进入内存状态投影，再合并成 NDJSON 全量快照；连接恢复后重新发送当前快照。
桌面宠物应用负责监听 socket 和显示状态，需单独启动。

## 安装

要求 DSH `>=0.2.1-rc.2`。
在本仓库根目录执行：

```sh
ln -s "$PWD" "$HOME/.dsh/plugins/dsh-native-pet"
dsh plugin --profile web add "link:$HOME/.dsh/plugins/dsh-native-pet"
```

随后在目标 profile 中加载插件。
插件只有 host 端，无浏览器端代码或运行时依赖。

## Socket

默认路径为 `~/Library/Application Support/dsh-native-pet/pet.sock`。
设置 `DSH_NATIVE_PET_RUNTIME_DIR` 后，路径改为该目录下的 `pet.sock`；DSH 与桌面宠物需使用同一目录。
插件异步连接，断开时按 250 ms 至 5000 ms 退避重连，默认每 5000 ms 发送心跳。
背压期间只保留一份待发最新快照，DSH 事件处理不等待 socket IO。

## 状态与隐私

只传输来源、会话标识、回合、阶段、工具及审批计数和终态结果标识；不读取历史会话正文，不发送对话文本、工具参数或凭据。
初始化只枚举当前会话及 agent 状态，不回放历史终态。
首次连接与重连的基线快照用于对齐当前状态，桌面宠物保持静默，不把历史状态当成新完成事件。
审批持续满 300 ms 才进入 `waiting`，即时通过的审批不会闪现等待状态。
终态会清空工具与审批计数；下一个运行状态或新回合解除终态反馈。

## 开发

本仓库是 DSH host 端的唯一实现来源，运行时为纯 JavaScript，无需构建。
`ai-skills-owner` 通过 `plugins/dsh/dsh-native-pet` 子模块引用，`harness-native-pet` 通过 `bridge/` 子模块引用。

```sh
npm ci
npm test
npm run test:e2e
npm run test:package
```

单元测试覆盖状态投影、协议和 Unix socket 客户端。
E2E 通过真实 DSH Host 的 agent、工具和审批链路验证 socket 快照，并用 `fixtures/` 中的共享样本验证协议编解码。
测试不依赖其他仓库的本地 checkout；`test:package` 会打包当前仓库，并通过已安装的 `dsh` 在隔离的 `DSH_HOME` 中验证插件安装、启停与移除。
运行环境以 `EPERM` 拒绝监听 Unix socket 时，相关单元测试会注明原因并跳过，Host E2E 会报错。

原生 UI 测试需要 macOS，并设置 `DSH_NATIVE_PET_APP` 指向已构建的应用二进制：

```sh
DSH_NATIVE_PET_APP=/path/to/DSHNativePet.app/Contents/MacOS/DSHNativePet npm run test:native
```

`test:native` 直接启动该二进制，不构建 Swift；CI 运行单元测试、Host/协议 E2E 和打包检查。
