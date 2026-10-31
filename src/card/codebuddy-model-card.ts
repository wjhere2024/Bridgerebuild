import type { CodeBuddyCatalog } from '../agent/codebuddy/models';

const plain = (content: string) => ({ tag: 'plain_text', content });
const markdown = (content: string) => ({ tag: 'markdown', content });

export function codeBuddyModelCard(catalog: CodeBuddyCatalog, selected: string, stale: boolean, notice?: string): object {
  const models = catalog.models.slice(0, 95);
  const options = [
    { text: plain('跟随 WorkBuddy 默认模型'), value: 'default' },
    ...models.map((model) => ({ text: plain(`${model.name} [${model.id}] · ${model.credits || '倍率未提供'}`), value: model.id })),
  ];
  if (!options.some((option) => option.value === selected)) options.push({ text: plain(`${selected}（已选，当前列表未包含）`), value: selected });
  return {
    schema: '2.0',
    config: { summary: { content: 'WorkBuddy 模型与积分倍率' } },
    header: { title: plain('WorkBuddy 模型与积分倍率'), template: 'blue' },
    body: { elements: [
      markdown(`**当前 Bridge 选择**：${selected === 'default' ? `跟随默认（查询时为 ${catalog.currentModelId || '未知'}）` : selected}\n切换只影响此 WorkBuddy 机器人，为当前聊天开启新会话。`),
      ...(notice ? [markdown(notice)] : []),
      markdown('下拉列表显示官方积分倍率，不是每条消息固定扣分；空值不代表免费，以官方账单为准。'),
      markdown(`${stale ? '⚠️ 刷新失败，正在显示上次成功缓存，倍率可能已变化。\n' : ''}获取时间：${catalog.fetchedAt}（缓存 10 分钟）`),
      { tag: 'form', name: 'workbuddy_models', elements: [
        { tag: 'select_static', name: 'model_name', required: true, initial_option: selected, options },
        { tag: 'button', name: 'workbuddy_submit', text: plain('切换模型'), type: 'primary', form_action_type: 'submit', behaviors: [{ type: 'callback', value: { cmd: 'model.submit' } }] },
      ] },
      { tag: 'button', name: 'workbuddy_refresh', text: plain('刷新模型与倍率'), behaviors: [{ type: 'callback', value: { cmd: 'model.refresh' } }] },
    ] },
  };
}
