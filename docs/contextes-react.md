# Contextes React et isolation des mises à jour

Ce document décrit la séparation des états globaux côté interface, afin qu’un changement d’un domaine ne notifie pas automatiquement tous les composants qui utilisaient le contexte monolithique.

## Domaines et hooks

| Domaine | Hook | État et responsabilités |
|---|---|---|
| Connexion | `useConnection()` | API locale, état connecté, origine distante, connexion/déconnexion et rafraîchissement. Sa valeur dépend du booléen « bootstrap présent », pas de l’identité de tout l’objet bootstrap. |
| Connexion en cours | `useConnecting()` | Indicateur transitoire de tentative de connexion. Isolé de `ConnectionDomain`; `ConnectionPanel` l’utilise pour désactiver le formulaire et afficher la progression. |
| Catalogue du connecteur | `useBootstrap()` | Projets, profils, version et capacités du connecteur. Séparé de la connexion afin que les mises à jour périodiques du bootstrap ne changent pas l’identité du contexte de connexion. |
| Workspace | `useWorkspace()` | Projet actif et sélection de projet. `sameProject` compare les six champs du contrat `Project` et préserve l’objet sélectionné lorsque ces champs n’ont pas changé. |
| Brouillons | `useUnsaved()` / `useUnsavedActions()` | Valeur du statut non enregistré et commande stable séparées en contextes de lecture et d’action. `WorkspaceDomain` n’inclut plus `unsaved`. |
| Agent | `useAgent()` | Profil sélectionné, mode Ask/Plan/Agent et session active. N’inclut pas le projet ni l’état de brouillon. |
| Navigation | `useNavigation()` | Vue active. Les commandes de navigation sont séparées dans `useNavigationActions()` pour que les composants qui ne font que naviguer ne s’abonnent pas aux changements de vue. |
| Notifications | `useNotice()` | Notice visible, séparée des commandes stables `notify`, `clearNotice`, `confirm` et `act` exposées par `useAppActions()`. |

Les consommateurs internes ont été migrés vers les hooks dont ils ont besoin. `useApp()` reste temporairement disponible pour compatibilité, mais est marqué `@deprecated` et n’est plus appelé par le code de l’interface : il réunit tous les domaines et annulerait l’isolation s’il était réutilisé.

## Stabilité et comportement

Les objets de contexte sont mémorisés avec `useMemo`; les commandes sont stabilisées avec `useCallback`. Les gardes de connexion et de sélection de projet lisent les dernières valeurs via des refs, évitant de recréer leurs fonctions à chaque mise à jour d’un état indépendant. La connexion et le bootstrap ont des contextes distincts; les actions et l’état de notification sont également séparés. `connecting` est séparé de l’état `connected`, et seul `ConnectionPanel` s’abonne au premier. Le setter des brouillons est exposé indépendamment de leur valeur, de sorte que Workbench peut publier ses modifications sans s’abonner à chaque changement du statut.

Dans `App.tsx`, l’application racine est mémoïsée. La notice est rendue par un composant dédié; la vue sélectionnée, le Workbench, le tiroir et le panneau Agent conservent leurs éléments React lorsque leurs entrées pertinentes n’ont pas changé. Ainsi, une notice ou une confirmation n’est plus une raison pour que l’App s’abonne à cet état et reconstruise ses sous-arbres.

Le garde-fou de confirmation lors du changement de projet est respecté dans la vue Projets : l’interface ne navigue vers l’éditeur que si `setProjectId()` renvoie `true`, y compris après la création d’un projet.

## Limites connues

`useBootstrap()` notifie volontairement ses abonnés lorsque le connecteur renvoie un nouveau bootstrap (heartbeat toutes les huit secondes). Les composants qui affichent le catalogue/version doivent donc pouvoir se mettre à jour. Le shell App dépend encore de la connexion, du bootstrap, du workspace, du mode et de la navigation; ces changements utiles peuvent le re-rendre. Le profilage des brouillons et des transitions `connecting` montre zéro rendu de la fonction `App` ciblée, alors que le contrefactuel `useApp()` agrégé se rend pour ces deux états; les composants qui lisent explicitement ces statuts restent réactifs.

Aucune dépendance de production ou de test n’a été ajoutée pour ce refactor.

## Vérifications

Validations exécutées après le changement :

- `pnpm typecheck` : réussi.
- `pnpm test` : 86 tests réussis.
- `pnpm build` : build Web, serveur et Desktop réussi après l’extraction. `editor.api` (environ 2,74 MB brut) dépasse encore le seuil d’avertissement Vite de 1,5 MB; le chunk Monaco (environ 1,30 MB brut) reste lourd sans dépasser ce seuil. Les avertissements `use client` de Lucide subsistent; aucun seuil n’a été relevé.
- `pnpm test:monaco-browser` : réussi sur Chrome 156.0.8078.73; chargement froid, ouverture de l’éditeur, conservation de l’instance lors des changements de vue et reprise après échec vérifiés.
- `pnpm test:secondary-views-browser` : réussi sur le même navigateur.
- `git diff --check` : réussi.

Le profilage reproductible (`scripts/profile-context-domains.mjs`) utilise React Profiler sous Chrome 156 / React 19.3.1 en développement. Pour `unsaved`, il a observé zéro appel à la fonction `App` et 12 commits descendants ciblés (médiane 1,8 ms) contre 12 appels à `App` et 12 commits agrégés (médiane 15,45 ms) dans 12 interactions. Ce benchmark est limité au sous-arbre racine de l’application et ne mesure pas layout/paint ni production; voir `docs/profilage-contextes-react.md`.
