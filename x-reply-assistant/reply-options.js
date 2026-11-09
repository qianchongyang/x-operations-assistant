(() => {
  const automatic = '自动';
  const directions = ['补完', '对作者说', '判断', '吐槽', '提问'];
  const tones = ['随手回', '轻松', '直接', '认真'];
  const lengths = {
    brief: { label: '更短', limit: 80, guide: '尽量用很短的一句话。' },
    normal: { label: '短回复', limit: 140, guide: '默认一句，通常 3–12 个词。技术问答或认真求助可用两句。' },
    fuller: { label: '多说一句', limit: 220, guide: '可以用两句说清同一个观点，能一句说完时保持简短。' },
  };
  globalThis.XReplyOptions = {
    automatic, directions, tones, lengths,
    defaults: { direction: automatic, tone: tones[0], length: 'normal' },
  };
})();
