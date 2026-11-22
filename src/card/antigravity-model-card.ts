import type { AntigravityCatalog } from '../agent/antigravity/models';

const plain = (content: string) => ({ tag: 'plain_text', content });
const markdown = (content: string) => ({ tag: 'markdown', content });

export function antigravityModelCard(catalog: AntigravityCatalog, selected: string, stale: boolean, notice?: string): object {
  const models = catalog.models.slice(0, 95);
  const options = [
    { text: plain('跟随 Antigravity 默认模型'), value: 'default' },
    ...models.map((model) => ({ text: plain(`${model.name} [${model.id}]`), value: model.id })),
  ];
  if (!options.some((option) => option.value === selected)) options.push({ text: plain(`${selected}（已选，当前列表未包含）`), value: selected });
  return {
    schema: '2.0',
    config: { summary: { content: 'Antigravity 模型' } },
    header: { title: plain('Antigravity 模型'), template: 'blue' },
    body: { elements: [
      markdown(`**当前 Bridge 选择**：${selected === 'default' ? '跟随默认（不指定 --model，由 agy 决定）' : selected}\n切换只影响此 Antigravity 机器人，为当前聊天开启新会话。`),
      ...(notice ? [markdown(notice)] : []),
      markdown(`${stale ? '⚠️ 刷新失败，正在显示上次成功缓存，列表可能已变化。\n' : ''}获取时间：${catalog.fetchedAt}（缓存 10 分钟，换账号后请点刷新）`),
      { tag: 'form', name: 'antigravity_models', elements: [
        { tag: 'select_static', name: 'model_name', required: true, initial_option: selected, options },
        { tag: 'button', name: 'antigravity_submit', text: plain('切换模型'), type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'model.submit' } }] },
      ] },
      { tag: 'button', name: 'antigravity_refresh', text: plain('刷新模型列表'), behaviors: [{ type: 'callback', value: { cmd: 'model.refresh' } }] },
    ] },
  };
}
