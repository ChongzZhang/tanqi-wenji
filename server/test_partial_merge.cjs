#!/usr/bin/env node
'use strict';
/** 模拟客户端 partial motion 合并逻辑，验证首包是否丢棋子 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, '..', '..', '.cursor', 'debug-7e2651.log');

function log(hypothesisId, message, data) {
  const line = JSON.stringify({
    sessionId: '7e2651',
    hypothesisId,
    location: 'test_partial_merge.cjs',
    message,
    data,
    timestamp: Date.now(),
    runId: 'sim',
  });
  fs.appendFileSync(LOG, line + '\n');
}

function mergeMotionDelta(partial, motionPieceState) {
  if (!partial || !partial.length) return motionPieceState || [];
  if (!motionPieceState || !motionPieceState.length) {
    return partial.map((r) => r.slice());
  }
  const map = {};
  for (const row of motionPieceState) map[`${row[0]}:${row[1]}`] = row;
  for (const row of partial) map[`${row[0]}:${row[1]}`] = row;
  return Object.values(map).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// 12 枚棋完整状态
const full = [];
for (let i = 0; i < 6; i++) full.push([0, i, 100 + i, 400, 0, 0, 0]);
for (let i = 0; i < 6; i++) full.push([1, i, 100 + i, 100, 0, 0, 0]);

// 行棋开始：clearMotionBuffer 清空 motionPieceState
let motionPieceState = null;
log('H1', 'after clearMotionBuffer', { pieceStateCount: 0 });

// 首包 partial 仅 2 枚运动棋（模拟 exportMotion delta）
const partial = [
  [0, 0, 105, 401, 0.5, 0.1, 0],
  [0, 1, 102, 399, 0.2, 0.05, 0],
];
const merged = mergeMotionDelta(partial, motionPieceState);
log('H1', 'after first partial merge without seed', {
  partialCount: partial.length,
  mergedCount: merged.length,
  bug: merged.length < 12,
});

// 正确做法：从 physics 种子后再 merge
motionPieceState = full.map((r) => r.slice());
const mergedFixed = mergeMotionDelta(partial, motionPieceState);
log('H1', 'after partial merge with seed', {
  mergedCount: mergedFixed.length,
  ok: mergedFixed.length === 12,
});

console.log('partial merge sim: without seed', merged.length, 'with seed', mergedFixed.length);
