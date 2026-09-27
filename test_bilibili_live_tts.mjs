import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./bilibili-live-tts.user.js', import.meta.url), 'utf8');
assert.match(source, /@name\s+B站直播 TTS 播报/);
assert.match(source, /INTERACT_WORD/);
assert.match(source, /SEND_GIFT/);
assert.match(source, /SUPER_CHAT_MESSAGE/);
assert.match(source, /DANMU_MSG/);
assert.match(source, /GM_registerMenuCommand/);
assert.match(source, /GM_xmlhttpRequest/);
assert.match(source, /SpeechSynthesisUtterance/);
assert.match(source, /audio\/speech/);
assert.match(source, /@connect\s+token-plan-cn\.xiaomimimo\.com/);
assert.match(source, /parseFrames/);
assert.match(source, /choices\?\.\[0\]\?\.message\?\.audio\?\.data/);
assert.match(source, /audio = \{ format: 'wav' \}/);
assert.match(source, /mimo-text/);

// 协议解析：必须走 Brotli(v3) 解码，且不得篡改鉴权 protover（篡改会让页面聊天冻结）
assert.match(source, /version === 3/);
assert.match(source, /PAGE_WINDOW\.BrotliDecode|window\.BrotliDecode/);
assert.doesNotMatch(source, /forceZlibAuth/, '不能篡改鉴权 protover');
assert.doesNotMatch(source, /auth\.protover\s*=\s*2/, '不能篡改鉴权 protover');
// 子类安全：Reflect.construct（new.target），不要直接 new Native(...)
assert.match(source, /Reflect\.construct\(Native, args, new\.target/);
assert.doesNotMatch(source, /const ws = new Native\(/);

// 语速与并发预取（0.2.6）
assert.match(source, /prefetch\(\)/, '云端队列需并发预取');
assert.match(source, /this\.inflight/, '预取需限制并发数');
assert.match(source, /speed: clamp\(settings\.rate/, 'OpenAI 模式需传 speed');
assert.match(source, /语速.*倍/, 'MiMo 模式需用 style 控制语速');
assert.match(source, /authHeaders\(\)/, '认证头集中构造');

// 弹幕过滤：屏蔽抽奖弹幕（0.2.7）
assert.match(source, /blockLottery/, '需有屏蔽抽奖弹幕开关');
assert.match(source, /isLotteryDanmu\(/, '需有抽奖弹幕识别函数');
assert.match(source, /lotteryKeywords/, '需可自定义抽奖关键词');

// RPM 限流与面板日志（0.2.12）
assert.match(source, /rpm: 0/, 'RPM 默认 0=不限制');
assert.match(source, /throttle\(\)/, '需有 RPM 节流');
assert.match(source, /data-key="rpm"/, '设置页需有 RPM 字段');
assert.match(source, /id="bltts-log"/, '设置页需有调试日志区');
assert.match(source, /renderLog\(\)/, '日志需渲染到面板');
// 调试钩子只暴露 openSettings，绝不暴露 settings/apiKey
assert.match(source, /__blttsOpenSettings = openSettings/, '需有打开面板的调试钩子');
assert.doesNotMatch(source, /__bltts[^=\n]*=\s*settings/, '不得把 settings 挂到页面全局');

// 调试日志收敛（0.2.8）：常规信息日志必须走 log()（受 debug 开关控制）
assert.match(source, /log\('收到直播包', commands\)/, '收到直播包需走 debug 开关');
assert.doesNotMatch(source, /console\.info\(\'\[B站TTS\]/, '不允许绕过 debug 开关的 info 日志');

// 调试日志需含具体 TTS 文本（0.2.9）
assert.match(source, /log\('入队TTS文本', sentence\)/, '入队日志需带文本');
assert.match(source, /log\('请求TTS文本', sentence\)/, '请求日志需带文本');
assert.match(source, /log\('开始播报TTS文本', sentence/, '播报日志需带文本');

// 预取音频不得被丢弃（0.2.10 回归）：fetch 后不允许再按 queue.includes 否决 blob
const prefetchBlock = source.slice(source.indexOf('prefetch()'), source.indexOf('isCloud()'));
assert.ok(!prefetchBlock.includes('queue.includes'), 'prefetch 不能丢弃已取回的音频');

assert.match(source, /@license\s+MIT/, '发布需带 @license MIT');

console.log('userscript contract checks passed');
