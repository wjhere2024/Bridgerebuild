export interface ModelProfileOption {
  name: string;
  key: string;
  model: string;
  current?: boolean;
}

const plain = (content: string) => ({ tag: 'plain_text', content });
const markdown = (content: string) => ({ tag: 'markdown', content });
const card = (title: string, elements: object[]) => ({
  schema: '2.0',
  config: { summary: { content: title } },
  header: { title: plain(title), template: 'blue' },
  body: { elements },
});

function button(label: string, action: string, arg = '', submit = false, type = 'default'): object {
  return {
    tag: 'button',
    name: `${action.replace(/-/g, '_')}_button`,
    text: plain(label),
    type,
    ...(submit ? { form_action_type: 'submit' } : {}),
    behaviors: [{ type: 'callback', value: { cmd: `model.${action}`, ...(arg ? { arg } : {}) } }],
  };
}

function row(elements: object[]): object {
  return {
    tag: 'column_set', flex_mode: 'flow', horizontal_spacing: 'small',
    columns: elements.map((element) => ({ tag: 'column', width: 'auto', elements: [element] })),
  };
}

export function modelSelectionCard(opts: {
  currentProfile: string;
  profiles: ModelProfileOption[];
  providerKeys?: string[];
  selectedKey?: string;
  /** Model to preselect when the shown provider is not the active one. */
  selectedModel?: string;
  notice?: string;
  error?: string;
  overrideModel?: string;
  agentName?: 'Codex' | 'Claude';
}): object {
  const agent = opts.agentName ?? 'Codex';
  const keys = [...new Set(opts.providerKeys ?? opts.profiles.map((profile) => profile.key))];
  const key = keys.includes(opts.selectedKey ?? '') ? opts.selectedKey! :
    opts.profiles.find((profile) => profile.current)?.key ?? keys[0];
  const profiles = opts.profiles.filter((profile) => profile.key === key);
  const current = profiles.find((profile) => profile.current) ??
    profiles.find((profile) => profile.model === opts.selectedModel) ?? profiles[0];
  const visible = profiles.slice(0, 100);
  if (current && !visible.includes(current)) visible[visible.length - 1] = current;
  const elements: object[] = [
    markdown(`**当前 ${agent} 默认模型**：${opts.currentProfile || '尚未选择'}\n切换会修改本机 ${agent} 默认配置，并为当前聊天开启新会话。`),
    ...(opts.overrideModel ? [markdown(`当前 Bridge 的 /config 另指定了模型 ${opts.overrideModel}；使用此处切换时会清除该覆盖。`)] : []),
    ...(opts.notice ? [markdown(opts.notice)] : []),
    ...(opts.error ? [markdown(`❌ ${opts.error}`)] : []),
  ];
  if (key) {
    elements.push(
      markdown('**服务商**（选择后立即切换，并沿用该服务商上次使用的模型）'),
      {
        tag: 'select_static', name: 'model_key', initial_option: key,
        options: keys.slice(0, 100).map((value) => ({ text: plain(value), value })),
        behaviors: [{ type: 'callback', value: { cmd: 'model.load-provider' } }],
      },
      ...(visible.length ? [{
        tag: 'form', name: 'model_selection', elements: [
          markdown(`**${key} 的模型**（缓存 ${profiles.length} 个）`),
          {
            tag: 'select_static', name: 'model_name', required: true,
            initial_option: current!.model,
            options: visible.map((profile) => ({ text: plain(profile.model), value: profile.model })),
          },
          button('切换模型', 'submit', key, true, 'primary'),
        ],
      }] : [markdown('该服务商暂无缓存模型，请刷新模型列表。')]),
      ...(profiles.length > 100 ? [markdown('卡片显示前 100 个模型；其他模型可发送 /model 服务商/模型名 来选择。')] : []),
      row([
        button('刷新模型', 'refresh-provider', key),
        button('添加模型', 'add-model', key),
        button('编辑服务商', 'edit-provider', key),
        button('删除服务商', 'delete-provider'),
      ]),
    );
  } else {
    elements.push(markdown('尚未添加服务商。'));
  }
  elements.push(button('添加服务商', 'add-provider'));
  return card(`${agent} 模型与服务商`, elements);
}

function providerForm(input?: { key: string; baseUrl: string; models: string[]; refreshedAt?: string }, agent = 'Codex'): object {
  const editing = input !== undefined;
  return card(editing ? `编辑 ${agent} 服务商` : `添加 ${agent} 服务商`, [
    markdown('保存时会自动获取模型列表。手动填写的模型会一并保存，刷新时保留；添加不代表已验证可调用。'),
    ...(input?.refreshedAt ? [markdown(`上次成功刷新：${input.refreshedAt}`)] : []),
    {
      tag: 'form', name: 'provider_form', elements: [
        ...(editing ? [markdown(`**服务商**：${input.key}`)] : [{
          tag: 'input', name: 'key_name', required: true,
          label: plain('服务商名称'), placeholder: plain('例如 my-provider'),
        }]),
        {
          tag: 'input', name: 'base_url', required: true,
          label: plain('Base URL'), placeholder: plain('https://api.example.com/v1'),
          ...(input ? { default_value: input.baseUrl } : {}),
        },
        {
          tag: 'input', name: 'api_key', required: !editing,
          label: plain(editing ? 'API Key（留空保留原密钥）' : 'API Key'),
          placeholder: plain(editing ? '留空保留原密钥' : '输入服务商的 API Key'),
          // Secrets are deliberately never prefilled or repeated in result cards.
        },
        {
          tag: 'input', name: 'custom_model_names', input_type: 'multiline_text',
          label: plain('手动模型名称（可选，逗号或换行分隔）'),
          placeholder: plain('填写后加入模型列表，后续刷新保留；空白不新增'),
        },
        row([
          button('保存并获取模型', editing ? 'update-provider' : 'create-provider', input?.key, true, 'primary'),
          button('取消', 'cancel'),
        ]),
      ],
    },
  ]);
}

export function modelAddKeyFormCard(agent?: 'Codex' | 'Claude'): object { return providerForm(undefined, agent); }

export function modelEditKeyFormCard(input: { key: string; baseUrl: string; models: string[]; refreshedAt?: string }, agent?: 'Codex' | 'Claude'): object {
  return providerForm(input, agent);
}

export function modelDeleteProviderSelectCard(keys: string[], agent: 'Codex' | 'Claude'): object {
  return card(`选择要删除的 ${agent} 服务商`, keys.length ? [
    markdown('请选择要删除的服务商；当前使用中的服务商不会出现在列表中。'),
    {
      tag: 'form', name: 'delete_provider_form', elements: [
        {
          tag: 'select_static', name: 'delete_provider_key', required: true,
          options: keys.slice(0, 100).map((value) => ({ text: plain(value), value })),
        },
        row([button('下一步：确认删除', 'select-delete-provider', '', true, 'danger'), button('取消', 'cancel')]),
      ],
    },
    ...(keys.length > 100 ? [markdown('这里只显示前 100 个服务商；其他服务商可发送 /model delete-provider 服务商名称 来删除。')] : []),
  ] : [markdown('没有可删除的服务商。请先切换到其他服务商，再删除原服务商。'), button('返回', 'cancel')]);
}

export function modelDeleteConfirmCard(input: { key: string }): object {
  return card('确认删除服务商', [
    markdown(`删除 **${input.key}** 的认证配置及缓存模型？本机保留配置备份，当前使用中的服务商不能删除。`),
    row([button('确认删除', 'confirm-delete-provider', input.key, false, 'danger'), button('取消', 'cancel')]),
  ]);
}

export function modelAddModelsFormCard(keys: string[], selectedKey: string | undefined, agent: 'Codex' | 'Claude'): object {
  const visible = keys.slice(0, 100);
  if (selectedKey && !visible.includes(selectedKey)) visible[visible.length - 1] = selectedKey;
  return card(`添加 ${agent} 模型`, keys.length ? [
    markdown('手动模型在刷新列表后保留。这里只添加可选项，不切换当前模型；能否调用需实际验证。'),
    { tag: 'form', name: 'manual_models_form', elements: [
      { tag: 'select_static', name: 'manual_provider_key', required: true,
        ...(selectedKey ? { initial_option: selectedKey } : {}),
        options: visible.map((value) => ({ text: plain(value), value })),
      },
      { tag: 'input', name: 'custom_model_names', input_type: 'multiline_text', required: true,
        label: plain('模型名称（逗号或换行分隔）'), placeholder: plain('按服务商说明填写完整模型 ID'),
      },
      row([button('保存模型', 'create-model', '', true, 'primary'), button('取消', 'cancel')]),
    ] },
  ] : [markdown('请先添加服务商。'), button('返回', 'cancel')]);
}
