# Contrat API du connecteur — version 0.1

Toutes les routes `/api/*` sauf `/api/health` exigent `Authorization: Bearer <pairingToken>`. Local seulement, contrôle Host et Origin. Le token de connexion reste en mémoire du navigateur, pas de clé fournisseur en localStorage. JSON errors `{error,code?}` avec HTTP non 2xx. Réponses JSON directes (pas enveloppe data). Types dans `shared/contracts.ts`. Confirmation `confirm:true` est requise pour mutations conséquentes; les permissions moteur passent par une décision explicite `once|reject`. Ne jamais auto-autoriser `always`.

## Noyau

- `GET /api/health` : `{healthy,version,engineVersion,localOnly:true}`; pas de détail de secrets.
- `GET /api/bootstrap` : `Bootstrap`.
- `GET /api/projects` → `Project[]`; `POST /api/projects` body `{name,path,trusted:boolean}` ouvre seulement un chemin réel, aucun clonage implicite.
- `GET /api/projects/:id/files?path=` → `FileNode[]`; `GET /api/projects/:id/file?path=` → `FileContent`.
- `PUT /api/projects/:id/file` body `{path,content,hash,confirm:true}` → `FileContent` (concurrence par hash, sauvegarde/checkpoint avant mutation).
- `GET /api/profiles` → `Profile[]`; `POST /api/profiles` body `{name,providerId,modelId,baseUrl?,apiKey?}` → `Profile`. Clé mémoire uniquement. `PUT /api/profiles/:id/secret` `{apiKey}` → `{hasSecret:true}`; `DELETE /api/profiles/:id/secret` → `{hasSecret:false}`.
- `POST /api/profiles/:id/test` → `{ok,detail}` uniquement après appel réel, ou erreur HTTP; profil configurable sans prétendre clé valide.
- `GET /api/projects/:id/models` → catalogue normalisé `{providers:[{id,name,models:[{id,name,context?,tools?,reasoning?,cost?}]}]}`; metadata ≠ accès testé.
- `GET /api/projects/:id/sessions` → `CortexSession[]`; `POST` body `{title,profileId,mode}` → session.
- `GET /api/sessions/:id/messages` → `ChatMessage[]` (text/actions/code erreurs réels, pas scénario d'exemple).
- `POST /api/sessions/:id/prompt` body `{text,profileId,mode,confirmProviderChange?:boolean}` → `{accepted:true}`; conserver l'engineId lors changement modèle, refuser sans confirmation changement provider.
- `GET /api/sessions/:id` → session; `POST /api/sessions/:id/interrupt` → `{ok:true}`.
- `GET /api/sessions/:id/permissions` → `PermissionRequest[]`; `POST /api/sessions/:id/permissions/:requestId` body `{decision:'once'|'reject'}` → `{ok:true}`.
- `GET /api/projects/:id/memory` → `MemoryEntry[]`; `POST` body `{kind,title,content}` → entry; `PUT /api/projects/:id/memory/:entryId` body `{kind,title,content}` → entry.

## Modules avancés

- `GET /api/projects/:id/git` → `{available,branch,status,log:[{hash,message,date}],diff}`.
- `POST /api/projects/:id/git/branch` `{name,confirm:true}`; `POST /api/projects/:id/git/checkpoint` `{message?,confirm:true}` → checkpoint sans écraser index; `GET /api/projects/:id/git/checkpoints` → checkpoints; `POST /api/projects/:id/git/restore` `{checkpointId,confirm:true}` (sinon refus), fichiers uniquement via validation.
- `POST /api/projects/:id/commands` `{command,confirm:true}` → `CommandResult`; exécution bornée pour projet approuvé uniquement; pas de shell caché derrière Ask. `GET /api/projects/:id/commands` → résultats persistés.
- `GET /api/projects/:id/knowledge` → documents; `POST` `{name,content}`; `DELETE /:docId` `{confirm:true}`; `GET /api/projects/:id/knowledge/search?q=` → passages `{documentId,name,text,score}[]`.
- `GET /api/projects/:id/skills` → skills; `POST` `{name,description,content}`; `PUT /:skillId`; `POST /:skillId/export` `{confirm:true}` écrit `.opencode/skills/<name>/SKILL.md` avec paths validés. `POST /api/projects/:id/skills/generate` `{request,profileId}` crée une vraie session si clé disponible.
- `GET /api/projects/:id/automations` → automations; `POST` config Automation; `PUT /:automationId`; `POST /:automationId/run` `{confirm:true}` → session; `GET /api/projects/:id/history` → événements.
- `GET /api/projects/:id/mcp` → connexions avec statuts réels; `POST` `{name,type:'local'|'remote',command?:string[],url?:string,confirm:true}`; `POST /:name/connect` `{confirm:true}`. Credentials sensibles ne sont pas autorisés dans un JSON public.
- `GET /api/projects/:id/apis` → configs REST sans secrets; `POST` `{name,baseUrl,method,path,headers?,apiKey?}`; `POST /:apiId/test` `{confirm:true}` avec réseau HTTPS ou loopback explicitement approuvé et méthodes sûres; mutation distante jamais implicite.
- `GET /api/projects/:id/agents` → sessions tâches worktrees; `POST` `{name,task,profileId,mode,confirm:true}` crée worktree unique avec session propre; pas merge auto.
- `GET /api/projects/:id/github` → état gh local si installé/auth + PR/workflows read-only. `POST /api/projects/:id/review` `{profileId}` → session d'analyse diff lecture seule; `GET /api/projects/:id/delivery` → résumé machine de fichiers diff, tests vraiment exécutés et problèmes.

## Interface d'intégration backend / avancés

Le noyau exporte dans `server/context.ts` un `ConnectorContext`. Contrat prévu : `store.all<T>(kind,projectId?)`, `store.get<T>(kind,id)`, `store.put<T extends {id:string}>(kind,value,projectId?)`, `store.remove(kind,id)`; `ctx.project(id):Project` validé; `ctx.vault.set(id,secret)`, `get(id)`, `delete(id)`, `redact(text)`; `ctx.engine.request(projectId,method,path,body?,profileId?)` requête au moteur contrôlé côté backend seulement; `ctx.createSession(projectId,{title,profileId,mode})`, `ctx.prompt(sessionId,{text,profileId,mode,confirmProviderChange?})`; `ctx.history(projectId,kind,title,detail)`. Avancés exporte `registerAdvancedRoutes(app:Express,ctx:ConnectorContext):void` dans `server/routes-advanced.ts` et n'initialise aucun service à l'import.
