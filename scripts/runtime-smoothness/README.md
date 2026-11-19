# EchoInk 桌面运行基线

只向命名的 disposable Vault 注入临时测量代码。测量埋点仅在内存中，不修改源码或产物。第一批实现另由功能分支提交。默认目标是 `~/EchoInk-TestVaults/测试仓库-运行丝滑度验收`，端口 `19463`；每次连接先读回 Vault 身份，拒绝真实 Vault。Node 22 或以上即可运行 CDP 脚本，不依赖 Playwright。

## 准备与顺序

1. 在目标工作树安装依赖后运行 `node scripts/runtime-smoothness/prepare.mjs`。它先生产构建，再复制样板，部署三件套，不覆盖 `data.json`；目标已存在会退出。输出的 `launch` 参数用于在独立终端启动 `/Applications/Obsidian.app`，必须保留独立 profile 与 `--use-mock-keychain`。不要启动样板。
2. 另一终端运行 `node scripts/runtime-smoothness/fake-provider.mjs`，仅监听 `127.0.0.1:19464`。真实模型调用是 0。它给主调用回放 1285 字符思考、1883 字符回答，10/12 字符一段，默认 40ms；标题请求返回短标题。
3. 插件首次加载前运行 `ECHOINK_PERF_NAME=startup-first node scripts/runtime-smoothness/startup.mjs`，记录启动。再次测启动需先重载独立 renderer，不能把卸载重装当作冷进程。
4. 在该副本内将唯一 DeepSeek 服务商的 Base URL 改为 `http://127.0.0.1:19464/v1`，Key 改为任意假值，保存；关闭新手引导，打开工作台与侧栏。不要打印旧 Key。也可通过 `cdp.mjs` 在内存配置后调用 `saveSettings(true)`。`stream.mjs` 会拒绝存在非本机 Base URL 的配置。
5. 依次运行下列命令；不要并行操作同一个 renderer。启动计时包含首次模块加载，流式脚本在准备阶段初始化运行服务，输入计时不含 CDP 传输时间。`settings.mjs` 会等当前页有实际内容，再等双 rAF，不能只等一个固定延时。

```sh
ECHOINK_PERF_NAME=stream-final node scripts/runtime-smoothness/stream.mjs
ECHOINK_PERF_NAME=thinking-running-final node scripts/runtime-smoothness/toggles.mjs --running --film
ECHOINK_PERF_NAME=thinking-completed-final node scripts/runtime-smoothness/toggles.mjs --film
node scripts/runtime-smoothness/interactions.mjs
node scripts/runtime-smoothness/render-replay.mjs
node scripts/runtime-smoothness/vault-burst.mjs
node scripts/runtime-smoothness/idle.mjs
node scripts/runtime-smoothness/idle-control.mjs
node scripts/runtime-smoothness/settings.mjs
node scripts/runtime-smoothness/animation-control.mjs
```

`render-replay.mjs` 在原生 Obsidian 里重放回答增量，使用真实消息渲染器，但不经过 Provider、引用校验与存档。它在 finally 中恢复合成会话。请在正式对话测量之后单独运行；报告必须与正式主链分开。`interactions.mjs` 通过 Pi SessionManager 创建 100 问答对、共 200 条真实归档消息，再用原生任务入口打开，未调用模型。

`idle.mjs` 包含采样器开销；CPU 结论必须引用无 trace 的 `idle-control.mjs`。空闲测量时不要同时录屏、运行其他测量或操作窗口。`--closed-only` 只用于补完已保存的前半组。关视图不等于卸载插件。

6. 汇总所需 trace（文件名不含 `.trace.json.gz`）：

```sh
node scripts/runtime-smoothness/analyze.mjs startup-first stream-final thinking-running-final thinking-completed-final interactions render-replay idle-visible idle-closed vault-burst
```

原始 trace 使用 gzip 保存，可解压后导入 Obsidian/Chrome DevTools Performance 查看火焰图。`trace-summary.json` 给出主线程长任务、带 JS 栈的同步 Layout、样式重算、CPU 自身及包含子调用的占时。后者相互包含，不能相加。ProfileChunk 可能在采样线程发出，按原始 Profile 身份归属主线程，不能仅按 chunk 的 tid 过滤。

## 口径与限制

- CDP 默认用 `Emulation.setFocusEmulationEnabled` 保持测试 renderer 的前台状态，避免 macOS 遮挡窗口后停掉 requestAnimationFrame。用 `ECHOINK_PERF_FOCUS=0` 才允许后台状态。不要把隐藏窗口中未刷新的画面当成产品错误。记录实际宿主版本，独立 profile 可能自动更新应用脚本。
- 超过 50ms 的主线程 `RunTask` 才计入长任务；PerformanceObserver 只作交叉检查。带 JS stackTrace 的 `Layout` 是同步排版口径，不声称全部来自滚动。
- `probe.js` 的方法包装与计数、计时器登记、MutationObserver 只存在于 renderer。`geometry.mjs` 与录屏有额外开销，只作定位和画面证据，不与无逐帧测量的主基线混比。
- `markdown.fast-render` 是快速文本/Markdown 子集的清空重建次数；`markdown.native-request` 是实际启动原生 Markdown 的次数；缓存命中不能算渲染。DOM MutationRecord 是节点级记录，不能当作整块替换次数。
- 字符数含 Markdown 语法与空白。输入和页面操作的画面时间用处理开始到双 requestAnimationFrame 的上界，不能声称是物理屏幕展示延迟。200 条消息测的是固定约 220 字符回答，不能外推到 200 条超长回答。
- 原生正式对话可能先缓存正文以校验引用。脚本保存正文长度时间线，不能把网络流等同于已显示的文字流。
- `saveData`、`saveSettings` 和 fs 计数层级不同，不能相加。fs.appendFileSync 内部可能调用 writeFileSync。
- 环境覆盖：`ECHOINK_PERF_VAULT`、`ECHOINK_PERF_PORT`、`ECHOINK_PERF_OUT`。所有证据只留本机，不提交 raw trace、录屏、profile、账号或用户数据。

结束后只关闭本任务实例、假服务，并删除本任务副本与临时 profile。不要操作日常 Obsidian 或真实 Vault。报告与脚本保留在功能分支。

## 第一批复测

复用上面的准备、宿主版本、视口与 40ms 事件流；证据输出放进新子目录，避免覆盖第一轮：

```sh
export ECHOINK_PERF_OUT="$PWD/docs/internal/test-evidence/2026-11-13-运行丝滑度优化/batch1"
ECHOINK_PERF_NAME=stream-after node scripts/runtime-smoothness/stream.mjs
ECHOINK_PERF_NAME=reading-after node scripts/runtime-smoothness/record.mjs node scripts/runtime-smoothness/acceptance.mjs
ECHOINK_PERF_NAME=stream-film-after node scripts/runtime-smoothness/record.mjs node scripts/runtime-smoothness/stream.mjs
node scripts/runtime-smoothness/interactions.mjs
node scripts/runtime-smoothness/regressions.mjs
node scripts/runtime-smoothness/animation-parity.mjs
node scripts/runtime-smoothness/visibility.mjs
node scripts/runtime-smoothness/settings.mjs
node scripts/runtime-smoothness/idle-control.mjs
node scripts/runtime-smoothness/animation-cpu.mjs
node scripts/runtime-smoothness/animation-residual.mjs
ECHOINK_PERF_NAME=idle-film-after node scripts/runtime-smoothness/record.mjs --seconds 12
node scripts/runtime-smoothness/analyze.mjs stream-after interactions settings-precise
```

`acceptance.mjs` 临时将假流放慢到 80ms，以容纳 20 次真实鼠标按下/抬起、原生 wheel 上滑、12 字符 Range 选择和完成检查，结束后恢复 40ms。复制动作仍调用真实处理器，只截获剪贴板写入，避免更换 OS 剪贴板。

`regressions.mjs` 检查生成中切任务后返回，以及 200 条消息的顶部/中部/底部实际测高与窗口身份；其逐帧几何采样只用于定位。`record.mjs` 使用 CDP screencast 原始时间戳编码 MP4，需要本机 ffmpeg，录屏结果不作为无录屏主基线。

`animation-parity.mjs` 默认从 `1abed51a` 读取旧姿态写入函数，在同一时间点比较五种状态各 241 帧的 SVG 属性；数学源文件必须未变。它不等于自然录屏的像素比较。`visibility.mjs` 实际切 Tab、隐藏/显示本任务 BrowserWindow，检查时间线暂停、SVG 零写入和同一控制器续播。

空闲 CPU 必须单独串行运行，停止构建、测试、ffmpeg 与 trace 分析。`animation-cpu.mjs` 是附加归因：仅在第一轮 unfinished/still 状态，用当前/旧 SVG 与状态写入/当前各测 20 秒；旧函数从 Git 读取，只替换当前 renderer 的临时方法，finally 恢复。它保留当前构建的其他逻辑，不能叫作整个旧版本的 CPU 基线。跨轮 60 秒数字有差异时，应同时看这种配对证据。

`animation-residual.mjs` 另外抓 10 秒 trace 和实际 SVG 写入图层，用于定位仍有的布局工作；不要把这段带观测器的采样当 CPU 基线。

## 第二批复测

先新建副本并部署最新构建；沿用第一轮宿主、视口、假流。所有命令先固定本轮证据目录：

```sh
export ECHOINK_PERF_OUT="$PWD/docs/internal/test-evidence/2026-11-13-运行丝滑度优化/batch2"
node scripts/runtime-smoothness/reload.mjs --deploy
ECHOINK_PERF_NAME=stream-batch2-cold-verified node scripts/runtime-smoothness/stream.mjs
ECHOINK_PERF_NAME=stream-batch2-warm-verified node scripts/runtime-smoothness/stream.mjs
ECHOINK_PERF_NAME=reading-batch2-accepted node scripts/runtime-smoothness/record.mjs node scripts/runtime-smoothness/acceptance.mjs --preserve-selection
ECHOINK_PERF_NAME=markdown-replay-latest node scripts/runtime-smoothness/record.mjs node scripts/runtime-smoothness/render-replay.mjs --check-blocks
node scripts/runtime-smoothness/markdown-parity.mjs
node scripts/runtime-smoothness/interactions.mjs
node scripts/runtime-smoothness/regressions.mjs
node scripts/runtime-smoothness/mobile-composer.mjs
node scripts/runtime-smoothness/animation-parity.mjs
node scripts/runtime-smoothness/visibility.mjs
ECHOINK_PERF_NAME=idle10-resume-batch2 node scripts/runtime-smoothness/record.mjs node scripts/runtime-smoothness/idle-resume.mjs
```

冷、热正式链必须连续测，冷之前重载。`stream.mjs` 记录本机服务首正文增量和 DOM 首正文的绝对时间；采样列表要按结果里的 sessionId 过滤，开头可能还是上一个会话。录屏另跑 `record.mjs node stream.mjs`，不能混作无录屏性能数字。需要保留多轮片段时用新 `ECHOINK_PERF_NAME`，避免旧帧目录尾部混入新片段。

`render-replay --check-blocks` 数已完成原生块的节点身份和整篇清空，检查完成选区。`markdown-parity` 紧接它运行，用同一宿主完整原生 Markdown、同宽屏外容器对比实际高度和文字。分块实现后，旧 probe 的 `markdown.fast-render` 仅表示流式请求，`markdown.native-request` 仅表示外层非 streaming 请求；两者不再等于整篇重画次数或内部原生块调用次数。

缩进代码补验可在 `render-replay` 后加 `--indented-code`，它在原回答前加入一个内部有空行的四空格代码块。回放 finally 会恢复原会话；如需接着比完整原生高度，先仅在这个副本的内存投影里重新显示补验文本，再跑 parity：

```sh
node scripts/runtime-smoothness/cdp.mjs "(async()=>{v.ensureSession().messages.find(m=>m.itemType==='assistant').text=__replayText;v.renderMessages({preserveScroll:true});await new Promise(r=>setTimeout(r,500));})()"
node scripts/runtime-smoothness/markdown-parity.mjs
```

该操作没有改 Pi 存档，也不发模型请求；测试完成删除副本。

`mobile-composer` 在当前 Chromium 中挂载真实 MobileUI/CSS 和内存数据，分别以 390/430px 刷新 50 次；不调用 Provider，不等于 iPhone 真机验收。结束会释放 fixture 和节点。

四引用场景先有一轮成功正式链。用 `reference-cases.mjs`，它默认读取本轮 `stream-batch2-cold-verified.json` 的无引用会话；也可用 `ECHOINK_PERF_ZERO_NAME` 指定其他成功的零引用结果名。它使用真实知识读取与权限/版本校验，只改指定副本的 `性能回放专用/` fixture，finally 恢复绑定和假服务模式。`--resume` 只补当前结果里未通过的场景；要从头重跑，将旧结果移到本轮归档子目录。

行比较时先 `row-comparison.mjs --start`，跑正式流后再 `row-comparison.mjs`，后者先恢复 JSON.stringify，再测压力样本；重载也会清掉临时埋点。`css-cpu-control` 仅适用本机归档的 CSS 试验构建，最终产品会拒绝运行；该试验未保留到产品。

最后单独跑无 trace CPU，不并行构建、测试、录屏或分析：

```sh
node scripts/runtime-smoothness/idle-control.mjs
```

脚本在可见工作台先发送真实鼠标移动，等待 1.2 秒后采样整 60 秒，包含剩余无操作宽限；随后关 EchoInk 页面再量 60 秒。它记录采样前后 active/idlePaused，不能把已暂停很久的状态冒充从操作开始的完整空闲窗口。

单跑既有测试时，先检查脚本真正读取的变量：通用 disposableTestRoot 读 `ECHOINK_TEST_ROOT`，部分旧工作台脚本读 `ECHOINK_WORKBENCH_TEST_ROOT`，phase1 runner 的临时产物读 `TMPDIR`。均指向本轮副本的 `.obsidian/perf-tests`。完整 `npm test` 自行建立并清理独立的命名验收根；不要改写 runner 去复用旧 90 目录。

## 第三批复测与量法修正

正式数字与逐控件表见更新报告“第三批前后对比”。最终正式流使用新复制的 `测试仓库-运行丝滑度复测验收`、独立端口 19466 和同一 Obsidian 1.15.1；`batch3/final-priority/trusted-before/` 是 main 第二批，`follow-fixed/` 为最终第三批，`follow-fixed-frame/` 是带 setter 的滚动诊断，`follow-fixed-reading/` 是最终阅读录屏。成对切页/设置计时在 `paired-before/`、`paired-after/`；无 probe CPU 在 `cpu-clean/`。逐控件审计与关键转场片段在 `batch3/final-clean/after-final/`。旧 `final-clean/before/` 发现过信任遮罩，不再作可交互主基线；`trusted-final/` 的 1059ms 及 `diagnostic-frame-warm/` 保留为自动滚动误判的失败证据。其他失败/压力定位不混入通过基线。

```sh
export ECHOINK_PERF_VAULT="$HOME/EchoInk-TestVaults/测试仓库-运行丝滑度复测验收"
export ECHOINK_PERF_PORT=19466
export ECHOINK_PERF_OUT="$PWD/docs/internal/test-evidence/2026-11-13-运行丝滑度优化/batch3/你的新轮次"
node scripts/runtime-smoothness/reload.mjs --deploy
ECHOINK_PERF_NAME=stream-cold node scripts/runtime-smoothness/stream.mjs
ECHOINK_PERF_NAME=stream-warm node scripts/runtime-smoothness/stream.mjs
node scripts/runtime-smoothness/analyze.mjs stream-cold stream-warm
node scripts/runtime-smoothness/frame-scroll.mjs
node scripts/runtime-smoothness/controls-audit.mjs
node scripts/runtime-smoothness/menus-audit.mjs
node scripts/runtime-smoothness/transitions.mjs sessions
node scripts/runtime-smoothness/transitions.mjs tabs
node scripts/runtime-smoothness/transitions.mjs disclosures
node scripts/runtime-smoothness/settings.mjs
node scripts/runtime-smoothness/settings-host-control.mjs
node scripts/runtime-smoothness/entrances.mjs
node scripts/runtime-smoothness/interactions.mjs --chat-only
```

- 模型只指向本机假服务。正式链先展开侧栏、等待初始页面就绪，再开始计时；结束必须断言本次会话在生成中确实显示过未完成正文。不能把隐藏的消息区或根本没发起模型调用的空样本算成性能改善。
- 同一副本反复生成会累积任务与后台记忆回放。需要重建数值基线时重新复制样板，并记录任务规模、宿主与视口；压力样本单列，不能混进固定基线。比较旧构建时可给 `reload --deploy` 设置 `ECHOINK_PERF_BUILD_ROOT` 指向明确的旧生产构建目录；只读该目录的三件套，仍只部署到已验证的验收副本。
- 脚本拒绝未知模态遮罩；本副本明确的“信任仓库作者”提示只在 reload 核对 Vault 后正常确认。点击前检查 elementFromPoint，不能把按错目标当成产品丢击。
- 首正文观察器先查文字与加载状态，再仅为真实正文读一次尺寸；不要每个思考增量都测空正文占位区。分析流式 trace 从 `perf-send` 开始，新增录制到 `perf-stream-end` 为止；保留 `excludedLongTasks`，明确列出发送之前由 profiler 启动产生的长任务，不把它们归因于产品。旧 trace 没有结束标记时保留到 trace 末尾。
- `frame-scroll` 统计稳定阶段每个滚动目标、每帧的实际滚动变化，原始写入也保存。结构重建帧另列；不要把“写入一次”夸成浏览器只做了一次 Layout。
- `controls-audit` 包括可滚到的当前控件和已启用模块的展开态，按下后首个 rAF 读样式、焦点及是否出现菜单。只拦截 trusted click；娃娃拖拽、原生 Select/Range 不自动按压。下拉在 pointerdown 就出现也是正确反馈，不能只看触发器颜色。`--settings-only` 复用主页面结果，`--scene=settings-account` 只补一个场景。
- 设置是独立窗口。`owned-settings` 只连接被主窗标记、且 Vault 身份匹配的子窗口。`settings.mjs` 等该窗口自己的双 rAF；`settings-host-control` 量宿主编辑器/外观页。`interactions --chat-only` 只测聊天、输入与 Tab，避免把主窗帧冒充设置窗帧。
- 录屏另跑，不作为无录屏延迟或 CPU 数字：`record.mjs node transitions.mjs sessions`，其余换成 `tabs` / `disclosures`；设置用 `record.mjs --settings node settings-transitions.mjs`（脚本路径仍需写全）。设置片段从可连接的首个内容画面开始；打开耗时另由 settings 脚本记录。每次用新的 `ECHOINK_PERF_NAME`，且录屏与无录屏计时使用不同的 `ECHOINK_PERF_OUT`：部分子脚本的 JSON 名固定，只有换片名仍可能覆盖计时结果；也避免混入旧帧尾部。
- `entrances` 区分内容首屏双 rAF 与整个 `openTaskDetail` Promise 结束；后者还含目录刷新，不能混成一个“首次可见”数字。
- 单独旧测试的输出根按脚本实际读取的变量设置，并先建立目录。`agent-runs-tests` 读 `ECHOINK_AGENTS_TEST_ROOT`；通用测试读 `ECHOINK_TEST_ROOT`；phase1 子程序临时根读 `TMPDIR`。输出目录在验收副本时，必要的包解析链接仅建在该副本 `.obsidian/node_modules`，不可改旧 90 目录或用户库。全量 npm test 继续使用 runner 自建的独立验收根。

最后先运行 `reload.mjs --no-probe`，读回确认 `window.__smooth` 不存在，再串行运行 `idle-control.mjs`。整段采样期间不构建、不跑测试、不录屏、不分析 trace。录屏、裸 CPU、附带 setter/MutationObserver 的诊断必须分开报。完成后仅清理本任务副本、profile 与本机假服务。

## 手机基线：iPhone / iPad

入口为 [手机评审与基线报告](../../docs/更新/2026-11-15-手机端运行丝滑度.md)。使用正式移动包与宿主移动 CSS；不是 browser-obsidian fixture，也不是 iOS 真机。

### 环境与选包

```sh
export ECHOINK_PERF_VAULT="$HOME/EchoInk-TestVaults/测试仓库-手机端丝滑度验收"
export ECHOINK_PERF_PORT=19571
export ECHOINK_FAKE_PORT=19572
export ECHOINK_PERF_OUT="$PWD/docs/internal/test-evidence/2026-11-15-手机端运行丝滑度/baseline"
node scripts/runtime-smoothness/prepare.mjs
node scripts/runtime-smoothness/mobile-baseline.mjs configure iphone
```

`prepare` 拒绝已有目标，构建后仅部署三件套，并验证部署没有动 `data.json`。`configure` 是部署之后的独立操作：只在命名副本改为唯一的假 Provider，关闭自动做梦和云同步，不打印旧凭据。用 prepare 输出的 launch 参数启动原版 Obsidian，保留独立 profile、19571 与 `--use-mock-keychain`。另一终端在同一环境变量下运行 `fake-provider.mjs`；它支持独立假服务端口与 WebView fetch 的 CORS 预检。真实模型调用为 0。

首次连接已核对副本后，正常确认该测试构建的信任提示，再调用一次宿主移动模拟：

```sh
node scripts/runtime-smoothness/cdp.mjs 'app.emulateMobile(true)'
node scripts/runtime-smoothness/mobile-baseline.mjs setup iphone
```

当前桌面宿主的 `emulateMobile` 会重载/CSS 切换，但 `Platform.isMobileApp` 仍为 false。`setup` 临时包装本插件的 require，在内存提供对应 Platform 标志，使原封不动的三件套选中移动入口；加载后恢复 evaluator。它记录原始标志、宿主与视口。iPhone 为 390×844，iPad 为 1180×820、保留原生右栏聊天。DPR 2、5 触点。每次测量的 CDP 连接都重设尺寸/触摸，并断言读回；不能只在 setup 设置一次，连接结束会撤销覆盖。

`setup` 默认把本轮副本的合成任务恢复成一个空任务，用于固定冷/热样本规模；`--preserve` 仅用于保留压力样本继续测 UI。不要对其他 Vault 使用。它不是安装/升级测试，不操作样板。

### 串行采样

下列示例为 iPhone；iPad 将每行的 `iphone` 换成 `ipad`。同一 renderer 的测量全部串行：

```sh
node scripts/runtime-smoothness/mobile-baseline.mjs setup iphone
node scripts/runtime-smoothness/mobile-stream.mjs stream iphone 1 cold
node scripts/runtime-smoothness/mobile-stream.mjs stream iphone 1 warm
node scripts/runtime-smoothness/mobile-baseline.mjs setup iphone
node scripts/runtime-smoothness/mobile-stream.mjs stream iphone 4 cold
node scripts/runtime-smoothness/mobile-stream.mjs stream iphone 4 warm
node scripts/runtime-smoothness/mobile-controls.mjs audit iphone
node scripts/runtime-smoothness/mobile-calibration.mjs calibration iphone
node scripts/runtime-smoothness/mobile-reading.mjs reading iphone
node scripts/runtime-smoothness/mobile-reading.mjs reading iphone --outer-only
node scripts/runtime-smoothness/mobile-interactions.mjs interactions iphone 1
node scripts/runtime-smoothness/mobile-interactions.mjs interactions iphone 4
node scripts/runtime-smoothness/mobile-interactions.mjs interactions iphone 1 --entrances-only
node scripts/runtime-smoothness/mobile-interactions.mjs interactions iphone 4 --entrances-only
```

- 正式流从实际触摸发送按钮的 click 开始，沿 MobileRuntime/transport，验证本次未完成正文确实进入视口。冷/热分别存；trace 分析沿桌面 RunTask >50ms、带 JS 栈 Layout 口径。每次 40ms 假流约有 5 秒固定思考，不能把它当 UI 延迟。直播正文节点替换与原生 Markdown 次数分开。
- `controls` 盘点当前现身实例，拦截 trusted click，真实 touchStart 后首个 rAF 读本体/子元素/伪元素样式。禁用、原生选择器、遮挡与已移走实例另列，不算成功。`calibration` 分开记录真实触摸、宿主 mobile-tap 和 DevTools 强制 :active；强制结果只验 CSS，不冒充触摸反馈。
- `reading` 的 setter/几何诊断不作为裸 CPU 或正式流性能数字。普通模式先滚思考区；`--outer-only` 必须另发新任务，不先滚思考，断言起初未暂停，再量首个 touchmove 和松手后 900ms。后者是模拟惯性观察窗，不等于 iOS 惯性时长。速度暂用 55ms，finally 恢复 40ms。
- `interactions` 直接向移动存档写固定的 200 条消息（100 对、回答约 220 字符、无思考字段），任务列表为 200 项。iPhone 用逐个真实触点向上移动；合成手势在该宿主可能拉出命令菜单。iPad 使用 touch 合成滚动。必须断言实际滚动位移、拒绝出现宿主遮罩的样本。trace 启动开销在测量标记前，帧采样也在 trace 启动后开始。
- 最终入口延迟取 `--entrances-only` 输出；它在有效内容出现后等所属主窗口双 rAF，另存 Promise 完成时间。iPad 先卸下已有设置页，首个 settings-open 包含新设置视图挂载。入口序列首屏后间隔 80ms，不能混成互不关联的冷启动统计。4× 下入口顺带记录，指定的列表/长会话滚动另有 4×。
- 键盘代理只缩短/恢复 visualViewport 高度 300px，布局尺寸与端身份保持不变；逐帧保留输入 Y。它不包含真 IME、原生键盘事件序列、键盘动画或非零安全区。旧 layout 缩高会让模拟宿主把 iPad 改判为手机，额外的边界变化只作诊断，不能算插件补偿往返；iOS 原生键盘/惯性/:active/滚动锚定需真机补验。

录屏另换输出目录，复用桌面 screencast/ffmpeg 编码，不覆盖无录屏结果。例如在 200 消息样本已经存在后：

```sh
ECHOINK_PERF_OUT="$PWD/docs/internal/test-evidence/2026-11-15-手机端运行丝滑度/baseline/film" \
  node scripts/runtime-smoothness/mobile-record.mjs film iphone \
  node scripts/runtime-smoothness/mobile-reading.mjs reading iphone
```

裸 CPU 最后单独采样，不与构建、测试、录屏或 trace 分析并行。`setup` 重载会清除临时 probe，并恢复一空任务的固定规模。`mobile-idle` 保留从可信活动起 1.2 秒之后的完整 60 秒，采整个 renderer 单核 CPU；记录视口、可见/焦点、动画与娃娃挂载数。

```sh
node scripts/runtime-smoothness/mobile-baseline.mjs setup iphone
node scripts/runtime-smoothness/mobile-idle.mjs idle iphone
```

两端都完成后离线生成摘要与报告表，再只读复核：

```sh
node scripts/runtime-smoothness/mobile-summary.mjs
node scripts/runtime-smoothness/mobile-summary.mjs --check
```

原始 trace、profile、录屏和帧只留本机；按需提交脱敏摘要 JSON 和截图到私有仓。报告保留失败、模拟限制和被排除样本的原因。结束后只退出本任务 Obsidian 和假服务，删除本任务副本及 prepare 创建的 profile，不处理日常 Obsidian 的 CLI socket。

手机批 1–3 的补充验收：

```sh
# 每批使用独立 ECHOINK_PERF_OUT；四组正式流仍按上面的冷/热与1x/4x命令。
node scripts/runtime-smoothness/mobile-press-gestures.mjs gestures iphone
node scripts/runtime-smoothness/mobile-functional.mjs verify iphone
node scripts/runtime-smoothness/mobile-batch-summary.mjs --check
```

`functional` 在唯一假 Provider 的副本中走真实触摸发送、停止、继续、503 后重试、切任务、完成 Markdown 和代码复制；复制只临时拦截本次 `clipboard.writeText`，核对宿主去除末尾换行后的正文，finally 恢复，不覆盖系统剪贴板。审批使用合成 worker 任务，沿正式审批 UI 和 note_create 执行；副本中临时给测试员工开放知识库能力、启用一个合成目录绑定，finally 恢复。批准前文件不存在，批准后正文正确且完成操作只有一次。没有补丁或绕过 Runtime/权限检查；只有模型响应为固定本机 SSE。

`reading` 的程序写入以实际送达的 touchstart / 首个 touchmove / touchend 时间分窗；CDP 发指令前的准备阶段不算手指控制。summary 同时保留该阶段的早期写入数。旧构建替换触摸目标后，后续事件无法冒泡到 document，标记 nativeTouchWindow.complete=false；此时仅保留原指令阶段在真实按下之后的写入观察，不能据缺失事件声称已暂停。`mobile-scroll-summary.mjs` 可离线重算同一原始记录，避免重跑挑样本。

流式重建分稳定阶段与完成态替换：前者必须 0，后者允许一次 Markdown 交接。`mobile-batch-summary --check` 重解析八份修后流 trace，核对长任务和同步排版数字，再与功能、真实触摸时间窗及规模滚动记录汇总。原始记录、校准失败和超项留本机，摘要单独提交。

最终 lint 兼容性修正后的独立复测存 `batch3/final-after-lint/`；原 `batch3/after/` 保留。`mobile-batch-summary.mjs --final --check` 读取前者并输出 `batch3-summary-final.json`，不会覆盖原摘要。复测仍从样板新复制、构建部署、独立 profile/同端口开始，按相同冷/热、1×/4× 和阅读脚本执行；禁止与构建、全量测试并行采样。

批 4 的首屏、键盘和输入反馈入口：

```sh
node scripts/runtime-smoothness/mobile-navigation.mjs nav ipad 1
node scripts/runtime-smoothness/mobile-navigation.mjs nav ipad 4
node scripts/runtime-smoothness/mobile-keyboard.mjs keyboard ipad
node scripts/runtime-smoothness/mobile-input-feedback.mjs input ipad
# 单独目录的诊断；不能用插桩数据替代正式计时
node scripts/runtime-smoothness/mobile-navigation.mjs nav ipad 1 --diagnostic
```

设备替换为 `iphone` 即为手机口径。navigation 使用固定 200 任务、200 消息长会话和 2 消息短会话，每条路径连续三次：打开长会话、切短会话、长会话返回列表、真实假流生成中切走再返回；读到实际内容后等待所属窗口双 rAF，并断言正文或列表行确实与可见滚动区相交。Promise 完成时间另列，trace 保留各路径的开始/首屏标记和 GC 事件。1× 每次都须 ≤100ms，4× 只作压力观察。诊断的 structuredClone 累计计数包含相邻场景间的准备动作，只用于定位复制热点。

`mobile-keyboard-proxy.mjs` 临时代理 visualViewport.height 并派发 resize，finally 恢复；逐次断言布局尺寸、phone/tablet 身份不变。`keyboard --layout` 仅复现旧布局缩高代理的端型误判，使用独立输出目录；不能把该结果当成插件键盘缺陷。测量连接在视口设置后、计时开始前等待宿主端型稳定，再读回环境；它仍是 Chromium 代理，不代表真键盘或 WKWebView。

输入反馈记录按住时透明度/pressed 标记、松开后的原生焦点与 tap highlight。输入框应保持 opacity 1，焦点和光标由宿主负责；不要给它恢复 .65 来凑按压覆盖率。录像沿 mobile-record，始终另设输出目录。

已有批4完整证据后，离线复核：`node scripts/runtime-smoothness/mobile-batch4-summary.mjs --check`。它对照 paired-before/final 的三次首屏、输入与可见视口代理，重解析正式流/导航/滚动 trace，合并 CPU 与主流程摘要；raw trace 只留本机。
