# Runner externe

Le connecteur ne parle pas au socket Docker. Il envoie une demande signée à un processus distinct, lié seulement à `127.0.0.1`.

```bash
export CORTEX_RUNNER_TOKEN='remplacer-par-un-secret-local-long'
export CORTEX_RUNNER_DATA="$PWD/.cortex/runner"
export CORTEX_RUNNER_HOST=127.0.0.1
export CORTEX_RUNNER_PORT=8791
pnpm exec tsx server/runner/main.ts
```

Le connecteur utilise `CORTEX_RUNNER_URL` (défaut `http://127.0.0.1:8791`) et le même `CORTEX_RUNNER_TOKEN`. Un HTTP non loopback est refusé. Le bind hors loopback est refusé. Un jeton de moins de 16 caractères empêche le démarrage.

Protocole `1` : `POST /v1/jobs`, `GET /v1/jobs/:id`, `POST /v1/jobs/:id/cancel`, `GET /v1/health`. Chaque mutation a un nonce, une expiration et une signature HMAC-SHA256. Un nonce ne sert qu’une fois. Un job déjà connu n’est pas relancé. `exactlyOnce` reste faux. Les jobs `running` au redémarrage deviennent `orphaned` et ne sont pas rejoués.

La commande autorisée est un argv, jamais un shell. `node`, `python3` et `pytest` seulement, sans métacaractère, sans `..`, sans chemin hors du dépôt et sans lien qui en sort. Le secret du runner est retiré des journaux avant la signature de la preuve.

## Isolation

`isolation: "required"` essaie Docker seulement si `docker info` répond. Le conteneur, quand il existe, reste non privilégié, sans socket Docker, sans secret, réseau coupé par défaut, et peut alors seul produire `CERTIFIED`.

Sans Docker, le runner utilise un namespace vérifié (`unshare` utilisateur, montage, PID, réseau si la politique le refuse). `server/runner/jail.sh` fait un `pivot_root`, détache l’ancienne racine, monte uniquement le dépôt sur `/work`, vide l’environnement (`env -i`) et retire les capabilities (`setpriv`, `no_new_privs`). Le réseau vers l’extérieur ne passe pas. Ce n’est pas Docker : pas d’image, pas de cgroup mémoire, pas de système en lecture seule. Sur un hôte déjà uid 0, la limite de processus n’est abaissée que si elle reste au-dessus du nombre de processus de cet uid. Le nombre de fichiers ouverts est plafonné à 128 et le timeout tue le groupe de processus. Le verdict d’un succès namespace est `PASSED_LOCAL` avec une preuve `PASS`. Il n’est jamais `CERTIFIED`.

S’il n’y a ni Docker ni namespace, le job est `BLOCKED`. Il n’y a pas de bascule vers le processus local.

`isolation: "local"` est explicite. Le processus n’est pas isolé. Sa preuve, même en cas de succès, reste `BLOCKED` et ne peut pas être `PASS`.

## Preuve

Chaque job terminal réussi ou exécuté porte une preuve : mission, runner `cortex-loopback`, commit s’il existe, commande, code de sortie, journal horodaté, empreinte SHA-256, artefacts, isolement, `dockerRan` et statut `PASS`, `FAIL` ou `BLOCKED`. La signature HMAC couvre ce corps. Le connecteur recalcule l’empreinte et la signature. Une preuve altérée, un `PASS` sans namespace ni conteneur, ou un `CERTIFIED` sans Docker réel est rejeté et le job connecteur reste `BLOCKED`.

`GET /api/projects/:id/sandbox` expose l’état et le JSON des jobs. L’interface Mission affiche le runner, le statut de preuve et l’empreinte.
