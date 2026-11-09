import { defaultPrompt } from './default-prompt.js';

export const defaults = {
  provider: 'openai',
  model: '',
  prompt: defaultPrompt,
  earlyMinutes: 30,
  lateMinutes: 360,
};

export const providers = {
  openai: { label: 'OpenAI', api: 'https://api.openai.com/v1', keyField: 'apiKey', modelField: 'model' },
  deepseek: {
    label: 'DeepSeek',
    api: 'https://api.deepseek.com',
    permission: 'https://api.deepseek.com/*',
    keyField: 'deepseekApiKey',
    modelField: 'deepseekModel',
  },
};

export function modelConnection(settings, provider = settings.provider) {
  const { keyField, modelField } = providers[provider];
  return { apiKey: settings[keyField], model: settings[modelField] };
}

const storage = chrome.storage.local;
// Enforce this before the extension can read or persist any key.
const storageReady = storage.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
let styleWrite = Promise.resolve();

export async function readStyleExamples() {
  await storageReady;
  const { styleExamples } = await storage.get({ styleExamples: [] });
  return styleExamples;
}

function updateStyleExamples(update) {
  const write = styleWrite.then(async () => {
    const saved = await readStyleExamples();
    const styleExamples = update(saved);
    await storage.set({ styleExamples });
    return styleExamples;
  });
  styleWrite = write.catch(() => {});
  return write;
}

export function saveStyleExample(postId, example) {
  return updateStyleExamples((saved) => {
    const others = saved.filter((item) => item.postId !== postId);
    return example ? [{ postId, ...example }, ...others].slice(0, 40) : others;
  });
}

export function editStyleExample(postId, original, changes) {
  return updateStyleExamples((saved) => {
    const item = saved.find((entry) => entry.postId === postId);
    if (!item && changes === null) return saved;
    if (!item || item.en !== original.en ||
        (original.context !== undefined && (item.context?.text || '') !== original.context)) {
      throw Object.assign(new Error('这条样本已更新或删除，请刷新样本。'), { code: 'request' });
    }
    if (changes === null) return saved.filter((entry) => entry.postId !== postId);
    const context = changes.context ? { ...item.context, text: changes.context } : null;
    return [{ ...item, en: changes.en, context, edited: true }, ...saved.filter((entry) => entry.postId !== postId)];
  });
}

export async function readSettings() {
  await storageReady;
  const settings = await storage.get({
    ...defaults, apiKey: '', deepseekApiKey: '', deepseekModel: '', notified: false,
  });
  if (!Object.hasOwn(providers, settings.provider)) settings.provider = defaults.provider;
  if (settings.prompt !== defaultPrompt) {
    // Upgrade exact defaults only. A user-edited prompt stays as saved.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(settings.prompt));
    const fingerprint = btoa(String.fromCharCode(...new Uint8Array(digest)));
    if ([
      'aF+BAt+cTGJ/wVUa+A++dWjPEd7M3Prn4LsXz4zeaac=',
      'WaMckZqUhXZSnw/BjzQOquyUBBKxHM7nvfixcFuH4ck=',
      '+TxVvJqW86rPWwto0N5y9PT6o8gLY9IiqeaoCVBswBQ=',
      'HO+XHDnpciqClcuEPSRQv7ffNZm3s0nzBzQLupFLkAU=',
      'c9yCQv6ozc7HB02bAVvzhnijoB4bFKRox+QOdUYJYrY=',
      'aZ725AwOCQKsWy4PJeTkRnuSKqGE6RFYhb119lZdf+o=',
      'V4dq/v+KjVziycB2jaNdGKgFwA2fac54TAUJNbD4nwY=',
      'EyVXsk89bM/FUU5HBRP7zzf2eOLvyce3Jr+zOpk+4os=',
    ].includes(fingerprint)) settings.prompt = defaultPrompt;
  }
  return settings;
}

export async function saveSettings(values) {
  await storageReady;
  await storage.set(values);
}

export async function clearKey(provider) {
  await storageReady;
  await storage.remove(providers[provider].keyField);
}
