

## Correctif final supplémentaire

L’exécution est maintenant conçue autour d’un même conteneur Podman : création, inspection host-side, démarrage attaché, sonde puis commande. L’attestation est liée à l’identifiant du conteneur, au `runnerId` et au nonce. Le superviseur vérifie la configuration inspectée avant le démarrage et refuse les divergences de réseau, namespaces, montage root, seccomp ou identité d’image.

La copie `cp()` a été remplacée par `scripts/copy-workspace-secure.py`. Le helper utilise réellement `openat2` avec les protections de résolution Linux, `O_NOFOLLOW`, descripteurs de répertoires, `fstat`, refus des hardlinks/fichiers spéciaux et contrôle de taille/identité après lecture. Un échec ou une indisponibilité entraîne un refus fermé.

La suite d’évasion ne considère plus un code retour non nul comme suffisant : chaque test exige désormais un motif de preuve observable correspondant au mécanisme de blocage attendu. Les tests restent bornés et les outils absents sont `NOT RUN`.

La validation locale finale est la suivante : typecheck PASS, 91 tests PASS, build PASS, validation Bash PASS, compilation Python PASS et test de copie simple avec rejet de symlink PASS. La VM rootless dédiée, l’attestation réelle Podman et le quota workspace complet restent NOT RUN dans ce sandbox. La certification P0 reste FAIL.

## Correctif preuves finales et transition CERTIFIED

La sonde collecte maintenant le cgroup réel depuis `/proc/self/cgroup`, vérifie que le chemin correspond à un cgroup visible sous `/sys/fs/cgroup`, et rapporte `cpu.max`, `memory.max`, `pids.max` ainsi que les contrôleurs actifs. Une simple chaîne non vide n’est plus acceptée.

Les sockets Docker et Podman sont contrôlés dans les emplacements système et rootless XDG pertinents. Les montages sont aussi inspectés pour détecter une exposition indirecte. Toute preuve de socket incomplète bloque l’attestation.

La preuve seccomp est séparée en hash local attendu, configuration host-side inspectée et mode seccomp observé dans `/proc/self/status`. Le hash du profil effectivement chargé reste `NOT RUN` tant que le runtime ne fournit pas une mesure fiable ; aucune correspondance n’est prétendue.

La copie openat2 gère les écritures partielles, fsync, mutations après lecture, limites de taille et de nombre de fichiers, et supprime le staging partiel en cas d’échec.

Une transition pure et testée existe désormais : `PREREQUISITES_VERIFIED → IMAGE_VERIFIED → ATTESTED → VALIDATED → CERTIFIED`. La transition finale exige explicitement le quota global. Les preuves expirées produisent `UNAVAILABLE` et révoquent la certification. Dans l’environnement courant, `storage=fail` et la preuve seccomp effective `NOT RUN` empêchent toujours `CERTIFIED`.

Résultats : typecheck PASS ; 93 tests PASS ; build PASS ; validation Bash PASS ; compilation Python PASS ; VM rootless dédiée NOT RUN ; quota global NOT RUN ; certification P0 FAIL.

## Architecture finale de certification

Les capacités sont désormais séparées : `backendAvailable`, `validationAvailable` et `certifiedExecutionAvailable`. Un backend peut être disponible et une validation contrôlée peut être préparée sans autoriser l’exécution d’un dépôt non fiable. `requireAvailable()` reste strictement bloqué tant que l’exécution certifiée n’est pas valide.

Un parcours `validateRunner()` indépendant de `execute()` crée un conteneur de validation sans monter ni exécuter de dépôt utilisateur, inspecte sa configuration côté hôte, démarre le même conteneur et compare les limites cgroup observées (`cpu.max`, `memory.max`, `pids.max`) aux limites `HostConfig`. Une preuve seccomp effectivement chargée reste `NOT RUN` si le runtime ne l’expose pas de manière mesurable ; cette condition bloque la certification.

La sonde résout maintenant le chemin cgroup du processus à partir de `/proc/self/cgroup` et lit les limites dans ce répertoire précis, jamais dans le cgroup racine par défaut. Les changements concurrents du workspace, le `ctime`, les métadonnées et le contenu copié restent soumis au refus fermé de la copie openat2.

Résultats réels : typecheck PASS ; 94 tests PASS ; build PASS ; syntaxe Bash PASS ; compilation Python PASS ; VM dédiée NOT RUN ; quota global NOT RUN ; hash seccomp effectivement chargé NOT RUN ; certification P0 FAIL.

## Correctif workflow réel de certification

La conversion CPU cgroup v2 utilise maintenant `quota_us = floor(NanoCpus * period_us / 1e9)` et compare la chaîne `cpu.max` à la période effective `HostConfig.CpuPeriod`. Les cas 0,5, 1, 2 et 4 CPU ainsi que les valeurs absentes sont couverts par des tests.

`IsolationAttestation` contient désormais `containerId`, `imageId`, `imageDigest`, `runnerId`, `nonce`, `createdAt` et `expiresAt`. L’attestation ne peut être produite qu’après inspection du même conteneur que celui démarré, vérification de son identifiant et vérification de son digest épinglé. Un nonce seul n’est pas considéré comme une preuve d’identité.

`validateRunner()` est un parcours distinct de `execute()`. Il ne monte ni n’exécute de dépôt utilisateur, inspecte le conteneur de validation, compare ses limites cgroup et conserve le workflow dans `runner-certification-workflow.json`. Les erreurs et preuves manquantes sont persistées. `transitionRunnerState()` est appelée après l’attestation réelle ; `CERTIFIED` exige également `seccompMeasured=true` et `storageQuota=true`. Avec seccomp effectivement chargé `NOT RUN` et quota global `NOT RUN`, la certification reste impossible.

Résultats : typecheck PASS ; 95 tests PASS ; build PASS ; validation Bash PASS ; compilation Python PASS ; validation VM dédiée NOT RUN ; quota global NOT RUN ; certification P0 FAIL.

## Correctif final — identité stricte et intégrité du workflow

La comparaison du conteneur est désormais exacte : l’identifiant retourné par `podman create` doit être identique, caractère par caractère, à l’identifiant de `podman inspect`. Les comparaisons par préfixe sont supprimées. L’identité inspectée doit également correspondre au nom runner attendu et contenir le digest épinglé dans les digests de l’image inspectée.

Le workflow persistant dispose maintenant d’un fichier d’intégrité SHA-256 adjacent. Au redémarrage, un fichier absent, corrompu, incomplet, incohérent ou dont le hash ne correspond pas entraîne un refus fermé. Les transitions et erreurs sont écrites dans `runner-certification-workflow.json` et ne peuvent pas être considérées comme certification sans preuves valides.

Tests supplémentaires : égalité exacte des identifiants, rejet d’un identifiant partiellement identique, digest substitué refusé, workflow incomplet/corrompu refusé, conversion CPU et transitions avec seccomp mesuré obligatoire.

Résultats : typecheck PASS ; 97 tests PASS ; build PASS ; validation Bash PASS ; compilation Python PASS ; tests rootless réels NOT RUN ; preuve seccomp effectivement chargée NOT RUN ; quota global workspace NOT RUN ; certification P0 FAIL / NOT RUN.

## Dernier correctif — identité mesurée et intégrité du workflow

Les contrôles d’identité ne reposent plus sur `includes()` ou des préfixes pour le conteneur et le nom. L’identifiant Podman de création doit égaler exactement celui de l’inspection. L’image est inspectée avant création pour obtenir séparément son image ID et son digest de manifeste/référence ; le conteneur doit présenter le même image ID et un digest correspondant à la référence épinglée. Les identifiants de conteneur, image, runner et nonce sont conservés dans l’attestation.

Le fichier JSON et le hash adjacent ne sont plus considérés comme une protection d’intégrité suffisante. Le workflow utilise désormais une signature HMAC avec une clé placée hors du répertoire de données, des écritures temporaires puis renommage, une vérification à chaque chargement et un refus si la clé, la signature ou la séquence est absente/incohérente. Cette protection dépend toutefois des permissions et du modèle de confiance du compte hôte ; elle ne constitue pas une preuve contre un attaquant capable de modifier simultanément la clé hors répertoire. Dans ce cas, la certification doit rester refusée.

`validateRunner()` persiste l’état réellement atteint après attestation puis n’avance à `VALIDATED` que si la sortie contient la preuve explicite de la suite d’évasion. Dans l’environnement courant, cette preuve, le hash seccomp chargé et le quota global restent `NOT RUN`; le workflow ne passe donc pas à `VALIDATED` ou `CERTIFIED`.

Tests réels : typecheck PASS ; 97 tests PASS ; build PASS ; Bash PASS ; Python PASS. Tests rootless/VM dédiée NOT RUN. Verdict obligatoire : **FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED**.

## Kit VM Linux dédiée ajouté

Le répertoire `lab/p0-vm/` contient les scripts reproductibles de contrôle hôte, installation Podman/crun, configuration rootless, préparation XFS, project quota, vérification runtime, build digesté, tests d’isolation, quota, seccomp, attestation et orchestration finale.

Le contrôle non destructif exécuté dans le sandbox a observé Ubuntu 24.04, noyau Linux aarch64 et filesystem ext4. Il est PASS pour le baseline hôte, mais il n'est pas une VM dédiée et ne constitue pas une preuve rootless, XFS/project-quota, seccomp chargé ou certification P0. Les étapes dépendant d’un périphérique XFS dédié restent NOT RUN.

Les scripts de syntaxe Bash, le typecheck TypeScript et la compilation Python sont PASS. Le verdict expérimental reste : FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED.

## Correctif final du kit VM

Le kit `lab/p0-vm/` a été durci conformément à la spécification corrective. `03-prepare-xfs.sh` résout le périphérique, refuse le root et les périphériques montés ou ambigus, vérifie le point de montage vide, fournit un mode `P0_XFS_VERIFY_ONLY=1` et exige une confirmation exacte ainsi que `P0_ALLOW_FORMAT=YES` avant tout `mkfs.xfs`.

`08-run-storage-tests.sh` vérifie XFS, `prjquota`, le project ID et le rapport XFS avant l’écriture. Une erreur `EDQUOT` est distinguée de `ENOSPC`, permission, I/O et absence de limite ; aucune erreur générique n’est un PASS. Les fichiers temporaires sont nettoyés et les rapports avant/après sont conservés.

`07-run-isolation-tests.sh` génère un nonce par exécution, le vérifie dans la sortie de la sonde, impose un UID/GID non-root et contrôle les preuves individuelles. `06-build-runner-image.sh` enregistre séparément image ID et RepoDigest et refuse l’absence de référence immuable. `11-run-p0-certification.sh` transmet les preuves et paramètres entre étapes et s’arrête sur précondition manquante.

Validation effectuée : Bash PASS, TypeScript PASS, Python PASS. Le contrôle XFS sans modification n’a pas été exécuté comme root et a été refusé avec le code attendu ; aucune opération de formatage n’a été réalisée. Les preuves VM dédiées, XFS réel, quota global et seccomp chargé restent NOT RUN. Verdict : FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED.

## Non-régression finale

`pnpm typecheck` : PASS. `pnpm test -- --reporter=dot` : 97 tests PASS. `pnpm build` : PASS. Syntaxe Bash et compilation Python : PASS. Le build signale uniquement des avertissements de taille de bundle et de directives de modules dépendantes, sans échec.

Le kit VM n’a pas été exécuté sur une VM dédiée dans cette session. Le sandbox a seulement exécuté le contrôle hôte non destructif et a observé ext4, pas XFS. La certification reste refusée.

## Troisième correctif ciblé du kit VM

Le script de quota a été réécrit pour éviter la condition Bash fragile et distinguer explicitement `EDQUOT`, `EACCES`, `EPERM`, `ENOSPC`, `EIO` et les erreurs inattendues. Il vérifie le filesystem XFS, `prjquota`, le project ID et une limite dure lisible avant toute écriture. Il ajoute une étape rootless concurrente avec quatre processus dans le même workspace ; si `EDQUOT` global n'est pas observé sans ambiguïté, le résultat est `GLOBAL_WORKSPACE_QUOTA=NOT RUN`.

L’orchestrateur accepte désormais les codes 0, 1 et 77 sans interrompre la collecte ordinaire. Il produit toujours un verdict final, conserve stdout, stderr, codes et durées, et maintient `FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED` dès qu’une preuve manque.

L’attestation est structurée en JSON versionné avec session, horodatages, image, environnement, tests et manifeste SHA-256. `verify-attestation.sh` vérifie indépendamment le schéma et les artefacts. Le statut de signature protégée reste `UNAVAILABLE`; le manifeste n'est pas présenté comme une signature cryptographique et la certification reste bloquée.

Le contrôle de topologie XFS possède maintenant le mode `--check`, refuse partitions, disques avec enfants, swap, device-mapper et points de montage non vides. Aucun formatage réel n'a été exécuté.

Validation ciblée : Bash PASS ; Python PASS ; typecheck PASS ; attestation synthétique avec statut 77 et vérification indépendante PASS. VM dédiée, XFS réel, quota global rootless et hash du filtre seccomp effectivement chargé : NOT RUN.
