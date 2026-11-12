import type { Express } from 'express';
import type { ConnectorContext } from './context.js';
import { registerGitRoutes } from './advanced/git.js';
import { registerCommandRoutes } from './advanced/process.js';
import { registerKnowledgeSkillRoutes } from './advanced/knowledge-skills.js';
import { registerAutomationRoutes } from './advanced/automations.js';
import { registerApiRoutes } from './advanced/network.js';
import { registerMcpRoutes } from './advanced/mcp.js';
import { registerAgentDeliveryRoutes } from './advanced/agents-delivery.js';

export { shutdownAdvanced } from './advanced/automations.js';

/** Core installs authenticated pairing/Origin/Host middleware before calling this function. */
export function registerAdvancedRoutes(app: Express, ctx: ConnectorContext): void {
  registerGitRoutes(app, ctx);
  registerCommandRoutes(app, ctx);
  registerKnowledgeSkillRoutes(app, ctx);
  registerApiRoutes(app, ctx);
  registerMcpRoutes(app, ctx);
  registerAgentDeliveryRoutes(app, ctx);
  registerAutomationRoutes(app, ctx);
}
