import type { Module } from './types.ts';
import { cloudSessionModule } from './providers-cloud-session/index.ts';
import { antigravityModule } from './providers-antigravity/index.ts';
import { cloudGatewayModule } from './providers-cloud-gateway/index.ts';
import { githubModule } from './github/index.ts';
import { automationModule } from './answer-automation/index.ts';
import { presenceModule } from './answer-presence/index.ts';
import { browserModule } from './answer-browser/index.ts';
import { stalledModule } from './todo-stalled/index.ts';
import { defaultsModule } from './providers-defaults/index.ts';
import { quietChildrenModule } from './answer-quiet-children/index.ts';
import { escalationModule } from './answer-escalation/index.ts';
import { claudeAccountsModule } from './usage-claude-accounts/index.ts';
import { providerQuotasModule } from './usage-provider-quotas/index.ts';

/**
 * 全部模块，按注册顺序排列（与整合前一致：云端会话最先注册）。
 * 新模块：在 `server/modules/<名称>/index.ts` 导出一个 Module，加到这里。
 */
export const MODULES: readonly Module<any>[] = [
  cloudSessionModule,
  antigravityModule,
  cloudGatewayModule,
  githubModule,
  automationModule,
  presenceModule,
  browserModule,
  stalledModule,
  defaultsModule,
  quietChildrenModule,
  escalationModule,
  claudeAccountsModule,
  providerQuotasModule,
];
