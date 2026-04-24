# OpenMeta CLI

**让开源贡献从“想做”变成“持续产出”。**  
**Turn open-source ambition into repeatable contribution output.**

OpenMeta CLI is an autonomous, local-first contribution agent for developers who want more than issue lists and inspiration. It scouts real GitHub opportunities, ranks them against your profile, prepares repository context, drafts patch and PR materials, and keeps a durable record of everything you ship.

它不是一个只会“推荐 issue”的工具。它是一条完整的开源贡献流水线：发现机会、判断价值、准备工作区、生成补丁方案、沉淀仓库记忆、记录贡献证据，并把整个过程组织成可以每天稳定运行的系统。

[中文](#中文) | [English](#english)

---

## 中文

### 一句话介绍

**OpenMeta CLI 是面向真实开源产出的自治贡献 Agent。**  
它帮助开发者持续发现高价值 issue，理解仓库上下文，准备 patch / PR 草稿，并把贡献过程沉淀为可复用、可追踪、可自动化的资产。

### 为什么它值得关注

开源贡献最难的，从来不是“写代码”本身，而是前面的那一长串摩擦：

- 不知道做什么
- 找到 issue 也判断不出值不值得做
- 切进陌生仓库的成本太高
- 每次都要重新梳理上下文
- 做完之后没有形成持续积累

**OpenMeta CLI 的价值，在于把这些零散、低效、重复的动作，收束成一个持续运转的贡献系统。**

它不是简单地把 issue 拉下来给你看，而是站在“贡献产出”视角，围绕真实开发者最关心的几个问题设计：

- 这个 issue 跟我的技术栈匹不匹配？
- 现在做，成功率高不高？
- 仓库里最值得先看的文件是什么？
- 能不能快速形成 patch 思路和 PR 叙事？
- 今天的投入，能不能变成明天的优势？

### 核心优势

#### 1. 不只是发现机会，而是筛出更值得投入的机会

OpenMeta 会从 GitHub 拉取开放 issue，并结合你的技术栈、熟练度、关注方向，对候选机会进行综合评分。  
评分不是单一维度，而是同时考虑：

- 技术匹配度
- issue 新鲜度
- 上手清晰度
- 合并潜力
- 仓库影响力

这意味着你看到的不是“更多 issue”，而是**更可能做成、也更值得做的 issue**。

#### 2. 不只是读 issue，而是进入仓库上下文

发现机会之后，OpenMeta 会为目标仓库准备本地工作区，自动拉取代码、识别候选文件、读取关键片段、检测常见测试命令，并结合 Repo Memory 形成更贴近仓库现实的上下文。

这一步的意义非常大：  
你不必每次都从零摸索项目结构，工具会先帮你把“第一轮认知成本”降下来。

#### 3. 不只是给建议，而是推进到可执行产物

OpenMeta 会进一步生成：

- Patch Draft
- PR Draft
- Contribution Dossier
- Contribution Inbox
- Proof of Work

也就是说，它不是停在“推荐方向”，而是推动你走到**能真正开始提交贡献**的那一步。

#### 4. 不只是单次使用，而是形成长期积累

很多工具的价值在第一次使用时很强，第二次就断掉了。  
OpenMeta 的设计重点之一，是让你的每次贡献行为都沉淀为下一次更高效的起点。

它会记录：

- 仓库记忆
- 最近处理过的 issue
- 偏好的文件路径
- 已生成的 dossier 数量
- 历史贡献 Proof of Work

工具越跑越懂你的贡献路径，系统性优势会越来越明显。

#### 5. 不只是自动化，而是可控的自动化

如果你希望把贡献节奏变成日常机制，OpenMeta 可以安装本地调度器，在 macOS 上使用 `launchd`，在 Linux 上使用 `cron`，按你设定的时间执行无人值守流程。

这带来的不是“炫技式自动化”，而是更接近真实工作流的能力：

- 固定节奏持续 scouting
- 每天稳定形成贡献候选
- 在低摩擦状态下保持开源参与

### 它能为你做什么

OpenMeta CLI 目前覆盖的主流程包括：

1. 发现 GitHub 上带有 `good first issue` / `help wanted` 等标签的开放 issue
2. 基于你的技术背景做匹配与排序
3. 选择最具潜力的贡献机会
4. 为目标仓库准备本地工作区
5. 探测候选文件与可执行校验命令
6. 生成 patch 策略与 PR 草稿
7. 维护 Inbox、Repo Memory、Proof of Work 等长期资产
8. 可选地将这些成果发布到你的私有仓库
9. 可选启用每日自动化执行

### 适合什么人

- 想稳定做开源，提升技术影响力，但总是卡在“今天做什么”
- 想提高 issue 筛选效率，而不是盲目刷列表
- 想把开源贡献做成长期习惯，而不是偶发行为
- 想为自己的成长、作品集、贡献轨迹建立连续记录
- 想用一个本地可控的 Agent，而不是依赖黑盒式在线平台

### 产品特质

#### Local-first，而不是 SaaS-first

OpenMeta 没有托管式后端依赖来替你“接管”流程。  
流程编排、状态保存、工作区准备、产物沉淀都在本地完成。你显式配置的 GitHub API 与 LLM API 之外，没有额外的平台锁定。

#### 面向贡献产出，而不是面向内容表演

很多工具擅长“写得像在做事”。  
OpenMeta 更关注的是：**能不能更高概率地把一次贡献从机会识别推进到实际产物。**

#### 为持续性设计，而不是为一次性演示设计

Inbox、Repo Memory、PoW、自动化调度，这些都说明它不是只服务于单次体验，而是为了长期积累而设计。

### 功能总览

| 模块 | 能力 |
|------|------|
| Opportunity Scoring | 对 issue 按技术匹配、时效性、上手清晰度、合并潜力、影响力综合排序 |
| Agent Loop | 执行从 issue 到 workspace、patch draft、PR draft 的自治流程 |
| Workspace Prep | 克隆仓库、识别候选文件、提取片段、探测测试命令、可运行基础校验 |
| Repo Memory | 为不同仓库保存记忆，持续提升上下文命中率 |
| Inbox | 沉淀高价值贡献机会，形成可回看的贡献收件箱 |
| Proof of Work | 将每次 Agent 运行记录为可追踪的贡献证据 |
| Artifact Publishing | 将 dossier、draft、inbox、PoW 等资产发布到目标私有仓库 |
| Automation | 支持本机每日调度，实现长期无人值守运行 |
| Secure Config | 敏感凭证采用 AES 加密存储 |

### 工作流

```text
Scout issues
  -> Rank by fit and opportunity
  -> Prepare repo workspace
  -> Detect files and checks
  -> Draft patch strategy
  -> Draft PR narrative
  -> Save inbox / memory / proof-of-work
  -> Optionally publish artifacts
  -> Repeat daily
```

### 安装与运行

当前仓库更适合**从源码使用**。

#### 环境要求

- Bun 1.0+
- Git
- GitHub Personal Access Token
- 一个兼容的 LLM API Key

#### 安装

```bash
bun install
```

#### 直接运行

```bash
bun run ./src/cli.ts --help
```

#### 构建 CLI

```bash
bun run build
./bin/openmeta.js --help
```

### 快速开始

```bash
# 1. 初始化配置
bun run ./src/cli.ts init

# 2. 手动运行自治贡献 Agent
bun run ./src/cli.ts agent

# 3. 只看机会排名
bun run ./src/cli.ts scout --limit 10

# 4. 查看贡献沉淀
bun run ./src/cli.ts inbox
bun run ./src/cli.ts pow

# 5. 查看或调整配置
bun run ./src/cli.ts config view
bun run ./src/cli.ts config set <key> <value>

# 6. 检查本地运行前置条件
bun run ./src/cli.ts doctor
```

如果你已经执行过构建，也可以直接使用：

```bash
./bin/openmeta.js init
./bin/openmeta.js agent --run-checks
./bin/openmeta.js automation status
```

### 命令一览

| 命令 | 说明 |
|------|------|
| `openmeta init` | 交互式初始化 GitHub、LLM、用户画像、目标仓库和自动化配置 |
| `openmeta doctor` | 检查本地配置、运行时、工作目录、目标仓库和调度器状态 |
| `openmeta agent` | 运行自治贡献主流程 |
| `openmeta agent --draft-only` | 只生成 dossier、patch draft 和 PR draft，不改仓库、不创建 PR |
| `openmeta agent --headless` | 使用已保存设置进行无人值守执行 |
| `openmeta agent --run-checks` | 执行检测到的基础校验命令 |
| `openmeta daily` | `agent` 的兼容别名，支持相同运行参数 |
| `openmeta scout --limit <count>` | 查看高价值贡献机会排名 |
| `openmeta inbox` | 查看已起草的贡献机会收件箱 |
| `openmeta pow` | 查看贡献工作量证明记录 |
| `openmeta automation status` | 查看自动化状态 |
| `openmeta automation enable` | 启用每日自动化 |
| `openmeta automation disable` | 关闭每日自动化 |
| `openmeta config view` | 查看当前配置 |
| `openmeta config set <key> <value>` | 修改配置项 |
| `openmeta config reset` | 重置配置 |

### 本地目录与资产

OpenMeta 会在本地维护自己的工作目录与状态：

- 配置文件：`~/.config/openmeta/config.json`
- 工作区目录：`~/.openmeta/workspaces`
- 产物目录：`~/.openmeta/artifacts`
- 仓库记忆、PoW 等状态：位于配置目录同级状态空间

这使它非常适合个人长期使用：状态明确、路径稳定、可审计、可备份。

### 安全与边界

OpenMeta 的卖点不是“替你托管一切”，而是**在你可控的本地环境里，把贡献流程自动化**。

- GitHub PAT 与 LLM API Key 使用 AES 加密保存
- 不依赖 OpenMeta 自建托管后端
- 只会访问你明确配置的 GitHub / LLM 服务
- Git 操作围绕目标仓库和本地工作区展开
- 自动化启用时会进行明确确认

### 技术栈

- Runtime: Bun
- Language: TypeScript
- CLI: Commander.js
- GitHub API: Octokit
- Git Operations: simple-git
- Prompts: Inquirer
- LLM: OpenAI-compatible API

### 结语

**OpenMeta CLI 不是一个“看起来很聪明”的开源玩具，而是一个把开源贡献做成长期系统的工具。**

如果你希望自己的开源参与不再依赖一时兴起，而是变成一种稳定、可积累、可复利的工程习惯，那么它值得你认真关注。

### License

MIT

---

## English

### The Pitch

**OpenMeta CLI is an autonomous contribution agent built for real open-source throughput.**  
It helps developers consistently discover worthwhile issues, understand unfamiliar repositories faster, draft patch and PR materials, and turn every run into reusable contribution assets.

### Why It Stands Out

The hardest part of open source is rarely typing code.  
It is the repeated friction before the code:

- deciding what to work on
- filtering noise from genuinely promising issues
- getting oriented inside an unfamiliar repository
- rebuilding context every single time
- losing momentum between one contribution and the next

**OpenMeta CLI is valuable because it turns that fragmented, high-friction process into a repeatable contribution system.**

It is designed around the questions serious contributors actually ask:

- Is this issue a strong fit for my stack?
- Is it fresh enough to be worth the effort?
- How easy will this repo be to enter?
- What files should I inspect first?
- Can I move from issue discovery to an actionable patch/PR narrative quickly?
- Will today's effort make tomorrow's contribution easier?

### Core Advantages

#### 1. It does not just find issues. It finds better bets.

OpenMeta pulls open GitHub issues and ranks them against your technical profile.  
The scoring model considers multiple signals together:

- technical fit
- freshness
- onboarding clarity
- merge potential
- repository impact

The result is not more noise. It is a cleaner stream of opportunities that are more likely to be worth your time.

#### 2. It does not stop at issue lists. It enters repository context.

Once an opportunity is selected, OpenMeta prepares a local workspace, fetches the repository, identifies likely files, reads meaningful snippets, detects common validation commands, and brings repo memory into the loop.

That matters because repository entry cost is where many contribution attempts die.  
OpenMeta lowers that first cognitive wall before you even begin.

#### 3. It does not just suggest. It pushes toward deliverables.

OpenMeta can generate and maintain:

- patch drafts
- PR drafts
- contribution dossiers
- inbox items
- proof-of-work records

This makes it far more than a recommendation engine. It is built to move you closer to an actual contribution outcome.

#### 4. It is designed for accumulation, not one-off novelty.

Many tools feel impressive once and useless the second time.  
OpenMeta is explicitly built so each run strengthens the next one.

It preserves:

- repo memory
- recent issues
- preferred file paths
- generated contribution dossiers
- proof-of-work history

Over time, the tool becomes more than automation. It becomes infrastructure for your contribution habit.

#### 5. It offers automation without surrendering control.

When you want consistency, OpenMeta can install a local scheduler using `launchd` on macOS or `cron` on Linux and run your contribution loop on a daily cadence.

That is not automation theater. It is practical leverage:

- continuous scouting
- a steady flow of contribution candidates
- lower friction for staying active in open source

### What It Actually Does

OpenMeta CLI currently covers a full contribution-oriented workflow:

1. Discover open GitHub issues with signals such as `good first issue` and `help wanted`
2. Score them against your stack, proficiency, and focus areas
3. Select the most promising opportunity
4. Prepare a local workspace for the target repository
5. Detect candidate files and baseline validation commands
6. Draft patch strategy and PR narrative
7. Maintain inbox, repo memory, and proof-of-work assets
8. Optionally publish those artifacts to your private repository
9. Optionally run the entire process on a daily automated schedule

### Who It Is For

- Developers who want to contribute consistently but stall at "what should I do today?"
- Engineers who want better issue filtering instead of endless GitHub browsing
- People building a long-term open-source habit rather than occasional bursts
- Contributors who want a documented track record of effort and output
- Users who prefer a local, controllable agent over a black-box hosted platform

### Product Character

#### Local-first, not SaaS-first

OpenMeta does not require an OpenMeta-hosted backend to orchestrate your workflow.  
Workspace preparation, state management, artifact generation, and contribution records stay local. The only network services involved are the GitHub and LLM APIs you explicitly configure.

#### Built for contribution throughput, not performative output

Some tools are excellent at looking productive.  
OpenMeta is optimized around a stricter question: **does this move a contribution forward?**

#### Designed for continuity, not demos

Repo memory, inbox, proof of work, and scheduler support all point to the same product philosophy: this is meant to compound.

### Feature Overview

| Module | Value |
|--------|-------|
| Opportunity Scoring | Rank issues by technical fit, freshness, onboarding clarity, merge potential, and impact |
| Agent Loop | Run an end-to-end flow from issue discovery to workspace prep, patch draft, and PR draft |
| Workspace Prep | Clone repos, surface likely files, extract snippets, detect validation commands, and run baseline checks when requested |
| Repo Memory | Preserve repository-specific context so future runs get sharper |
| Inbox | Keep the highest-value drafted opportunities in one place |
| Proof of Work | Record every agent run as a contribution asset |
| Artifact Publishing | Publish dossiers, drafts, inbox state, and proof-of-work history to a target private repo |
| Automation | Install a local daily scheduler for unattended execution |
| Secure Config | Store sensitive credentials with AES encryption |

### Workflow

```text
Scout issues
  -> Rank by fit and opportunity
  -> Prepare repo workspace
  -> Detect files and checks
  -> Draft patch strategy
  -> Draft PR narrative
  -> Save inbox / memory / proof-of-work
  -> Optionally publish artifacts
  -> Repeat daily
```

### Install and Run

At the moment, this repository is best used **from source**.

#### Requirements

- Bun 1.0+
- Git
- GitHub Personal Access Token
- A compatible LLM API key

#### Install dependencies

```bash
bun install
```

#### Run directly from source

```bash
bun run ./src/cli.ts --help
```

#### Build the CLI binary

```bash
bun run build
./bin/openmeta.js --help
```

### Quick Start

```bash
# 1. Initialize GitHub, LLM, profile, repo, and automation settings
bun run ./src/cli.ts init

# 2. Run the autonomous contribution loop
bun run ./src/cli.ts agent

# 3. Only scout and rank opportunities
bun run ./src/cli.ts scout --limit 10

# 4. Inspect durable contribution assets
bun run ./src/cli.ts inbox
bun run ./src/cli.ts pow

# 5. Review or update configuration
bun run ./src/cli.ts config view
bun run ./src/cli.ts config set <key> <value>

# 6. Check local prerequisites before a full run
bun run ./src/cli.ts doctor
```

If you already built the binary:

```bash
./bin/openmeta.js init
./bin/openmeta.js agent --run-checks
./bin/openmeta.js automation status
```

### Command Surface

| Command | Description |
|---------|-------------|
| `openmeta init` | Interactive setup for GitHub, LLM, profile, target repo, and automation |
| `openmeta doctor` | Check local config, runtimes, paths, target repo, and scheduler state |
| `openmeta agent` | Run the autonomous contribution workflow |
| `openmeta agent --draft-only` | Generate dossier, patch draft, and PR draft artifacts without editing files or opening a PR |
| `openmeta agent --headless` | Execute unattended using saved automation defaults |
| `openmeta agent --run-checks` | Run detected baseline validation commands |
| `openmeta daily` | Compatibility alias for `agent` with the same runtime options |
| `openmeta scout --limit <count>` | Show ranked contribution opportunities |
| `openmeta inbox` | Show drafted contribution opportunities |
| `openmeta pow` | Show proof-of-work history |
| `openmeta automation status` | Show automation status |
| `openmeta automation enable` | Enable daily unattended automation |
| `openmeta automation disable` | Disable daily unattended automation |
| `openmeta config view` | Show current configuration |
| `openmeta config set <key> <value>` | Update a config value |
| `openmeta config reset` | Reset configuration |

### Local Paths and Assets

OpenMeta keeps a clear local footprint:

- config: `~/.config/openmeta/config.json`
- workspaces: `~/.openmeta/workspaces`
- artifacts: `~/.openmeta/artifacts`
- repo memory and proof-of-work state: stored in the local OpenMeta state area

This makes the tool practical for long-term individual use: stable paths, inspectable state, and easy backup.

### Security and Operating Model

OpenMeta's promise is not "we host everything for you."  
Its promise is stronger for many developers: **your contribution workflow stays under your control.**

- GitHub PAT and LLM API keys are stored with AES encryption
- No OpenMeta-managed hosted backend is required
- Only the GitHub and LLM services you explicitly configure are contacted
- Git operations are scoped to your chosen repositories and local workspaces
- Enabling unattended automation is an explicit choice

### Tech Stack

- Runtime: Bun
- Language: TypeScript
- CLI: Commander.js
- GitHub API: Octokit
- Git operations: simple-git
- Interactive prompts: Inquirer
- LLM integration: OpenAI-compatible API

### Final Word

**OpenMeta CLI is not an open-source productivity toy. It is a system for compounding contribution momentum.**

If you want your open-source work to become more consistent, more intentional, and more durable over time, this project deserves attention.

### License

MIT
