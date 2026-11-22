# Antigravity 接入与新机重建指南

> 本文档记录把 Antigravity（Google 的 agy CLI）接进飞书桥的完整流程，以及重建时要避的坑。
> 代码已包含 Antigravity 适配器与动态 `/model` 切换（commit `1fa4f1c` 起）。按本文档走一遍，即可在新机器/新盒子上重建。

---

## 一、装 agy 并登录

1. 安装 agy（Google Antigravity CLI），装到 `~/.local/bin/agy`。
   注意：`~/.local/bin` 通常不在默认 PATH 里，调用时用全路径，或把该目录加进 PATH。
2. **登录必须在 tmux 里跑**。agy 没有 TTY 会直接报错（bubbletea 错误）。
   ```bash
   tmux new-session -d -s agy-login 'agy'
   tmux attach -t agy-login
   ```
3. 选 Google OAuth 登录后，终端显示授权链接。
   链接可能被折行，用 `tmux capture-pane -J -p -t agy-login` 抓屏、把折行拼接起来再打开。
4. 在浏览器里完成授权，把授权码粘回 tmux 完成登录。
5. 验证：
   ```bash
   ~/.local/bin/agy models        # 能列出可用模型
   ~/.local/bin/agy -p "你好"     # 问答测试通过
   ```

---

## 二、装桥

```bash
git clone <本仓库> && cd Bridgerebuild
pnpm install
pnpm typecheck && pnpm build     # 先验证再安装，不要跳过
pnpm build:global                # 或按 README 的全局安装步骤
```

改完源码后同样：先 `pnpm typecheck` + `pnpm build` 通过，再装到全局。

---

## 三、建 profile（最容易踩坑的一步）

```bash
tmux new-session -d -s profile-create
tmux send-keys -t profile-create 'lark-channel-bridge profile create --agent antigravity' Enter
tmux attach -t profile-create
```

**铁律**：

1. **必须在 tmux 里直连 TTY 跑，禁止加任何管道重定向**（如 `| tee`）。
   加了管道会被程序判为非交互模式，直接拒绝创建。输出靠 `tmux capture-pane` 抓。
2. **扫码绑定飞书应用**。也可以用已有的 App ID / App Secret。
3. **不要关 YOLO**。Antigravity 的 `dangerouslySkipPermissions` 在创建时默认就是开的，
   保持开启。关掉后飞书里每个操作都要确认，但桥侧没有终端可确认，会卡死。
4. **创建中途失败不用慌**。失败时会留下一个半成品目录（只有密钥文件、没有配置），
   先清理该 profile 目录再重建。**飞书应用本身不用重建**，复用之前建好的那个即可。

服务条款页的数据收集复选框保持默认即可，事后可在 Antigravity 设置里退出。

---

## 四、起服务（systemd 用户服务）

每个 profile 一个服务，模板见 `scripts/systemd/lark-channel-bridge.bot.@.service`，
把 `@` 换成 profile 名（如 `claude`、`antigravity`）安装到 `~/.config/systemd/user/`：

```bash
which node   # 先查 node 的实际路径，下面要用
cp scripts/systemd/lark-channel-bridge.bot.@.service \
   ~/.config/systemd/user/lark-channel-bridge.bot.antigravity.service
# 编辑刚拷好的文件，把 NODE_PATH 换成 which node 的结果
systemctl --user daemon-reload
systemctl --user enable --now lark-channel-bridge.bot.antigravity.service
```

要点：

- `PATH` 里必须含 `~/.local/bin`，否则服务找不到 agy。
- `Restart=always`，桥崩了自动拉起来。
- 日志在 `~/.lark-channel/profiles/<profile>/logs/daemon/`（`daemon-stdout.log` /
  `daemon-stderr.log`），journal 里基本没内容，查问题看这两个文件。

---

## 五、看门狗（推荐装）

桥进程活着、但到飞书的 WebSocket 偶尔会卡死（日志标记 `[keepalive.ws-stuck]`），
表现为用户发消息零回复。看门狗每 2 分钟检查一次，抓到就自动重启：

```bash
cp scripts/bridge-watchdog.sh ~/bin/bridge-watchdog.sh
chmod +x ~/bin/bridge-watchdog.sh
cp scripts/systemd/bridge-watchdog.service scripts/systemd/bridge-watchdog.timer \
   ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bridge-watchdog.timer
```

检查三项：服务在运行、桥进程有 TCP 连接、新增日志里无未恢复的 ws-stuck。
多 profile 时脚本会逐个看守（每个 profile 独立的状态文件）。

---

## 六、飞书里用 /model 切换模型

- `/model`：弹出模型选择卡片。
- `/model <模型ID>`：直接切换。
- `/model refresh`：重新拉取模型列表（**换账号后必须跑一次**，列表是动态取的）。
- `/model status` / `/model default`：查看当前选择 / 恢复默认。

模型列表每次从 `agy models` 动态取（10 分钟缓存），换账号后模型不同也能自动适配。
切换后下一条消息开新会话生效，**不用重启桥**。

---

## 七、已修复的坑（当前代码不会再遇到，记录备查）

1. **profile 创建时 antigravity 配置对象未生成**：`profile-bootstrap.ts` 只给 codex
   生成配置对象，antigravity 的校验直接抛错，进程在写全局配置前退出，
   只留下半成品目录。已修：bootstrap 补 `createBootstrapAntigravityConfig`。
2. **保存时 antigravity 配置被丢弃**：`profile-store.ts` 的序列化字段清单和类型里
   只有 codex、没有 antigravity，配置保存时被丢掉。已修：两处都补上 antigravity。
3. **/model 对 antigravity 弹 Codex 的模型**：原 `/model` 只有 codebuddy 独立分支、
   其余全走 Codex 的模型 store，选了也不生效。已修：独立的 antigravity 模型发现、
   卡片与处理器（`src/agent/antigravity/models.ts`、
   `src/commands/antigravity-model.ts`、`src/card/antigravity-model-card.ts`）。

---

## 八、仍需注意

- **额度查不到**：agy CLI 没有 quota/usage 命令，只能去 Antigravity 网页控制台看。
- **会话别养太肥**：会话记录到 1.5MB 左右、或 7–8 个实质任务后，用飞书 `/reset`
  开新会话；进度及时落盘（写文件、提交代码），不要只留在会话里。
- **内存小的机器上重活一次只跑一个**，两个重活并行容易 OOM，把桥进程挤死。
- **不要在桥侧输入密码或凭证**。登录一律由本人在实时画面或浏览器里完成。
