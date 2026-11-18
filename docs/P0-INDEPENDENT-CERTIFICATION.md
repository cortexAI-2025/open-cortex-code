# Certification indépendante P0

`lab/p0-vm/11-run-p0-certification.sh` orchestre les vérifications dans un environnement dédié. Il ne donne jamais de privilège root au runner et n'utilise ni `--privileged`, ni `--cgroupns=host`, ni fallback rootful.

Les preuves sont séparées en :

- prérequis système ;
- identité image/containeur ;
- isolation réellement observée ;
- limites CPU/mémoire ;
- quota global ;
- seccomp effectivement mesuré ;
- tests d'évasion ;
- persistance et révocation.

Le verdict est `CERTIFIED` uniquement si toutes les preuves obligatoires sont mesurées. Sinon : `FAIL / NOT RUN — P0 CERTIFICATION NOT GRANTED`.
