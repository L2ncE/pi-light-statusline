# pi-light-statusline

<div align="center">

**给 [pi](https://pi.dev) 的轻量彩色状态栏 —— 官方布局、你的配色、实时 tok/s 与缓存命中率，外加可选的 AI 装逼加载文案。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)

[English](README.md)

</div>

## 这是什么

pi 内置 footer 信息够用但没有颜色，也看不到生成速度；
[pi-powerline-footer](https://github.com/nicobailon/pi-powerline-footer) 功能强大但太重——
20 多个 segment、preset、主题、欢迎页一堆东西。

`pi-light-statusline` 取中间路线：保留内置 footer 的干净布局
（左统计、右侧对齐的模型名 + thinking 级别），再加上：

- 每格的**配色与 Nerd Font 图标**（ASCII 终端自动降级为纯文本）
- **`tok/s`** —— 当前 assistant 消息的实时输出速度，结束后定格为最终值
- **缓存命中率** —— 最近一轮 prompt cache 的命中情况
- **AI working vibes**（可选，默认关闭）—— 用你指定的模型生成主题化加载文案

```
 gists.lanlance.cn   main   53k/1.0M (5.3%)
 47 tok/s  78% Cache                               glm-5.3  󰠚 xhigh
```

其他扩展的 footer 状态（比如 subagent 工具的）不受影响：和内置 footer 一样，
它们渲染在状态栏下方的独立一行。

## 安装

```bash
pi install npm:pi-light-statusline
```

或从 git：

```bash
pi install git:https://github.com/L2ncE/pi-light-statusline
```

或先试用不安装：

```bash
pi -e /path/to/pi-light-statusline
```

零配置即可用（有默认布局）。重启 pi 或 `/reload` 生效。

## Segments

| id | 默认位置 | 图标 | 内容 |
|---|---|---|---|
| `model` | 右 |  | 当前模型 id，小写 |
| `thinking` | 右 | 󰠚 | thinking 级别；`high`/`xhigh`/`max` 用彩虹色 |
| `path` | 左 |  | 当前目录 basename |
| `git` | 左 |  | 当前分支 |
| `context` | 左 |  | 上下文用量 `53k/1.0M (5.3%)`；> 70% 警告色，> 90% 错误色 |
| `tps` | 左 |  | `47 tok/s` 流式实时，结束定格；首秒内隐藏 |
| `cache_rate` | 左 |  | 最近一轮缓存命中率 `78%` |

无内容的 segment（没有 git 分支、还没有 token）自动隐藏。

## 配置

所有配置集中在 `~/.pi/agent/settings.json` 的一个 `lightStatusline` 块里。
数组决定 segment 顺序，不写就用默认。

```jsonc
{
  "lightStatusline": {
    "line1": ["path", "git", "context"],
    "line2": ["tps", "cache_rate"],
    "right": ["model", "thinking"],
    "colors": {
      "model": "#0ABAB5",
      "path": "#e06c75",
      "git": "#1a7f37",
      "context": "#98c379"
    },
    "icons": { "tps": "" },
    "vibes": { "enabled": false }
  }
}
```

- **`line1` / `line2` / `right`** —— 每行的 segment id 顺序：第一行（path/git/context）、第二行统计（tps/cache_rate）、右侧对齐（model/thinking）。旧版单一 `left` 数组会自动拆分。未知 id 忽略。
- **`colors`** —— 每格颜色：pi 主题色名（`accent`、`warning`、`dim` 等）或 `#RRGGBB`。默认用低调的主题色；`context` 在 70%/90% 阈值时始终升级为 `warning`/`error`。
- **`icons`** —— 每格图标覆盖。自动检测终端（`LIGHT_STATUSLINE_NERD_FONTS=1` 强制开，`=0` 强制关）。

## Vibes（装逼加载文案）

pi 工作时，把默认 loader 换成按当前任务实时生成、带人设的文案，比如：

```
⠦ 凝神聚念，洞彻微观玄机...
```

```jsonc
{
  "lightStatusline": {
    "vibes": {
      "enabled": true,
      "theme": "神龙尊者",                    // 你的人设
      "model": "mccodex/LongCat-Flash-Chat", // 任意已配置的 pi 模型
      "fallback": "龙威震世",                 // 失败/超时时显示
      "prompt": "…",                          // 可选自定义模板
      "maxLength": 18,
      "timeoutMs": 3000,
      "color": "rainbow"                      // 可选：色名、#hex 或 "rainbow"
    }
  }
}
```

每次 agent 启动生成一次（不做工具调用中途的反复刷新）。prompt 模板支持
`{theme}`、`{task}`（当前提示词）、`{exclude}`（近期文案，防重复）和
`{maxLength}`。超时或失败时回退 fallback——vibes 永远不会搞坏你的会话。

## License

[MIT](LICENSE) © L2ncE
