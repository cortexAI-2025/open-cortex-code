# Certification Phase 6.2 — runner externe

Date : 2026-11-22. Base `1089ecc`. Branche `cortex/phase6-2-external-sandbox`. Aucun appel modèle. Aucun statut `CERTIFIED`.

## Ce qui a tourné

| Contrôle | Résultat | Preuve |
| --- | --- | --- |
| `pnpm exec tsc --noEmit` | exit 0 | compilation stricte du dépôt |
| `pnpm exec vitest run` | 149/149 | suite produit, dont `tests/external-runner.test.ts` |
| `pnpm build` | exit 0 | web, serveur, desktop |
| Docker | absent | `docker` introuvable, aucune version |
| Gradle | absent | fixture `fixtures/certification/java-gradle` non exécutée |
| Appel xAI | aucun | 0 jeton, tarif indisponible |

## E2E isolé

Commande réelle : `node --test tests/iso.test.js`, `isolation: "required"`, runner loopback `cortex-loopback`.

Le test a constaté : exit 0, `dockerRan` faux, verdict `PASSED_LOCAL` (pas `CERTIFIED`), preuve `PASS`, isolement `namespace`, signature HMAC acceptée, commit Git de 40 caractères, artefact `stdout`, fichier `marker.txt` écrit dans le dépôt, répertoire de jail supprimé. Dans le namespace : `XAI_API_KEY`, `CORTEX_RUNNER_TOKEN`, `GH_TOKEN` et `GITHUB_TOKEN` absents, `/etc` et `/home` invisibles, `/etc/hostname` et `/oldroot/etc/hostname` illisibles, TCP vers `1.1.1.1:443` non établi, `ulimit -n` à 128.

Un échec de test donne `FAIL`. Un timeout donne `timedOut` et pas `PASS`. `node --test …; touch`, `/etc/passwd` et un lien hors dépôt sont `BLOCKED` avant exécution. Une preuve dont le journal est modifié sans nouvelle signature est refusée par le connecteur.

## Reprise et intégrité

Le processus du runner a été tué par `SIGKILL` sur son groupe pendant un job local encore `running`. Au redémarrage le job est `orphaned`, verdict non `CERTIFIED`, et le même identifiant ne relance pas la commande. `exactlyOnce` reste faux.

Un résumé « simulateur solaire » ne change pas l’objectif scellé « Corriger un bug TypeScript dans un dépôt de test. » Aucun fichier `apps/solar` n’est créé. L’amendement utilisateur passe en version 2 et conserve l’instruction originale.

## Ce qui n’est pas certifié

Le namespace n’est pas un conteneur. Il n’y a pas de cgroup mémoire, pas d’image, pas de racine en lecture seule. La limite de processus n’est abaissée que si elle dépasse déjà le nombre de processus de l’uid hôte. Docker reste `BLOCKED`. React, Next, Android et Java ne sont pas certifiés dans cette phase.
