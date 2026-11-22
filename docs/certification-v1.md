# Livraison locale V1

Date : 2026-11-22. Branche `release/open-cortex-code-v1`. Les PR #6 à #11 sont une pile linéaire depuis `main` : aucun commit de ces têtes n’est absent de cette branche. Aucune fusion dans `main`. Aucun appel modèle. Coût : tarif indisponible.

## Vérifications

| Contrôle | Résultat |
| --- | --- |
| `pnpm exec tsc --noEmit` | exit 0 |
| `pnpm test` | 149 réussis, 0 échoué |
| `pnpm build` | exit 0 |
| Connecteur local | page `200`, API sans jeton `401` |

## Scénario réel

Mission scellée sur `cortex/double`, dépôt de test `double`.

- Agent : non invoqué, arrêt `blocked`, source inchangée. Aucun correctif n’est présenté comme généré par un modèle.
- Correctif local borné (fragment exact, pas un modèle) : `src/double.js` modifié, `node --test tests/double.test.js` exit 0.
- Runner `cortex-loopback` : verdict `PASSED_LOCAL`, isolement `namespace`, `dockerRan` faux, preuve `PASS`, HMAC vérifiée, exit 0.
- Git : commit local seulement. `pushed` faux, `merged` faux, `remoteCertified` faux. Pas de push et pas de fusion.

## Non exécuté

| Scénario | État |
| --- | --- |
| Docker | BLOCKED. Binaire absent. Pas de `CERTIFIED`. |
| Gradle / Java | BLOCKED. Gradle absent. |
| Android | BLOCKED. Non exécuté. |

Le namespace (pivot_root, réseau neuf, environnement vide, capabilities retirées) n’est pas une sandbox Docker : pas d’image, pas de cgroup mémoire, pas de racine en lecture seule.

Verdict : **GO limité** pour un usage local avec une clé BYOK ou un modèle loopback fourni par l’utilisateur. **NO-GO** pour la fusion dans `main`, la production, et toute certification Docker.
