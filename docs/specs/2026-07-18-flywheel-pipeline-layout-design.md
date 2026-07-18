# 飞轮页面流水线布局重构设计

**版本**：v1.0  
**日期**：2026-07-18  
**相关模块**：lingxi-desktop（桌面端飞轮页面）、jlyl-cloud/server（云端 AEO/写作建议/自动写作）  
**设计状态**：待评审

---

## 1. 背景与目标

### 1.1 当前问题

当前飞轮页面采用「信息陈列式」布局，板块并列堆叠：

- 当前巡检轮次 / 写作建议池（左右并排）
- AEO 报告详情（折叠面板，分片/日报/周报/月报平铺）
- 最近写作任务 / 最近发布任务（左右并排）
- 云端工作日志

问题：
1. 板块之间是并列关系，看不出数据与成果的流动关系。
2. AEO 报告内部四层（分片/日报/周报/月报）折叠在同一卡片内，数据依赖关系不清晰。
3. 写作建议池与 AEO 报告、写作任务之间的来源/消费关系无法直观体现。
4. 自动写作配额同时承担「发布节奏」和「内容策略节奏」双重语义，容易配置混乱。

### 1.2 设计目标

将飞轮页面重构为「工业流水线」式布局，让用户一眼看清：

1. **数据流向**：巡检采集 → AEO 分析 → 写作建议 → 文章生成 → 平台发布。
2. **AEO 内部层级**：分片（原料）→ 日报/周报/月报（加工车间）→ 被选中的池驱动写作建议池。
3. **建议消费状态**：哪些写作建议已消费、已生成文章、已发布。
4. **发布节奏与策略节奏解耦**：自动写作配额只控制每天发布量，写作建议来源控制内容策略调整频率。

---

## 2. 总体布局方案

采用 **方案 C：纵向流水线**（已在与用户的设计讨论中确认）。

### 2.1 页面结构（从上至下）

```
┌─────────────────────────────────────────┐
│  客户选择 + 飞轮总开关 + 快捷操作按钮      │
├─────────────────────────────────────────┤
│  Step 0 · 实时总控台                     │
│  [当前轮次] [本轮进度] [今日查询] [待处理建议] │
├─────────────────────────────────────────┤
│  Step 1 · 数据采集：当前巡检轮次           │
│  [该客户所有任务列表 · 当前执行高亮 · 进度条] │
│           ↓                             │
│  Step 2 · 分析加工：AEO 报告车间           │
│           ↓                             │
│  Step 3 · 决策建议：写作建议池             │
│           ↓                             │
│  Step 4 · 内容产出：最近写作任务           │
│           ↓                             │
│  Step 5 · 发布执行：最近发布任务           │
├─────────────────────────────────────────┤
│  调试与日志区（左右并排）                   │
│  [飞轮调试控制台]      [云端工作日志]        │
└─────────────────────────────────────────┘
```

### 2.2 色彩体系（与流水线阶段对应）

| 阶段 | 主色 | 用途 |
|------|------|------|
| 数据采集 | `#3b82f6` 蓝 | 当前巡检轮次 |
| 分析加工 | `#8b5cf6` 紫 | AEO 报告车间 |
| 决策建议 | `#f59e0b` 橙 | 写作建议池 |
| 内容产出 | `#10b981` 绿 | 最近写作任务 |
| 发布执行 | `#ef4444` 红 | 最近发布任务 |

---

## 3. Step 1 · 数据采集：当前巡检轮次

### 3.1 内部结构

数据采集阶段展示该客户名下的所有巡检任务，并以卡片列表形式呈现。核心设计要点：

- **任务列表**：展示该客户所有 `real_collect_task` 任务。
- **当前执行高亮**：正在执行的任务用蓝色边框 + 阴影高亮，显示「执行中」Tag。
- **实时进度条**：每个任务显示本轮进度条（已查询 / 总查询）。
- **任务状态**：执行中 / 待调度 / 未启用 / 已完成 / 异常。
- **快捷入口**：查看全部分片报告、进入任务详情。

### 3.2 任务卡片信息

每个任务卡片展示：

| 字段 | 说明 |
|------|------|
| 任务名称 | `task_name` |
| 词类型 | 蒸馏词 / 品牌词 |
| 当前轮次 | `round` |
| 分片进度 | 已完成分片数 / 总分片数 |
| 查询进度 | 已查询数 / 总查询数（估算） |
| 预计剩余时间 | 根据当前速率估算 |
| 状态 Tag | 执行中 / 待调度 / 未启用 / 已完成 |

### 3.3 实时数据更新

- 每 10-30 秒轮询一次后端 API 获取任务状态。
- 当前执行任务显示进度条动画。
- 非执行任务显示上次完成时间或下次调度时间。

### 3.4 交互

- 点击任务卡片 → 展开/折叠该任务的实时详情。
- 点击「查看全部分片报告」→ 跳转到分片报告列表。
- 点击「进入任务详情」→ 打开任务详情弹窗（复用现有页面）。

---

## 4. AEO 报告「加工车间」详细设计

### 4.1 结构

AEO 报告车间作为一个整体卡片区域，内部采用「上一下三」结构：

- **上半区：分片池（原料）**
  - 展示当日/当周/当月已生成的分片报告缩略卡片。
  - 每个分片卡片显示：分片 ID、词类型（蒸馏词/品牌词）、查询量、命中率。
  - 点击分片卡片可查看分片报告详情弹窗。

- **下半区：三个周期池并列**
  - **日报池**（靛蓝 `#6366f1`）
  - **周报池**（紫 `#8b5cf6`）
  - **月报池**（深紫 `#a855f7`）
  - 每个池显示：报告数、覆盖范围、查询量/命中数、建议数。
  - 每个池有一个「链接到写作建议池」开关，三选一。

### 3.2 数据沉淀方向

数据只能单向沉淀，不可逆转：

```
分片池 → 日报池 → 周报池 → 月报池
```

- 日报由当日所有分片汇总生成。
- 周报由最近 7 天日报/分片汇总生成。
- 月报由最近 30 天日报/分片汇总生成。

### 3.3 池链接规则

- 日报/周报/月报三选一链接到写作建议池。
- 被链接的池会将其 `writing_suggestions` 推入写作建议池。
- 未被链接的池仅作为数据沉淀和历史查阅，不影响写作建议。
- 所有日报/周报/月报都正常生成，不受链接状态影响。
- 链接配置需持久化，按客户维度存储。

### 3.4 链接配置持久化

新增配置项存储到 `cloud_api_config` 表：

```
suggestion_source_period_type: 'daily' | 'weekly' | 'monthly'  // 默认 'daily'
```

前端在 AEO 车间点击链接按钮时，调用 API 更新该配置。

---

## 5. 写作建议池详细设计

### 5.1 持久化到独立表

新增表 `aeo_writing_suggestion`：

```sql
CREATE TABLE aeo_writing_suggestion (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  period_report_id INTEGER REFERENCES aeo_period_report(id) ON DELETE CASCADE,
  source_type VARCHAR(20) NOT NULL, -- 'daily' | 'weekly' | 'monthly'
  report_date DATE NOT NULL,
  topic TEXT NOT NULL,
  reason TEXT,
  direction VARCHAR(100),
  platforms TEXT[],
  keywords TEXT[],
  priority VARCHAR(20) DEFAULT 'medium', -- 'high' | 'medium' | 'low'
  consumed BOOLEAN DEFAULT FALSE,
  consumed_at TIMESTAMP,
  writing_task_id INTEGER REFERENCES ai_writing_task(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_aeo_writing_suggestion_user_consumed ON aeo_writing_suggestion(user_id, consumed);
CREATE INDEX idx_aeo_writing_suggestion_period_report ON aeo_writing_suggestion(period_report_id);
```

### 5.2 消费状态

每条建议在 UI 上展示三种状态：

| 状态 | 含义 | UI 样式 |
|------|------|---------|
| 待消费 | 已进入建议池，尚未生成写作任务 | 橙色 Tag |
| 已生成 | 已基于该建议创建写作任务 | 绿色 Tag |
| 已发布 | 建议对应的文章已完成多平台发布 | 蓝色 Tag |

### 5.3 建议消费链路

当 flywheelDaemon 或用户手动触发自动写作时：

1. 读取 `cloud_api_config.suggestion_source_period_type`。
2. 查询该周期类型下最新一份未消费的 `aeo_period_report`。
3. 读取其关联的 `aeo_writing_suggestion` 记录（`consumed = false`）。
4. 基于这些建议创建 `ai_writing_task`，并将 `writing_task_id` 回写到 `aeo_writing_suggestion`。
5. 文章发布完成后，将对应建议状态更新为「已发布」（可选，通过 publish_record 关联判断）。

### 5.4 UI 展示

写作建议池区域显示：

- 顶部：来源标签（来源：日报池 / 周报池 / 月报池）、最近更新时间。
- 列表：每条建议卡片，包含主题、原因、方向、推荐平台/关键词、消费状态。
- 已消费建议可折叠或置底，避免干扰待消费建议。
- 点击建议可查看完整详情和消费链路时间线。

---

## 6. 自动写作配额简化

### 6.1 当前问题

当前自动写作配额可能包含 daily/weekly/monthly 选项，导致：
- 用户不清楚「配额周期」和「建议来源周期」如何配合。
- 不同周期下的文章分配容易出现不均（如每周 70 篇在某些天分配 0 篇）。

### 6.2 简化方案

取消自动写作配额的「周/月」选项，**统一按天设置**：

```
自动写作配额 = 每日生成 X 篇
```

- 用户只填写「每天生成多少篇」。
- 原 weekly/monthly 配额在迁移时换算为日均量：
  - weekly / 7
  - monthly / 30
- flywheelDaemon 每天按固定数量创建写作任务，不再做周期分配逻辑。

### 6.3 与建议来源的配合

| 建议来源 | 内容策略调整频率 | 发布节奏 | 说明 |
|----------|------------------|----------|------|
| 日报 | 每天 | 每天 X 篇 | 每天根据最新数据调整内容 |
| 周报 | 每周 | 每天 X 篇 | 一周内内容策略稳定，每周一更新 |
| 月报 | 每月 | 每天 X 篇 | 一月内内容策略稳定，每月初更新 |

---

## 7. API 变更

### 7.1 新增/修改云端 API

#### 7.1.1 获取池链接配置

```http
GET /api/content/cloud-api-config
```

响应增加字段：

```json
{
  "suggestion_source_period_type": "daily"
}
```

#### 7.1.2 更新池链接配置

```http
PUT /api/content/cloud-api-config
Body: { "suggestion_source_period_type": "weekly" }
```

#### 7.1.3 获取写作建议列表

```http
GET /api/content/writing-suggestions?consumed=false&limit=50
```

响应：

```json
{
  "code": 0,
  "data": {
    "items": [
      {
        "id": 1,
        "source_type": "daily",
        "report_date": "2026-07-18",
        "topic": "针对「代理记账成本」话题增加价格透明度的科普内容",
        "reason": "蒸馏词查询中该话题命中率低",
        "direction": "科普",
        "platforms": ["doubao", "deepseek"],
        "keywords": ["代理记账", "价格透明"],
        "priority": "high",
        "consumed": false,
        "writing_task_id": null
      }
    ]
  }
}
```

#### 7.1.4 消费建议（内部调用）

创建写作任务时，由后端自动将建议标记为已消费：

```sql
UPDATE aeo_writing_suggestion
SET consumed = true, consumed_at = NOW(), writing_task_id = ?
WHERE id = ?;
```

### 7.2 前端 API 封装

在 `lingxi-desktop/src/renderer/pages/Content/contentApi.ts` 中新增：

- `getWritingSuggestions(params)`
- `updateSuggestionSourceType(type)`

---

## 8. 前端组件结构

### 8.1 飞轮页面组件拆分

```
FlywheelPage
├── FlywheelHeader          # 客户选择、总开关、操作按钮
├── RealtimeConsole         # 实时总控台
├── PipelineStage           # 通用流水线阶段容器
│   ├── StageHeader
│   └── StageBody
├── DataCollectionStage     # 步骤1：当前巡检轮次
│   ├── TaskList              # 任务列表容器
│   │   └── TaskCard          # 单个巡检任务卡片
│   │       ├── TaskStatusTag # 状态标签
│   │       └── ProgressBar   # 实时进度条
│   └── TaskActions           # 快捷操作（分片报告、任务详情）
├── AeoWorkshopStage        # 步骤2：AEO 报告车间
│   ├── ShardPool
│   ├── PeriodPool (×3)
│   └── PoolLinkButton
├── SuggestionPoolStage     # 步骤3：写作建议池
│   ├── SuggestionCard
│   └── SuggestionTimeline
├── WritingTaskStage        # 步骤4：最近写作任务
├── PublishTaskStage        # 步骤5：最近发布任务
└── DebugLogArea            # 调试与日志区（左右并排）
    ├── FlywheelDebugConsole  # 飞轮调试控制台
    └── CloudWorkLog          # 云端工作日志
```

### 8.2 AEO 车间交互

- 点击分片卡片 → 打开分片报告详情弹窗（复用现有组件）。
- 点击周期池卡片 → 打开日报/周报/月报详情弹窗。
- 点击「链接到写作建议池」按钮 → 切换链接状态，更新 `cloud_api_config`。
- 链接状态改变后，写作建议池立即重新加载对应来源的建议。

### 8.3 写作建议池交互

- 每条建议显示消费状态 Tag。
- 已消费建议显示关联的写作任务 ID，可点击跳转。
- 支持按状态筛选（全部 / 待消费 / 已生成 / 已发布）。
- 建议池底部显示消费链路时间线示例。

---

## 9. 数据流时序

### 9.1 日报驱动（默认）

```
00:00  generateAeoReport(daily)
       ↓ 调用 generatePeriodReport('daily')
00:05  aeo_period_report(daily) 生成，writing_suggestions 拆分为独立行写入 aeo_writing_suggestion
       ↓ flywheelDaemon 每日调度
01:00  读取 aeo_writing_suggestion (consumed=false, source_type='daily')
       ↓
       创建 ai_writing_task
       更新 aeo_writing_suggestion.consumed=true, writing_task_id=?
       ↓
02:00  文章生成完成
       ↓
03:00  创建 publish_task 并分发到各平台
```

### 9.2 周报/月报驱动

```
周一/月初 generatePeriodReport('weekly'/'monthly')
          ↓
          writing_suggestions 写入 aeo_writing_suggestion
          ↓
          一周内/一月内 flywheelDaemon 每天都读取这些未消费建议
          ↓
          每天创建 ai_writing_task 时复用这些建议（直到下次周期报告生成新建议）
```

---

## 10. 关键决策记录

| 决策 | 选项 | 选择 |
|------|------|------|
| 整体布局方向 | A 横向 / B 星型 / C 纵向 | C 纵向 |
| AEO 车间结构 | 折叠面板 / 分片池+三池并列 / Tabs | 分片池+三池并列 |
| 建议来源链接 | 固定日报 / 三选一 | 三选一（日报/周报/月报） |
| 自动写作配额 | 保留周月 / 统一按天 | 统一按天 |
| 写作建议持久化 | JSONB 数组 / 独立表 | 独立表 `aeo_writing_suggestion` |

---

## 11. 风险与待办

### 11.1 风险

1. **历史数据迁移**：原 `aeo_period_report.writing_suggestions` JSONB 数组需要迁移到 `aeo_writing_suggestion` 表。
2. **配额简化影响**：已配置 weekly/monthly 配额的用户需要平滑迁移为日均量。
3. **状态同步**：已消费建议与 writing_task 的关联需要在创建任务时原子写入，避免重复消费。

### 11.2 待办

1. 设计数据库迁移脚本（migrate.ts）。
2. 修改 `generatePeriodReport` 将 writing_suggestions 写入独立表。
3. 修改 flywheelDaemon 消费建议逻辑。
4. 简化自动写作配额 UI 和后端逻辑。
5. 实现前端 AEO 车间和写作建议池 UI。
6. 补充 TypeScript 类型定义。
7. 编写测试用例（建议消费防重、配额换算等）。

---

## 12. 附录：UI 设计稿文件

- `e:\Golutra1\.superpowers\brainstorm\flywheel-pipeline-layout.html` — 总体流水线布局草案
- `e:\Golutra1\.superpowers\brainstorm\flywheel-layout-3options.html` — 三种布局方案对比
- `e:\Golutra1\.superpowers\brainstorm\flywheel-aoi-workshop-detail.html` — AEO 车间与写作建议池详细设计
