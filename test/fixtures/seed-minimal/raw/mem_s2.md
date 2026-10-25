---
id: mem_s3
type: raw
title: 调优顺序扫描（原文）
time: 2026-01-03T09:00:00.000Z
status: active
session_id: sess-b
confidence: 0.8
tags: database, performance
entities: PostgreSQL
sources: sess-b:session
---

# 调优顺序扫描（原文）

EXPLAIN ANALYZE 输出：Seq Scan on orders (cost=0.00..43120.00 rows=200000)。

调整前 812ms，加 btree 索引后 12ms。
