// ==UserScript==
// @name         B站直播 TTS 播报
// @namespace    heixiu.bilibili.live.tts
// @version      0.2.15
// @description  播报B站直播间的进房、关注、点赞、送礼、弹幕和醒目留言，并提供可配置的TTS设置页 · https://github.com/AdoreJc/blive-tts
// @author       AdoreJc
// @license      MIT
// @match        https://live.bilibili.com/*
// @match        https://www.bilibili.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        GM_notification
// @connect      token-plan-cn.xiaomimimo.com
// @connect      api.openai.com
// @connect      *
// ==/UserScript==

(() => {
  'use strict';

  const KEY = 'bltts-settings-v1';
  const SOURCE = 'heixiu-bili-live-tts';
  const DEFAULTS = {
    enabled: true,
    mode: 'browser', // browser | openai | mimo
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    style: '自然、简洁、像直播间助手一样播报。',
    language: 'zh-CN',
    rate: 1,
    pitch: 1,
    volume: 1,
    cooldownMs: 1200,
    rpm: 0,
    maxQueue: 8,
    debug: false,
    events: { enter: true, follow: true, like: false, gift: true, danmu: true, superchat: true },
    blockLottery: true,
    lotteryKeywords: '抽奖,天选时刻,天选,口令,上车,开奖',
    templates: {
      enter: '{user} 进入了直播间',
      follow: '{user} 关注了主播',
      like: '{user} 点了赞',
      gift: '{user} 送出了 {count} 个 {gift}',
      danmu: '{user} 说：{message}',
      superchat: '{user} 发送醒目留言：{message}，金额 {price} 元'
    }
  };

  const clone = value => JSON.parse(JSON.stringify(value));
  const merge = (base, extra) => {
    const out = { ...base, ...extra };
    for (const key of Object.keys(base)) {
      if (base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
        out[key] = { ...base[key], ...(extra?.[key] || {}) };
      }
    }
    return out;
  };
  const loadSettings = () => merge(clone(DEFAULTS), GM_getValue(KEY, {}));
  let settings = loadSettings();
  const saveSettings = next => { settings = merge(clone(DEFAULTS), next); GM_setValue(KEY, settings); return settings; };
  const logLines = [];
  const serialize = value => {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const renderLog = () => {
    const el = document.getElementById('bltts-log');
    if (!el) return;
    el.textContent = logLines.join('\n');
    el.scrollTop = el.scrollHeight;
  };
  const log = (...args) => {
    if (!settings.debug) return;
    console.debug('[B站TTS]', ...args);
    logLines.push(`${new Date().toTimeString().slice(0, 8)} ${args.map(serialize).join(' ')}`);
    if (logLines.length > 100) logLines.shift();
    renderLog();
  };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const format = (template, data) => String(template || '').replace(/\{(\w+)\}/g, (_, key) => text(data[key] ?? ''));
  const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || min));
  // 认证头：集中构造，避免模板串内联被编辑工具误伤
  function authHeaders() {
    if (!settings.apiKey) return {};
    const value = 'Bearer' + ' ' + settings.apiKey;
    return { Authorization: value };
  }

  function findValue(obj, keys, fallback = '') {
    if (!obj || typeof obj !== 'object') return fallback;
    for (const key of keys) if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
    return fallback;
  }
  function walk(obj, callback, seen = new Set()) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj); callback(obj);
    for (const value of Object.values(obj)) if (value && typeof value === 'object') walk(value, callback, seen);
  }

  async function decodePacket(input) {
    if (typeof input === 'string') {
      try { return JSON.parse(input); } catch { return null; }
    }
    if (input && typeof input.arrayBuffer === 'function') input = await input.arrayBuffer();
    if (ArrayBuffer.isView(input)) input = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
    if (Object.prototype.toString.call(input) !== '[object ArrayBuffer]') return null;
    const decoder = new TextDecoder();

    async function parseFrames(bytes) {
      const messages = [];
      let offset = 0;
      while (offset + 16 <= bytes.length) {
        const view = new DataView(bytes.buffer, bytes.byteOffset + offset);
        const packetLen = view.getUint32(0);
        const headerLen = view.getUint16(4);
        const version = view.getUint16(6);
        const operation = view.getUint32(8);
        if (packetLen < headerLen || headerLen < 16 || offset + packetLen > bytes.length) break;
        const body = bytes.slice(offset + headerLen, offset + packetLen);
        offset += packetLen;
        if (operation === 3) continue;
        if (operation === 5 && version === 2) {
          try {
            const inflated = new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
            messages.push(...await parseFrames(inflated));
          } catch (error) { console.warn('[B站TTS] zlib直播包解压失败', error); }
          continue;
        }
        if (operation === 5 && version === 3) {
          // B站默认 protover=3（Brotli）。页面自带 window.BrotliDecode（room-player 提供），复用它，
          // 不要改鉴权为 zlib——页面播放器没有 zlib 分支，改了会冻结页面聊天。
          try {
            const decode = typeof PAGE_WINDOW !== 'undefined' && typeof PAGE_WINDOW.BrotliDecode === 'function' ? PAGE_WINDOW.BrotliDecode : null;
            if (!decode) { console.warn('[B站TTS] 页面Brotli解码器未就绪，无法解析Brotli直播包'); continue; }
            const raw = decode(body);
            const inner = raw instanceof ArrayBuffer ? new Uint8Array(raw) : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new Uint8Array(raw);
            const sub = await parseFrames(inner);
            log('v3包解码', { rawType: raw ? (raw.constructor ? raw.constructor.name : typeof raw) : String(raw), innerLen: inner.length, subCount: sub.length });
            messages.push(...sub);
          } catch (error) { console.warn('[B站TTS] Brotli直播包解压失败', error); }
          continue;
        }
        if (operation === 5 || operation === 8) {
          try { messages.push(JSON.parse(decoder.decode(body))); }
          catch (error) { log('JSON直播包解析失败', { version, operation, bytes: body.length, error }); }
        }
      }
      if (!messages.length && offset === 0) {
        try { messages.push(JSON.parse(decoder.decode(bytes))); } catch { /* not a plain JSON payload */ }
      }
      return messages;
    }

    const messages = await parseFrames(new Uint8Array(input));
    return messages.length ? messages : null;
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // Minimal protobuf decoder: returns { fieldNumber: [values...] }.
  function decodeProto(bytes) {
    const out = {};
    let i = 0;
    const readVarint = () => {
      let value = 0, shift = 0;
      while (i < bytes.length) {
        const byte = bytes[i++];
        value |= (byte & 0x7f) << shift;
        if (!(byte & 0x80)) return value >>> 0;
        shift += 7;
      }
      return value >>> 0;
    };
    while (i < bytes.length) {
      const key = readVarint();
      const field = key >> 3;
      const wire = key & 7;
      if (wire === 0) (out[field] ||= []).push(readVarint());
      else if (wire === 2) {
        const len = readVarint();
        const slice = bytes.slice(i, i + len);
        i += len;
        (out[field] ||= []).push(slice);
      } else if (wire === 5) { (out[field] ||= []).push(bytes.slice(i, i + 4)); i += 4; }
      else if (wire === 1) { (out[field] ||= []).push(bytes.slice(i, i + 8)); i += 8; }
      else break;
    }
    return out;
  }
  const protoString = value => {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      try { return text(new TextDecoder().decode(value)); } catch { return ''; }
    }
    return text(value ?? '');
  };

  function normalizeInteractV2(node) {
    // INTERACT_WORD_V2 pb fields: 1=uid 2=uname 5=msg_type 6=roomid 7=timestamp
    let fields;
    try { fields = decodeProto(base64ToBytes(node.data?.pb || '')); } catch { return null; }
    const msgType = Number(fields[5]?.[0] || 1);
    return {
      type: msgType === 2 || msgType === 3 ? 'follow' : 'enter',
      user: protoString(fields[2]?.[0]) || '有人',
      message: '', gift: '', count: 0, price: 0
    };
  }

  function normalizeGiftV2(node) {
    // SEND_GIFT_V2 pb（来自 blivedm models/pb.py SendGiftBroadcast）:
    // 1=uid 2=uname 10=[gift_item]（gift_item: 1=gift_id 2=gift_name 3=num 5=price 7=total_coin 8=coin_type）
    let root;
    try { root = decodeProto(base64ToBytes(node.data?.pb || node.pb || '')); } catch { return null; }
    const user = protoString(root[2]?.[0]);
    if (!user) return null;
    const list = Array.isArray(root[10]) ? root[10] : [];
    const events = [];
    for (const raw of list) {
      let g;
      try { g = decodeProto(raw); } catch { continue; }
      const giftName = protoString(g[2]?.[0]);
      if (!giftName) continue;
      // price=单价，total_coin=总瓜子数；播报金额优先取 total_coin
      const price = Number(g[7]?.[0] || g[5]?.[0] || 0);
      events.push({ type: 'gift', user, message: '', gift: giftName, count: Number(g[3]?.[0] || 1), price });
    }
    return events;
  }

  function normalizeEvent(payload) {
    const events = [];
    const candidates = Array.isArray(payload) ? payload : [payload];
    for (const root of candidates) walk(root, node => {
      if (!node?.cmd) return;
      const cmd = text(node.cmd).split(':')[0];
      const data = node.data?.data && typeof node.data.data === 'object' ? node.data.data : (node.data || node);
      if (cmd === 'INTERACT_WORD' || cmd === 'WELCOME' || cmd === 'WELCOME_GUARD') {
        const msgType = Number(data.msg_type ?? data.msgType ?? 1);
        events.push({
          type: msgType === 2 || msgType === 3 ? 'follow' : 'enter',
          user: text(data.uname || data.username || data.name || '有人'), message: '', gift: '', count: 0, price: 0
        });
      } else if (cmd === 'LIKE_INFO_V3_CLICK' || cmd === 'LIKE_CLICK') {
        events.push({ type: 'like', user: text(data.uname || data.username || '有人'), message: '', gift: '', count: 0, price: 0 });
      } else if (cmd === 'SEND_GIFT' || cmd === 'COMBO_SEND') {
        events.push({
          type: 'gift', user: text(data.uname || data.username || '有人'), message: '',
          gift: text(data.giftName || data.gift_name || data.giftname || '礼物'),
          count: Number(data.num || data.gift_num || data.total_num || data.combo_num || 1), price: Number(data.price || data.total_coin || 0)
        });
      } else if (cmd === 'DANMU_MSG') {
        const info = Array.isArray(node.info) ? node.info : [];
        const sender = Array.isArray(info[2]) ? info[2] : [];
        const message = text(info[1] || data.msg || data.message || '');
        if (message) events.push({ type: 'danmu', user: text(sender[1] || data.uname || '有人'), message, gift: '', count: 0, price: 0 });
      } else if (cmd === 'SUPER_CHAT_MESSAGE' || cmd === 'SUPER_CHAT_MESSAGE_JPN') {
        events.push({
          type: 'superchat', user: text(data.user_info?.uname || data.uname || '有人'),
          message: text(data.message || ''), gift: '', count: 0, price: Number(data.price || 0)
        });
      } else if (cmd === 'INTERACT_WORD_V2') {
        const event = normalizeInteractV2(node);
        if (event) events.push(event);
        else console.warn('[B站TTS] INTERACT_WORD_V2 protobuf 解码失败', node);
      } else if (cmd === 'SEND_GIFT_V2') {
        const gifts = normalizeGiftV2(node);
        if (gifts && gifts.length) events.push(...gifts);
        else console.warn('[B站TTS] SEND_GIFT_V2 protobuf 解码失败', node);
      } else if (cmd.endsWith('_V2')) {
        // RANK_CHANGED_V2 等是排行榜/统计类包，不是互动消息，静默忽略
        if (cmd === 'RANK_CHANGED_V2' || cmd === 'VOICE_JOIN_SWITCH_V2') log('忽略非互动V2包', cmd);
        else console.warn('[B站TTS] 收到暂未支持的Protobuf互动包', cmd, node);
      }
    });
    return events;
  }

  class Speaker {
    constructor() { this.queue = []; this.busy = false; this.lastAt = 0; this.audio = null; this.pending = new Map(); this.inflight = 0; this.reqTimes = []; this.throttleWait = 0; this.throttleChain = Promise.resolve(); }
    // 请求速率限制：每分钟最多 rpm 次 TTS 请求；0=不限制。返回还需等待的毫秒数
    rpmWait() {
      const rpm = Math.floor(Number(settings.rpm) || 0);
      if (rpm <= 0) return 0;
      const now = Date.now();
      this.reqTimes = this.reqTimes.filter(t => now - t < 60000);
      if (this.reqTimes.length < rpm) return 0;
      return Math.max(0, 60000 - (now - this.reqTimes[0])) + 100;
    }
    throttle() {
      // 串行占位：并发预取的多个请求排队领号，避免同时通过造成超限
      const run = async () => {
        let wait = this.rpmWait();
        while (wait > 0) {
          this.throttleWait = wait;
          log('RPM限流等待', `${Math.round(wait / 1000)}s`, `窗口 ${this.reqTimes.length}/${Math.floor(Number(settings.rpm) || 0)}`);
          await new Promise(resolve => setTimeout(resolve, wait));
          this.throttleWait = 0;
          wait = this.rpmWait();
        }
        this.reqTimes.push(Date.now());
      };
      const next = this.throttleChain.then(run, run);
      this.throttleChain = next.catch(() => {});
      return next;
    }
    enqueue(sentence) {
      if (!settings.enabled || !text(sentence)) return;
      sentence = text(sentence);
      if (this.queue.length >= clamp(settings.maxQueue, 1, 50)) this.pending.delete(this.queue.shift()); // 溢出丢弃，不播它的预取结果
      this.queue.push(sentence);
      log('入队TTS文本', sentence);
      this.prefetch();
      this.pump();
    }
    // 并发预取：播放当前句时，同时请求队列里后续句子的语音，播完无缝接下一句
    prefetch() {
      const limit = 3;
      for (const s of this.queue) {
        if (this.inflight >= limit) break;
        if (this.pending.has(s)) continue;
        const promise = this.fetch(s)
          .catch(error => { console.warn('[B站TTS] 预取语音失败', error); return null; })
          .finally(() => { this.inflight--; });
        this.inflight++;
        this.pending.set(s, promise);
      }
    }
    isCloud() { return settings.mode === 'openai' || settings.mode === 'mimo-text' || settings.mode === 'mimo'; }
    async fetch(sentence) {
      await this.throttle();
      log('请求TTS文本', sentence);
      if (settings.mode === 'openai') return this.openAiBlob(sentence);
      if (settings.mode === 'mimo-text' || settings.mode === 'mimo') return this.mimoBlob(sentence);
      return Promise.resolve(null); // 浏览器语音无法预取
    }
    async pump() {
      if (this.busy || !this.queue.length) return;
      this.busy = true;
      const wait = Math.max(0, Number(settings.cooldownMs) - (Date.now() - this.lastAt));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      const sentence = this.queue.shift();
      log('开始播报TTS文本', sentence, `(${settings.mode})`);
      try {
        const pre = this.pending.get(sentence);
        let blob = null;
        if (pre) { this.pending.delete(sentence); blob = await pre; }
        else blob = await this.fetch(sentence);
        if (blob) { log('播放预取音频', sentence, `${Math.round(blob.size / 1024)}KB`); await this.playBlob(blob); }
        else if (!this.isCloud()) await this.browserTts(sentence); // 云端模式下 null=已失败，跳过即可
      } catch (error) { console.warn('[B站TTS] 播报失败', sentence, error); }
      this.lastAt = Date.now(); this.busy = false;
      this.prefetch();
      this.pump();
    }
    browserTts(sentence) {
      return new Promise((resolve, reject) => {
        if (!('speechSynthesis' in window)) return reject(new Error('浏览器不支持 SpeechSynthesis'));
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(sentence);
        utterance.lang = settings.language || 'zh-CN';
        utterance.rate = clamp(settings.rate, 0.5, 2);
        utterance.pitch = clamp(settings.pitch, 0, 2);
        utterance.volume = clamp(settings.volume, 0, 1);
        const voices = window.speechSynthesis.getVoices();
        const preferred = voices.find(v => v.lang === utterance.lang) || voices.find(v => v.lang.startsWith('zh'));
        if (preferred) utterance.voice = preferred;
        utterance.onend = resolve; utterance.onerror = reject;
        window.speechSynthesis.speak(utterance);
      });
    }
    playBlob(blob) {
      return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(blob);
        const audio = this.audio = new Audio(objectUrl);
        audio.volume = clamp(settings.volume, 0, 1);
        let settled = false;
        const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(watchdog); URL.revokeObjectURL(objectUrl); fn(arg); };
        // 看门狗：Audio 既不结束也不报错时（约30s，覆盖最长语句×2倍速上限）不再卡死队列
        const watchdog = setTimeout(() => {
          log('播放超时，跳过该条', `${Math.round(blob.size / 1024)}KB`);
          try { audio.pause(); } catch {}
          done(resolve, undefined);
        }, 30000);
        audio.onended = () => { log('播放完成'); done(resolve, undefined); };
        audio.onerror = () => done(reject, new Error(`浏览器无法解码或播放返回的音频（code=${audio.error?.code ?? '?'}）`));
        audio.play().then(() => log('开始播放音频', `${Math.round(blob.size / 1024)}KB`, `vol=${audio.volume}`), error => done(reject, new Error(`浏览器阻止音频播放：${error.message}`)));
      });
    }
    openAiBlob(sentence) {
      const url = `${settings.baseUrl.replace(/\/$/, '')}/audio/speech`;
      return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'POST', url, headers: { 'Content-Type': 'application/json', ...authHeaders() }, data: JSON.stringify({ model: settings.model, input: sentence, voice: settings.voice, instructions: settings.style, speed: clamp(settings.rate, 0.5, 2), response_format: 'mp3' }), responseType: 'blob', onload: response => {
        if (response.status < 200 || response.status >= 300) return reject(new Error(`TTS HTTP ${response.status}: ${String(response.responseText || '').slice(0, 300)}`));
        resolve(response.response);
      }, onerror: () => reject(new Error('TTS 网络请求失败')) }));
    }
    mimoBlob(sentence) {
      const url = `${settings.baseUrl.replace(/\/$/, '')}/chat/completions`;
      const voiceDesign = String(settings.model).includes('voicedesign');
      // 语速通过 <style> 自然语言控制（MiMo 无独立 speed 参数），1.0 时不注入
      const rate = clamp(settings.rate, 0.5, 2);
      const speedHint = rate === 1 ? '' : `语速${rate > 1 ? '加快' : '放慢'}到约${rate}倍。`;
      const style = [speedHint, settings.style || ''].filter(Boolean).join('');
      const content = style ? `<style>${style}</style>${sentence}` : sentence;
      const messages = [];
      if (style) messages.push({ role: 'user', content: style });
      messages.push({ role: 'assistant', content });
      const audio = { format: 'wav' };
      if (!voiceDesign && settings.voice) audio.voice = settings.voice;
      return new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: 'POST', url,
        headers: { 'Content-Type': 'application/json', ...authHeaders(), 'api-key': settings.apiKey },
        data: JSON.stringify({ model: settings.model, messages, audio }),
        onload: response => {
          let json;
          try { json = JSON.parse(response.responseText); } catch { return reject(new Error(`MiMo TTS 返回的不是JSON（HTTP ${response.status}）：${String(response.responseText).slice(0, 300)}`)); }
          if (response.status < 200 || response.status >= 300) return reject(new Error(`MiMo TTS HTTP ${response.status}: ${json.error?.message || JSON.stringify(json).slice(0, 300)}`));
          const base64 = json.choices?.[0]?.message?.audio?.data;
          if (!base64) return reject(new Error(`MiMo TTS 响应中没有 choices[0].message.audio.data：${JSON.stringify(json).slice(0, 500)}`));
          try {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            resolve(new Blob([bytes], { type: 'audio/wav' }));
          } catch (error) { reject(new Error(`MiMo TTS 音频解码失败：${error.message}`)); }
        },
        onerror: response => reject(new Error(`MiMo TTS 网络请求失败${response?.error ? `：${response.error}` : ''}`))
      }));
    }
  }
  const speaker = new Speaker();

  // B站协议没有给抽奖弹幕打标记，只能按关键词识别（关键词可在设置页自定义）
  function isLotteryDanmu(message) {
    const keywords = String(settings.lotteryKeywords || '').split(/[,，、\s]+/).filter(Boolean);
    return keywords.some(word => String(message || '').includes(word));
  }

  function announce(event) {
    if (!settings.events[event.type]) return;
    if (event.type === 'danmu' && settings.blockLottery && isLotteryDanmu(event.message)) {
      log('屏蔽抽奖弹幕', event);
      return;
    }
    const sentence = format(settings.templates[event.type], event);
    log(event.type, event, sentence);
    speaker.enqueue(sentence);
  }

  function installPageHook() {
    const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const Native = page.WebSocket;
    if (!Native || Native.__bltts) { console.warn('[B站TTS] WebSocket hook 未安装：已有hook或WebSocket不可用'); return; }
    const onMessage = event => {
      if (typeof event.data === 'string' || event.data?.arrayBuffer || Object.prototype.toString.call(event.data) === '[object ArrayBuffer]') {
        PAGE_WINDOW.postMessage({ source: SOURCE, payload: event.data }, '*');
      }
    };
    function Wrapped(...args) {
      const ws = Reflect.construct(Native, args, new.target || Wrapped);
      ws.addEventListener('message', onMessage);
      log('捕获 WebSocket', args[0]);
      return ws;
    }
    Wrapped.prototype = Native.prototype;
    Object.setPrototypeOf(Wrapped, Native);
    Wrapped.__bltts = true;
    page.WebSocket = Wrapped;
    PAGE_WINDOW.postMessage({ source: SOURCE, type: 'hook-ready' }, '*');
    log('WebSocket hook 已安装');
  }
  const PAGE_WINDOW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  window.addEventListener('message', async event => {
    if (event.source !== PAGE_WINDOW || event.data?.source !== SOURCE) return;
    if (event.data.type === 'hook-ready') { log('已开始监听直播 WebSocket'); return; }
    const decoded = await decodePacket(event.data.payload);
    if (decoded === null) { log('忽略非JSON控制包/心跳包'); return; }
    const commands = decoded.filter(item => item?.cmd);
    if (!commands.length) return;
    log('收到直播包', commands);
    for (const item of commands) for (const normalized of normalizeEvent(item)) announce(normalized);
  });
  installPageHook();

  function injectStyles() {
    if (document.getElementById('bltts-style')) return;
    const style = document.createElement('style'); style.id = 'bltts-style'; style.textContent = `#bltts-panel{position:fixed;z-index:2147483647;inset:5vh 5vw;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:16px;box-shadow:0 24px 80px #000b;font:14px/1.45 system-ui,sans-serif;display:none;overflow:auto}#bltts-panel.open{display:block}#bltts-panel .bltts-head{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;border-bottom:1px solid #374151;position:sticky;top:0;background:#111827}#bltts-panel h2{margin:0;font-size:20px}#bltts-panel .bltts-body{padding:18px 22px;display:grid;grid-template-columns:repeat(2,minmax(260px,1fr));gap:14px 22px}#bltts-panel label{display:flex;flex-direction:column;gap:6px;color:#9ca3af}#bltts-panel input,#bltts-panel select,#bltts-panel textarea{box-sizing:border-box;width:100%;padding:9px 10px;border:1px solid #4b5563;border-radius:8px;background:#1f2937;color:#f9fafb}#bltts-panel textarea{min-height:58px;resize:vertical}#bltts-panel .wide{grid-column:1/-1}#bltts-panel fieldset{border:1px solid #374151;border-radius:10px;padding:12px;display:flex;gap:14px;flex-wrap:wrap}#bltts-panel fieldset label{display:block}#bltts-panel button{border:0;border-radius:8px;padding:9px 14px;background:#fb7299;color:white;cursor:pointer}#bltts-panel button.secondary{background:#374151}#bltts-panel .hint{font-size:12px;color:#9ca3af}#bltts-panel .inline{flex-direction:row;align-items:center;gap:8px;display:flex}#bltts-panel .inline input{width:auto}#bltts-panel .logbox .log{box-sizing:border-box;width:100%;height:200px;overflow:auto;margin:6px 0 0;padding:10px;border:1px solid #4b5563;border-radius:8px;background:#0b1220;color:#93c5fd;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all;text-align:left}#bltts-panel .status{color:#86efac;min-height:1.4em}@media(max-width:800px){#bltts-panel .bltts-body{grid-template-columns:1fr}}`; document.head.appendChild(style);
  }
  const field = (label, key, value, type = 'text') => `<label>${esc(label)}<input data-key="${key}" type="${type}" value="${esc(value)}"></label>`;
  function openSettings() {
    if (!document.body) return setTimeout(openSettings, 100);
    injectStyles();
    let panel = document.getElementById('bltts-panel');
    if (!panel) { panel = document.createElement('section'); panel.id = 'bltts-panel'; panel.innerHTML = `<div class="bltts-head"><h2>▸ B站直播 TTS 控制台</h2><button class="secondary" data-action="close">关闭</button></div><div class="bltts-body"><div class="wide hint">配置保存在 Tampermonkey 存储中。MiMo TTS 直接调用 chat/completions 音频接口并播放云端返回的 WAV；当前 Chromium 没有系统语音，浏览器语音模式会失败。</div><label>播报开关<select data-key="enabled"><option value="true">开启</option><option value="false">关闭</option></select></label><label>TTS 模式<select data-key="mode"><option value="browser">浏览器语音（免费）</option><option value="openai">OpenAI 兼容音频 TTS</option><option value="mimo-text">小米 MiMo 云端 TTS</option></select></label>${field('Base URL（不含末尾路径）','baseUrl',settings.baseUrl)}${field('API Key（仅保存在本地）','apiKey',settings.apiKey,'password')}${field('模型','model',settings.model)}${field('音色','voice',settings.voice)}${field('语言','language',settings.language)}${field('语气/风格','style',settings.style)}${field('语速 0.5–2','rate',settings.rate,'number')}${field('音调 0–2','pitch',settings.pitch,'number')}${field('音量 0–1','volume',settings.volume,'number')}<label>播报间隔（毫秒）<input data-key="cooldownMs" type="number" value="${settings.cooldownMs}"></label><label>最大排队数量<input data-key="maxQueue" type="number" value="${settings.maxQueue}"></label><label>请求速率限制 RPM（0=不限）<input data-key="rpm" type="number" min="0" value="${settings.rpm}"></label><fieldset class="wide"><legend>播报哪些互动</legend>${Object.entries({enter:'进房',follow:'关注',like:'点赞',gift:'送礼',danmu:'弹幕',superchat:'醒目留言'}).map(([key,name]) => `<label><input data-event="${key}" type="checkbox"> ${name}</label>`).join('')}</fieldset><div class="wide hint">模板变量：{user} 用户名　{message} 内容　{gift} 礼物　{count} 数量　{price} 金额</div><fieldset class="wide"><legend>弹幕过滤</legend><label><input data-key="blockLottery" type="checkbox"> 屏蔽抽奖弹幕（口令/天选时刻等）</label><label style="flex:1;min-width:220px">抽奖关键词（逗号分隔）<input data-key="lotteryKeywords" type="text"></label></fieldset>${Object.entries({enter:'进房模板',follow:'关注模板',like:'点赞模板',gift:'送礼模板',danmu:'弹幕模板',superchat:'醒目留言模板'}).map(([key,name]) => `<label class="wide">${name}<textarea data-template="${key}"></textarea></label>`).join('')}<fieldset class="wide"><legend>调试</legend><label class="inline"><input data-key="debug" type="checkbox"> 显示调试日志</label><button class="secondary" data-action="clearlog">清空日志</button></fieldset><div class="wide logbox"><div class="hint">调试日志（勾选上方开关后输出，最近 100 条）</div><pre id="bltts-log" class="log"></pre></div><div class="wide"><button data-action="save">保存设置</button> <button class="secondary" data-action="test">测试播报</button> <button class="secondary" data-action="reset">恢复默认</button> <span class="status" data-status></span></div></div>`; document.body.appendChild(panel); panel.addEventListener('click', handlePanelClick); }
    panel.querySelectorAll('[data-key]').forEach(el => { const key = el.dataset.key; if (el.type === 'checkbox') el.checked = Boolean(settings[key]); else el.value = settings[key]; });
    panel.querySelectorAll('[data-event]').forEach(el => { el.checked = Boolean(settings.events[el.dataset.event]); });
    panel.querySelectorAll('[data-template]').forEach(el => { el.value = settings.templates[el.dataset.template] || ''; });
    panel.classList.add('open');
  }
  function readPanel() {
    const next = clone(settings); const panel = document.getElementById('bltts-panel');
    panel.querySelectorAll('[data-key]').forEach(el => { const key = el.dataset.key; next[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value; });
    next.events = { ...next.events }; panel.querySelectorAll('[data-event]').forEach(el => { next.events[el.dataset.event] = el.checked; });
    next.templates = { ...next.templates }; panel.querySelectorAll('[data-template]').forEach(el => { next.templates[el.dataset.template] = el.value; });
    return next;
  }
  function handlePanelClick(event) {
    const action = event.target.dataset.action; if (!action) return;
    const panel = document.getElementById('bltts-panel'); const status = panel.querySelector('[data-status]');
    if (action === 'close') panel.classList.remove('open');
    if (action === 'save') { saveSettings(readPanel()); status.textContent = '已保存'; setTimeout(() => { status.textContent = ''; }, 1800); }
    if (action === 'test') { saveSettings(readPanel()); speaker.enqueue('这是B站直播TTS测试播报'); status.textContent = '已加入播报队列'; }
    if (action === 'reset') { saveSettings(clone(DEFAULTS)); openSettings(); status.textContent = '已恢复默认'; }
    if (action === 'clearlog') { logLines.length = 0; renderLog(); }
  }
  GM_registerMenuCommand('打开 B站直播 TTS 设置', openSettings);
  // 调试钩子：仅供控制台/自动化打开面板（不暴露任何配置内容）
  PAGE_WINDOW.__blttsOpenSettings = openSettings;
  GM_registerMenuCommand('测试 TTS 播报', () => speaker.enqueue('这是B站直播TTS测试播报'));
  log('loaded', settings);
})();
