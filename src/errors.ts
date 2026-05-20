export interface ErrorDef {
  message: string;
  needRefresh: boolean;
}

export const ERR: Record<string, ErrorDef> = {
  NOT_IN_LOBBY:         { message: '未加入大厅', needRefresh: false },
  LOBBY_NOT_FOUND:      { message: '游戏房间已不存在，请刷新页面', needRefresh: true },
  PLAYER_NOT_FOUND:     { message: '玩家ID未找到', needRefresh: false },
  GAME_NOT_STARTED:     { message: '对局未开始', needRefresh: false },
  GAME_ALREADY_STARTED: { message: '对局已开始', needRefresh: false },
  CREATOR_ONLY:         { message: '只有房主可以邀请 AI', needRefresh: false },
  CREATOR_ONLY_AI_READY:{ message: '只有房主可以准备 AI', needRefresh: false },
  CREATOR_ONLY_KICK_AI: { message: '只有房主可以踢出 AI', needRefresh: false },
  CREATOR_ONLY_TRANSFER:{ message: '只有房主可以转让', needRefresh: false },
  AI_NOT_FOUND:         { message: 'AI 玩家未找到', needRefresh: false },
  TARGET_INVALID:       { message: '目标玩家无效', needRefresh: false },
  NEED_LOBBY_NAME:      { message: '请提供大厅名称', needRefresh: false },
  LOBBY_STARTED_JOIN:   { message: '大厅已开始对局, 请使用其他名称', needRefresh: false },
  NAME_DUPLICATE:       { message: '该大厅中已存在同名玩家，请选择其他名称', needRefresh: false },
} as const;

export type ErrorCode = keyof typeof ERR;

export function errorResponse(code: ErrorCode): { action: string; errorKey: ErrorCode } {
  return { action: 'error', errorKey: code };
}
