import type { Express } from 'express';
import type { ConnectorContext } from './context.js';
import { registerGitRoutes } from './advanced/git.js';
import { registerCommandRoutes } from './advanced/process.js';
import { registerKnowledgeSkillRoutes } from './advanced/knowledge-skills.js';
import { registerAutomationRoutes } from './advanced/automations.js';
import { registerApiRoutes } from './advanced/network.js';
import { registerMcpRoutes } from './advanced/mcp.js';
import { registerAgentDeliveryRoutes } from './advanced/agents-delivery.js';
import { registerGitPublishRoutes } from './advanced/git-publish.js';
import { registerMissionRoutes } from './advanced/mission.js';
import { registerRepairRoutes } from './advanced/repair.js';
import { registerAgentMissionRoutes } from './advanced/agent-mission.js';
import { registerOrchestratorRoutes } from './advanced/orchestrator.js';
import { registerRuntimeRoutes } from './advanced/runtime.js';
import { registerSecureRoutes } from './advanced/secure-execution.js';
import { registerResilienceRoutes } from './advanced/resilience.js';
import { registerIntegrityRoutes } from './advanced/mission-integrity.js';
import { registerSandboxRoutes } from './advanced/external-runner.js';
import { registerWorktreeClaimRoutes } from './advanced/worktree-claims.js';
import { registerCtoBridgeRoutes } from './advanced/cto-bridge.js';
import { registerCtoHumanRoutes } from './advanced/cto-human.js';

export { shutdownAdvanced } from './advanced/automations.js';

/** Core installs authenticated pairing/Origin/Host middleware before calling this function. */
export function registerAdvancedRoutes(app: Express, ctx: ConnectorContext): void {
  registerGitRoutes(app, ctx);
  registerGitPublishRoutes(app, ctx);
  registerCommandRoutes(app, ctx);
  registerKnowledgeSkillRoutes(app, ctx);
  registerApiRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerAgentDeliveryRoutes(app, ctx);
  registerMissionRoutes(app, ctx);
  registerRepairRoutes(app, ctx);
  registerAgentMissionRoutes(app, ctx);
  registerOrchestratorRoutes(app, ctx);
  registerRuntimeRoutes(app, ctx);
  registerSecureRoutes(app, ctx);
  registerResilienceRoutes(app, ctx);
  registerIntegrityRoutes(app, ctx);
  registerSandboxRoutes(app, ctx);
  registerWorktreeClaimRoutes(app, ctx);
  registerCtoBridgeRoutes(app, ctx);
  registerCtoHumanRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
}
