# Notes Desktop

个人云网盘 **Notes** 的轻量桌面助手。

技术栈：**Tauri 2 + Vue 3 + TypeScript + Vite + ali-oss 6.23.x**。
UI 使用 Vue + 原生 CSS，无 UI 框架、无 Electron、无 Node sidecar。
本项目是由 ChatGPT 5.6 Sol + Deepseek v4.1 Flash + Deepseek Harness 框架基于 Web 项目 [NotesFrontend (Vue3-Web)](https://github.com/simon-hale/NotesFrontend) 移植而来的轻量级桌面端跨平台上传工具，暂时无功能补全计划。

## 功能范围

已实现：

```text
登录 / 自动登录 / 退出
云端目录浏览（root + 面包屑导航）
创建目录
文件 / 目录重命名
文件 / 目录删除（删除前确认）
文件上传（独立上传窗口，OSS 分片上传）
Windows Explorer 右键 “Upload to Notes”
```

---

## 1. 环境要求

| 依赖 | 说明 |
| --- | --- |
| Node.js | ≥ 18（推荐 20/22） |
| Rust | ≥ 1.77.2（`rustup` 安装） |
| 系统依赖 | Windows：WebView2 Runtime + MSVC 生成工具；macOS：Xcode CLT；Linux：webkit2gtk 等（见 Tauri 官方前置条件） |

> **Windows 请使用默认的 `x86_64-pc-windows-msvc` 工具链。**
> 如果改用 `x86_64-pc-windows-gnu`（MinGW），链接阶段可能出现
> `ld.exe: .rsrc merge failure: multiple non-default manifests` 警告，
> 那是 MinGW 的 windres 与 Rust 默认 manifest 叠加导致的工具链现象，不影响 MSVC 构建。

## 2. 配置（唯一的环境配置入口）

所有环境相关地址**只**在 `.env.local` 中维护，业务代码（`.vue` / `.ts` / `.rs`）里没有硬编码域名。

```bash
cp .env.example .env.local
```

`.env.example`（模板，会提交）：

```dotenv
VITE_API_BASE_URL=https://your-notes-backend.example.com
```

`.env.local`（真实地址，已被 `.gitignore` 忽略，不会提交）。

`VITE_API_BASE_URL` 是**唯一**需要你填的东西，它会被两处消费（触发时机不同，见 §3）：

1. 前端 `src/config.ts` —— 前端唯一读取环境变量的位置，所有 REST 请求都以它为 base，
   由 Vite（`npm run dev` / `npm run build`）使用；
2. Rust `src-tauri/build.rs` —— 在 **Rust/Tauri 构建时**把它写进
   `src-tauri/capabilities/default.json`，让 Tauri 的 HTTP capability **只**放行这一个后端域名。
   `build.rs` 是 Rust 构建脚本，只有 `cargo` / `tauri` 命令会执行它，
   `npm run build` 不会。

### CI / 打包机：用环境变量代替文件

`build.rs` 的取值优先级是：

```text
1. 进程环境变量 VITE_API_BASE_URL   ← CI 直接注入，不必往磁盘写任何文件
2. <项目根>/.env.local
3. <项目根>/.env
4. 占位域名 https://your-notes-backend.example.com
```

所以 CI 上可以完全不动 `.env.local`：

```bash
VITE_API_BASE_URL=https://notes.example.com npm run tauri:build
```

`build.rs` 里也声明了 `cargo:rerun-if-env-changed=VITE_API_BASE_URL`，
改了 CI 变量之后权限清单会自动重新生成，不会用到上一次的缓存结果。

> 前端侧同理：Vite 会读取进程环境里的 `VITE_API_BASE_URL` 并覆盖 `.env*` 文件里的值，
> 所以上面那条命令对前端构建同样生效。

> ⚠️ `VITE_*` 会被打进客户端构建产物，只能放"地址"这类非机密配置；
> **绝对不要**把密码、JWT、AccessKey、STS 凭证写进任何 `.env` 文件或代码。
> 仓库里也**不要**提交真实部署地址——`.env` / `.env.*` 全部被 gitignore，只放行 `.env.example`。

### 权限清单：模板 vs 生成物

| 文件 | 是否提交 | 说明 |
| --- | --- | --- |
| `src-tauri/capabilities/default.json.example` | ✅ 提交 | 权限清单**模板**（示例文件，Tauri 不会加载）。要增删权限改这里 |
| `src-tauri/capabilities/default.json` | ❌ 已 gitignore | **生成物**，Tauri 真正读取的权限清单，会被写入你的真实后端域名 |

后者在**编译期**被固化进二进制。因为里面必然带着你的后端地址，所以它不进仓库：

```text
capabilities/default.json.example
        │  build.rs 读取模板 + .env.local 里的 VITE_API_BASE_URL
        ▼
capabilities/default.json   （生成物，gitignored）
        │  tauri-build / tauri-codegen 读取
        ▼
编进二进制的 ACL
```

**你不需要手工维护它，但它只由 Rust/Tauri 构建路径生成。**
`build.rs` 是 Rust 构建脚本，只有 `cargo` 系列命令会执行它：

| 命令 | 会执行 `build.rs` 吗 | 会生成/刷新 `capabilities/default.json` 吗 |
| --- | --- | --- |
| `npm run typecheck` | ❌ | ❌ 前端类型检查 |
| `npm run build` | ❌ | ❌ **纯前端 TypeScript + Vite 构建** |
| `npm run dev` | ❌ | ❌ 只起 Vite dev server |
| `cargo check`（在 `src-tauri/`） | ✅ | ✅ |
| `cargo build`（在 `src-tauri/`） | ✅ | ✅ |
| `npm run tauri:dev` | ✅ | ✅ 开发态 Tauri 应用 |
| `npm run tauri:build` | ✅ | ✅ **推荐的生产打包命令** |

> ⚠️ 常见误解：`npm run build` **不会**执行 `build.rs`，也不会生成权限清单。
> 它只产出 `dist/`。要生成/刷新 `capabilities/default.json`，必须走 `cargo` 或 `tauri` 命令
> （`npm run tauri:dev` / `npm run tauri:build` 内部会调用 cargo）。

首次生成（或地址变化）时，Rust 构建输出会出现一条提示：

```text
warning: Notes Desktop: 已生成 capabilities/default.json，HTTP 权限作用域为 https://你的后端域名/*
```

只有内容真的变化时才写盘（避免 mtime 抖动引发重复编译）。全新克隆后第一次 `cargo build`
（或 `tauri dev` / `tauri build`）会从模板重建这个文件；如果连 `.env.local` 都没有，
就写入占位域名——此时前端同样会显示"缺少后端配置"，两边行为一致。

## 3. 开发与构建

### 各命令分别做什么

```text
npm run typecheck   -> 仅前端类型检查（vue-tsc 检查 src/，tsc 检查 vite.config.ts）
npm run build       -> 仅前端 TypeScript + Vite 构建，产出 dist/
                       ⚠️ 不执行 Rust build.rs，也不生成 capabilities/default.json
npm run dev         -> 仅 Vite dev server（浏览器里看 UI，Tauri API 不可用）

cargo check         -> Rust 静态检查（在 src-tauri/ 下执行）
cargo build         -> Rust 构建；会执行 build.rs，因此会按需生成 capabilities/default.json
                       （build.rs 是 Rust 构建脚本，只有 cargo 系列命令会跑它）

npm run tauri:dev   -> 开发态 Tauri 应用（内部调用 cargo，会执行 build.rs）
npm run tauri:build -> 推荐的生产打包命令（内部调用 cargo + 打包器，会执行 build.rs）
```

### 推荐的全新构建流程

```bash
npm ci                                      # 按 package-lock.json 安装依赖
cp .env.example .env.local                  # Windows: copy .env.example .env.local
                                            # 然后填入真实的 VITE_API_BASE_URL

npm run typecheck                           # 前端类型检查
npm run build                               # 前端构建（产出 dist/）

cd src-tauri && cargo check && cd ..        # Rust 检查，同时生成 capabilities/default.json
                                            #（不想手动 cd 也可以跳过，下一步会一并完成）

npm run tauri:dev                           # 功能自测
npm run tauri:build                         # 生产打包
```

> `capabilities/default.json` 由 **Rust/Tauri 构建路径**（`build.rs`）生成，
> **不是**由独立的 Vite 前端构建生成。所以在跑 `npm run tauri:dev` / `npm run tauri:build`
> 之前先做一次 `cargo check`，可以在最早的时间点发现权限清单或后端地址的问题。

### 打包（`npm run tauri:build`）

一条命令搞定：它内部先执行 `beforeBuildCommand`（= `npm run build`）产出 `dist/`，
再用 `--release` 编译 Rust，最后调用打包器产出安装包。

Windows 上 `bundle.targets = "all"` 会同时产出 MSI 与 NSIS 安装包，
首次运行会自动下载 WiX / NSIS 工具链到 `%LOCALAPPDATA%\tauri`：

```text
src-tauri/target/release/notes-desktop.exe                              单文件可执行程序
src-tauri/target/release/bundle/msi/Notes Desktop_1.0.0_x64_en-US.msi   MSI 安装包
src-tauri/target/release/bundle/nsis/Notes Desktop_1.0.0_x64-setup.exe  NSIS 安装包
```

macOS 产出 `.app` / `.dmg`，Linux 产出 `.deb` / `.rpm` / `.AppImage`（在对应平台上执行同样的命令）。

打包前请确认：

- `.env.local` 里的 `VITE_API_BASE_URL` 是**目标环境**的地址——它会被同时写进前端产物和
  `capabilities/default.json`（HTTP 权限白名单）。地址非法会让构建直接失败（fail closed）；
- 想临时覆盖（例如 CI），直接注入环境变量即可：`VITE_API_BASE_URL=https://… npm run tauri:build`。

> ⚠️ **Tauri CLI 会校验 Rust crate 与 npm 包的版本必须处于同一 major.minor。**
> 例如 `tauri-plugin-http` 的 crate 已经发到 2.7.x，而对应的 npm 包
> `@tauri-apps/plugin-http` 最新仍是 2.6.1；如果 `Cargo.toml` 写成 `"2"`，
> cargo 会解析出 2.7.0，`tauri build` 会直接报
> `Found version mismatched Tauri packages` 并**拒绝打包**。
> 因此这里固定为 `tauri-plugin-http = "2.6"`。升级任何插件时，
> 记得让 npm 包与 crate 的 major.minor 保持一致。

### 其他说明

- **只调前端样式 / 组件**：`npm run dev`，浏览器里打开即可（Tauri API 不可用）。
- **`cargo clippy`**：在 `src-tauri/` 下执行；三平台共用代码，
  Windows 专属代码全部位于 `cfg(target_os = "windows")`。

> **构建目标按平台自动选择。** `vite.config.ts` 读取 Tauri CLI 注入的
> `TAURI_ENV_PLATFORM`：Windows 用 `chrome105`（WebView2 是 Chromium 内核），
> macOS / Linux 回落到 `safari13`（WebKit）。手写 `npx vite build` 时该变量为空，
> 会走 `safari13` 分支，同样是可用的安全默认值。

## 4. 窗口与行为

应用只有两个窗口，加载同一个 SPA，由 `getCurrentWindow().label` 决定渲染哪个视图。

| label | 尺寸 | 说明 |
| --- | --- | --- |
| `main` | 900×650 | 首页：`Notes / 当前账号 / Upload / New Folder / Logout` + 面包屑 + 文件夹/文件列表 |
| `upload` | 560×620 | 独立上传窗口，默认隐藏；待上传列表 + 目标云目录 + 目录选择 + 进度 |

- 首页 **Upload** → `open({ multiple: true, directory: false })` 选本地文件 →
  `queue_upload_paths()` 入队 → 打开上传窗口（带上当前目录作为目标目录建议）。
- 上传窗口**默认隐藏**，关闭时只 `hide()` 不销毁，因此上传状态不会丢；
  有任务在上传时会先弹确认，确认后取消并清理（详见下文「关闭上传窗口」）。
- 上传窗口在**登录页 / 初始化 / 断网重试**期间也由 `App.vue` 的关闭守卫保护：
  任何情况下都不会被销毁，只隐藏，保证 `open_upload_window` 始终能找回它。

### 跨窗口登录状态同步

两个窗口是两个独立 WebView，各自在内存里持有 JWT。它们通过两个轻量事件保持一致：

```text
notes:auth-changed   某个窗口登录成功 -> 其它窗口从 Tauri Store 取回令牌并切换为已登录
notes:logout         某个窗口退出 / 令牌被判定失效 -> 其它窗口立即清空内存认证态
```

- **JWT 不会出现在事件 payload 里**：事件只带 `username` 这类非敏感标记，
  接收方一律回 `auth.json` 重新读取。
- **只发给另一个窗口**：用 `emitTo(另一个窗口的 label, ...)` 而不是全局 `emit`，
  发送方不会收到自己发出的事件，也就不存在"处理自己事件"的回环：

  ```text
  本地 login / logout      -> 定向广播给另一个窗口
  远端 auth-changed 事件   -> 作废旧请求 -> 重读 Store -> 本地应用，不广播
  远端 logout 事件         -> 本地清理（clearSession(false)），不广播
  ```

  即收到的广播不会再被转发出去，而本地登录/退出仍然照常广播。
- 事件监听在 `AuthGate` 挂载时注册、**等两个 listener 都注册完成后才调用 `initAuth()`**，
  避免启动瞬间的登录/退出事件因为监听未就绪而丢失；卸载时统一释放。

#### 退出登录 / 换账号会清理账号相关的界面状态

`auth.ts` 提供 `onSessionChanged()` 订阅，派发时带上 `{ previousUsername, currentUsername }`
（**只有账号名，没有 JWT**）。会话被清空、登录、或登录账号发生变化时都会派发一次，
用于丢掉上一个账号遗留的状态，**避免新账号复用旧的目录 ID、上传队列或恢复任务**：

- `upload.ts`：**先请求取消**，并在任何 `await` 之前重算 `uploadState.tasks` 与清空目标目录，
  **再**对上一会话的上传做有界等待；被移出界面的任务对象仍被 worker 持有，
  会照常走完取消/清理。任务的取舍见下一节。
- `UploadView`：目标为空**且没有上传在跑**时加载当前账号自己的 root
  （同时监听 `target.length` 与 `running`，因此上一会话的上传收尾后也能补上初始化）。
- `HomeView`：清空面包屑/列表，并在仍处于登录态时重新 `loadRoot()`。

订阅者出错不会影响其它订阅者，也不会阻塞认证流程（清理本身是异步的）。

#### 恢复任务（metadata-pending）如何跨重新登录保留

**可恢复任务的定义**：`objectUploaded === true && status !== 'success'`，
也就是"OSS 对象**已经完整上传**，但 `/api/file/insert/` 还没成功"。
每个任务在创建时都会打上 `ownerUsername`（**只记账号名，绝不记 JWT**）。

会话变化时的取舍规则（其余任务一律清掉，与之前一致）：

| 场景 | `previousUsername` → `currentUsername` | 保留谁 |
| --- | --- | --- |
| 退出登录 / 令牌失效 | `A` → `''` | `A` 的恢复任务（等它回来补写元数据） |
| 同一账号重新登录 | `''` → `A` | `A` 的恢复任务继续可重试 |
| 换账号登录（本地或远端） | `A` → `B` | 只留 `B` 的；**`A` 的全部丢弃** |

即 `keepUsername = currentUsername || previousUsername`，只有
`isMetadataPendingTask(task) && task.ownerUsername === keepUsername` 的任务会被保留。
**一个账号的待办永远不会出现在另一个账号的界面里。**

重试行为：

- 只用**当时最新的**访问令牌（`getAccessToken()`），不会保存或复用旧令牌；
- 只走补写元数据的分支（`/api/file/insert/`），**绝不重传 OSS 对象**；
- 因此即使重新登录后换了目标目录也不影响它——补写用的是上传成功时保存的
  `uploadedPath` / `uploadedParentId` / `uploadedFilename` 快照。

其他约束：恢复任务**只存在于内存**，不落盘，应用重启即丢弃（本项目没有为上传队列
设计持久化机制）；这类任务仍然只能 Retry，不能被 Remove / Clear。

#### 认证请求的代际号（防止过期响应覆盖新登录）

`src/services/auth.ts` 维护一个 `authGeneration`。登录、退出、远端登录态变化、重试、
初始化都会 `++authGeneration` 并 abort 上一个在途请求；任何请求在写状态之前必须同时满足：

```ts
generation === authGeneration && verifiedToken === accessToken
```

满足不了就**什么都不做**。远端 `auth-changed` 处理还会在作废请求之后**捕获当时的代际号**，
并在每次 `await` 读取持久化信息之后重新比对，因此"处理期间又发生了新登录"时，
这次远端变化的结果会被直接丢弃，不会覆盖更新的认证状态。

因此"为旧令牌发出的延迟 401"永远不可能：
清掉一个更新的有效登录、把界面踢回登录页、或删除刚写入的凭据。

### 上传活动状态与退出

是否"有上传在跑"由 Rust 侧显式的 `UploadActivity(bool)` 记录，
**不用上传窗口的可见性来推断**（窗口可见 ≠ 正在上传，窗口隐藏也可能还有任务在收尾）：

```text
上传窗口：startUpload() 开始时 set_upload_active(true)
          · fail-closed：登记失败就【不开始上传】，复位本地运行态并提示用户；
            因为退出逻辑依赖它，登记不上就可能导致"有上传时直接退出"。
          整轮上传的 finally 里 set_upload_active(false)   ← 最终清理路径
          · best-effort：成功/失败/取消三条路径都会执行，失败只做一次轻量重试后放弃；
            即使没清掉，Rust 侧的退出等待仍有硬超时兜底。
```

**`running` / `waitForUploadIdle()` 覆盖的是完整生命周期**，而不只是文件 worker：

```text
生命周期 promise = set_upload_active(true) 登记
                 + 跑完所有任务（成功 / 失败 / 取消）
                 + 最终的 set_upload_active(false) 清理
```

只有这个 promise 真正结束之后，才会把 `uploadState.running` 置 false、
把 `runningPromise` 置空、释放 `runController`。这样：

- 关闭窗口 / 取消 / 会话清理里的 `waitForUploadIdle()` 等待的是"连清理都做完了"；
- **登记那一步也在 promise 里**：否则在 `set_upload_active(true)` 这个 IPC 还在路上时，
  `running === true` 而 `runningPromise === null`，`waitForUploadIdle()` 会立刻误判为 idle；
- 新的上传不可能在上一轮的 `setUploadActive(false)` 还悬着时就开始
  （否则旧的那次 false 可能盖掉新的 true，让退出逻辑误判）。

清理用一个 `activeRegistered` 标记把关：**只有登记成功过才执行 `set_upload_active(false)`**，
登记失败（fail closed，压根没开始上传）时不会去清一个从未登记成功、可能属于别人的状态。

关闭主窗口（= 退出应用）时**不会**直接 `app.exit(0)`：

```text
1. UploadActivity == false  -> 直接退出
2. UploadActivity == true   ->
     a. Rust 广播 notes:prepare-exit
     b. 上传窗口：请求取消 -> 等真正 idle（含 best-effort abortMultipartUpload 与 worker 退出）
     c. 上传窗口回报 confirm_exit_ready
     d. Rust 最多等 EXIT_CLEANUP_TIMEOUT_MS = 5s，超时也会退出
```

等待在 Rust 侧的一个普通线程里完成，不依赖异步运行时是否还活着，
所以 OSS abort 失败或上传窗口无响应都**不会**让退出无限阻塞。
首页与上传窗口会分别显示"正在退出…"与"正在取消上传并清理未完成的分片…"。

### 关闭上传窗口：取消与收尾的顺序

```text
请求取消（abort signal + 立刻发一次 best-effort abortMultipartUpload）
  -> 等上传真正 idle（其中包含完整的 multipart 清理）-> 才隐藏窗口
```

- 有上传在跑时先弹确认；确认后进入取消流程。
- 取消时会**立刻**对进行中的 multipart 发一次 `abortMultipartUpload`，
  不必等当前分片请求返回——但这是"尽早发出清理请求"，
  **不等于**在途分片会立即终止（HTTP 请求无法强制中断）。
- multipart 自己的失败/取消路径仍然完整执行：
  `abort` → `Promise.allSettled(workers)` → 再 abort 一次（清掉第一次之后才完成的分片）。
- 如果超过 `UPLOAD_CLEANUP_TIMEOUT_MS = 3s` 还没收尾，
  **窗口保持可见**并显示"正在取消上传并清理未完成的分片…"，
  后台继续等待真正 idle 后再隐藏——**不会假装上传已经停了**。
- 期间重复点关闭不会重复取消；如果用户在这段时间又发起了新上传，则不会把窗口藏起来。

### ⚠️ 取消是"尽力而为"，不是保证

**不要指望退出/取消时 OSS 上的分片一定被清干净。** 实际情况是：

- 已经发出的分片 HTTP 请求**无法被强制中断**（`ali-oss` 没有暴露该能力），
  只能等它自己返回或超时。取消时我们能做的是：
  设置取消标志、立刻**发出**一次 best-effort `abortMultipartUpload`（早发请求，不是立即终止）、
  停止启动新的分片、等 worker 退出后再补一次 abort，并且**有界等待**后就不再拖延退出。
- 因此下列情况都可能留下**未完成的 multipart 分片**：
  网络卡死导致单个请求直到 180s 超时才返回、进程崩溃、被任务管理器强杀、
  断电，以及退出等待（Rust 侧 5s）先于分片请求超时。
- 这些残留分片既不会被合并成对象，也不会出现在 `files` 表里，
  但会占用 OSS 存储空间。

**最终兜底机制是 OSS 生命周期规则**，请在目标 Bucket 上配置一条
「删除过期未完成的分片」（`AbortMultipartUpload`）规则，例如：

```text
规则：未完成分片（Incomplete Multipart Upload）在 3 天后自动删除
```

这样无论上层发生什么（崩溃、强杀、超时），残留分片都会被 OSS 自动回收。
应用侧的 `abortMultipartUpload` 只是"尽快清理"的优化，不能替代这条规则。

### 目标目录建议：同样是"事件只做通知"

`notes:upload-target` 与 `notes:upload-pending` 遵循同一条规则：

```text
Rust 存 hint -> emit 通知 -> UploadView 收到通知 -> take_upload_target_hint()
                                                      （Rust 侧 slot 被取空）
```

**不能直接用 `event.payload`**：那样 Rust 里的 `UploadTargetHint` 永远不会被清空，
账号 A 留下的目录建议会在账号 B 重新 mount 时被 `take_upload_target_hint()` 取出来，
把 B 的目标目录覆盖成 A 的目录 ID。

### 跨账号的会话守卫

账号相关的异步操作统一遵循"发起时捕获令牌，`await` 之后校验"的规则：

| 位置 | 校验内容 |
| --- | --- |
| `addPaths()` / 待上传队列 / 目标建议消费 | 上传会话代际号（`uploadSessionGeneration`） |
| `HomeView` / `UploadView` 的**系统文件对话框** | 打开对话框前先捕获令牌/代际号，返回后与入队后再各校验一次 |
| `DirectoryPicker` 的每个目录请求 | `generation` + `getAccessToken() === token` + `!disposed` |
| `HomeView` 的目录读取 | `generation` + 令牌 + `!disposed` |
| `HomeView` 的创建/重命名/删除 | 发起时的令牌（弹窗还会记住打开时的令牌） |
| `UploadView.initializeTarget()` | 发起时的令牌 + `target` 仍为空 + 没有上传在跑 |

系统文件对话框可能停留很久，期间账号完全可能被换掉（另一个窗口退出/登录），
所以它是单独一类需要"进入前捕获、返回后校验"的异步操作。

会话切换时，`DirectoryPicker` 会中止在途请求、清空面包屑与列表（仍打开且有令牌就用新会话重新初始化）；
`HomeView` 会关掉上一个账号遗留的 Rename / New Folder 弹窗并复位 `mutating`。

### 同一时间只接受一个上传批次

首页顶部 **Upload** 会在**打开文件选择器之前**与**返回之后**各检查一次；
两个状态**互补**，任一为真都直接拒绝新批次，
提示"已有上传正在进行"并聚焦已有上传窗口：

| | 含义 | 谁写 | 谁读 |
| --- | --- | --- | --- |
| `UploadActivity` | 此刻是否有上传在跑 | 上传流程（startUpload 起止） | 退出逻辑、首页关闭确认、**首页开新批次前** |
| `UploadBatchBusy` | 这一批是否仍占着目标目录 | **只由上传窗口**在任务列表变化时写 | 首页开新批次前 |

只看 `upload_active()` 是不够的：队列里还躺着待上传 / 失败任务时它是 false，
但那一批仍然占着**全局唯一的目标目录**。
所以另有一个独立状态 `UploadBatchBusy`（**刻意与 `UploadActivity` 分开**，退出语义不变）。

`UploadBatchBusy` 的判定规则：列表里**只要还有没成功的任务**
（待上传 / 上传中 / 失败 / 已取消，含只差补写元数据的）就算占用中；
全部成功或列表被清空后才释放。会话切换时由 `upload.ts` 的清理路径兜底置为 false。

**状态查询失败时 fail closed**：两次检查里任何一个 Rust 查询出错，都按"不允许开新批次"处理
（同样提示并聚焦），绝不放过"两批共用同一个目标目录"的情况。

上传窗口自己的"添加文件"不受此限制——它加进的是同一批、用的是同一个目标目录。

### 首页选完文件后会补一次 pending 通知

`queue_upload_paths` 只入队、不广播，所以首页在 `open_upload_window()`（应用/广播目标目录建议）
之后再定向发一次 `notes:upload-pending`，顺序是"先目标、后通知"。
事件依旧只是通知：payload 里不含任何路径，上传窗口收到后自己调用
`take_pending_upload_paths()` 取走真实数据（与冷启动、Explorer 右键完全同一条路径）。

## 5. Windows Explorer 右键 “Upload to Notes”

- 使用**当前用户级 classic Shell Verb**，写 `HKCU`，**不需要管理员权限**：

```text
HKCU\Software\Classes\*\shell\NotesUpload
  (默认)            = "Upload to Notes"
  MultiSelectModel  = "Single"
  Icon              = "<当前 Notes 可执行文件绝对路径>"
HKCU\Software\Classes\*\shell\NotesUpload\command
  (默认)            = "\"<Notes 可执行文件绝对路径>\" --upload \"%1\""
```

- 注册是**幂等**的，并且会用 `std::env::current_exe()` 刷新 executable path
  （换安装目录后自动修正）。

- **用户可以关掉它，应用会记住。** 首页底部有一个开关，对应偏好
  `shellIntegrationEnabled`（存在 `settings.json`）：

  | 偏好 | 启动时的行为 |
  | --- | --- |
  | 缺省 / `true` | 幂等注册（或刷新已存在的项），保持"装好即注册" |
  | `false` | **完全不触碰注册表**，尊重用户的选择 |

  关闭时会同时删除已有注册表项；重新打开会立即重新注册。
  写偏好只走 Tauri Store，Rust 侧在 `setup()` 里读同一个文件决定要不要注册。
  **偏好始终与注册表实际状态保持一致**：注册表操作失败时会回滚偏好并刷新显示真实状态，
  不会出现"开关显示已关闭、注册表其实还在"这类不一致。

- 需要卸载时也可以用首页开关，或直接删除上面两个注册表项。
- **Windows 11**：该 classic verb 出现在右键菜单的 **“显示更多选项”**（Shift+F10）里。
  V1 有意不实现 COM `IExplorerCommand` / DLL / sparse package，因此不会再占用一级菜单。
- 收到的路径**只作为普通参数**处理：应用绝不会把文件路径拼接成 shell 命令执行。

### 单实例与 `--upload`

`tauri-plugin-single-instance` 是**第一个**注册的插件，应用只允许一个实例。

```text
冷启动：Notes Desktop.exe --upload "C:\a.pdf"   → 入队 + 显示并聚焦上传窗口
已运行：Notes Desktop.exe --upload "C:\b.zip"   → 第二个实例立刻退出，
                                                 第一个实例的 callback 入队并显示上传窗口
```

只接受 `--upload <path>`；路径必须真实存在且是普通文件才会入队。
路径数据放在 Rust 侧 `PendingUploads(Mutex<Vec<PathBuf>>)`，事件只做通知，
上传窗口 mount 时主动调用 `take_pending_upload_paths()`，
所以不存在"listener 还没初始化就丢文件"的问题。

## 6. 上传流程

严格保留现有 NotesFrontend 的语义：

```text
申请 STS  →  OSS 上传真正完成  →  POST /api/file/insert/  →  才算 100% 成功
```

| 项 | 值 |
| --- | --- |
| 分片大小 | 5 MiB |
| 单文件分片并发 | 3 |
| 文件之间 | 串行 |
| OSS 请求超时 | 180 s |
| 失败分片重试 | 最多额外 2 次（等待 500 ms、1000 ms） |
| 空文件 | `client.put(objectKey, new Blob([]))`，成功后再 insert |
| 目标路径 | `breadcrumbs.map(i => `${i.id}/`).join('')`，例如 `1/12/34/` |
| 进度 | OSS 阶段最多 99%，insert 成功后才 100% |

其他要点：

- 本地文件通过 Rust 命令 `read_file_chunk(path, offset, length)` 分片读取，
  用 `tauri::ipc::Response::new(bytes)` 以**原始二进制**返回（无 base64、无 JSON）。
  每次都是打开 → seek → 读取 → 函数结束 RAII 关闭，不存在常驻文件句柄。
- 只保留 `{ number, etag }`，每个分片用完立即释放 `Uint8Array / ArrayBuffer / Blob` 引用，
  因此内存占用不随文件大小线性增长（GB 级文件同样如此）。
- 重试只针对失败分片，已完成分片不重传；严重失败或用户取消会 best-effort
  `abortMultipartUpload`，abort 自身失败不会覆盖原始错误。
- 分片 worker 共享一个 `stopScheduling` 标记：任一 worker **最终失败**时先置位，
  其它 worker 完成手头在途的分片后立即退出，不再领取新分片。
  这不会改变 abort 架构（仍是 abort → `Promise.allSettled(workers)` → 再 abort 一次），
  只是避免在第一次 abort 生效前白白继续上传、拖长取消时间。
- insert 失败时明确提示 **“OSS 已上传成功，但文件元数据写入失败”**。
  再次重试**只补写数据库**，不会偷偷重传整个文件，而且这个补写是自洽的：

  - 上传成功时会把 `uploadedPath` / `uploadedParentId` / `uploadedFilename` 三个快照记在任务上；
  - 重试时**先走补写分支**：不 `stat` 本地文件（文件可能已被删除/移动），也不看当前 UI 目标目录；
  - 因此即使用户改了目标目录，也不会"重新上传一遍"而把原来那个已经完整上传、
    数据库里却没有记录的 OSS object 永久遗留。
  - 这类任务（`objectUploaded && status !== 'success'`）**只能 Retry**：
    `removeTask` / `clearFinishedTasks` / `clearAllTasks` 都会保留它，
    界面上也不提供"移除"按钮——丢掉它等于制造一个用户看不见也删不掉的 OSS 孤儿对象。
- 同目录同名：后端返回 `same_file_name` 时给出简短覆盖提示并继续上传（沿用后端覆盖语义）。
- **登录态失效（后端 tokenVersion 机制）**在接口层表现为 HTTP **401 / 403**，
  上传流程把它识别为“会话过期”而不是普通上传失败：

  | 行为 | 说明 |
  | --- | --- |
  | 提示 | 显示 **“登录状态已失效，请重新登录”**；若 OSS 对象已传完，追加“登录后重试只会补写元数据” |
  | 重试 | **不重试**。`isRetryableError` 明确把 401/403 排除在外，分片重试、空文件重传都不会覆盖它 |
  | 当前请求 | 上传流程自身遇到 401/403 时**不主动清任务、不清目标目录、不触发 `logout()`** |
  | 恢复状态 | 已经 OSS 完成的（99%）任务保持 99% 与 `uploadedPath` / `uploadedParentId` / `uploadedFilename` 快照；会话变化时仅保留属于相应账号的 metadata-pending 任务，重新登录后可继续补写元数据、不重传文件 |

  这里不由上传流程直接触发 `logout()`：401/403 发生时 OSS 上可能已经存在完整对象，
  直接清掉恢复任务会制造用户无法管理的孤儿对象。

  如果登录态随后确实发生变化，则仍会走 `clearSession` → `onSessionChanged`：
  普通或未完成的上传任务会被清理，目标目录会重置；只有“OSS 已完整上传、元数据尚未写入”
  且属于对应账号的恢复任务会暂时保留。同一账号重新登录后可继续 Retry；
  若切换到其他账号，则旧账号的恢复任务会被丢弃，避免跨账号状态泄漏。

## 7. OSS CORS（可能需要运维配置）

REST 请求由 `@tauri-apps/plugin-http` 在 **Rust 侧**发出，不受 WebView CORS 限制；
但 `ali-oss` 是在 **WebView 里用 XHR** 直连 OSS 的，因此仍然受 WebView 的 CORS 约束。

如果现有 Bucket 的 CORS 只允许 Web 站点域名，桌面端的 origin 不在白名单里，
上传会在浏览器层被拒绝。此时需要在 OSS Bucket 的跨域设置里**增加**桌面端 origin：

```text
Windows / Android : http://tauri.localhost
macOS / iOS / Linux: tauri://localhost
```

需要放行的 Method：`PUT`、`POST`、`GET`、`HEAD`；
需要放行的 Header：`*`（至少包含 `Content-Type`、`Content-Length`、`x-oss-*`、
`authorization`、`x-amz-*` 等由 SDK 自动加上的签名头）；
**必须暴露的 Header：`ETag`**（缺它 multipart 无法完成，SDK 会直接报错
"Please set the etag of expose-headers in OSS"）。

对应地，`tauri.conf.json` 的 CSP `connect-src` 只额外开放了 `https://*.aliyuncs.com`。

本项目**不会**通过关闭 WebView 安全机制、放宽 CSP 或把长期 AccessKey 放进客户端来绕过 CORS。

## 8. 安全与稳定性

- JWT 只用于 Notes 后端的 `Authorization: Bearer` 头；不打印日志、不拼 URL、不发给 OSS，
  **也不放进跨窗口事件**（`notes:auth-changed` 只带 username）。
- 登录信息存在 Tauri Store（`auth.json`，位于应用数据目录），**不使用 WebView localStorage**。
  Store 只承担持久化，它不是系统密钥链，也不是强加密保险箱。
  应用偏好（右键菜单开关）存放在同目录的 `settings.json`。
- 启动时若存在 `username` / `access` 会调用 `/api/user/auto-login/` 恢复登录；
  只有**明确的认证失败（401/403）**才清理持久化信息，普通断网 / 超时 / 5xx 会保留令牌并提供重试。
  当前后端没有 refresh-token 机制，本项目也没有自行发明一个。
- STS 凭证只存在于内存中，用完即弃；不落盘、不记录长期 AccessKey。
- Tauri capability 采用最小权限：`core:default` + 上传窗口自身需要的 window 权限 +
  `dialog:allow-open` / `dialog:allow-confirm` + `store:default` + 仅指向配置后端的 `http:default` 作用域。
- 目录切换带 request generation + `AbortController`：绝不让旧响应覆盖当前目录。
- 所有事件 listener / timer / AbortController / 上传 worker 都有明确 cleanup：
  - 事件注册一律经 `src/utils/listeners.ts` 的 registry 登记，
    **即使组件在 `listen()` / `onCloseRequested()` 的 Promise resolve 之前就卸载**，
    注册完成后也会立刻 `unlisten`，不会泄漏监听；
  - `HomeView` / `DirectoryPicker` / `UploadView` 卸载时 abort 在途请求、清除定时器，
    并用 `disposed` 标志保证异步回调不再写已销毁组件的状态；
  - 上传取消时先**尽早发出**一次 best-effort `abortMultipartUpload`（这只是清理请求，
    已经发出的分片 HTTP 请求不会因此立即终止），再 `Promise.allSettled` 等所有
    worker 退出并补一次 abort，不留游离的分片上传任务。
- Windows 专属代码（含 `winreg` 依赖）全部位于 `cfg(target_os = "windows")` 之内，
  macOS / Linux 可以正常编译，也不会链接 `winreg`。

## 9. 目录结构

```text
src/
  App.vue                  按窗口 label 选择视图
  main.ts
  config.ts                唯一读取 VITE_* 的地方
  components/
    AuthGate.vue           启动恢复登录 / 登录页 / 断网重试 / 跨窗口登录态同步
    Breadcrumbs.vue
    FileList.vue
    DirectoryPicker.vue
    UploadItem.vue
  views/
    LoginView.vue
    HomeView.vue
    UploadView.vue
  services/
    api.ts                 后端协议（表单 POST + Bearer）
    auth.ts                Tauri Store 持久化 + auto-login + 跨窗口广播 + 认证代际号
    settings.ts            应用偏好（右键菜单开关）
    filesystem.ts          Rust 命令封装
    upload.ts              唯一的上传实现（UploadService）
    events.ts              事件名（跨窗口 + Rust）
  types/
  utils/
    listeners.ts           事件注册的统一登记/释放
    format.ts
  styles/theme.css

src-tauri/
  build.rs                 构建前由模板 + .env.local 生成 capabilities/default.json
  src/
    lib.rs                 入口、single-instance、窗口显示/聚焦、启动时按偏好注册右键菜单
    config.rs              统一常量（事件名、退出超时、settings key）
    commands/
      files.rs             stat_local_file / read_file_chunk
      upload_queue.rs      PendingUploads / UploadActivity / queue & take / 打开上传窗口
      app_lifecycle.rs     优雅退出握手（基于 UploadActivity）
    shell_integration/
      mod.rs               平台分发 + is_enabled（读用户偏好）
      windows.rs           HKCU classic verb
      macos.rs             V1 Unsupported
      linux.rs             V1 Unsupported
  tauri.conf.json
  capabilities/
    default.json.example   权限清单模板（提交）
    default.json           生成物（gitignored，含真实后端域名）
```

## 10. V1 已知限制

- macOS / Linux 的 `shell_integration` 为 Unsupported / No-op（只保留模块边界，
  不影响编译，也不影响主页与上传窗口）。
- **取消 / 退出时的 OSS 清理是尽力而为，不是保证**：
  已经发出的分片请求无法强制中断，取消只是停止启动新分片 + best-effort
  `abortMultipartUpload`，并且有界等待后不再拖延退出。
  网络卡死、崩溃、强杀、断电都可能留下未完成的分片，
  **必须依赖 Bucket 的「删除过期未完成分片」生命周期规则做最终回收**（见 §4）。
- 断点续传不在范围内：取消或失败后重试会从 STS 重新开始。
