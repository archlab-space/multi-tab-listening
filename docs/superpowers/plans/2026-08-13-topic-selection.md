# 选题层重做 Implementation Plan（第一阶段）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 tweet-generator 按「实体热度为主、讨论量为辅」选题，素材统一走 `/blogs` 单流，内容分 project / hot / labs 三层配额。

**Architecture:** AgentLens 的 `/blogs` 每条都带 `signal`（`hn_story` → HN 分数，`gh_project` → stars/day），现有代码从未声明这个字段因而静默丢弃。本阶段把 `signal` 接进类型系统，新增一个纯函数实体打分模块，用「tier 内 min-max 归一化」的加权公式排序，并删掉 `/projects` 那条平行选题路径。

**Tech Stack:** TypeScript (ESM, `.js` 后缀导入), vitest, drizzle-orm, Postgres

**Spec:** `/Users/WHO/.claude/plans/modular-discovering-treasure.md`

## Global Constraints

- 账号保持**英文**，本阶段不涉及任何文案语言变更。
- 导入一律带 `.js` 后缀（ESM + `moduleResolution: nodenext`）。
- 测试用 vitest：`pnpm --filter tweet-generator test`。
- 每个任务一个 commit，消息用祈使句小写，格式 `feat(tweet-generator): ...` / `refactor(...)` / `test(...)`，与现有 git log 一致。
- **不得**硬编码 API key。`AGENTLENS_API_KEY` 本阶段仅加入 config 与 `.env.example`，第二阶段才使用。
- 不动 `x-poster`、`discord-monitor`、`ai-assistant`。
- 本阶段**不改** `llm/`、`image/` 下任何文件。

## File Structure

| 文件 | 责任 |
|---|---|
| `src/sources/agentlens.ts` | 只放 AgentLens 的 wire 形状与 HTTP。新增 `BlogSignal` 与 `heatOf()` |
| `src/sources/agentlens.fixtures.ts` | 真实 payload 回放。补 hn_story / gh_project 两组带 signal 的响应 |
| `src/select/entities.ts` | **新增。** 纯函数实体打分，无 I/O |
| `src/select/rank.ts` | **新增。** tier 内归一化排序，无 I/O |
| `src/select/pool.ts` | 候选挑选。删掉 `selectProject` 后只剩 blogs 一条路 |
| `src/select/quota.ts` | 按 tier 排配额顺序 |
| `src/select/dedupe.ts` | 删除（`starBucket` 是其唯一导出） |
| `src/config.ts` | tier 定义、配额、权重、`AGENTLENS_API_KEY` |
| `src/sources/candidates.ts` | 统一候选形状 + gh_project 的 `/projects` 补全 |
| `src/store.ts` | 按 tier 统计用量；写入 `entities` / `tier` |
| `shared/src/schema.ts` | `tweets.entities`、`tweets.tier` |

---

### Task 1: 把 `signal` 接进类型系统

**Files:**
- Modify: `tweet-generator/src/sources/agentlens.ts:32-57`
- Modify: `tweet-generator/src/sources/agentlens.fixtures.ts`
- Test: `tweet-generator/src/sources/agentlens.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `type BlogSignal = { type: string; [key: string]: unknown }`；`function heatOf(signal: BlogSignal | null): number | null`；`BlogListItem.signal` 与 `BlogDetail.signal` 字段；`BlogReference.identifier?: string`

**设计说明（实现者必读）：** 不要把 `BlogSignal` 写成判别联合。API 已经有三种 `type`（`hn_points` / `momentum` / `youtube`），未来还会加，而判别联合遇到未知 `type` 会让 `switch` 编译失败或悄悄走进 `default`。改用宽松形状 + 一个把它压成 `number | null` 的访问器：`youtube` 那种非数值信号自然返回 `null`，与「没有信号」走同一条路径。

- [ ] **Step 1: 写失败的测试**

把 `tweet-generator/src/sources/agentlens.test.ts` 顶部的导入行改为 `import { AgentLensClient, AgentLensError, heatOf } from './agentlens.js'`，然后在文件末尾追加：

```ts
describe('heatOf', () => {
  it('reads the HN score', () => {
    expect(heatOf({ type: 'hn_points', value: 803 })).toBe(803)
  })

  it('reads project momentum as stars per day', () => {
    expect(heatOf({ type: 'momentum', stars_per_day: 202 })).toBe(202)
  })

  it('has no heat for a null signal', () => {
    expect(heatOf(null)).toBeNull()
  })

  it('has no heat for a youtube signal, which only names a channel', () => {
    expect(heatOf({ type: 'youtube', channel: 'Stanford Online' })).toBeNull()
  })

  it('has no heat for a signal kind the API added after this was written', () => {
    expect(heatOf({ type: 'reddit_upvotes', value: 91 })).toBeNull()
  })

  it('has no heat when the expected field is the wrong type', () => {
    expect(heatOf({ type: 'hn_points', value: '803' })).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter tweet-generator test -- agentlens`
Expected: FAIL，`heatOf` is not exported / is not a function

- [ ] **Step 3: 实现**

在 `tweet-generator/src/sources/agentlens.ts` 中，`BlogListItem` 定义之前插入：

```ts
/**
 * Whatever the API attached to a dispatch as evidence of interest.
 *
 * Deliberately not a discriminated union. Three kinds exist today
 * (`hn_points`, `momentum`, `youtube`) and more will follow; a union makes
 * an unknown kind either a compile error or a silent fall-through, and this
 * service should simply treat a kind it does not understand as no signal.
 */
export type BlogSignal = { type: string; [key: string]: unknown }

/**
 * The signal as a single comparable number, or null when there is none.
 *
 * `youtube` carries only a channel name, so it collapses to null and takes
 * the same path as a dispatch that arrived without a signal at all.
 */
export function heatOf(signal: BlogSignal | null): number | null {
  if (!signal) return null
  if (signal.type === 'hn_points' && typeof signal.value === 'number') {
    return signal.value
  }
  if (
    signal.type === 'momentum' &&
    typeof signal.stars_per_day === 'number'
  ) {
    return signal.stars_per_day
  }
  return null
}
```

在 `BlogListItem` 接口末尾（`generated_at` 之后）加一行：

```ts
  signal: BlogSignal | null
```

`BlogDetail` 继承 `BlogListItem`，无需重复声明。

在 `BlogReference` 接口（`html_url?` 之后）加一行——`identifier` 是 `gh_project` blog 回查 `/projects` 的 join key（Step 5 的 fixture 注释写的就是它）。现在声明它，Task 6 的 hydration 才不会拿一个不存在的字段去编译：

```ts
  /**
   * The join key for a gh_project dispatch: the same identifier that
   * `GET /projects/ghp:{identifier}` takes. Only gh_project references
   * carry it; everything else leaves it undefined.
   */
  identifier?: string
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter tweet-generator test -- agentlens`
Expected: PASS

- [ ] **Step 5: 补真实 fixtures**

在 `tweet-generator/src/sources/agentlens.fixtures.ts` 末尾追加（**这些是 2026-08-13 从线上 API 实取的，不要改数值**）：

```ts
/**
 * hn_story list payload. Captured live on 2026-08-13.
 *
 * Two of these five are the reason this account reads as off-topic: the
 * highest-scoring items on HN are frequently not about AI at all.
 */
export const hnListResponse = {
  items: [
    {
      id: '23b30b2a-4f5d-40fd-abd1-69941edef8a7',
      title: 'Tailscale SQLite WAL-Reset Bug Investigation and Fix',
      summary:
        'Tailscale traced months of control-plane outages to a 16-year-old ' +
        'SQLite WAL-Reset data-race bug, collaborated with SQLite developers, ' +
        'and deployed a fix in SQLite 3.52.0 (later 3.51.3) to restore ' +
        'reliability.',
      period_label: null,
      job_type: 'hn_story',
      source_id: 'hn:story',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-13T02:07:28.190Z',
      signal: { type: 'hn_points', value: 803 },
    },
    {
      id: 'd7c7408a-f3fc-4879-aa90-fc6e96204da1',
      title:
        'AI Is Removing the Middle Class of Software Engineering - ' +
        'Implications and Community Reactions',
      summary:
        'AI-generated code is accelerating the impact of bad engineering ' +
        'decisions, concentrating value in a few top engineers while ' +
        'marginalizing mid-level developers.',
      period_label: null,
      job_type: 'hn_story',
      source_id: 'hn:story',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-13T02:07:27.624Z',
      signal: { type: 'hn_points', value: 729 },
    },
    {
      id: '924f4e7f-1bb7-4530-b95d-461a0db5598b',
      title: 'Why Tiny JPEGs Look Different in Chrome',
      summary:
        'Chrome uses partial IDCT scaling via libjpeg-turbo to optimize the ' +
        'decoding of small JPEGs, which can lead to visual discrepancies ' +
        'like thicker lines in icons compared to other browsers.',
      period_label: null,
      job_type: 'hn_story',
      source_id: 'hn:story',
      model: 'gemma-4-31b-it',
      occurred_at: null,
      generated_at: '2026-08-13T02:07:58.961Z',
      signal: { type: 'hn_points', value: 256 },
    },
    {
      id: '26bf9183-7dc0-4cd1-8daf-8660e7bc22aa',
      title: 'Hand-Etched Holograms Created with a Pen Plotter',
      summary:
        'A hobbyist uses a refurbished pen plotter and CD jewel cases to ' +
        'etch reflective ridges that produce depth cues, demonstrating a ' +
        'low-cost, hand-drawn holography technique.',
      period_label: null,
      job_type: 'hn_story',
      source_id: 'hn:story',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-13T02:05:26.669Z',
      signal: { type: 'hn_points', value: 179 },
    },
  ],
  total: 3874,
  offset: 0,
  limit: 20,
}

/**
 * gh_project list payload. Captured live on 2026-08-13.
 *
 * `stars_per_day` of 1 and 2 is why the velocity floor has to survive the
 * move onto the blogs stream: newest-first here is mostly noise.
 */
export const projectBlogListResponse = {
  items: [
    {
      id: 'a1000000-0000-4000-8000-000000000001',
      title:
        'ante: Ante - a 15 MB, offline-capable terminal coding agent',
      summary:
        'A single-binary terminal coding agent that runs offline against ' +
        'local models and ships as a 15 MB executable.',
      period_label: null,
      job_type: 'gh_project',
      source_id: 'ghp:story',
      model: 'openai/gpt-oss-120b',
      occurred_at: null,
      generated_at: '2026-08-13T00:04:00.000Z',
      signal: { type: 'momentum', stars_per_day: 202 },
    },
    {
      id: 'a1000000-0000-4000-8000-000000000002',
      title:
        'ComfyUI-H3-Motion-Context: Seamless video-and-audio chaining',
      summary:
        'A ComfyUI node that chains video and audio generation passes while ' +
        'preserving motion context across segment boundaries.',
      period_label: null,
      job_type: 'gh_project',
      source_id: 'ghp:story',
      model: 'gemma-4-31b-it',
      occurred_at: null,
      generated_at: '2026-08-13T00:04:00.000Z',
      signal: { type: 'momentum', stars_per_day: 76 },
    },
    {
      id: 'a1000000-0000-4000-8000-000000000003',
      title:
        'DiffSynth-Studio: an open-source diffusion model engine',
      summary:
        'A diffusion engine that exposes training and inference for image ' +
        'and video models behind one Python API.',
      period_label: null,
      job_type: 'gh_project',
      source_id: 'ghp:story',
      model: 'gemma-4-31b-it',
      occurred_at: null,
      generated_at: '2026-08-13T02:00:00.000Z',
      signal: { type: 'momentum', stars_per_day: 13 },
    },
    {
      id: 'a1000000-0000-4000-8000-000000000004',
      title:
        'ios-simulator-mcp: an MCP server for controlling the iOS simulator',
      summary:
        'An MCP server that exposes the iOS simulator to agents for ' +
        'programmatic UI interaction.',
      period_label: null,
      job_type: 'gh_project',
      source_id: 'ghp:story',
      model: 'gemma-4-31b-it',
      occurred_at: null,
      generated_at: '2026-08-13T00:01:00.000Z',
      signal: { type: 'momentum', stars_per_day: 1 },
    },
  ],
  total: 1582,
  offset: 0,
  limit: 20,
}

/**
 * A gh_project detail body. `references[0].identifier` is the join key back
 * to `GET /projects/ghp:{identifier}`.
 */
export const projectBlogDetailResponse = {
  ...projectBlogListResponse.items[0],
  body_markdown:
    '## What it is\n\nAnte is a terminal coding agent that ships as a ' +
    'single 15 MB binary and runs against local models.\n',
  references: [
    {
      type: 'repo',
      identifier: 'anteproject/ante',
      title: 'anteproject/ante',
      url: 'https://github.com/anteproject/ante',
    },
  ],
  translation_status: 'ready',
}

/**
 * The x_digest whose body is dense with comparable entities. Captured live
 * on 2026-08-13. This is the shape the account exists to post.
 */
export const grokDigestListItem = {
  id: 'b2000000-0000-4000-8000-000000000001',
  title:
    'AI & Frontier Tech Roundup - Grok 4.6/4.7, Open-Weight Model Surge, ' +
    'Agent Governance, and Edge AI Advances',
  summary:
    'Grok 4.6/4.7 is delivering faster, cheaper performance that rivals top ' +
    'coding agents, while a flood of open-weight models (DeepSeek V4 Pro, ' +
    'Qwen 3.8-Max, Nemotron 3.5 Lightning) and emerging agent-governance ' +
    'platforms are accelerating the shift toward autonomous agents.',
  period_label: null,
  job_type: 'x_digest',
  source_id: 'x:search',
  model: 'openai/gpt-oss-120b',
  occurred_at: null,
  generated_at: '2026-08-13T01:04:37.189Z',
  signal: null,
}
```

- [ ] **Step 6: 订正一条已经不成立的注释**

`tweet-generator/src/sources/agentlens.ts` 顶部 class 注释里这句已经过时——`/query` 的 100 次是一次性赠额而非每月配额，可付费加购：

```
 * `/query` is deliberately not implemented: its quota is 100 calls per 30
 * days, which cannot sustain a service running every two hours.
```

替换为：

```
 * `/query` (semantic search) is not implemented here yet. It is metered but
 * not rate-limited — the 100 free calls are a one-off grant, not a monthly
 * allowance — so the constraint on using it is cost, not throughput.
```

- [ ] **Step 7: 跑全部测试**

Run: `pnpm --filter tweet-generator test`
Expected: PASS（现有 fixtures 已带 `signal: null`，新字段不会破坏既有断言）

- [ ] **Step 8: Commit**

```bash
git add tweet-generator/src/sources/agentlens.ts \
        tweet-generator/src/sources/agentlens.fixtures.ts \
        tweet-generator/src/sources/agentlens.test.ts
git commit -m "feat(tweet-generator): read the signal the API was already sending"
```

---

### Task 2: 实体显著性打分

**Files:**
- Create: `tweet-generator/src/select/entities.ts`
- Test: `tweet-generator/src/select/entities.test.ts`

**Interfaces:**
- Consumes: 无（纯函数，无导入）
- Produces: `interface EntityScore { score: number; entities: string[] }`；`function scoreEntities(text: string): EntityScore`

**设计说明（实现者必读）：** 三层加权求和，风格照抄同目录的 `niche.ts`（正则表 + 纯函数 + 穷举测试）。
- **词表层**捕获已知大牌（权重 3）。
- **型号模式层**捕获词表里没有的新模型（权重 2）——`LFM2.5-VL-3B` 这种今天才发布的名字不可能预先写进词表，这一层是它唯一的入口。
- **benchmark 层**权重 2。
- **不设负分表。** 非 AI 内容自然得 0 分沉底，不需要枚举「Amiga / JPEG / 全息图」这类无穷无尽的东西。
- 去重按小写做，`entities` 保留首次出现的原始大小写（它会被持久化并在第二阶段用来找对比对象）。

- [ ] **Step 1: 写失败的测试**

创建 `tweet-generator/src/select/entities.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { scoreEntities } from './entities.js'

describe('scoreEntities', () => {
  it('scores a vendor name', () => {
    const result = scoreEntities('Anthropic ships a new endpoint')
    expect(result.entities).toContain('Anthropic')
    expect(result.score).toBeGreaterThan(0)
  })

  it('catches a model name that no lexicon could have contained', () => {
    // Released the day this was written. The pattern layer is its only way in.
    const result = scoreEntities("LFM2.5-VL-3B release notes / what's new")
    expect(result.entities).toContain('LFM2.5-VL-3B')
  })

  it('catches versioned model names', () => {
    expect(scoreEntities('Grok 4.6 is out').entities).toContain('Grok 4.6')
    expect(scoreEntities('Qwen 3.8-Max weights').entities).toContain(
      'Qwen 3.8-Max',
    )
  })

  it('scores benchmarks', () => {
    const result = scoreEntities('82.9% on Terminal-Bench 2.1')
    expect(result.entities).toContain('Terminal-Bench')
  })

  it('gives non-AI material a score of zero', () => {
    expect(scoreEntities('Hand-Etched Holograms Created with a Pen Plotter')
      .score).toBe(0)
    expect(scoreEntities('Why Tiny JPEGs Look Different in Chrome').score)
      .toBe(0)
  })

  it('ranks an entity-dense digest far above a hot but entity-free story', () => {
    // The whole point of this module: the Tailscale story scored 803 on HN
    // and the Grok roundup carries no signal at all, yet the roundup is the
    // one this account exists to post.
    const tailscale = scoreEntities(
      'Tailscale SQLite WAL-Reset Bug Investigation and Fix ' +
        'Tailscale traced months of control-plane outages to a 16-year-old ' +
        'SQLite WAL-Reset data-race bug, and deployed a fix in SQLite ' +
        '3.52.0 (later 3.51.3).',
    )
    const grok = scoreEntities(
      'AI & Frontier Tech Roundup - Grok 4.6/4.7, Open-Weight Model Surge ' +
        'Grok 4.6/4.7 is delivering faster, cheaper performance, while a ' +
        'flood of open-weight models (DeepSeek V4 Pro, Qwen 3.8-Max, ' +
        'Nemotron 3.5 Lightning) accelerate the shift to autonomous agents.',
    )
    expect(grok.score).toBeGreaterThan(tailscale.score * 2)
  })

  it('counts each entity once however often it appears', () => {
    const once = scoreEntities('Gemini')
    const thrice = scoreEntities('Gemini and Gemini and gemini')
    expect(thrice.score).toBe(once.score)
    expect(thrice.entities).toHaveLength(1)
  })

  it('is case-insensitive but reports the original spelling', () => {
    expect(scoreEntities('deepseek ships').entities).toEqual(['deepseek'])
  })

  it('has no entities in empty text', () => {
    expect(scoreEntities('')).toEqual({ score: 0, entities: [] })
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter tweet-generator test -- entities`
Expected: FAIL，Cannot find module './entities.js'

- [ ] **Step 3: 实现**

创建 `tweet-generator/src/select/entities.ts`：

```ts
/**
 * How much of a title is made of things a reader already searches for.
 *
 * The account's problem was never that its posts were wrong — it was that
 * nobody had heard of what they were about. A dispatch naming Grok and
 * DeepSeek reaches people who are already looking; one naming OlmoEarth
 * reaches nobody, however sound the finding.
 *
 * Three layers, because one is not enough on its own. The lexicon knows the
 * incumbents. The pattern layer catches models released after this file was
 * last edited — `LFM2.5-VL-3B` cannot be in any lexicon on the day it ships,
 * and that day is exactly when it is worth posting about. Benchmarks are
 * separate because they are what makes two models comparable.
 *
 * There is deliberately no penalty list. Material about pen plotters scores
 * zero and sinks on its own; enumerating everything that is not AI is a list
 * with no end.
 */

const VENDOR_WEIGHT = 3
const MODEL_WEIGHT = 2
const BENCHMARK_WEIGHT = 2

/** Labs, products, and the tools this audience already uses daily. */
const VENDORS = [
  'OpenAI', 'Anthropic', 'Claude', 'ChatGPT', 'GPT', 'Codex', 'Sora',
  'Whisper', 'Google DeepMind', 'DeepMind', 'Gemini', 'Gemma',
  'DeepSeek', 'Qwen', 'Alibaba', 'Llama', 'Mistral', 'Grok', 'xAI',
  'Nvidia', 'Nemotron', 'Cohere', 'Perplexity', 'Cursor', 'Copilot',
  'Hugging Face', 'HuggingFace', 'Groq', 'Fireworks', 'Replicate',
  'Stability AI', 'Midjourney', 'Kimi', 'MiniMax', 'Liquid AI', 'LFM',
  'Phi', 'GLM', 'vLLM', 'Ollama', 'LangChain', 'LlamaIndex', 'MCP',
]

/** What makes two models comparable, and therefore what a versus post needs. */
const BENCHMARKS = [
  'SWE-bench', 'Terminal-Bench', 'MMLU', 'MMMU', 'HumanEval', 'ARC-AGI',
  'GPQA', 'AIME', 'LiveCodeBench', 'HellaSwag', 'BIG-bench',
]

/**
 * A capitalised name with a version: `Grok 4.6`, `Qwen 3.8-Max`,
 * `LFM2.5-VL-3B`, `LFM2.5-2.6B`.
 *
 * Two branches, because a separated version and a glued one accept
 * different shapes. `Grok 4.6` is name, separator, number. `LFM2.5-VL-3B`
 * has the number welded to the name and must carry a second digit
 * somewhere in its tail — that requirement is exactly what keeps
 * `ComfyUI-H3-Motion-Context` out: it starts like a glued version and never
 * shows a digit again, so no lexicon will ever need to name it.
 */
const MODEL_PATTERN =
  /\b(?:[A-Z][A-Za-z]*[ -]\d+(?:[.-][A-Za-z0-9]+)*|[A-Z][A-Za-z]*\d+(?=[.-][^\s]*\d)[.-][A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)\b/g

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lexiconPattern(terms: string[]): RegExp {
  const alternation = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  return new RegExp(`(?<![\\w-])(?:${alternation})(?![\\w-])`, 'gi')
}

const VENDOR_PATTERN = lexiconPattern(VENDORS)
const BENCHMARK_PATTERN = lexiconPattern(BENCHMARKS)

export interface EntityScore {
  /** Weighted count of distinct entities. Zero means nothing recognisable. */
  score: number
  /**
   * Distinct entities in first-seen spelling. Persisted on the tweet row:
   * finding a comparison partner later means asking what we have already
   * written about, and that question needs the names, not the score.
   */
  entities: string[]
}

export function scoreEntities(text: string): EntityScore {
  const seen = new Map<string, string>()
  let score = 0

  const collect = (pattern: RegExp, weight: number): void => {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0]
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      seen.set(key, raw)
      score += weight
    }
  }

  collect(VENDOR_PATTERN, VENDOR_WEIGHT)
  collect(BENCHMARK_PATTERN, BENCHMARK_WEIGHT)
  collect(MODEL_PATTERN, MODEL_WEIGHT)

  return { score, entities: [...seen.values()] }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter tweet-generator test -- entities`
Expected: PASS

若 `LFM2.5-VL-3B` 一例失败，先单独在 node 里验证 `MODEL_PATTERN`，不要改断言去迁就正则——那个断言正是这个模块存在的理由。

- [ ] **Step 5: Commit**

```bash
git add tweet-generator/src/select/entities.ts \
        tweet-generator/src/select/entities.test.ts
git commit -m "feat(tweet-generator): score how searchable a dispatch is"
```

---

### Task 3: 三层 tier 与配额重排

**Files:**
- Modify: `tweet-generator/src/config.ts:7-26`（`SourceKind`、`SOURCE_PRIORITY`、`Quota`）与配额读取处
- Modify: `tweet-generator/.env.example`
- Test: `tweet-generator/src/config.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `type Tier = 'project' | 'hot' | 'labs'`；`const TIER_OF_KIND: Record<SourceKind, Tier>`；`const TIER_PRIORITY: readonly Tier[]`；`GeneratorConfig.quota: Record<Tier, number>`；`GeneratorConfig.entityWeight: number`；`GeneratorConfig.agentlensApiKey: string | null`；`SourceKind` 不再包含 `'youtube_video'`

**设计说明（实现者必读）：** 现状 `QUOTA_LAB=4` 是 `DAILY_CAP=10` 里最大的一档，而 `lab_article` 是唯一 `signal` 恒为 `null` 的源——热度无从判断却占了四成版面。新默认把版面挪给能判断热度、且是对比素材唯一稳定来源的 hot 层。

- [ ] **Step 1: 写失败的测试**

追加到 `tweet-generator/src/config.test.ts`：

```ts
import { TIER_OF_KIND, TIER_PRIORITY } from './config.js'

describe('tiers', () => {
  it('maps every source kind to a tier', () => {
    expect(TIER_OF_KIND).toEqual({
      gh_project: 'project',
      hn_story: 'hot',
      x_digest: 'hot',
      lab_article: 'labs',
    })
  })

  it('no longer knows about youtube', () => {
    expect(Object.keys(TIER_OF_KIND)).not.toContain('youtube_video')
  })

  it('lists every tier exactly once', () => {
    expect([...TIER_PRIORITY].sort()).toEqual(['hot', 'labs', 'project'])
  })
})
```

**改掉现有的 `quota` 断言。** `config.test.ts:19-25` 现在写着按 kind 的五个键，把那一段替换为：

```ts
    expect(config.quota).toEqual({ hot: 5, project: 3, labs: 2 })
    expect(config.entityWeight).toBe(0.7)
    expect(config.agentlensApiKey).toBeNull()
```

同时**删除**同一个 `toEqual` 块后面的 `expect(config.projectCooldownDays).toBe(7)` 一行。

再追加一组语义断言。注意 `loadConfig` 要求 `LLM_MODEL`，传空对象会抛——沿用文件顶部已有的 `minimal` 夹具：

```ts
describe('quota defaults', () => {
  it('gives the hot tier the largest share, since it is the only tier with both a heat signal and comparison material', () => {
    const config = loadConfig(minimal)
    expect(config.quota.hot).toBeGreaterThan(config.quota.labs)
    expect(config.quota.hot + config.quota.project + config.quota.labs)
      .toBeLessThanOrEqual(config.dailyCap)
  })

  it('weights entity salience above raw discussion volume', () => {
    // A story can be the loudest thing on HN and still be about a plotter.
    expect(loadConfig(minimal).entityWeight).toBeGreaterThan(0.5)
  })

  it('reads the API key when one is set', () => {
    const config = loadConfig({ ...minimal, AGENTLENS_API_KEY: 'k' } as NodeJS.ProcessEnv)
    expect(config.agentlensApiKey).toBe('k')
  })
})
```

**另外两处既有断言也必须改**，否则本任务结束时 `config` 测试会红：把「rejects a quota total above the daily cap」里的 `QUOTA_LAB: '9'` 改为 `QUOTA_HOT: '9'`（`QUOTA_LAB` 已不再被读取，9 也不再让总额超限）：

```ts
  it('rejects a quota total above the daily cap', () => {
    expect(() =>
      loadConfig({ ...minimal, QUOTA_HOT: '9' } as NodeJS.ProcessEnv),
    ).toThrow(/exceeds DAILY_CAP/)
  })
```

把「reads overrides」用例整体替换为（旧键 `QUOTA_LAB` / `QUOTA_DIGEST` / `QUOTA_HN` / `QUOTA_YOUTUBE` 已不存在；留着 `QUOTA_YOUTUBE: '0'` 还会让新默认值 5+3+2=10 撞上 `DAILY_CAP: '6'` 直接抛错）：

```ts
  it('reads overrides', () => {
    const config = loadConfig({
      ...minimal,
      QUOTA_HOT: '2',
      QUOTA_PROJECT: '1',
      QUOTA_LABS: '1',
      ENTITY_WEIGHT: '0.9',
      DAILY_CAP: '6',
      TIMEZONE: 'UTC',
    } as NodeJS.ProcessEnv)

    expect(config.quota.hot).toBe(2)
    expect(config.quota.labs).toBe(1)
    expect(config.entityWeight).toBe(0.9)
    expect(config.dailyCap).toBe(6)
    expect(config.timezone).toBe('UTC')
  })
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter tweet-generator test -- config`
Expected: FAIL，`TIER_OF_KIND` is not exported

- [ ] **Step 3: 实现**

在 `tweet-generator/src/config.ts` 中，把 `SourceKind` 改为四种（删掉 `'youtube_video'`），并替换 `SOURCE_PRIORITY` / `Quota` 段落：

```ts
/** The four AgentLens dispatch kinds this service draws from. */
export type SourceKind =
  | 'lab_article'
  | 'gh_project'
  | 'x_digest'
  | 'hn_story'

/**
 * What a post is for, which is a different question from where it came from.
 *
 * Quota lives here rather than on the kind because `hn_story` and `x_digest`
 * do the same job — they are what is being talked about right now — while
 * differing entirely in whether the API can tell us how loudly.
 */
export type Tier = 'project' | 'hot' | 'labs'

export const TIER_OF_KIND: Record<SourceKind, Tier> = {
  gh_project: 'project',
  hn_story: 'hot',
  x_digest: 'hot',
  lab_article: 'labs',
}

/** Breaks ties in the quota picker when two tiers have equal headroom. */
export const TIER_PRIORITY: readonly Tier[] = ['hot', 'project', 'labs']

export const KINDS_OF_TIER: Record<Tier, readonly SourceKind[]> = {
  project: ['gh_project'],
  hot: ['x_digest', 'hn_story'],
  labs: ['lab_article'],
}

export type Quota = Record<Tier, number>
```

在 `GeneratorConfig` 接口中：删除 `projectCooldownDays`，保留 `projectMinVelocityPerDay`（Task 6 会把它挪到新位置），并加入：

```ts
  /**
   * How much of the ranking is entity salience versus raw discussion volume.
   * Above 0.5 on purpose: a story can be the loudest thing on HN and still
   * be about a pen plotter.
   */
  entityWeight: number
  /** Only the comparison finder needs it, and only from phase two. */
  agentlensApiKey: string | null
```

在配置加载函数中，把 `QUOTA_LAB` / `QUOTA_PROJECT` / `QUOTA_DIGEST` / `QUOTA_HN` / `QUOTA_YOUTUBE` 五个读取替换为三个，并加两行：

```ts
    quota: {
      hot: nonNegativeInt(env, 'QUOTA_HOT', 5),
      project: nonNegativeInt(env, 'QUOTA_PROJECT', 3),
      labs: nonNegativeInt(env, 'QUOTA_LABS', 2),
    },
    entityWeight: Number(env.ENTITY_WEIGHT ?? '0.7'),
    agentlensApiKey: env.AGENTLENS_API_KEY || null,
```

同时删除 `projectCooldownDays` 的读取行。

- [ ] **Step 4: 更新 `.env.example`**

把 `tweet-generator/.env.example` 中 `# Daily quota per source.` 注释以下的配额五行：

```
QUOTA_LAB=4
QUOTA_PROJECT=3
QUOTA_DIGEST=1
QUOTA_HN=1
QUOTA_YOUTUBE=1
```

替换为：

```
# Per-tier daily quota. hot gets the largest share: it is the only tier with
# both a heat signal and material that supports a comparison post.
QUOTA_HOT=5
QUOTA_PROJECT=3
QUOTA_LABS=2
# Share of the ranking given to entity salience over raw discussion volume.
ENTITY_WEIGHT=0.7
# Optional. Only the comparison finder uses it. Get one at
# https://agentlenshq.com/account
AGENTLENS_API_KEY=
```

再删掉下面 `PROJECT_COOLDOWN_DAYS=7` 那一行（config 里已移除）。它上方 `# Selection. A project reposts only after crossing a star bucket, and never within the cooldown, and never while its momentum is below the floor.` 注释同样过时——star bucket 与 cooldown 都随 Task 5/6 消失，一并改为：

```
# Selection. On the blogs stream a gh_project's quality is decided by the
# star-velocity floor; the leaderboard sort no longer applies.
```

- [ ] **Step 5: 跑测试**

Run: `pnpm --filter tweet-generator test -- config`
Expected: PASS。

跑全量 `pnpm --filter tweet-generator test` 时 `quota.test.ts` 与 `store.test.ts` 会失败——`quota.ts` / `store.ts` 还在导入本任务刚删除的 `SOURCE_PRIORITY`，vite 会报 "does not provide an export named 'SOURCE_PRIORITY'"。这是预期的中间态，Task 7 修复；`select/windows.ts` 的 `WINDOW_HOURS` 多一个键不影响运行，Task 6 会删。本步只要求 `config` 那一组测试通过。

- [ ] **Step 6: Commit**

```bash
git add tweet-generator/src/config.ts tweet-generator/src/config.test.ts \
        tweet-generator/.env.example
git commit -m "feat(tweet-generator): group the sources by what a post is for"
```

---

### Task 4: tier 内归一化排序

**Files:**
- Create: `tweet-generator/src/select/rank.ts`
- Test: `tweet-generator/src/select/rank.test.ts`

**Interfaces:**
- Consumes: `heatOf`（Task 1）、`scoreEntities`（Task 2）
- Produces: `interface Rankable { title: string; summary: string; signal: BlogSignal | null }`；`interface Ranked<T> { item: T; rank: number; entities: string[] }`；`function rankWithinTier<T extends Rankable>(items: T[], entityWeight: number): Ranked<T>[]`

**设计说明（实现者必读）：** 两个信号的量纲天差地别——HN 分数在 179–803，`momentum` 的 `stars_per_day` 在 1–1200，而 `lab_article` 和 `x_digest` 根本没有。任何跨 tier 的绝对比较都是错的。所以两项都在**传进来的这一批**里做 min-max 归一化，调用方只在同一个 tier 内调用它。

全批 heat 都是 null 时（labs 与 x_digest 的常态），heat 项恒为 0，公式自然退化成纯实体分。全批 heat 相同时 min === max，此时统一取 1（而不是除以零）：它们在这一维上没有区别，就不该在这一维上分出高下。

- [ ] **Step 1: 写失败的测试**

创建 `tweet-generator/src/select/rank.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import {
  grokDigestListItem,
  hnListResponse,
  projectBlogListResponse,
} from '../sources/agentlens.fixtures.js'
import { rankWithinTier, type Rankable } from './rank.js'

const WEIGHT = 0.7

function titles(items: { item: Rankable }[]): string[] {
  return items.map((ranked) => ranked.item.title)
}

describe('rankWithinTier', () => {
  it('puts the entity-dense digest above the loudest entity-free story', () => {
    const ranked = rankWithinTier(
      [...(hnListResponse.items as Rankable[]), grokDigestListItem],
      WEIGHT,
    )
    expect(titles(ranked)[0]).toContain('Grok 4.6/4.7')
  })

  it('sinks the two non-AI stories despite their HN scores', () => {
    const ranked = rankWithinTier(
      [...(hnListResponse.items as Rankable[]), grokDigestListItem],
      WEIGHT,
    )
    const bottom = titles(ranked).slice(-2).join(' | ')
    expect(bottom).toContain('Holograms')
    expect(bottom).toContain('Tiny JPEGs')
  })

  it('reports the entities it found, for persistence', () => {
    const [top] = rankWithinTier([grokDigestListItem], WEIGHT)
    expect(top!.entities).toContain('DeepSeek')
  })

  it('falls back to pure entity score when nothing in the batch has heat', () => {
    // Every x_digest and lab_article arrives with signal: null.
    const ranked = rankWithinTier(
      [
        { title: 'Pen plotter holography', summary: '', signal: null },
        grokDigestListItem,
      ],
      WEIGHT,
    )
    expect(titles(ranked)[0]).toContain('Grok 4.6/4.7')
  })

  it('does not divide by zero when every item has the same heat', () => {
    const same = [
      { title: 'Claude ships', summary: '', signal: { type: 'hn_points', value: 100 } },
      { title: 'Gemini ships', summary: '', signal: { type: 'hn_points', value: 100 } },
    ]
    const ranked = rankWithinTier(same, WEIGHT)
    expect(ranked.every((r) => Number.isFinite(r.rank))).toBe(true)
  })

  it('ranks an empty batch to an empty result', () => {
    expect(rankWithinTier([], WEIGHT)).toEqual([])
  })

  it('is stable enough that a 1200 stars/day project does not swamp an 803-point story — they are never compared', () => {
    // Guard against a future refactor merging the tiers: this function is
    // only ever handed one tier's items, and normalising per batch is what
    // makes that safe.
    const project = rankWithinTier(
      projectBlogListResponse.items as Rankable[],
      WEIGHT,
    )
    expect(project.every((r) => r.rank >= 0 && r.rank <= 1)).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter tweet-generator test -- rank`
Expected: FAIL，Cannot find module './rank.js'

- [ ] **Step 3: 实现**

创建 `tweet-generator/src/select/rank.ts`：

```ts
import { heatOf, type BlogSignal } from '../sources/agentlens.js'
import { scoreEntities } from './entities.js'

/** The three fields ranking needs. Anything wider is the caller's business. */
export interface Rankable {
  title: string
  summary: string
  signal: BlogSignal | null
}

export interface Ranked<T> {
  item: T
  /** 0..1. Only comparable against other items from the same call. */
  rank: number
  entities: string[]
}

/**
 * Normalised against the batch, never against a constant.
 *
 * An identical batch is the point: HN scores run 179-803, project momentum
 * runs 1-1200, and half the sources send no signal at all. Any fixed scale
 * would encode one source's range as the truth for all of them. Callers
 * therefore hand this one tier's items at a time.
 */
function normalise(values: (number | null)[]): number[] {
  const present = values.filter((value): value is number => value !== null)
  if (present.length === 0) return values.map(() => 0)

  const min = Math.min(...present)
  const max = Math.max(...present)
  // Every item scored the same, so none of them is ahead on this axis.
  // Dividing here would be a zero divide; returning 1 says "no separation".
  if (max === min) return values.map((value) => (value === null ? 0 : 1))

  return values.map((value) =>
    value === null ? 0 : (value - min) / (max - min),
  )
}

export function rankWithinTier<T extends Rankable>(
  items: T[],
  entityWeight: number,
): Ranked<T>[] {
  if (items.length === 0) return []

  const scored = items.map((item) =>
    scoreEntities(`${item.title} ${item.summary}`),
  )
  const entityRanks = normalise(scored.map((score) => score.score))
  const heatRanks = normalise(items.map((item) => heatOf(item.signal)))

  return items
    .map((item, index) => ({
      item,
      rank:
        entityWeight * entityRanks[index]! +
        (1 - entityWeight) * heatRanks[index]!,
      entities: scored[index]!.entities,
    }))
    .sort((a, b) => b.rank - a.rank)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter tweet-generator test -- rank`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tweet-generator/src/select/rank.ts tweet-generator/src/select/rank.test.ts
git commit -m "feat(tweet-generator): rank a tier against itself, never across tiers"
```

---

### Task 5: gh_project 候选从 `/projects` 补全

**Files:**
- Modify: `tweet-generator/src/sources/candidates.ts:37-77`
- Test: `tweet-generator/src/sources/candidates.test.ts`

**Interfaces:**
- Consumes: `BlogDetail`、`ProjectDetail`（Task 1 之后 `BlogDetail` 带 `signal`）
- Produces: `function blogToCandidate(blog: BlogDetail, project?: ProjectDetail | null): Candidate`；`Candidate.entities: string[]`；`projectToCandidate` 删除

**设计说明（实现者必读）：** 走单一 blogs 流之后，`gh_project` 的候选是一条 blog，而 blog 不带 stars / forks / license。这些数字是 `Candidate.facts` 的全部来源，而 `facts` 是验证器判断「模型有没有编数字」的白名单——丢了它们，关于项目的帖子就再也写不出一个具体数字。所以 `gh_project` 的 blog 必须用 `references[0].identifier` 回查 `/projects/ghp:{identifier}` 补全。

补全**失败不是错误**：项目可能已从榜单下架（API 对 `relevance != 'relevant'` 直接 404）。此时候选照常产出，只是 `facts` 为空——与其他四种 blog 一样。

- [ ] **Step 1: 写失败的测试**

先改 `tweet-generator/src/sources/candidates.test.ts`：把导入行的 `projectToCandidate` 删掉（`import { blogToCandidate, formatCount, projectToCandidate }` → `import { blogToCandidate, formatCount }`），并**整个删除**文件末尾的 `describe('projectToCandidate', ...)` 用例块（4 个用例）。函数本身在本任务删除，留着这段会让整个测试文件加载失败。

然后在文件末尾追加：

```ts
import { describe, expect, it } from 'vitest'
import {
  blogDetailResponse,
  projectBlogDetailResponse,
  projectDetailResponse,
} from './agentlens.fixtures.js'
import { blogToCandidate } from './candidates.js'
import type { BlogDetail, ProjectDetail } from './agentlens.js'

describe('blogToCandidate', () => {
  it('carries the entities it found, for the comparison finder', () => {
    const candidate = blogToCandidate(blogDetailResponse as BlogDetail)
    expect(candidate.entities).toContain('LFM2.5-2.6B')
  })

  it('hydrates a project dispatch with the numbers a blog does not carry', () => {
    const candidate = blogToCandidate(
      projectBlogDetailResponse as BlogDetail,
      projectDetailResponse as ProjectDetail,
    )
    expect(candidate.facts).toContain('18.4k stars')
    expect(candidate.facts).toContain('+443 stars/day')
  })

  it('still produces a candidate when the project has left the leaderboard', () => {
    // /projects 404s for anything no longer relevant+active. That is a
    // dispatch with no metrics, not a dispatch that cannot be posted.
    const candidate = blogToCandidate(
      projectBlogDetailResponse as BlogDetail,
      null,
    )
    expect(candidate.facts).toEqual([])
    expect(candidate.title).toContain('ante')
  })

  it('keys a project dispatch on the dispatch, not on a star bucket', () => {
    // Bucketing existed to let one repo be posted again after it grew. On
    // the blogs stream each dispatch is already a distinct event.
    const candidate = blogToCandidate(
      projectBlogDetailResponse as BlogDetail,
      projectDetailResponse as ProjectDetail,
    )
    expect(candidate.dedupeKey).toBe(
      `agentlens:blog:${projectBlogDetailResponse.id}`,
    )
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter tweet-generator test -- candidates`
Expected: FAIL，`entities` 不存在于 `Candidate`

- [ ] **Step 3: 实现**

在 `tweet-generator/src/sources/candidates.ts` 中：

删除 `import { starBucket } from '../select/dedupe.js'`，加入 `import { scoreEntities } from '../select/entities.js'`。

在 `Candidate` 接口末尾加：

```ts
  /**
   * The searchable names in this dispatch. Persisted on the tweet row so a
   * later post can ask what we have already written about and build a
   * comparison out of it.
   */
  entities: string[]
```

用下面这个替换 `blogToCandidate`，并**整个删除** `projectToCandidate`：

```ts
/**
 * `project` is the `/projects` record for a gh_project dispatch, or null.
 *
 * A blog carries no stars, forks, or licence, and `facts` is the validator's
 * whitelist of figures the model is allowed to quote. Without hydration
 * every post about a repository loses the ability to state a single number.
 * Null is the ordinary case for a repo that has since left the leaderboard,
 * and it costs the post its metrics, not its existence.
 */
export function blogToCandidate(
  blog: BlogDetail,
  project?: ProjectDetail | null,
): Candidate {
  const reference = blog.references?.[0]
  const facts: string[] = []

  if (project) {
    facts.push(
      project.full_name,
      `${formatCount(project.stars)} stars`,
      `+${Math.round(project.star_velocity_per_day)} stars/day`,
      `${formatCount(project.forks)} forks`,
    )
    if (project.language) facts.push(project.language)
    if (project.license) facts.push(project.license)
  }

  return {
    kind: blog.job_type,
    externalId: blog.id,
    title: blog.title,
    summary: blog.summary,
    body: blog.body_markdown,
    facts,
    sourceUrl: reference?.html_url ?? reference?.url ?? null,
    freshness: new Date(blog.generated_at),
    dedupeKey: `agentlens:blog:${blog.id}`,
    entities: scoreEntities(`${blog.title} ${blog.summary}`).entities,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter tweet-generator test -- candidates`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tweet-generator/src/sources/candidates.ts \
        tweet-generator/src/sources/candidates.test.ts
git commit -m "feat(tweet-generator): hydrate a project dispatch with its metrics"
```

---

### Task 6: `pool.ts` 改成 blogs 单流

**Files:**
- Modify: `tweet-generator/src/select/pool.ts`（整个文件）
- Delete: `tweet-generator/src/select/dedupe.ts` 与 `tweet-generator/src/select/dedupe.test.ts`
- Modify: `tweet-generator/src/select/windows.ts`（删 `youtube_video` 条目）
- Test: `tweet-generator/src/select/pool.test.ts`

**Interfaces:**
- Consumes: `rankWithinTier`（Task 4）、`blogToCandidate`（Task 5）、`TIER_OF_KIND` / `KINDS_OF_TIER`（Task 3）
- Produces: `interface PoolDeps { listBlogs; getBlog; getProject; knownDedupeKeys; failureCounts }`（`listProjects` 与 `projectPostedSince` 移除）；`function selectCandidate(tier: Tier, now: Date, config: GeneratorConfig, deps: PoolDeps): Promise<Candidate | null>`

**设计说明（实现者必读）：** 这是本阶段最关键的一步，也是最容易漏掉一件事的一步：**速度闸必须跟着搬家**。原来 `gh_project` 的质量由 `/projects` 那条路上的 `star_velocity_per_day >= 20` 把关；换到 blogs 流之后，如果不用 `signal.stars_per_day` 重建这道闸，选出来的会是 fixtures 里 `stars_per_day` 为 1 和 2 的那些条目——比现状更糟。

- [ ] **Step 1: 写失败的测试**

先改 `tweet-generator/src/select/pool.test.ts:19-46` 的两个夹具。`blogItem()` 补 `signal`，`deps()` 去掉两个不再存在的成员：

```ts
function blogItem(overrides: Partial<BlogListItem> = {}): BlogListItem {
  return {
    id: 'b1',
    title: 'A new inference engine',
    summary: 'It is faster.',
    job_type: 'lab_article',
    source_id: 'lab:openai',
    occurred_at: null,
    generated_at: '2026-08-05T05:00:00.000Z',
    signal: null,
    ...overrides,
  }
}

function deps(overrides: Partial<PoolDeps> = {}): PoolDeps {
  return {
    listBlogs: vi.fn().mockResolvedValue([blogItem()]),
    getBlog: vi.fn(async (id: string) => blogDetail(blogItem({ id }))),
    getProject: vi.fn().mockResolvedValue(null),
    knownDedupeKeys: vi.fn().mockResolvedValue(new Set<string>()),
    failureCounts: vi.fn().mockResolvedValue(new Map<string, number>()),
    ...overrides,
  }
}
```

同时：把 import 里的 `ProjectListItem`、`ProjectDetail` 一起删掉（新 `deps()` 不再用它们）；删掉整个 `describe('selectCandidate for gh_project', ...)` 用例块（它断言的正是 `listProjects` / `projectPostedSince` 行为，两条路径本任务删除）；把所有 `selectCandidate('lab_article', ...)` 这类调用的第一个参数改为 tier（`'labs'` / `'hot'` / `'project'`）。

**「returns the freshest eligible blog」这个用例必须整体替换**，不只是换参数：新 `pool.ts` 用实体分 + 热度排序，不再按 `generated_at` 倒序，两条同分条目保持输入顺序，原断言 `externalId === 'new'` 会直接翻车。换成（排序语义变了，用例名也改）：

```ts
  it('ranks the more searchable item above a vague one', async () => {
    // Newest-first is gone: within a tier the pool orders by entity
    // salience and heat, so the fresher but unsearchable item no longer
    // wins.
    const vague = blogItem({
      id: 'vague',
      title: 'Why Tiny JPEGs Look Different in Chrome',
      generated_at: '2026-08-05T05:00:00.000Z',
    })
    const dense = blogItem({
      id: 'dense',
      title: 'Anthropic ships a new Claude endpoint',
      generated_at: '2026-08-05T01:00:00.000Z',
    })

    const candidate = await selectCandidate(
      'labs',
      now,
      config,
      deps({ listBlogs: vi.fn().mockResolvedValue([vague, dense]) }),
    )

    expect(candidate!.externalId).toBe('dense')
  })
```

然后追加项目层的新用例：

```ts
import { projectBlogListResponse } from '../sources/agentlens.fixtures.js'

describe('selectCandidate for the project tier', () => {
  const projectDeps = deps({
    listBlogs: vi
      .fn()
      .mockResolvedValue(projectBlogListResponse.items as BlogListItem[]),
    getBlog: vi.fn(async (id: string) =>
      blogDetail(
        projectBlogListResponse.items.find(
          (item) => item.id === id,
        ) as BlogListItem,
      ),
    ),
  })

  /** 2026-08-13 10:00 Shanghai — inside the gh_project window for all four. */
  const then = new Date('2026-08-13T02:00:00.000Z')

  it('rejects the projects nobody is starring', async () => {
    // stars_per_day of 1, 2 and 13 are all below the floor of 20. Losing
    // this check is how the blogs stream becomes worse than what it replaced.
    const candidate = await selectCandidate('project', then, config, projectDeps)
    expect(candidate!.title).toContain('ante') // the 202 stars/day one
  })

  it('finds nothing when every project is below the floor', async () => {
    const strict = loadConfig({
      LLM_MODEL: 'pinned',
      TIMEZONE: 'Asia/Shanghai',
      PROJECT_MIN_VELOCITY_PER_DAY: '500',
    } as NodeJS.ProcessEnv)
    expect(
      await selectCandidate('project', then, strict, projectDeps),
    ).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter tweet-generator test -- pool`
Expected: FAIL，`selectCandidate` 第一个参数仍是 `SourceKind` 而非 `Tier`

- [ ] **Step 3: 实现**

用下面这份替换 `tweet-generator/src/select/pool.ts` 的全部内容：

```ts
import type { GeneratorConfig, SourceKind, Tier } from '../config.js'
import { KINDS_OF_TIER } from '../config.js'
import type {
  BlogDetail,
  BlogListItem,
  ProjectDetail,
} from '../sources/agentlens.js'
import { heatOf } from '../sources/agentlens.js'
import { blogToCandidate, type Candidate } from '../sources/candidates.js'
import { passesNicheGate } from './niche.js'
import { rankWithinTier } from './rank.js'
import { windowStart } from './windows.js'

/**
 * The I/O this module needs, as plain functions rather than the client and
 * store objects. Selection is the part with the silent bugs, so it is worth
 * being able to test every rule against literals.
 */
export interface PoolDeps {
  listBlogs(jobType: SourceKind, limit?: number): Promise<BlogListItem[]>
  getBlog(id: string): Promise<BlogDetail>
  /** Null when the repo has left the leaderboard; /projects 404s for those. */
  getProject(id: string): Promise<ProjectDetail | null>
  knownDedupeKeys(keys: string[]): Promise<Set<string>>
  failureCounts(externalIds: string[]): Promise<Map<string, number>>
}

const MAX_FAILURES = 3

/**
 * The star-velocity floor, rebuilt on the blogs stream.
 *
 * It used to live on the /projects path, where the leaderboard had already
 * sorted by momentum. Newest-first on /blogs has not: a live sample ran
 * 13, 2, 76, 202, 1 stars per day. Dropping this check when the streams
 * merged would have made selection worse than the thing it replaced.
 */
function passesVelocityFloor(
  item: BlogListItem,
  config: GeneratorConfig,
): boolean {
  if (item.job_type !== 'gh_project') return true
  const velocity = heatOf(item.signal)
  return velocity !== null && velocity >= config.projectMinVelocityPerDay
}

export async function selectCandidate(
  tier: Tier,
  now: Date,
  config: GeneratorConfig,
  deps: PoolDeps,
): Promise<Candidate | null> {
  const batches = await Promise.all(
    KINDS_OF_TIER[tier].map(async (kind) => {
      const since = windowStart(kind, now)
      return (await deps.listBlogs(kind)).filter(
        (item) => new Date(item.generated_at) >= since,
      )
    }),
  )

  const items = batches
    .flat()
    .filter((item) => passesNicheGate(`${item.title} ${item.summary}`))
    .filter((item) => passesVelocityFloor(item, config))

  if (items.length === 0) return null

  // Ranked as one batch because they are one tier: normalising per tier is
  // what keeps a project's 1200 stars/day from being compared against an
  // HN story's 803 points, two numbers that share no scale.
  const ranked = rankWithinTier(items, config.entityWeight)

  const known = await deps.knownDedupeKeys(
    ranked.map((entry) => `agentlens:blog:${entry.item.id}`),
  )
  const failures = await deps.failureCounts(
    ranked.map((entry) => entry.item.id),
  )

  const winner = ranked.find(
    (entry) =>
      !known.has(`agentlens:blog:${entry.item.id}`) &&
      (failures.get(entry.item.id) ?? 0) < MAX_FAILURES,
  )
  if (!winner) return null

  // Bodies cost one request each, so only the selected item is fetched.
  const blog = await deps.getBlog(winner.item.id)
  const identifier = blog.references?.[0]?.identifier
  const project =
    blog.job_type === 'gh_project' && identifier
      ? await deps.getProject(`ghp:${identifier}`)
      : null

  return blogToCandidate(blog, project)
}
```

- [ ] **Step 4: 删掉分桶去重与 youtube 窗口**

```bash
rm tweet-generator/src/select/dedupe.ts tweet-generator/src/select/dedupe.test.ts
```

在 `tweet-generator/src/select/windows.ts` 的 `WINDOW_HOURS` 中删除 `youtube_video: 168,` 一行，并把文件顶部注释里 `youtube_video 0` 那句连同 gh_project 段落一并改为：

```
 * Measured supply on 2026-08-05, per 24h: hn_story 68, gh_project 88,
 * lab_article 4, x_digest 2.
 *
 * gh_project's window is generous but rarely binding: eligibility there is
 * decided by the star-velocity floor in pool.ts instead.
```

`tweet-generator/src/select/windows.test.ts` 同步改：删除「gives YouTube a week」整个用例（`WINDOW_HOURS['youtube_video']` 现在是 undefined，`windowStart('youtube_video', ...)` 会算出 Invalid Date），并把「has a window for every source kind」的键断言改为四个：

```ts
  it('has a window for every source kind', () => {
    expect(Object.keys(WINDOW_HOURS).sort()).toEqual([
      'gh_project',
      'hn_story',
      'lab_article',
      'x_digest',
    ])
  })
```

- [ ] **Step 5: 在 index.ts 里接上 404 → null 的适配层**

**这一步不能跳过。** `AgentLensClient.getProject` 在非 2xx 时抛 `AgentLensError`（`agentlens.ts:126-135`），而 `PoolDeps.getProject` 约定返回 `null`。`/projects/:id` 对任何 `relevance != 'relevant'` 或 `status != 'active'` 的仓库直接 404 —— 那是**常态**，不是故障。少了这层适配，一个已下榜的项目会把整个补货周期炸掉。

在 `tweet-generator/src/index.ts` 的 `deps` 对象（第 49-53 行附近）中，删除 `listProjects` 与 `projectPostedSince` 两行，并把 `getProject` 换成：

```ts
  // A repo that has left the leaderboard 404s here, which is ordinary: the
  // dispatch is still worth posting, it just goes out without star counts.
  // Any other failure is a real one and belongs to the cycle's error path.
  getProject: async (id) => {
    try {
      return await agentlens.getProject(id)
    } catch (error) {
      if (error instanceof AgentLensError && /returned 404/.test(error.message)) {
        return null
      }
      throw error
    }
  },
```

把 `AgentLensError` 加入该文件从 `./sources/agentlens.js` 的导入。

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter tweet-generator test -- pool`
Expected: PASS

**预期中的中间态：** 本任务结束时 `index.ts:117,127` 仍在调用 `orderKinds` 并把 kind 传给 `selectCandidate`，所以 `pnpm --filter tweet-generator build` 会报类型错——Task 7 修复它。vitest 走 esbuild 只转译不做类型检查，因此测试照常全绿。**不要**为了让 build 过而提前改这两行，那会把 Task 7 的改动拆散到两个 commit 里。

- [ ] **Step 7: Commit**

```bash
git add -A tweet-generator/src/select tweet-generator/src/sources \
        tweet-generator/src/index.ts
git commit -m "refactor(tweet-generator): one stream of dispatches, ranked per tier"
```

---

### Task 7: 配额按 tier 排序

**Files:**
- Modify: `tweet-generator/src/select/quota.ts`
- Modify: `tweet-generator/src/store.ts:20-28,87-105`
- Test: `tweet-generator/src/select/quota.test.ts`

**Interfaces:**
- Consumes: `Tier` / `TIER_PRIORITY` / `TIER_OF_KIND`（Task 3）
- Produces: `interface QuotaUsage { used: Record<Tier, number>; total: number }`；`function orderTiers(now: Date, usage: QuotaUsage, config: GeneratorConfig): Tier[]`

**设计说明（实现者必读）：** 逻辑与现有 `orderKinds` 完全同构——按剩余配额比例排序，同比例按优先级破平——只是把维度从 kind 换成 tier。09:00 那条数字摘要的时间锚点保留：摘要在 09:05 落地、隔天就没价值，等不到比例排序轮到它。区别是现在它把 `hot` **整个 tier** 顶到前面。

- [ ] **Step 1: 写失败的测试**

`quota.test.ts:1-27` 现有的导入、`fresh` 与 `usage()` 夹具按 kind 建键，整段替换。`loadConfig` 与 `config` 夹具一并写全，免得执行者替换时弄丢新用例依赖的 `config`：

```ts
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../config.js'
import { orderTiers, type QuotaUsage } from './quota.js'

const config = loadConfig({
  LLM_MODEL: 'pinned',
  TIMEZONE: 'Asia/Shanghai',
} as NodeJS.ProcessEnv)

/** Nothing posted yet today. */
const fresh: QuotaUsage = {
  used: { hot: 0, project: 0, labs: 0 },
  total: 0,
}

function usage(partial: Partial<QuotaUsage['used']>): QuotaUsage {
  const used = { ...fresh.used, ...partial }
  return {
    used,
    total: Object.values(used).reduce((sum, n) => sum + n, 0),
  }
}

/** 08:30 Shanghai — before the digest anchor. */
const beforeAnchor = new Date('2026-08-13T00:30:00.000Z')
/** 10:00 Shanghai — after it. */
const afterAnchor = new Date('2026-08-13T02:00:00.000Z')
```

再把该文件所有 `orderKinds` 的用例改写为：

```ts
describe('orderTiers', () => {
  it('offers nothing once the daily cap is spent', () => {
    expect(orderTiers(afterAnchor, usage({ hot: 5, project: 3, labs: 2 }), config))
      .toEqual([])
  })

  it('drops a tier whose own quota is spent', () => {
    expect(orderTiers(afterAnchor, usage({ hot: 5 }), config))
      .not.toContain('hot')
  })

  it('orders by remaining headroom, not by a fixed priority', () => {
    // hot has burned most of its share; labs has burned none.
    expect(orderTiers(beforeAnchor, usage({ hot: 4, project: 1 }), config)[0])
      .toBe('labs')
  })

  it('puts hot first after the digest anchor, whatever the ratios say', () => {
    // The digest lands at 09:05 and is worthless tomorrow. It cannot wait
    // for the ratio picker to reach its tier in the afternoon.
    expect(orderTiers(afterAnchor, usage({ hot: 4, project: 1 }), config)[0])
      .toBe('hot')
  })

  it('offers every tier when nothing has gone out yet', () => {
    expect(orderTiers(beforeAnchor, fresh, config)).toHaveLength(3)
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `pnpm --filter tweet-generator test -- quota`
Expected: FAIL，`orderTiers` is not exported

- [ ] **Step 3: 实现**

在 `tweet-generator/src/select/quota.ts` 中，把 `QuotaUsage`、`orderKinds` 改成：

```ts
import { minutesIntoDayIn } from 'shared/clock'
import { TIER_PRIORITY, type GeneratorConfig, type Tier } from '../config.js'

export interface QuotaUsage {
  used: Record<Tier, number>
  total: number
}

/** 09:00 local. AgentLens publishes the day's digests just after this. */
export const DIGEST_ANCHOR_MINUTE = 9 * 60

/**
 * The tiers worth trying this cycle, best first.
 *
 * Returning an ordered list rather than one tier is what makes fallback
 * free: the caller walks it and takes the first tier whose pool is not
 * empty, with no separate fallback path to keep in step.
 *
 * The ordering is by remaining quota ratio, ties broken by priority. Strict
 * priority ordering would instead post the whole hot allowance, then the
 * whole project allowance — a monotone, visibly automated timeline.
 */
export function orderTiers(
  now: Date,
  usage: QuotaUsage,
  config: GeneratorConfig,
): Tier[] {
  if (usage.total >= config.dailyCap) return []

  const eligible = TIER_PRIORITY.filter((tier) => {
    const quota = config.quota[tier]
    return quota > 0 && usage.used[tier] < quota
  })

  const ratio = (tier: Tier): number =>
    (config.quota[tier] - usage.used[tier]) / config.quota[tier]

  const ordered = [...eligible].sort((a, b) => {
    const difference = ratio(b) - ratio(a)
    if (difference !== 0) return difference
    return TIER_PRIORITY.indexOf(a) - TIER_PRIORITY.indexOf(b)
  })

  // The one time-based exception. The digest lands at 09:05 local and is
  // worthless by tomorrow, so the tier that carries it cannot wait for the
  // ratio picker to reach it in the afternoon.
  const minute = minutesIntoDayIn(config.timezone, now)
  if (minute >= DIGEST_ANCHOR_MINUTE && ordered.includes('hot')) {
    return ['hot', ...ordered.filter((tier) => tier !== 'hot')]
  }

  return ordered
}
```

- [ ] **Step 4: 让 store 按 tier 统计**

在 `tweet-generator/src/store.ts` 中：

把 import 行的 `SOURCE_PRIORITY, type SourceKind` 换成 `TIER_OF_KIND, type SourceKind, type Tier`（`TIER_PRIORITY` 在新代码里用不上，别引）。

把 `emptyUsage()` 换成：

```ts
function emptyUsage(): QuotaUsage['used'] {
  return { project: 0, hot: 0, labs: 0 }
}
```

把 `usageSince` 的聚合循环换成（查询本身不变，仍按 `tweets.source` 分组——source 存的是 kind，tier 在这里折叠）：

```ts
    const used = emptyUsage()
    let total = 0
    for (const row of rows) {
      total += row.count
      const tier = TIER_OF_KIND[row.source as SourceKind] as Tier | undefined
      // A row whose source predates the tier split, or names the retired
      // youtube kind, still counts toward the daily cap but belongs to no
      // tier's allowance.
      if (tier) used[tier] += row.count
    }
    return { used, total }
```

删除 `projectPostedSince` 方法（`pool.ts` 已不再需要它）。

`tweet-generator/src/store.test.ts` 同步改，否则全量测试红：
- 删除整个 `describe('projectPostedSince', ...)` 用例块——方法已不存在。
- `usageSince` 三个用例里按 kind 的断言改为按 tier：`lab_article` → `labs`、`hn_story` → `hot`、`gh_project` → `project`。即「counts rows per source and in total」里 `expect(after.used.lab_article - before.used.lab_article).toBe(2)` 改为 `expect(after.used.labs - before.used.labs).toBe(2)`，`hn_story` 与 `gh_project` 两行同理；「counts nothing on an empty day」里的 `usage.used.lab_article` 改为 `usage.used.labs`。

- [ ] **Step 5: 改 `index.ts` 的调用处**

vitest 不做类型检查，所以这步不会自己失败——但**不能省**：不改的话 `pnpm --filter tweet-generator build` 会挂在 `orderKinds` 上，Task 8 也拿不到循环里的 `tier`。

在 `tweet-generator/src/index.ts` 中：
- 导入行 `import { orderKinds } from './select/quota.js'` 改为 `import { orderTiers } from './select/quota.js'`。
- `tick()` 里 `const order = orderKinds(now, usage, config)` 改为 `orderTiers`。
- 循环头 `for (const kind of order)` 改为 `for (const tier of order)`。
- 循环体内 `selectCandidate(kind, now, config, deps)` 的第一个参数改为 `tier`；`logger.debug('Pool empty, falling through', { kind })` 里的 `kind` 一并改为 `tier`。

- [ ] **Step 6: 跑全部测试**

Run: `pnpm --filter tweet-generator test`
Expected: PASS（`quota.test.ts` 与 `store.test.ts` 已在本任务改写；`index.ts` 不被任何测试加载，改它只影响 build）。

- [ ] **Step 7: Commit**

```bash
git add tweet-generator/src/select/quota.ts \
        tweet-generator/src/select/quota.test.ts \
        tweet-generator/src/store.ts tweet-generator/src/index.ts
git commit -m "feat(tweet-generator): spend the daily cap per tier"
```

---

### Task 8: 持久化 tier 与 entities

**Files:**
- Modify: `shared/src/schema.ts:163-215`
- Modify: `tweet-generator/src/store.ts`（`EnqueueInput` 与 `enqueue`）
- Modify: `tweet-generator/src/index.ts`（入队处传值）
- Create: `db/migrations/`（由 `pnpm db:generate` 生成）

**Interfaces:**
- Consumes: `Candidate.entities`（Task 5）、`Tier`（Task 3）
- Produces: `tweets.entities: text[]`、`tweets.tier: varchar(10)`；`EnqueueInput.entities?: string[]`、`EnqueueInput.tier?: Tier`

**设计说明（实现者必读）：** `entities` 在本阶段**只写不读**。第二阶段的对比对象发现要问「我们最近写过哪些东西」，那时候需要的是一段已经积累起来的历史；等到那时才开始写，冷启动期就没有任何素材可比。现在开始写，是为了那时能读。

- [ ] **Step 1: 改 schema**

在 `shared/src/schema.ts` 的 `tweets` 表定义中，`archetype` 之后加入：

```ts
    /**
     * Which tier's allowance this post spent. Stored because the quota
     * picker counts a day's usage from these rows after a restart.
     */
    tier: varchar('tier', { length: 10, enum: ['project', 'hot', 'labs'] }),
    /**
     * The searchable names this post is about.
     *
     * Write-only for now. A comparison post has to ask what we have already
     * covered, and that history only exists if it was being recorded before
     * the feature that reads it shipped.
     */
    entities: text('entities').array(),
```

确认 `text` 已在文件顶部的 drizzle 导入中；若无则加入。

- [ ] **Step 2: 生成迁移**

```bash
pnpm db:generate
```

检查 `db/migrations/` 下新生成的 `.sql`：应只包含两条 `ALTER TABLE ... ADD COLUMN`。若它还想改 `archetype` 列，说明 drizzle 为 enum 产出了 check 约束——那是预期内的，一并保留。

- [ ] **Step 3: 应用迁移**

```bash
pnpm db:up
```

Expected: 迁移成功，无报错。

- [ ] **Step 4: 让 store 写入**

在 `tweet-generator/src/store.ts` 中，`EnqueueInput` 加两个可选字段：

```ts
  tier?: Tier
  entities?: string[]
```

`enqueue` 的 `.values({...})` 中加两行：

```ts
        tier: input.tier ?? null,
        entities: input.entities ?? null,
```

- [ ] **Step 5: 让入队处传值**

在 `tweet-generator/src/index.ts` 里找到调用 `store.enqueue(...)` 的地方，把当前循环已经持有的 tier 和 `candidate.entities` 加进去：

```ts
      tier,
      entities: candidate.entities,
```

- [ ] **Step 6: 跑全部测试**

Run: `pnpm --filter tweet-generator test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add shared/src/schema.ts db/migrations tweet-generator/src/store.ts \
        tweet-generator/src/index.ts
git commit -m "feat(tweet-generator): record what each post was about"
```

---

## 端到端验证

八个任务全部完成后：

1. **类型全通**：`pnpm --filter tweet-generator build`，无 `youtube_video` 残留报错。
2. **全部单测**：`pnpm --filter tweet-generator test`。
3. **真跑一轮**：`pnpm --filter tweet-generator start`，跑满一个补货周期。
4. **查库看选出了什么**：

```sql
SELECT source, tier, archetype, entities, left(content, 80)
FROM tweets ORDER BY created_at DESC LIMIT 10;
```

判定标准：`entities` 非空且含真实模型/厂商名；`tier` 有值；**没有**关于全息图、JPEG 解码、Amiga 这类零实体题材的推。

5. **发帖侧未破坏**：`x-poster` 保持 `X_DRY_RUN=true` 跑一遍，确认带图推文的附件流程仍正常（`d74388a`、`21ebd91` 两次修的就是这里）。

## 本阶段明确不做

- 不动 `llm/` 下任何文件：`versus` 形制、素材决定形制、分层调性属于第二阶段。
- 不动 `image/` 下任何文件：LLM 产 HTML 与渲染校验属于第三阶段。
- `AGENTLENS_API_KEY` 只进配置，不发起任何 `/query` 请求。
- `entities` 只写不读。
