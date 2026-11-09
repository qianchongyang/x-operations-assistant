import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { defaultPrompt } from '../x-reply-assistant/default-prompt.js';

const file = (name) => readFileSync(new URL('../x-reply-assistant/' + name, import.meta.url), 'utf8');
const url = 'https://x.com/example/status/42';
const post = { id: '42', text: 'The plan changed again.', language: 'en', replies: [] };
const defaults = { direction: '自动', tone: '随手回', length: 'normal' };
const first = { en: 'There goes the stable plan.', zh: '稳定套餐又没了。', direction: '吐槽', style_score: 5, risk: 'low', risk_reason_zh: '' };
const second = { en: 'You bought a moving target.', zh: '你买了个一直在变的东西。', direction: '对作者说', style_score: 4, risk: 'low', risk_reason_zh: '' };
const third = { ...first, en: 'New plan, same problem.', zh: '套餐变了，问题还是那个。', direction: '判断', style_score: 3 };
const batch = { original_language: 'other', original_zh: '套餐又变了。', summary_zh: '作者在吐槽，未读到已加载回复。', post_kind: '吐槽',
  recommendation: 'reply', skip_reason_zh: '', note_zh: '可配梗图。', candidates: [second, third, first] };
const rewrite = { ...first, en: 'Stable plan, gone.', zh: '稳定套餐没了。' };
const store = {};
const calls = [];
let listener;
let respond;
let tabUrl;

globalThis.chrome = {
  storage: { local: {
    setAccessLevel: async () => {},
    get: async (defaults) => structuredClone(Object.fromEntries(
      Object.entries(defaults).map(([key, value]) => [key, store[key] ?? value]),
    )),
    set: async (values) => Object.assign(store, structuredClone(values)),
    remove: async (key) => { delete store[key]; },
  } },
  runtime: {
    getURL: (path) => 'chrome-extension://test/' + path,
    onMessage: { addListener: (handler) => { listener = handler; } },
  },
  tabs: { get: async () => ({ url: tabUrl }) },
  permissions: { contains: async () => false },
  action: { onClicked: { addListener() {} } },
};
globalThis.fetch = async (url, request) => {
  assert.equal(url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(request.body);
  const input = JSON.parse(body.input);
  calls.push({ input, body });
  const value = await respond(input);
  return { ok: true, json: async () => ({ status: 'completed', output: [
    { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] },
  ] }) };
};
await import('../x-reply-assistant/background.js');
const { readSettings, saveSettings, clearKey, providers, modelConnection } = await import('../x-reply-assistant/settings.js');

beforeEach(() => {
  for (const key of Object.keys(store)) delete store[key];
  Object.assign(store, { apiKey: 'mock-only', model: 'mock-model', notified: true });
  calls.length = 0;
  tabUrl = url;
  respond = (input) => input.draft
    ? { recommendation: 'reply', skip_reason_zh: '', candidates: [rewrite] } : batch;
});

function send(message, options = false) {
  const sender = { url: options ? 'chrome-extension://test/options.html#style-library' : url, tab: { id: 1 }, frameId: 0 };
  return new Promise((resolve) => listener(message, sender, resolve));
}

function analyze(preferences = defaults, raw = post) {
  return send({ type: 'analyze', post: raw, preferences });
}

test('automatic and single-direction modes, tone and length choices, and validation', async () => {
  const auto = await analyze();
  assert.equal(auto.ok, true);
  assert.deepEqual(auto.result.candidates.map((item) => item.direction), ['吐槽', '对作者说', '判断']);
  assert.equal(calls[0].input.draft_options.max_chars, 140);

  const fourth = { ...first, en: 'Terms and conditions, updated daily.', direction: '补完' };
  for (const candidates of [[], [first], [first, second], [first, second, third, fourth]]) {
    respond = () => ({ ...batch, candidates });
    assert.equal((await analyze()).ok, false);
  }

  respond = () => ({ ...batch, candidates: batch.candidates.map((item) => ({ ...item, direction: '吐槽' })) });
  assert.equal((await analyze()).ok, false);
  const manual = await analyze({ direction: '吐槽', tone: '轻松', length: 'brief' });
  assert.equal(manual.ok, true);
  assert.equal(calls.at(-1).input.draft_options.tone, '轻松');
  assert.equal(calls.at(-1).input.draft_options.max_chars, 80);
  assert.equal((await analyze({ ...defaults, direction: '提问' })).ok, false);
  respond = () => ({ ...batch, candidates: [{ ...first, en: 'A'.repeat(220) }, second, third] });
  assert.equal((await analyze({ ...defaults, length: 'fuller' })).ok, true);
  assert.equal((await analyze()).ok, false);
  respond = () => ({ ...batch, candidates: [first, { ...second, en: 'There goes another one.' }, third] });
  assert.equal((await analyze()).ok, false);
  respond = () => ({ ...batch, candidates: [first, { ...second, risk: 'medium' }, third] });
  assert.equal((await analyze()).ok, false);
  assert.equal((await analyze({ ...defaults, length: 'constructor' })).ok, false);
});

test('single rewrite sends one draft, synchronizes both languages, and handles skip and failures', async () => {
  const message = { type: 'rewrite', post, preferences: defaults, draft: first, change: '更短', others: [second.en] };
  const result = await send(message);
  assert.deepEqual(result.result.candidate, rewrite);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.draft_options.max_chars, first.en.length - 1);
  assert.equal(calls[0].input.draft_options.direction, first.direction);
  assert.deepEqual(calls[0].input.other_drafts, [second.en]);
  assert.equal(calls[0].input.draft.zh, first.zh);
  await send({ ...message, change: '认真' });
  assert.equal(calls.at(-1).input.draft_options.tone, '认真');
  await send({ ...message, change: '更口语' });
  assert.match(calls.at(-1).input.draft_options.tone, /更口语/);
  const longer = { ...first, en: 'A'.repeat(145), zh: '稳定套餐又没了，而且影响了使用。' };
  respond = () => ({ recommendation: 'reply', skip_reason_zh: '', candidates: [longer] });
  assert.deepEqual((await send({ ...message, change: '更长' })).result.candidate, longer);
  assert.equal(calls.at(-1).input.draft_options.max_chars, 220);
  assert.match(calls.at(-1).input.draft_options.length_guide, /比旧稿略长/);
  respond = () => ({ recommendation: 'reply', skip_reason_zh: '', candidates: [rewrite] });
  assert.match((await send({ ...message, change: '更长' })).error, /没有变长/);
  assert.deepEqual((await send({ ...message, draft: longer })).result.candidate, rewrite);
  assert.equal(calls.at(-1).input.draft_options.max_chars, 144);
  const beforeLimit = calls.length;
  assert.match((await send({ ...message, change: '更长', draft: { ...first, en: 'A'.repeat(220) } })).error, /220 字符上限/);
  assert.equal(calls.length, beforeLimit);
  respond = () => ({ recommendation: 'skip', skip_reason_zh: '缺少关键上下文。', candidates: [] });
  assert.equal((await send(message)).result.skipReason, '缺少关键上下文。');
  respond = () => ({ recommendation: 'reply', skip_reason_zh: '', candidates: [{ ...first, en: second.en }] });
  assert.equal((await send({ ...message, change: '轻松' })).ok, false);
  respond = () => { throw new Error('mock network failure'); };
  assert.match((await send(message)).error, /连接/);
});

test('translation, unknown media, empty replies, skip, and detail-page access', async () => {
  respond = () => ({ ...batch, original_language: 'zh', recommendation: 'skip', skip_reason_zh: '正文太少。', candidates: [], note_zh: '' });
  const result = await analyze(defaults, { ...post, translated: true, hasMedia: true });
  assert.equal(result.result.skipReason, '正文太少。');
  assert.equal(result.result.originalZh, batch.original_zh);
  assert.equal(calls[0].input.post.display_kind, 'x_translation');
  assert.equal(calls[0].input.post.media_unread, true);
  assert.deepEqual(calls[0].input.replies, []);
  const chinese = { ...post, text: '中文原话。', language: 'zh-Hant' };
  assert.equal((await analyze(defaults, chinese)).result.originalZh, chinese.text);
  assert.equal((await analyze(defaults, { ...chinese, translated: true })).result.originalZh, chinese.text);
  tabUrl = url + '/photo/1';
  assert.equal((await analyze()).ok, false);
  assert.equal(calls.length, 3);
});

test('manual translation sends only the typed text and is restricted to the current post', async () => {
  const message = { type: 'translateReply', postId: post.id, text: '  套餐又变了。  ' };
  respond = () => ({ en: 'The plan changed again.' });
  assert.deepEqual((await send(message)).result, { english: 'The plan changed again.' });
  assert.deepEqual(calls[0].input, { text: '套餐又变了。' });
  assert.equal((await send({ ...message, postId: '99' })).ok, false);
  assert.equal((await send({ ...message, text: ' ' })).ok, false);
  assert.equal((await send({ ...message, text: '中'.repeat(2001) })).ok, false);
  assert.equal(calls.length, 1);
  respond = () => ({ en: ' ' });
  assert.match((await send(message)).error, /没有返回英文/);
});

test('old samples, contextual marks, edited expression, stale undo, and removal', async () => {
  const old = { postId: '12', post_kind: '吐槽', direction: '顺势接梗', tone: '幽默', en: 'Old sample.' };
  store.styleExamples = [old];
  assert.deepEqual((await send({ type: 'listStyles' }, true)).result, [old]);
  assert.equal((await send({ type: 'listStyles' })).ok, false);
  await analyze();
  assert.equal(calls[0].input.style_examples[0].tone, '幽默');
  const mark = (candidate, previous) => send({ type: 'styleFeedback', postId: '42', postKind: '吐槽',
    candidate, previous, context: { text: post.text, translated: true } });
  assert.equal((await mark(first)).ok, true);
  assert.equal(store.styleExamples[0].context.text, post.text);
  assert.equal(store.styleExamples[0].context.translated, true);
  assert.equal((await mark(second)).ok, true);
  assert.equal((await mark(null, first.en)).ok, false);
  assert.equal(store.styleExamples[0].en, second.en);
  assert.equal((await mark(null, second.en)).ok, true);
  assert.deepEqual(store.styleExamples, [old]);
  const edit = { type: 'editStyle', postId: '12', original: { en: old.en, context: '' },
    en: 'My final wording.', context: 'Context added later.' };
  const edited = await send(edit, true);
  assert.equal(edited.result[0].edited, true);
  assert.equal(edited.result[0].context.text, edit.context);
  assert.equal((await send({ ...edit, type: 'removeStyle' }, true)).ok, false);
  await analyze();
  assert.equal(calls.at(-1).input.style_examples[0].en, edit.en);
  assert.equal(calls.at(-1).input.style_examples[0].context.text, edit.context);
  const removed = await send({ ...edit, type: 'removeStyle', original: { en: edit.en, context: edit.context } }, true);
  assert.deepEqual(removed.result, []);
});

test('previous default upgrades and a custom prompt is preserved', async () => {
  const version141 = defaultPrompt
    .replace('适合回复时给三条。自动接法要为每条选不同的接法和切入点，语气跟着原帖走。', '按原帖内容决定给几条，有一个自然的切入点就只给一条。自动接法给多条时，至少覆盖两种接法。')
    .replace('3. 三条双语候选。', '3. 1–4 条候选。');
  assert.notEqual(version141, defaultPrompt);
  store.prompt = version141;
  assert.equal((await readSettings()).prompt, defaultPrompt);
  const version14 = version141
    .replace('按原帖内容决定给几条，有一个自然的切入点就只给一条。自动接法给多条时，至少覆盖两种接法。', '自动接法至少有两种实质不同的接法。')
    .replace('3. 1–4 条候选。', '3. 2–3 条候选。')
    .replace('没有自然接法时，建议跳过。', '找不到两条合适的候选时，建议跳过。');
  assert.notEqual(version14, defaultPrompt);
  store.prompt = version14;
  assert.equal((await readSettings()).prompt, defaultPrompt);
  const previous = version14
    .replace('英文默认最多 140 字符。本次选择「更短」时最多 80 字符，选择「多说一句」时最多 220 字符，可以用两句说清同一个观点。所有上限均含空格和标点。', '每条英文正文最多 140 字符，含空格和标点。')
    .replace('自动接法至少有两种实质不同的接法。指定接法时用同一接法提供不同的观察或切入点，开头和句式有明显区别。指定接法或语气仍须贴合原帖，提问以作者有意求讨论为前提。', '同一批候选至少有两种实质不同的接法，开头和句式有明显区别。');
  assert.notEqual(previous, defaultPrompt);
  store.prompt = previous;
  assert.equal((await readSettings()).prompt, defaultPrompt);
  store.prompt = previous + '\n自定义偏好。';
  assert.equal((await readSettings()).prompt, store.prompt);
});

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; }
  get isConnected() { return this.tag === 'body' || Boolean(this.parent?.isConnected); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  add(node) { this.append(node); }
  prepend(...nodes) { for (const node of nodes) node.parent = this; this.children.unshift(...nodes); }
  replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attrs[key] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  fire(name = 'click') { if (!this.disabled) this.listeners[name]?.({ preventDefault() {}, stopPropagation() {} }); }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  focus() {}
  querySelectorAll() { return []; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this); this.parent = null; }
}

const nodes = (node) => [node, ...node.children.flatMap(nodes)];
const byClass = (root, cls) => nodes(root).filter((node) => node.className === cls);
const button = (root, text) => nodes(root).find((node) => node.tag === 'button' && node.textContent === text);
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('local dialog interactions: automatic draft, exact copy, hearts, optional rewrite, and stale results', async () => {
  const document = { body: new Element('body'), createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  const main = new Element('article');
  const raw = { ...post, translated: true, hasMedia: true };
  let pending;
  let clipboard;
  let mockedCandidates;
  const context = {
    document, window: {}, location: { href: url }, MutationObserver: class { observe() {} },
    XReplyPost: { idFromUrl: () => '42', locate: () => ({ main }), read: () => raw },
    chrome: { runtime: { sendMessage(message) {
      pending = mockedCandidates && message.type === 'analyze'
        ? Promise.resolve({ ok: true, result: { recommendation: 'reply', candidates: mockedCandidates } })
        : send(message);
      return pending;
    } } },
    navigator: { clipboard: { writeText: async (text) => { clipboard = text; } } },
  };
  runInNewContext(file('reply-options.js') + '\n' + file('content.js'), context);
  const open = byClass(main, 'xra-entry')[0];
  const view = document.body;
  async function click(node, event = 'click') { pending = null; node.fire(event); await pending; await tick(); }
  await click(open);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input.draft_options.tone, '随手回');
  assert.ok(nodes(view).some((node) => node.textContent?.includes('图像或视频内容未知')));
  assert.ok(nodes(view).some((node) => node.textContent === '原帖中文（依据 X 平台译文）'));
  assert.ok(nodes(view).some((node) => node.textContent === batch.original_zh));
  const cards = byClass(view, 'xra-candidate');
  assert.equal(cards.length, 3);
  assert.equal(button(view, '管理风格样本'), undefined);
  const firstCopy = byClass(cards[0], 'xra-english')[0];
  const otherCopy = byClass(cards[1], 'xra-english')[0];
  await click(firstCopy);
  assert.equal(clipboard, first.en);
  assert.equal(store.styleExamples, undefined);
  const hearts = cards.map((card) => byClass(card, 'xra-heart')[0]);
  assert.equal(hearts[0].attrs['aria-pressed'], 'false');
  await click(hearts[0]);
  assert.equal(hearts[0].attrs['aria-pressed'], 'true');
  await click(hearts[1]);
  assert.equal(hearts[0].attrs['aria-pressed'], 'false');
  await click(hearts[1]);
  assert.equal(hearts[1].attrs['aria-pressed'], 'false');
  assert.deepEqual(store.styleExamples, []);

  const [manual] = byClass(view, 'xra-manual');
  assert.ok(nodes(view).indexOf(manual) > nodes(view).indexOf(cards.at(-1)));
  const rewriteMenu = (card) => nodes(byClass(card, 'xra-candidate-head')[0]).filter((node) => node.tag === 'select');
  assert.deepEqual(cards.map((card) => rewriteMenu(card).length), [1, 1, 1]);
  assert.equal(nodes(manual).filter((node) => node.attrs['aria-label']?.includes('改写方式')).length, 0);
  const [firstRewrite, otherRewrite] = cards.flatMap(rewriteMenu);
  firstRewrite.value = '更短';
  await click(firstRewrite, 'change');
  assert.equal(firstRewrite.value, '');
  assert.equal(firstCopy.textContent, rewrite.en);
  assert.equal(byClass(cards[0], 'xra-chinese')[0].textContent, rewrite.zh);
  assert.equal(otherCopy.textContent, second.en);
  assert.equal(byClass(view, 'xra-candidate').length, 3);
  await click(firstCopy);
  assert.equal(clipboard, rewrite.en);
  assert.deepEqual(store.styleExamples, []);
  const longer = { ...first, en: 'The stable plan did not last very long.', zh: '稳定的套餐没持续多久。' };
  respond = () => ({ recommendation: 'reply', skip_reason_zh: '', candidates: [longer] });
  firstRewrite.value = '更长';
  await click(firstRewrite, 'change');
  assert.equal(calls.at(-1).input.draft.en, rewrite.en);
  assert.equal(firstCopy.textContent, longer.en);
  assert.equal(byClass(cards[0], 'xra-chinese')[0].textContent, longer.zh);
  await click(firstCopy);
  assert.equal(clipboard, longer.en);
  respond = () => { throw new Error('network failure'); };
  firstRewrite.value = '更短';
  await click(firstRewrite, 'change');
  assert.equal(firstCopy.textContent, longer.en);
  assert.ok(byClass(cards[0], 'xra-feedback').some((item) => item.textContent?.includes('连接')));

  const own = byClass(view, 'xra-own-sample')[0];
  own.open = true;
  const ownInput = nodes(own).find((node) => node.tag === 'textarea');
  ownInput.value = 'My actual final reply.';
  assert.deepEqual(store.styleExamples, []);
  const beforeSave = calls.length;
  await click(button(own, '保存为风格样本'));
  assert.equal(calls.length, beforeSave);
  assert.equal(store.styleExamples[0].en, ownInput.value);
  assert.equal(store.styleExamples[0].context.text, post.text);
  assert.equal(store.styleExamples[0].edited, true);

  let finish;
  respond = () => new Promise((resolve) => { finish = resolve; });
  firstRewrite.value = '更短';
  firstRewrite.fire('change');
  const deferred = pending;
  await tick();
  const before = calls.length;
  firstRewrite.value = '更短';
  firstRewrite.fire('change');
  otherRewrite.value = '更长';
  otherRewrite.fire('change');
  await tick();
  assert.equal(calls.length, before);
  button(view, '关闭').fire();
  respond = () => batch;
  open.fire();
  const reopened = pending;
  finish({ recommendation: 'reply', skip_reason_zh: '', candidates: [{ ...rewrite, en: 'Plan gone.', zh: '套餐没了。' }] });
  await deferred;
  await reopened;
  await tick();
  assert.equal(byClass(view, 'xra-candidate').length, 3);
  assert.equal(firstCopy.textContent, longer.en);
  assert.equal(byClass(view, 'xra-english')[0].textContent, first.en);
  for (const count of [2, 5]) {
    button(view, '关闭').fire();
    mockedCandidates = Array.from({ length: count }, (_, index) => ({ ...first, en: 'Draft ' + index }));
    await click(open);
    const visible = byClass(view, 'xra-candidate');
    assert.equal(visible.length, count);
    assert.deepEqual(visible.map((card) => rewriteMenu(card).length), Array(count).fill(1));
  }
});

test('manual regeneration and Chinese conversion keep their text and the bottom close works', async () => {
  const document = { body: new Element('body'), createElement: (tag) => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  const main = new Element('article');
  let pending;
  let clipboard;
  const context = {
    document, window: {}, location: { href: url }, MutationObserver: class { observe() {} },
    XReplyPost: { idFromUrl: () => post.id, locate: () => ({ main }), read: () => post },
    chrome: { runtime: { sendMessage(message) { pending = send(message); return pending; } } },
    navigator: { clipboard: { writeText: async (value) => { clipboard = value; } } },
  };
  runInNewContext(file('reply-options.js') + '\n' + file('content.js'), context);
  const view = document.body;
  async function click(node) { pending = null; node.fire(); await pending; await tick(); }
  await click(byClass(main, 'xra-entry')[0]);
  const [manual, translation] = byClass(view, 'xra-manual');
  const footer = byClass(view, 'xra-footer')[0];
  assert.equal(footer.parent.children.at(-1), footer);
  assert.equal(footer.parent.children.at(-2), translation);

  const input = nodes(translation).find((node) => node.tag === 'textarea');
  input.value = '这套餐又变了。';
  const english = 'This plan changed again.';
  respond = () => ({ en: english });
  await click(button(translation, '转换'));
  const copy = byClass(translation, 'xra-english')[0];
  assert.equal(copy.textContent, english);
  assert.equal(copy.parent.hidden, false);
  await click(copy);
  assert.equal(clipboard, english);

  const [, tone, length] = nodes(manual).filter((node) => node.tag === 'select');
  tone.value = '轻松';
  length.value = 'brief';
  const regenerate = button(manual, '按选择重新生成');
  respond = () => { throw new Error('network failure'); };
  await click(regenerate);
  assert.equal(byClass(view, 'xra-candidate').length, 3);
  assert.match(byClass(manual, 'xra-feedback')[0].textContent, /连接/);
  const revised = { ...first, en: 'The stable plan was a phase.', zh: '稳定的套餐只是个阶段。' };
  respond = () => ({ ...batch, candidates: [revised, second, third] });
  await click(regenerate);
  assert.equal(calls.at(-1).input.draft_options.tone, '轻松');
  assert.equal(calls.at(-1).input.draft_options.max_chars, 80);
  assert.equal(byClass(view, 'xra-candidate').length, 6);
  const generated = byClass(manual, 'xra-manual-result')[0];
  assert.equal(generated.parent.children.indexOf(generated), generated.parent.children.indexOf(regenerate.parent) + 2);
  assert.equal(byClass(generated, 'xra-candidate').length, 3);
  const generatedCopy = byClass(generated, 'xra-english')[0];
  assert.equal(generatedCopy.textContent, revised.en);
  assert.equal(byClass(generated, 'xra-chinese')[0].textContent, revised.zh);
  assert.equal(byClass(view, 'xra-english')[0].textContent, first.en);
  await click(generatedCopy);
  assert.equal(clipboard, revised.en);
  assert.equal(byClass(view, 'xra-manual')[1], translation);
  assert.equal(input.value, '这套餐又变了。');
  assert.equal(copy.textContent, english);
  input.value = '新的文字';
  input.fire('input');
  assert.equal(copy.parent.hidden, true);

  let finish;
  respond = () => new Promise((resolve) => { finish = resolve; });
  button(translation, '转换').fire();
  const conversion = pending;
  await tick();
  button(byClass(view, 'xra-footer')[0], '关闭').fire();
  assert.equal(view.children[0].open, false);
  finish({ en: 'Stale result.' });
  await conversion;
  await tick();
  assert.equal(copy.textContent, english);
});

test('settings keeps each provider configuration separate and removes the style management entry', async () => {
  store.styleExamples = [{ postId: '42', post_kind: '吐槽', direction: '判断', en: 'Saved wording.' }];
  store.deepseekModel = 'deepseek-flash';
  const examples = structuredClone(store.styleExamples);
  const elements = new Map();
  const permissions = [];
  let granted = false;
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, Object.assign(new Element('div'), { value: '', classList: { toggle() {} } }));
      }
      return elements.get(id);
    },
  };
  class Option extends Element {
    constructor(text, value) { super('option'); this.textContent = text; this.value = value; }
  }
  runInNewContext(file('options.js').replace(/^import [^\n]+\n/, ''), {
    document, Option, defaults: { prompt: defaultPrompt }, readSettings, saveSettings, clearKey, providers, modelConnection,
    chrome: {
      runtime: { getManifest: () => JSON.parse(file('manifest.json')) },
      permissions: { request({ origins }) { permissions.push(...origins); return Promise.resolve(granted); } },
    },
  });
  await tick();
  const provider = document.getElementById('provider');
  const key = document.getElementById('api-key');
  const model = document.getElementById('model');
  const form = document.getElementById('settings');
  assert.equal(provider.value, 'openai');
  assert.equal(key.value, '');
  assert.equal(model.value, 'mock-model');
  assert.doesNotMatch(file('options.html'), /管理风格样本|style-library/);

  key.value = 'unsaved-openai-key';
  provider.value = 'deepseek';
  provider.fire('change');
  assert.equal(key.value, '');
  assert.equal(model.value, 'deepseek-flash');
  key.value = 'mock-deepseek-only';
  form.fire('submit');
  await tick();
  assert.equal((await readSettings()).provider, 'openai');
  assert.equal(store.deepseekApiKey, undefined);

  granted = true;
  form.fire('submit');
  await tick();
  assert.equal(store.provider, 'deepseek');
  assert.equal(store.deepseekApiKey, 'mock-deepseek-only');
  assert.equal(store.apiKey, 'mock-only');
  assert.equal(store.model, 'mock-model');
  assert.deepEqual(permissions, ['https://api.deepseek.com/*', 'https://api.deepseek.com/*']);

  document.getElementById('clear-key').fire();
  await tick();
  assert.equal(store.deepseekApiKey, undefined);
  assert.equal(store.apiKey, 'mock-only');
  provider.value = 'openai';
  provider.fire('change');
  assert.equal(model.value, 'mock-model');
  form.fire('submit');
  await tick();
  assert.equal(store.provider, 'openai');
  assert.deepEqual(store.styleExamples, examples);
  assert.equal(calls.length, 0);
});

test('DeepSeek lists models and validates bilingual replies, rewrites, and manual translation', async (t) => {
  Object.assign(store, { provider: 'deepseek', deepseekApiKey: 'mock-deepseek-only', deepseekModel: 'deepseek-flash' });
  let allowed = false;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer mock-deepseek-only');
    if (url === 'https://api.deepseek.com/models') {
      return { ok: true, json: async () => ({ data: [{ id: 'deepseek-v4-pro' }, { id: 'deepseek-flash' }] }) };
    }
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.equal(body.response_format.type, 'json_object');
    assert.match(body.messages[0].content, /JSON Schema/);
    const value = body.messages[1].content === '连接测试。' ? { ok: true } : await respond(JSON.parse(body.messages[1].content));
    return { ok: true, json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: value === null ? '   ' : JSON.stringify(value) } }],
    }) };
  });
  t.mock.method(chrome.permissions, 'contains', async ({ origins }) => {
    assert.deepEqual(origins, ['https://api.deepseek.com/*']);
    return allowed;
  });

  assert.equal((await analyze()).code, 'setup');
  allowed = true;
  assert.deepEqual((await send({ type: 'models' }, true)).result, ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal((await send({ type: 'test' }, true)).ok, true);
  const drafted = await analyze();
  assert.equal(drafted.result.candidates[0].en, first.en);
  assert.equal(drafted.result.candidates[0].zh, first.zh);
  const rewritten = await send({ type: 'rewrite', post, preferences: defaults, draft: first, change: '更短', others: [] });
  assert.equal(rewritten.result.candidate.zh, rewrite.zh);
  respond = (input) => {
    assert.deepEqual(input, { text: '有意思。' });
    return { en: 'Interesting.' };
  };
  assert.equal((await send({ type: 'translateReply', postId: '42', text: '有意思。' })).result.english, 'Interesting.');
  respond = () => null;
  assert.match((await analyze()).error, /格式无法识别/);
});
