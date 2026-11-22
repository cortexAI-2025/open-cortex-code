# Certification Phase 6

Preuve produite le 2026-11-22 sur un dépôt temporaire, hors du dépôt produit. Le correctif n’a pas été fourni au modèle. Le dépôt temporaire a été supprimé après la mesure. Aucun dépôt GitHub de fixture n’a été créé.

## Node.js / TypeScript — PASSED_LOCAL

Défaut réel : `src/tax.ts` renvoyait `Math.round(amount * 0.1)` alors que le test exige 20 pour un montant de 100. Objectif transmis : calculer 20 pour cent, arrondi à l’entier. Politique de test `deny`. Branche du fixture `cortex/phase6-node`, pas `main`.

Commande : `node --experimental-strip-types --test tests/tax.test.ts`.

| Étape | Résultat |
| --- | --- |
| Test initial | `FAILED`, exit 1 |
| Isolation exigée | `BLOCKED_SANDBOX`, `dockerRan` faux |
| Appels modèle | 1, plafond autorisé 2 |
| Fournisseur / modèle | `xai` / `grok-4.20-0309-non-reasoning` |
| Session OpenCode | `ff8e904c-fe77-4909-9dfc-568ca754a0c8` |
| Jetons | 6248 entrée, 137 sortie |
| Fichier appliqué | `src/tax.ts` seulement |
| Test inchangé | oui, SHA-256 `68d50793b926db7e1646b78c578c9018660185a6f5203426d00bc357adaf5756` |
| Rejeu local | `PASSED_LOCAL`, exit 0 |
| Verdict mission | `PROVEN`, complet |
| Statut projet | `PASSED_LOCAL` |
| `certified` | faux |

Ce n’est pas `CERTIFIED`. Le coût monétaire n’est pas estimé : tarif indisponible.

## Autres environnements

| Scénario | Statut | Justification |
| --- | --- | --- |
| React | `SKIPPED` | React est dans le produit, pas dans un projet isolé. Aucune installation réseau et aucun appel modèle. |
| Next.js | `SKIPPED` | Paquet Next absent. Aucune installation et aucun succès simulé. |
| Python | `SKIPPED` | Python 3.10.22 est présent. Le même défaut 10 % contre 20, lancé par `python3 -m unittest tests/test_tax.py`, sort en exit 1. Le correctif modèle n’a pas été lancé, pour limiter les appels payants. Ce rouge n’est pas un PASS. |
| Android Gradle | `BLOCKED` | `javac` présent. `gradle` et `ANDROID_HOME` absents. Aucun PASS. |

## Sandbox

`docker` est absent (`command not found`). Toute demande d’isolation a répondu `BLOCKED_SANDBOX` sans lancer le processus local. La certification sandbox est **NO-GO**.

## Ce que les tests unitaires prouvent, et ce qu’ils ne prouvent pas

La suite produit couvre la traversée de chemins, les liens hors dépôt, les commandes interdites, les fichiers sensibles, le timeout, l’annulation, la concurrence, la reprise d’un bail abandonné après redémarrage SQLite, l’idempotence externe avec `exactlyOnce` faux, le budget fournisseur, le circuit breaker et le refus d’un push forcé ou vers `main`. Ces tests n’exécutent pas Docker et ne peuvent pas afficher `CERTIFIED`.

La reprise prouvée est celle du bail SQLite. La session OpenCode de cette certification n’a pas été crashée puis reprise.
