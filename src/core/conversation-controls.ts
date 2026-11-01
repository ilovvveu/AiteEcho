import type { VerboseMode } from '../types/agent.js';
import type { ConversationProgressMode, PersistedConversationState } from '../types/session.js';

type ConversationModeDefaults = {
  defaultProgressMode: ConversationProgressMode;
  defaultVerboseMode: VerboseMode;
};

type ConversationModeResolution = {
  progressMode: ConversationProgressMode;
  progressSource: 'default' | 'conversation';
  verboseMode: VerboseMode;
  verboseSource: 'default' | 'conversation';
};

type CommandPatch = Pick<PersistedConversationState, 'progressModeOverride' | 'verboseModeOverride'>;

type ControlCommandParams = ConversationModeDefaults & {
  prefix: string;
  commandName: string;
  args: string[];
  persisted?: Partial<Pick<PersistedConversationState, 'progressModeOverride' | 'verboseModeOverride'>>;
};

type ControlCommandResult = {
  patch?: CommandPatch;
  message: string;
};

function normalizeVerboseMode(value: string): VerboseMode | undefined {
  switch (value.toLowerCase()) {
    case 'normal':
    case 'off':
    case 'quiet':
      return 'normal';
    case 'verbose':
    case 'on':
      return 'verbose';
    case 'debug':
      return 'debug';
    default:
      return undefined;
  }
}

function normalizeProgressMode(value: string): ConversationProgressMode | undefined {
  switch (value.toLowerCase()) {
    case 'off':
    case 'quiet':
      return 'off';
    case 'message':
    case 'on':
      return 'message';
    default:
      return undefined;
  }
}

export function resolveConversationModes(
  defaults: ConversationModeDefaults,
  persisted?: Partial<Pick<PersistedConversationState, 'progressModeOverride' | 'verboseModeOverride'>>,
): ConversationModeResolution {
  return {
    progressMode: persisted?.progressModeOverride ?? defaults.defaultProgressMode,
    progressSource: persisted?.progressModeOverride ? 'conversation' : 'default',
    verboseMode: persisted?.verboseModeOverride ?? defaults.defaultVerboseMode,
    verboseSource: persisted?.verboseModeOverride ? 'conversation' : 'default',
  };
}

export function handleConversationControlCommand(
  params: ControlCommandParams,
): ControlCommandResult | null {
  const resolved = resolveConversationModes(params, params.persisted);

  if (params.commandName === 'quiet') {
    return {
      patch: {
        progressModeOverride: 'off',
        verboseModeOverride: 'normal',
      },
      message: '已切换为安静模式：progress=off，verbose=normal。',
    };
  }

  if (params.commandName === 'verbose') {
    if (params.args.length === 0) {
      return {
        message: [
          `当前会话详细模式：${resolved.verboseMode}（${resolved.verboseSource === 'conversation' ? '会话覆盖' : '全局默认'}）`,
          `可用命令：${params.prefix}verbose normal | verbose | debug | default`,
        ].join('\n'),
      };
    }
    const raw = params.args[0]?.toLowerCase();
    if (raw === 'default' || raw === 'reset') {
      return {
        patch: {
          verboseModeOverride: undefined,
        },
        message: `已恢复当前会话详细模式为全局默认：${params.defaultVerboseMode}。`,
      };
    }
    const verboseMode = normalizeVerboseMode(raw || '');
    if (!verboseMode) {
      return {
        message: `用法：${params.prefix}verbose normal|verbose|debug|default`,
      };
    }
    return {
      patch: {
        verboseModeOverride: verboseMode,
      },
      message: `已设置当前会话详细模式为 ${verboseMode}。`,
    };
  }

  if (params.commandName === 'progress') {
    if (params.args.length === 0) {
      return {
        message: [
          `当前会话处理中汇报：${resolved.progressMode}（${resolved.progressSource === 'conversation' ? '会话覆盖' : '全局默认'}）`,
          `可用命令：${params.prefix}progress off | message | default`,
        ].join('\n'),
      };
    }
    const raw = params.args[0]?.toLowerCase();
    if (raw === 'default' || raw === 'reset') {
      return {
        patch: {
          progressModeOverride: undefined,
        },
        message: `已恢复当前会话处理中汇报为全局默认：${params.defaultProgressMode}。`,
      };
    }
    const progressMode = normalizeProgressMode(raw || '');
    if (!progressMode) {
      return {
        message: `用法：${params.prefix}progress off|message|default`,
      };
    }
    return {
      patch: {
        progressModeOverride: progressMode,
      },
      message: `已设置当前会话处理中汇报为${progressMode === 'off' ? '关闭' : '消息模式'}。`,
    };
  }

  return null;
}
