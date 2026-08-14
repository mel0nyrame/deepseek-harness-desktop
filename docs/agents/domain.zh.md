# 领域文档

[English](domain.md) | 中文

工程 skill 在探索或修改代码时使用本仓库的领域文档。

## 探索前

1. 如果根目录存在 `CONTEXT-MAP.md`，先读取它。
2. 按照该地图读取与请求范围相关的各个 `CONTEXT.md`。
3. 读取 `docs/adr/` 下相关的系统级 ADR。
4. 在 `CONTEXT-MAP.md` 声明的位置读取相关的上下文专用 ADR。

文件或目录不存在时直接继续。`domain-modeling` skill 会在术语或持久决策得到确定时按需创建领域文件。

## 多上下文布局

```text
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                         # System-wide decisions
└── packages/
    └── <context>/
        ├── CONTEXT.md               # Context glossary
        └── docs/
            └── adr/                 # Context-specific decisions
```

`CONTEXT-MAP.md` 是上下文位置的唯一真源。一个上下文可以对应一个包组、单个包或其他内聚的产品领域；不要仅根据目录深度推断上下文的归属。

仅在有内容时创建文件和目录。`CONTEXT.md` 是领域术语及其关系的词汇表，不是实现规格。仅当一项决策难以逆转、缺少理由时令人意外，并且经过实质性取舍后才记录 ADR。

## 使用规范术语

在 issue 标题、规格说明、假设、重构提案和测试名称中，使用相关 `CONTEXT.md` 定义的术语。避免使用词汇表明确区分或拒绝的同义词。

需要的概念不存在时，先重新确认仓库是否已经使用其他术语。如果确实存在缺口，通过 `domain-modeling` 解决并更新相应词汇表。

## 指出 ADR 冲突

输出与适用的 ADR 冲突时，明确指出该冲突。应当写出 ADR 名称并解释重新讨论该决策的理由，而不是静默覆盖。
