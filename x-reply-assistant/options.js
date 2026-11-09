import { defaults, providers, modelConnection, readSettings, saveSettings, clearKey } from './settings.js';

const form = document.getElementById('settings');
const provider = document.getElementById('provider');
const key = document.getElementById('api-key');
const keyState = document.getElementById('key-state');
const model = document.getElementById('model');
const early = document.getElementById('early');
const late = document.getElementById('late');
const prompt = document.getElementById('prompt');
const status = document.getElementById('status');
const clear = document.getElementById('clear-key');
let busy = false;
let saved;

function report(message, error = false) {
  status.textContent = message;
  status.classList.toggle('error', error);
}

function renderKey(hasKey) {
  keyState.textContent = hasKey ? '已配置。输入新 Key 后保存即可更换。' : '尚未配置。';
  clear.hidden = !hasKey;
}

function setModels(ids, selected) {
  model.replaceChildren(new Option(ids.length ? '请选择模型' : '请先保存 Key 并刷新模型', ''));
  for (const id of ids) model.add(new Option(id, id));
  model.value = ids.includes(selected) ? selected : '';
}

function renderConnection() {
  const connection = modelConnection(saved, provider.value);
  renderKey(Boolean(connection.apiKey));
  setModels(connection.model ? [connection.model] : [], connection.model);
}

async function execute(action) {
  if (busy) return;
  busy = true;
  const fieldsets = [...form.querySelectorAll('fieldset')];
  fieldsets.forEach((node) => { node.disabled = true; });
  document.getElementById('save').disabled = true;
  try {
    await action();
  } catch (error) {
    report(error.message || '操作失败，请重试。', true);
  } finally {
    fieldsets.forEach((node) => { node.disabled = false; });
    document.getElementById('save').disabled = false;
    busy = false;
  }
}

async function request(type, payload = {}) {
  if (provider.value !== saved.provider || key.value.trim()) {
    throw new Error('请先保存当前服务商和 Key。');
  }
  const response = await chrome.runtime.sendMessage({ ...payload, type });
  if (!response?.ok) throw new Error(response?.error || '扩展未能完成请求，请重试。');
  return response.result;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const candidateKey = key.value.trim();
  const earlyMinutes = early.valueAsNumber;
  const lateMinutes = late.valueAsNumber;
  const customPrompt = prompt.value.trim();
  if (lateMinutes <= earlyMinutes) return report('第二个时间分段必须大于第一个。', true);
  if (!customPrompt) return report('请填写提示词。', true);
  if (candidateKey && !/^[\x21-\x7e]+$/.test(candidateKey)) return report('API Key 不能包含空格或非英文字符。', true);
  const selected = provider.value;
  const { keyField, modelField, permission } = providers[selected];
  execute(async () => {
    if (permission && !await chrome.permissions.request({ origins: [permission] })) {
      return report('连接权限未获授权，设置未保存。', true);
    }
    await saveSettings({
      provider: selected,
      ...(candidateKey && { [keyField]: candidateKey }),
      [modelField]: model.value,
      prompt: customPrompt,
      earlyMinutes,
      lateMinutes,
      notified: true,
    });
    key.value = '';
    saved = await readSettings();
    const connection = modelConnection(saved);
    renderKey(Boolean(connection.apiKey));
    report(connection.apiKey && !connection.model ? '已保存 Key。请刷新模型列表，选中模型后再保存。' : '设置已保存。');
  });
});

provider.addEventListener('change', () => {
  key.value = '';
  renderConnection();
  report(provider.value === saved.provider ? '' : '切换后，点击「保存设置」使所选服务商生效。');
});

clear.addEventListener('click', () => execute(async () => {
  await clearKey(provider.value);
  saved = await readSettings();
  key.value = '';
  renderKey(false);
  report('已清除本地 API Key。');
}));

document.getElementById('refresh').addEventListener('click', () => execute(async () => {
  report('正在获取模型列表…');
  const ids = await request('models');
  setModels(ids, model.value);
  report(ids.length ? '模型列表已更新。选择模型后点击「保存设置」。' : '当前项目未找到兼容的文本模型。');
}));

document.getElementById('test').addEventListener('click', () => execute(async () => {
  report('正在测试连接…');
  await request('test');
  report('连接成功，已保存的模型支持结构化回复。');
}));

document.getElementById('reset').addEventListener('click', () => {
  prompt.value = defaults.prompt;
  report('已恢复默认提示词，点击「保存设置」后生效。');
});

execute(async () => {
  saved = await readSettings();
  provider.value = saved.provider;
  renderConnection();
  early.value = saved.earlyMinutes;
  late.value = saved.lateMinutes;
  prompt.value = saved.prompt;
  document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;
});
